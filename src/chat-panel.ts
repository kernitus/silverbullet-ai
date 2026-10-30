import { type ChatScope, noteFolders, scopePermissions } from "./chat-scope.ts";
import { experimental_createSteering, type UIMessage } from "ai";
import { createPanelPush } from "./panel-push.ts";
import { currentPageContext } from "./page-context.ts";
import { filterCapabilities, isRestricted } from "./capabilities.ts";
import { interruptedMessages, type RunCheckpoint } from "./execution.ts";
import {
  CHAT_HISTORY_KEY,
  savePanelInstruction,
  type RunInstruction,
  beginPanelTurn,
  savePanelCompaction,
  savePanelCheckpoint,
  loadPanelHistory,
  clearPanelHistory,
} from "./panel-history.ts";
import {
  asset,
  clientStore,
  editor,
  index,
  lua,
  space,
} from "@silverbulletmd/silverbullet/syscalls";
import type {
  AIAgentTemplate,
  Attachment,
  ChatMessage,
  LuaToolDefinition,
  Tool,
  Usage,
  PathPermissions,
} from "./types.ts";
import {
  aiSettings,
  chatSystemPrompt,
  currentAIProvider,
  enabledAttachmentKinds,
  getSelectedTextModel,
  initIfNeeded,
  setSessionToggle,
  toolsEnabled,
} from "./init.ts";
import {
  assembleMessagesWithAttachments,
  enrichChatMessages,
  log,
} from "./utils.ts";
import { extractFilesFromMarkdown, getFileHandlerExts } from "./files.ts";
import {
  convertToOpenAITools,
  discoverAllTools,
  runStreamingAgenticChat,
} from "./tools.ts";
import {
  buildAgentSystemPrompt,
  discoverAgents,
  filterToolsForAgent,
} from "./agents.ts";
import { getModelContextLimit as lookupModelContextLimit } from "./model-metadata.ts";

let isPanelOpen = false;
let panelStarting = false;
let currentChatAgent: AIAgentTemplate | null = null;

let sessionTokenUsage: Usage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};
let tokenUsageLoaded = false;

interface StreamBuffer {
  baseMessages: ChatMessage[];
  preview?: UIMessage;
  previewLimited?: boolean;
  status: "streaming" | "complete" | "error" | "cancelled";
  controller: AbortController;
  chatId: string;
  checkpoint: RunCheckpoint;
  steering?: ReturnType<typeof experimental_createSteering>;
  instructions: RunInstruction[];
  error?: string;
  statusMessage?: string;
  messages?: ChatMessage[];
}
const streamBuffers = new Map<string, StreamBuffer>();
let latestRunId: string | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
const panelPush = createPanelPush(() => {
  const buffer = latestRunId ? streamBuffers.get(latestRunId) : undefined;
  return {
    agentRef: currentChatAgent?.ref ?? null,
    reasoningEnabled: aiSettings?.chat?.showReasoning ?? false,
    run: buffer
      ? {
          id: latestRunId,
          chatId: buffer.chatId,
          status: buffer.status,
          preview: buffer.preview,
          previewLimited: buffer.previewLimited,
          statusMessage: buffer.statusMessage,
          instructions: buffer.instructions,
          error: buffer.error,
        }
      : undefined,
  };
});

export function connectPanelChat() {
  return panelPush.connect();
}

function finishPanelRun(id: string): void {
  panelPush.changed();
  // Reopening recovers terminal history from storage after this live cache expires.
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => {
    expiryTimer = undefined;
    if (streamBuffers.get(id)?.status !== "streaming") streamBuffers.delete(id);
  }, 5 * 60_000);
}

const TOKEN_USAGE_KEY = "ai.panelTokenUsage";
const PANEL_STATE_KEY = "ai.panelOpen";
const AGENT_KEY = "ai.panelAgent";

/**
 * Helper to avoid exporting get/set/clear separately in the plug yaml
 * @param action - "get" returns current agent, "set" sets agent, "clear" clears agent
 * @param agent - Agent to set (only used with "set" action)
 */
export async function chatAgentState(
  action: "get" | "set" | "clear",
  agent?: AIAgentTemplate | null,
): Promise<AIAgentTemplate | null | void> {
  switch (action) {
    case "get":
      if (!currentChatAgent) {
        const stored = await clientStore.get(AGENT_KEY);
        if (stored) {
          currentChatAgent = stored as AIAgentTemplate;
        }
      }
      return currentChatAgent;
    case "set":
      currentChatAgent = agent ?? null;
      await clientStore.set(AGENT_KEY, currentChatAgent);
      panelPush.changed();
      break;
    case "clear":
      currentChatAgent = null;
      await clientStore.del(AGENT_KEY);
      panelPush.changed();
      break;
  }
}

async function initChatAgent(): Promise<void> {
  if (currentChatAgent) return;

  const agents = await discoverAgents();
  const configuredRef = aiSettings?.chat?.defaultAgent;
  const refToFind = configuredRef || "default";
  const defaultAgent = agents.find((a) => a.ref === refToFind);
  if (defaultAgent) {
    currentChatAgent = defaultAgent;
  }
}

/**
 * Loads the panel HTML and script, with the vendored DOMPurify prepended so
 * it's guaranteed to be defined before the panel script runs (no CDN needed).
 */
async function loadPanelAssets(): Promise<{ html: string; script: string }> {
  const html = await asset.readAsset(
    "silverbullet-ai",
    "assets/chat-panel.html",
  );
  const purify = await asset.readAsset(
    "silverbullet-ai",
    "assets/purify.min.js",
  );
  const script = await asset.readAsset(
    "silverbullet-ai",
    "assets/chat-panel.js",
  );
  return { html, script: purify + "\n" + script };
}

/**
 * Opens the AI Assistant panel (side panel)
 */
export async function openAIAssistant() {
  await initIfNeeded();

  if (isPanelOpen) {
    return;
  }

  const { html, script } = await loadPanelAssets();
  await editor.showPanel("rhs", 1, html, script);
  isPanelOpen = true;
  await clientStore.set(PANEL_STATE_KEY, true);
}

/** Start a fresh conversation without changing saved agent definitions. */
async function openScopedChat(chatScope: ChatScope): Promise<void> {
  if (
    panelStarting ||
    [...streamBuffers.values()].some((buffer) => buffer.status === "streaming")
  )
    throw new Error("Stop the running chat before opening a scoped chat.");
  panelStarting = true;
  try {
    await clearPanelHistory(crypto.randomUUID(), chatScope);
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
    streamBuffers.clear();
    latestRunId = undefined;
    await closeAIAssistant();
    await openAIAssistant();
  } finally {
    panelStarting = false;
  }
}

export async function chatWithCurrentNote(): Promise<void> {
  const path = await editor.getCurrentPage();
  if (!path) throw new Error("Open a note first.");
  await openScopedChat({ kind: "note", path });
}

export async function chatWithFolder(): Promise<void> {
  const folders = noteFolders(await space.listPages());
  if (!folders.length) {
    await editor.flashNotification(
      "No note folders found. Use AI: Chat with Current Note for a root-level note.",
    );
    return;
  }
  const selected = await editor.filterBox(
    "Chat with Folder",
    folders.map((path) => ({ name: path, path })),
    "Choose a folder, including its subfolders",
  );
  if (!selected) return;
  if (!folders.includes(selected.path))
    throw new Error("Select a folder from the list.");
  await openScopedChat({ kind: "folder", path: selected.path });
}

/**
 * Opens the AI Assistant as a full-screen modal (better for mobile)
 */
export async function openAIAssistantModal() {
  await initIfNeeded();

  if (isPanelOpen) {
    return;
  }

  const { html, script } = await loadPanelAssets();
  await editor.showPanel("modal", 20, html, script);
  isPanelOpen = true;
  await clientStore.set(PANEL_STATE_KEY, true);
}

/**
 * Closes the AI Assistant panel (works for both side panel and modal)
 */
export async function closeAIAssistant() {
  await editor.hidePanel("rhs");
  await editor.hidePanel("modal");
  isPanelOpen = false;
  panelPush.close();
  await clientStore.set(PANEL_STATE_KEY, false);
}

/**
 * Toggles the AI Assistant panel
 */
export async function toggleAIAssistant() {
  if (isPanelOpen) {
    await closeAIAssistant();
  } else {
    await openAIAssistant();
  }
}

/**
 * Starts a panel chat session with tool support.
 * Called from the panel iframe.
 * This is called each time a new message is sent, not just the first one.
 */
export async function startPanelChat(
  messages: ChatMessage[],
  chatId: string = crypto.randomUUID(),
  options: { attachPage?: boolean } = {},
): Promise<{
  streamId?: string;
  error?: string;
}> {
  let streamId: string | undefined;
  if (panelStarting) return { error: "A chat is already starting." };
  panelStarting = true;
  try {
    if (
      [...streamBuffers.values()].some(
        (buffer) => buffer.status === "streaming",
      )
    )
      return {
        error:
          "A chat is already running. Stop it before starting another turn.",
      };
    const stored = await getPanelChatHistory();
    if (stored?.chatScope && stored.id !== chatId)
      return {
        error:
          "This chat has changed. Reopen the panel before sending a message.",
      };
    const chatScope = stored?.id === chatId ? stored.chatScope : undefined;
    const lastInput = messages.at(-1);
    if (stored?.id === chatId && lastInput)
      messages = [...stored.messages, lastInput];
    await initIfNeeded();

    if (!currentAIProvider) {
      return {
        error:
          "No text model configured. Please add a text model in your config.",
      };
    }

    await initChatAgent();
    const chatAgent = chatScope ? null : currentChatAgent;

    streamId = `stream_${crypto.randomUUID()}`;
    const controller = new AbortController();
    const permissions: PathPermissions = chatScope
      ? scopePermissions(chatScope)
      : {
          allowedReadPaths: chatAgent?.aiagent.allowedReadPaths,
          allowedWritePaths: chatAgent?.aiagent.allowedWritePaths,
          allowUnsafeLua:
            chatAgent?.aiagent.allowUnsafeLua ??
            aiSettings?.chat?.allowUnsafeLua,
        };

    const scope = JSON.stringify({
      agent: chatAgent?.ref,
      chatScope,
      read: permissions.allowedReadPaths,
      write: permissions.allowedWritePaths,
    });
    if (
      isRestricted(permissions) &&
      stored?.id === chatId &&
      stored.messages.length &&
      stored.scope !== scope
    ) {
      return {
        error:
          "Start a new chat before changing to a restricted agent or changing its path permissions. Earlier conversation contents may be outside the new scope.",
      };
    }
    // Only the active or most recent run needs live preview state.
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
    streamBuffers.clear();
    latestRunId = streamId;
    streamBuffers.set(streamId, {
      baseMessages: messages,
      status: "streaming",
      controller,
      chatId,
      checkpoint: { messages },
      steering: currentAIProvider.languageModel
        ? experimental_createSteering()
        : undefined,
      instructions: [],
    });

    let luaTools = toolsEnabled()
      ? await discoverAllTools()
      : new Map<string, LuaToolDefinition>();
    if (chatAgent) {
      luaTools = filterToolsForAgent(luaTools, chatAgent);
    }
    luaTools = filterCapabilities(luaTools, permissions);
    const tools = convertToOpenAITools(luaTools);
    log.debug(
      `Panel chat: discovered ${tools.length} tools${
        chatAgent
          ? ` (filtered for agent: ${chatAgent.aiagent.name || chatAgent.ref})`
          : ""
      }`,
    );

    let contextBlock = "";
    let pageImageSource: { page: string; content: string } | undefined;
    try {
      const pageContext = await currentPageContext(
        permissions.allowedReadPaths,
        options.attachPage === true,
      );
      contextBlock = pageContext.text;
      if (chatScope)
        contextBlock += `\nChat scope: ${chatScope.kind} ${JSON.stringify(chatScope.path)}. Use read_note and search_notes within this scope. The scope stays fixed when the user navigates to another note.`;
      pageImageSource = pageContext.attachment;
      contextBlock += `\nCurrent date and time: ${new Date().toISOString()}`;
      if (chatAgent)
        contextBlock += `\nActive agent: ${chatAgent.aiagent.name || chatAgent.ref}`;
    } catch (e) {
      log.debug("Could not get page context:", e);
    }

    if (aiSettings?.chat?.customContext && !isRestricted(permissions)) {
      try {
        const customResult = await lua.evalExpression(
          aiSettings.chat.customContext,
        );
        if (customResult) {
          contextBlock += `\n\n${customResult}`;
        }
      } catch (e) {
        log.error("Failed to evaluate customContext:", e);
      }
    }

    let systemContent: string;
    let agentAttachments: Attachment[] = [];
    if (chatAgent) {
      // Use agent prompt if we have one
      const agentResult = await buildAgentSystemPrompt(chatAgent);
      systemContent = agentResult.systemPrompt;
      agentAttachments = agentResult.attachments;
    } else {
      systemContent = chatSystemPrompt.content;
    }

    const systemMessage: ChatMessage = {
      role: "system",
      content: systemContent,
    };

    // Only the new user message is enriched. Earlier SDK parts are immutable history.
    const last = messages.at(-1);
    if (!last || last.role !== "user" || typeof last.content !== "string") {
      throw new Error("A chat turn must end with a user text message.");
    }
    const history = messages
      .slice(0, -1)
      .filter((message) => message.role !== "system");
    const { messagesWithAttachments } = isRestricted(permissions)
      ? {
          messagesWithAttachments: [
            { message: { ...last }, attachments: [] as Attachment[] },
          ],
        }
      : await enrichChatMessages([{ ...last }]);

    // Prepend page context after message enrichment
    if (contextBlock) {
      const lastUserIdx = messagesWithAttachments.findLastIndex(
        (m) => m.message.role === "user",
      );
      if (lastUserIdx !== -1) {
        const lastMessage = messagesWithAttachments[lastUserIdx].message;
        lastMessage.content = `<context>\n${contextBlock}\n</context>\n\n${lastMessage.content}`;

        if (pageImageSource) {
          const enabledKinds = enabledAttachmentKinds();
          const handlerExts = await getFileHandlerExts();
          if (enabledKinds.size > 0 || handlerExts.size > 0) {
            // Append page-embedded files to the last message
            const existing = messagesWithAttachments[lastUserIdx].attachments;
            const seen = new Set(
              existing
                .filter((a) => a.binary || a.type === "file")
                .map((a) => a.name),
            );
            const pageFiles = await extractFilesFromMarkdown(
              pageImageSource.content,
              pageImageSource.page,
              enabledKinds,
              handlerExts,
              seen,
              permissions.allowedReadPaths,
            );
            existing.push(...pageFiles);
          }
        }
      }
    }

    const workingMessages = assembleMessagesWithAttachments(
      systemMessage,
      messagesWithAttachments,
      agentAttachments,
    );

    const transientPrefixLength = 1 + agentAttachments.length;
    workingMessages.splice(transientPrefixLength, 0, ...history);
    const compaction =
      stored?.id === chatId && stored.scope === scope
        ? stored.compaction
        : undefined;
    await beginPanelTurn(
      chatId,
      streamId,
      messages,
      scope,
      compaction,
      chatScope,
    );
    const runningId = streamId;
    panelPush.changed();
    runToolLoop(
      runningId,
      workingMessages,
      tools,
      luaTools,
      transientPrefixLength,
      permissions,
      !chatAgent?.aiagent.toolsExclude?.includes("research_notes") &&
        (!chatAgent?.aiagent.tools?.length ||
          chatAgent.aiagent.tools.includes("research_notes")),
      compaction,
    )
      .catch(async (error: Error) => {
        const buffer = streamBuffers.get(runningId);
        if (buffer) {
          const terminalStatus = buffer.controller.signal.aborted
            ? "cancelled"
            : "error";
          buffer.error =
            terminalStatus === "cancelled"
              ? "Stopped. Completed work has been kept."
              : error.message;
          buffer.messages = interruptedMessages(buffer.checkpoint);
          await settlePanelInstructions(buffer, runningId);
          await savePanelCheckpoint(
            buffer.chatId,
            runningId,
            { messages: buffer.messages },
            terminalStatus,
            buffer.error,
          );
          buffer.status = terminalStatus;
          finishPanelRun(runningId);
        }
      })
      .catch((error) => {
        const buffer = streamBuffers.get(runningId);
        if (buffer) {
          buffer.status = "error";
          buffer.error = `Could not save recovery state: ${error instanceof Error ? error.message : String(error)}`;
          finishPanelRun(runningId);
        }
      });

    return { streamId };
  } catch (error) {
    if (streamId) streamBuffers.delete(streamId);
    log.error("Error starting panel chat:", error);
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    panelStarting = false;
  }
}

/**
 * Runs the tool loop: execute tool calls until we get a final response,
 * then stream that response to the buffer.
 */
async function runToolLoop(
  streamId: string,
  messages: ChatMessage[],
  tools: Tool[],
  luaTools: Map<string, LuaToolDefinition>,
  transientPrefixLength: number,
  permissions: PathPermissions,
  enableResearch: boolean,
  compaction?: import("./context.ts").CompactionState,
): Promise<void> {
  const buffer = streamBuffers.get(streamId);
  if (!buffer) return;

  const result = await runStreamingAgenticChat({
    messages,
    tools,
    luaTools,
    provider: currentAIProvider,
    runId: streamId,
    abortSignal: buffer.controller.signal,
    enableResearch,
    steering: buffer.steering,
    onProgress: (message) => {
      buffer.statusMessage = message;
      panelPush.changed();
    },
    compaction,
    onCompaction: (state) =>
      savePanelCompaction(buffer.chatId, streamId, state),
    onUsage: updateTokenUsage,
    onCheckpoint: async (checkpoint) => {
      if (buffer.status !== "streaming") return;
      buffer.checkpoint = {
        ...checkpoint,
        messages: checkpoint.messages.slice(transientPrefixLength),
      };
      await savePanelCheckpoint(buffer.chatId, streamId, buffer.checkpoint);
    },
    onPreview: (message) => {
      buffer.preview = message;
      panelPush.changed();
    },
    onPreviewLimited: () => {
      buffer.previewLimited = true;
      panelPush.changed();
    },
    onToolCall: (toolName, _args, result) => {
      const status = result.success ? "✓" : "✗";
      buffer.statusMessage = `${status} ${toolName}`;
      panelPush.changed();
    },
    permissions,
  });

  await settlePanelInstructions(buffer, streamId);
  buffer.messages = result.messages.slice(transientPrefixLength);
  buffer.checkpoint = { messages: buffer.messages };
  await savePanelCheckpoint(
    buffer.chatId,
    streamId,
    buffer.checkpoint,
    "complete",
  );
  buffer.status = "complete";
  finishPanelRun(streamId);
}

async function settlePanelInstructions(
  buffer: StreamBuffer,
  streamId: string,
): Promise<void> {
  for (const instruction of buffer.instructions) {
    if (instruction.status !== "queued") continue;
    instruction.status = "not-delivered";
    instruction.reason = "Run ended before delivery was confirmed";
    await savePanelInstruction(buffer.chatId, streamId, instruction);
  }
}

export async function steerPanelChat(
  streamId: string,
  chatId: string,
  text: string,
): Promise<{ id?: string; error?: string }> {
  const buffer = streamBuffers.get(streamId);
  if (
    !buffer ||
    buffer.chatId !== chatId ||
    buffer.status !== "streaming" ||
    buffer.controller.signal.aborted
  )
    return {
      error: "This run has ended. Send your instruction as a new turn.",
    };
  if (!buffer.steering)
    return { error: "This provider does not support active instructions." };
  if (typeof text !== "string" || !text.trim() || text.length > 4000)
    return { error: "Instructions must contain 1 to 4000 characters." };
  if (buffer.instructions.length >= 20)
    return {
      error: "This run has reached its limit of 20 active instructions.",
    };
  const instruction: RunInstruction = {
    id: crypto.randomUUID(),
    text: text.trim(),
    status: "queued",
  };
  buffer.instructions.push(instruction);
  try {
    if (!(await savePanelInstruction(chatId, streamId, instruction)))
      throw new Error("This conversation has ended.");
    if (buffer.status !== "streaming" || buffer.controller.signal.aborted) {
      instruction.status = "not-delivered";
      instruction.reason = "Run ended before the instruction could be queued";
      await savePanelInstruction(chatId, streamId, instruction);
      return { error: instruction.reason };
    }
    panelPush.changed();
    void buffer.steering
      .steer(instruction.text, { id: instruction.id })
      .then(async (outcome) => {
        instruction.status = outcome.type;
        if (outcome.type === "not-delivered")
          instruction.reason = outcome.reason;
        await savePanelInstruction(chatId, streamId, instruction);
        panelPush.changed();
      })
      .catch((error) => {
        buffer.statusMessage = `Could not save instruction delivery status: ${String(error)}`;
        buffer.controller.abort(error);
      });
    return { id: instruction.id };
  } catch (error) {
    instruction.status = "not-delivered";
    instruction.reason = String(error);
    return { error: `Could not queue instruction: ${String(error)}` };
  }
}

export async function cancelPanelChat(streamId: string): Promise<void> {
  streamBuffers
    .get(streamId)
    ?.controller.abort(new DOMException("Stopped by user", "AbortError"));
}

export async function getPanelChatHistory() {
  const stored = await loadPanelHistory(
    (id) => streamBuffers.get(id)?.status === "streaming",
  );
  const buffer = stored?.run ? streamBuffers.get(stored.run.id) : undefined;
  return buffer?.status === "streaming"
    ? { ...stored!, displayMessages: buffer.baseMessages }
    : stored;
}

export async function resetPanelChatHistory(id: string): Promise<void> {
  if (
    panelStarting ||
    [...streamBuffers.values()].some((buffer) => buffer.status === "streaming")
  )
    throw new Error("Stop the running chat before starting a new one.");
  await clearPanelHistory(id);
  clearTimeout(expiryTimer);
  expiryTimer = undefined;
  streamBuffers.clear();
  latestRunId = undefined;
  panelPush.changed();
}

/**
 * Exports the current panel chat to a markdown page.
 * If a page with the same chatId exists, updates it instead of creating new.
 * TODO: Allow user to specify folder to save these to
 */
export async function exportPanelChat(): Promise<void> {
  try {
    const stored = await clientStore.get(CHAT_HISTORY_KEY);

    if (!stored || !stored.messages || stored.messages.length === 0) {
      await editor.flashNotification("No chat history to export", "error");
      return;
    }

    const chatId = stored.id;
    const history = stored.messages as ChatMessage[];

    const existingPages = await index.queryLuaObjects<{ name: string }>(
      "page",
      {
        objectVariable: "_",
        where: await lua.parseExpression(
          `_.chatId == "${chatId}" and _.tags and table.includes(_.tags, "aichat")`,
        ),
      },
    );

    const timestamp = new Date().toISOString().split("T")[0];
    let pageName: string;

    if (existingPages.length > 0) {
      pageName = existingPages[0].name;
    } else {
      pageName = `AI Chat ${timestamp} ${Date.now()}`;
    }

    const agentRef = currentChatAgent?.ref || null;

    let content = `---
dateCreated: "${timestamp}"
dateUpdated: "${timestamp}"
chatId: "${chatId}"
tags: aichat${agentRef ? `\nagent: "${agentRef}"` : ""}
---

# AI Assistant Chat

`;

    for (const msg of history) {
      if (msg.role === "system") continue;
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .map((part) => {
                if (part.type === "text") return part.text;
                if (part.type === "reasoning")
                  return aiSettings?.chat?.showReasoning ? part.text : "";
                if (part.type === "tool-call")
                  return `Tool: ${part.toolName}\n${JSON.stringify(part.input, null, 2)}`;
                if (part.type === "tool-result")
                  return `Result: ${part.toolName}\n${part.output.type === "text" ? part.output.value : JSON.stringify(part.output)}`;
                if (part.type === "image") return "[Image attachment]";
                if (part.type === "file")
                  return `[File: ${part.filename || part.mediaType}]`;
                return "";
              })
              .filter(Boolean)
              .join("\n");
      if (!text) continue;
      const needsNewline = text.startsWith("```");
      content += `**${msg.role}**:${needsNewline ? "\n" : " "}${text}\n\n`;
    }

    await space.writePage(pageName, content);
    await editor.navigate(pageName);

    const action = existingPages.length > 0 ? "updated" : "exported to";
    await editor.flashNotification(`Chat ${action} "${pageName}"`);
  } catch (error) {
    log.error("Error exporting chat:", error);
    await editor.flashNotification("Failed to export chat", "error");
  }
}

/**
 * Resets the session token usage (e.g., when starting a new chat).
 */
export async function resetSessionTokenUsage(): Promise<void> {
  sessionTokenUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  tokenUsageLoaded = true;
  await saveTokenUsage();
}

/**
 * Saves the current token usage to clientStore.
 */
async function saveTokenUsage(): Promise<void> {
  try {
    await clientStore.set(TOKEN_USAGE_KEY, sessionTokenUsage);
  } catch (e) {
    log.error("Failed to save token usage:", e);
  }
}

/**
 * Updates session token usage from a response and persists it.
 */
async function updateTokenUsage(usage: Usage | undefined): Promise<void> {
  if (!usage) return;
  await loadPersistedTokenUsage();
  sessionTokenUsage.prompt_tokens += usage.prompt_tokens;
  sessionTokenUsage.completion_tokens += usage.completion_tokens;
  sessionTokenUsage.total_tokens += usage.total_tokens;
  await saveTokenUsage();
}

/**
 * Loads token usage from clientStore (called once on first getChatStatus call).
 */
async function loadPersistedTokenUsage(): Promise<void> {
  if (tokenUsageLoaded) return;
  try {
    const stored = (await clientStore.get(TOKEN_USAGE_KEY)) as Usage | null;
    if (stored) {
      sessionTokenUsage = stored;
    }
  } catch (e) {
    log.error("Failed to load token usage:", e);
  }
  tokenUsageLoaded = true;
}

/**
 * Gets the context window limit for a model.
 * First tries the provider's API (e.g., Ollama), then falls back to LiteLLM metadata.
 */
async function getContextLimit(
  modelName: string,
  providerHint?: string,
): Promise<number | null> {
  const providerLimit = await currentAIProvider?.getContextLimit(modelName);
  if (providerLimit) {
    return providerLimit;
  }
  return lookupModelContextLimit(modelName, providerHint);
}

export interface ChatStatus {
  reasoning: {
    enabled: boolean;
  };
  tokens: Usage;
  model: {
    name: string | null;
    contextLimit: number | null;
  };
}

/**
 * Returns consolidated chat panel status including reasoning, tokens and model information.
 */
export async function getChatStatus(): Promise<ChatStatus> {
  await initIfNeeded();
  await loadPersistedTokenUsage();

  const model = await getSelectedTextModel();
  let contextLimit: number | null = null;

  if (model?.modelName) {
    contextLimit = await getContextLimit(model.modelName, model.providerKey);
  }

  return {
    reasoning: { enabled: aiSettings?.chat?.showReasoning ?? false },
    tokens: { ...sessionTokenUsage },
    model: { name: model?.name ?? null, contextLimit },
  };
}

/**
 * Toggles a chat setting for the current session only.
 */
async function toggleChatSetting(
  settingKey: "showReasoning",
  enabledMessage: string,
  disabledMessage: string,
): Promise<void> {
  if (!aiSettings?.chat) {
    await editor.flashNotification("Settings not loaded", "error");
    return;
  }

  const newValue = !(aiSettings.chat[settingKey] ?? false);
  aiSettings.chat[settingKey] = newValue;
  setSessionToggle(settingKey);
  panelPush.changed();

  await editor.flashNotification(
    newValue ? enabledMessage : disabledMessage,
    "info",
  );
}

/**
 * Toggles the reasoning display setting for the current session
 */
export function toggleReasoningEnabled(): Promise<void> {
  return toggleChatSetting(
    "showReasoning",
    "Reasoning display enabled (session only)",
    "Reasoning display disabled (session only)",
  );
}

/**
 * Re-opens the chat panel if it was o pen before
 */
export async function restorePanelState(): Promise<void> {
  try {
    const wasOpen = await clientStore.get(PANEL_STATE_KEY);
    if (wasOpen) {
      await openAIAssistant();
    }
  } catch (e) {
    log.error("Failed to restore panel state:", e);
  }
}
