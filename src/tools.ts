import { getModelContextLimit } from "./model-metadata.ts";
import { estimateTokenCount } from "tokenx";
import { consumeAgentStream } from "./ui-stream.ts";
import { computeApprovalDiff, type DiffLine } from "./diff.ts";
import { hashSHA256 } from "@silverbulletmd/silverbullet/lib/crypto";
import {
  ToolLoopAgent,
  asSchema,
  isStepCount,
  type ModelMessage,
  type ToolSet,
  type UserModelMessage,
  type Experimental_Steering,
} from "ai";
import type { ProviderInterface } from "./interfaces/Provider.ts";
import { toSDKTools, toUsage } from "./providers/messages.ts";
import {
  asset,
  clientStore,
  editor,
  lua,
  space,
} from "@silverbulletmd/silverbullet/syscalls";
import { attachmentMessage, isPathAllowed, log } from "./utils.ts";
import { getFileHandlerExts, resolveFileToAttachment } from "./files.ts";
import type {
  ChatMessage,
  JsonSchemaObject,
  LuaToolDefinition,
  PathPermissions,
  ToolExecutionContext,
  Tool,
  Usage,
} from "./types.ts";
import {
  aiSettings,
  currentModel,
  initIfNeeded,
  supportedAttachmentKinds,
} from "./init.ts";
import { discoverMCPTools, executeMCPTool } from "./mcp/index.ts";
import { createContextManager, boundedToolOutput } from "./context.ts";
import { researchTool } from "./research.ts";
import { buildReadNoteTool, buildWriteNoteTool } from "./note-tools.ts";
import { canUseTool, filterCapabilities } from "./capabilities.ts";
import {
  registerRun,
  signalForRun,
  type RunCheckpoint,
  type PendingTool,
} from "./execution.ts";
import { buildSearchNotesTool } from "./search.ts";
import { buildSkillTool, discoverSkills, SKILL_TOOL_NAME } from "./skills.ts";

function validatePathPermission(
  tool: LuaToolDefinition,
  args: Record<string, unknown>,
  permissions: PathPermissions | undefined,
): { allowed: true } | { allowed: false; error: string } {
  if (!permissions) return { allowed: true };

  const readParams = tool.readPathParam ? [tool.readPathParam].flat() : [];
  const writeParams = tool.writePathParam ? [tool.writePathParam].flat() : [];

  for (const paramName of readParams) {
    const page = args[paramName];
    if (
      typeof page === "string" &&
      !isPathAllowed(page, permissions.allowedReadPaths)
    ) {
      return { allowed: false, error: `Read access denied for "${page}"` };
    }
  }

  for (const paramName of writeParams) {
    const page = args[paramName];
    if (typeof page === "string") {
      // Write operations also require read access (to get current content for diffs, etc.)
      if (!isPathAllowed(page, permissions.allowedReadPaths)) {
        return { allowed: false, error: `Read access denied for "${page}"` };
      }
      if (!isPathAllowed(page, permissions.allowedWritePaths)) {
        return { allowed: false, error: `Write access denied for "${page}"` };
      }
    }
  }

  return { allowed: true };
}

const MAX_TOOL_ITERATIONS = 10;

type ApprovalResult = {
  approved: boolean;
  feedback?: string | null;
};

type PendingApproval = {
  signal?: AbortSignal;
  cleanup?: () => void;
  submitting?: boolean;
  resolve: (result: ApprovalResult) => void;
  toolName: string;
  args: Record<string, unknown>;
};

const pendingApprovals = new Map<string, PendingApproval>();

type PendingWrite = {
  signal?: AbortSignal;
  cleanup?: () => void;
  submitting?: boolean;
  resolve: (result: ApprovalResult) => void;
  page: string;
  newContent: string;
  currentContent: string | null;
  diff: DiffLine[];
};

const pendingWrites = new Map<string, PendingWrite>();

export type ToolExecutionResult = {
  success: boolean;
  result?: string;
  summary?: string;
  error?: string;
  // Paths the tool asks to attach to the conversation (e.g. view_file). Resolved
  // into carrier messages that the model sees on its next turn.
  attachPaths?: string[];
};

const TOOL_RESULT_CACHE_PREFIX = "ai.toolResults.";

export async function cacheToolResult(
  id: string,
  result: string,
): Promise<void> {
  await clientStore.set(`${TOOL_RESULT_CACHE_PREFIX}${id}`, result);
}

export async function getCachedToolResult(id: string): Promise<string | null> {
  return await clientStore.get(`${TOOL_RESULT_CACHE_PREFIX}${id}`);
}

export function generateDefaultSummary(
  toolName: string,
  args: Record<string, unknown>,
  result: string,
): string {
  const bytes = new TextEncoder().encode(result).length;
  const lines = result.split("\n").length;
  const preview = result.slice(0, 100).replace(/\n/g, " ").trim();
  const argsStr = Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  return `${toolName}(${argsStr}) returned ${bytes} bytes, ${lines} lines. Preview: ${preview}${
    result.length > 100 ? "..." : ""
  }`;
}

function toLuaStringLiteral(value: string): string {
  // Lua string in double quotes with basic escapes
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * Discovers tools defined in Space Lua under the `ai.tools` table.
 * Each tool should have: description, parameters, handler
 *
 * Note: We can't fetch the full ai.tools table because Lua functions
 * can't be serialized. Instead, we get tool names and fetch metadata
 * for each tool individually.
 */
export async function discoverTools(): Promise<Map<string, LuaToolDefinition>> {
  const tools = new Map<string, LuaToolDefinition>();

  try {
    const toolsExist = await lua.evalExpression(
      "ai ~= nil and ai.tools ~= nil",
    );

    if (!toolsExist) {
      log.debug("ai.tools not defined - Space Lua AI Tools may not be loaded");
      return tools;
    }

    // Get tool names (keys only, no functions) using IIFE
    const toolNames = (await lua.evalExpression(`(function()
      local names = {}
      for k, _ in pairs(ai.tools) do
        table.insert(names, k)
      end
      return names
    end)()`)) as string[];

    if (!toolNames || !Array.isArray(toolNames) || toolNames.length === 0) {
      log.debug("No tools found in ai.tools");
      return tools;
    }

    log.debug(`Found ${toolNames.length} tool names:`, toolNames);

    // Fetch metadata for each tool (without the handler function)
    for (const name of toolNames) {
      try {
        const nameLiteral = toLuaStringLiteral(name);
        const metadata = (await lua.evalExpression(`(function()
          local tool = ai.tools[${nameLiteral}]
          if tool then
            return {
              description = tool.description,
              parameters = tool.parameters,
              requiresApproval = tool.requiresApproval or false,
              readOnly = tool.readOnly or false,
              unsafeLua = tool.unsafeLua or false,
              readPathParam = tool.readPathParam,
              writePathParam = tool.writePathParam
            }
          end
          return nil
        end)()`)) as {
          description: string;
          parameters: LuaToolDefinition["parameters"];
          requiresApproval?: boolean;
          readOnly?: boolean;
          unsafeLua?: boolean;
          readPathParam?: string;
          writePathParam?: string;
        } | null;

        if (metadata && metadata.description && metadata.parameters) {
          tools.set(name, {
            description: metadata.description,
            parameters: metadata.parameters,
            handler: name,
            requiresApproval: metadata.requiresApproval === true,
            readOnly: metadata.readOnly === true,
            unsafeLua: metadata.unsafeLua === true,
            readPathParam: metadata.readPathParam,
            writePathParam: metadata.writePathParam,
          });
          log.debug(`Discovered tool: ${name}`);
        } else {
          log.warn(`Invalid metadata for tool "${name}":`, metadata);
        }
      } catch (e) {
        log.error(`Error fetching metadata for tool "${name}":`, e);
      }
    }

    log.debug(`Discovered ${tools.size} tools from Space Lua`);
  } catch (e) {
    log.error("Error discovering tools:", e);
  }

  return tools;
}

/**
 * Discovers all tools available to the chat: Space Lua tools (`ai.tools`) merged
 * with tools from configured MCP servers. MCP tools are namespaced
 * (`mcp__<server>__<tool>`) so they never collide with Lua tools.
 */
export async function discoverAllTools(): Promise<
  Map<string, LuaToolDefinition>
> {
  const [tools, mcpTools, skills] = await Promise.all([
    discoverTools(),
    discoverMCPTools(aiSettings?.mcpServers),
    discoverSkills(),
  ]);
  tools.set("search_notes", buildSearchNotesTool());
  tools.set("read_note", buildReadNoteTool());
  tools.set("create_note", buildWriteNoteTool(true, requestWriteApproval));
  tools.set("edit_note", buildWriteNoteTool(false, requestWriteApproval));
  for (const [name, def] of mcpTools) {
    tools.set(name, def);
  }
  if (skills.length > 0) {
    tools.set(SKILL_TOOL_NAME, buildSkillTool(skills));
  }
  return tools;
}

/**
 * Lua-callable: run a single tool using the configured approval policy.
 *
 * @example From Space Lua:
 * ```lua
 * local r = system.invokeFunction("silverbullet-ai.callTool",
 *   "mcp__my_server__add", {a = 2, b = 3})
 * print(r.success, r.result)
 * ```
 */
export async function callTool(
  toolName: string,
  args?: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  await initIfNeeded();
  const luaTools = await discoverAllTools();
  if (
    toolRequiresApproval(
      luaTools.get(toolName),
      aiSettings?.chat?.skipToolApproval,
    )
  ) {
    const approval = await requestToolApproval(toolName, args ?? {});
    if (!approval.approved)
      return {
        success: false,
        error: approval.feedback || "Tool rejected by user",
      };
  }
  return await executeTool(toolName, args ?? {}, luaTools, {
    allowUnsafeLua: aiSettings?.chat?.allowUnsafeLua,
  });
}

/**
 * Lua-callable: list all discovered tools (Space Lua `ai.tools` + MCP servers) so
 * scripts can introspect what is available before calling `callTool`. The
 * `requiresApproval` flag reflects what the chat flow would prompt for; `callTool`
 * itself never prompts.
 *
 * @example From Space Lua:
 * ```lua
 * for _, t in ipairs(system.invokeFunction("silverbullet-ai.listTools")) do
 *   print(t.name, t.source)
 * end
 * ```
 */
export async function listTools(): Promise<
  Array<{
    name: string;
    description: string;
    parameters: JsonSchemaObject;
    source: NonNullable<LuaToolDefinition["source"]>;
    mcpServer?: string;
    requiresApproval: boolean;
    readOnly: boolean;
  }>
> {
  await initIfNeeded();
  const luaTools = await discoverAllTools();
  return Array.from(luaTools.entries()).map(([name, def]) => ({
    name,
    description: def.description,
    parameters: def.parameters,
    source: def.source ?? "lua",
    mcpServer: def.mcpServer,
    requiresApproval: toolRequiresApproval(
      def,
      aiSettings?.chat?.skipToolApproval,
    ),
    readOnly: def.readOnly === true,
  }));
}

/**
 * Converts Space Lua tool definitions to OpenAI tool format
 */
export function convertToOpenAITools(
  luaTools: Map<string, LuaToolDefinition>,
): Tool[] {
  const tools: Tool[] = [];

  for (const [name, def] of luaTools) {
    tools.push({
      type: "function",
      function: {
        name,
        description: def.description,
        parameters: {
          // Preserve the full JSON Schema (e.g. $defs/$ref/additionalProperties from MCP servers)
          ...def.parameters,
          type:
            typeof def.parameters.type === "string"
              ? def.parameters.type
              : "object",
          properties: def.parameters.properties || {},
          required: def.parameters.required || [],
        },
      },
    });
  }

  return tools;
}

/**
 * Converts a JavaScript value to Lua literal syntax
 */
function toLuaLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return "nil";
  }
  if (typeof value === "string") {
    return toLuaStringLiteral(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "nil";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => toLuaLiteral(v)).join(", ");
    return `{${items}}`;
  }
  if (typeof value === "object") {
    const pairs = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `[${toLuaStringLiteral(k)}]=${toLuaLiteral(v)}`)
      .join(", ");
    return `{${pairs}}`;
  }
  return "nil";
}

/**
 * Executes a tool by calling its Lua handler function
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  luaTools: Map<string, LuaToolDefinition>,
  permissions?: PathPermissions,
  context?: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  context?.abortSignal?.throwIfAborted();
  const tool = luaTools.get(toolName);

  if (!tool) {
    return {
      success: false,
      error: `Unknown tool: ${toolName}`,
    };
  }

  if (!canUseTool(toolName, tool, permissions))
    return { success: false, error: "Tool capability denied for this agent" };
  const permCheck = validatePathPermission(tool, args, permissions);
  if (!permCheck.allowed) {
    return { success: false, error: permCheck.error };
  }

  // MCP-sourced tools execute over HTTP instead of through a Lua handler.
  if (tool.source === "mcp") {
    return await executeMCPTool(
      tool,
      args,
      aiSettings?.mcpServers,
      context?.abortSignal,
    );
  }
  if (tool.execute) {
    return await tool.execute(args, permissions, context);
  }

  try {
    const luaArgs = toLuaLiteral(args);
    const toolNameLiteral = toLuaStringLiteral(toolName);
    const result = await lua.evalExpression(
      `ai.tools[${toolNameLiteral}].handler(${luaArgs}, ${toLuaLiteral({ runId: context?.runId })})`,
    );

    if (
      typeof result === "object" &&
      result !== null &&
      "result" in result &&
      "summary" in result
    ) {
      const resultStr =
        typeof result.result === "string"
          ? result.result
          : JSON.stringify(result.result, null, 2);
      return {
        success: true,
        result: resultStr,
        summary: String(result.summary),
        attachPaths: parseAttachPaths(result.attachPaths),
      };
    }

    // Plain return - backward compatible
    const resultStr =
      typeof result === "string" ? result : JSON.stringify(result, null, 2);

    return {
      success: true,
      result: resultStr,
    };
  } catch (e) {
    log.error(`Error executing tool "${toolName}":`, e);
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function bindApprovalAbort(
  id: string,
  pending: PendingApproval | PendingWrite,
  map: Map<string, any>,
): void {
  const signal = pending.signal;
  if (!signal) return;
  const cancel = () => {
    if (pending.submitting) return;
    map.delete(id);
    pending.cleanup?.();
    pending.resolve({ approved: false, feedback: "Execution cancelled" });
    void editor.hidePanel("modal").catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  pending.cleanup = () => signal.removeEventListener("abort", cancel);
  if (signal.aborted) cancel();
}

/**
 * Requests user approval before executing a tool using a custom modal.
 * Note: For tools that write pages, use ai.writePage() in Lua which shows a diff preview.
 */
function requestToolApproval(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ApprovalResult> {
  signal?.throwIfAborted();
  if (pendingApprovals.size || pendingWrites.size) {
    return Promise.resolve({
      approved: false,
      feedback: "Another approval is pending. Retry after it is resolved.",
    });
  }
  const approvalId = `approval_${Date.now()}_${crypto.randomUUID()}`;

  return new Promise((resolve, reject) => {
    const pending: PendingApproval = { resolve, toolName, args, signal };
    pendingApprovals.set(approvalId, pending);
    bindApprovalAbort(approvalId, pending, pendingApprovals);

    (async () => {
      try {
        const html = await asset.readAsset(
          "silverbullet-ai",
          "assets/tool-approval-modal.html",
        );
        const script = await asset.readAsset(
          "silverbullet-ai",
          "assets/tool-approval-modal.js",
        );

        const initScript = `
        globalThis.toolApprovalData = ${JSON.stringify({ approvalId, toolName, args, hasDiffSupport: false })};
        ${script}
      `;

        signal?.throwIfAborted();
        await editor.showPanel("modal", 20, html, initScript);
        if (signal?.aborted) await editor.hidePanel("modal");
      } catch (e) {
        log.error("Error showing tool approval modal:", e);
        pendingApprovals.delete(approvalId);
        pending.cleanup?.();
        reject(e);
      }
    })();
  });
}

/**
 * Unified approval submission handler for both tool and write approvals.
 * Called from the modal JS when user approves or rejects.
 */
export async function submitApproval(
  type: "tool" | "write",
  id: string,
  approved: boolean,
  feedback?: string | null,
): Promise<void> {
  const pending =
    type === "tool" ? pendingApprovals.get(id) : pendingWrites.get(id);
  if (!pending || pending.submitting) return;
  pending.submitting = true;
  try {
    pending.signal?.throwIfAborted();
    await editor.hidePanel("modal");
    if (type === "write" && approved) {
      const write = pending as PendingWrite;
      const current = await readWriteSnapshot(write.page);
      if (current !== write.currentContent) {
        pending.resolve({
          approved: false,
          feedback:
            "Page changed since the preview. Read it again and propose a new edit.",
        });
        return;
      }
      pending.signal?.throwIfAborted();
      await space.writePage(write.page, write.newContent);
    }
    pending.resolve({ approved, feedback });
  } catch (error) {
    pending.resolve({
      approved: false,
      feedback: `Approval failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    pending.cleanup?.();
    if (type === "tool") pendingApprovals.delete(id);
    else pendingWrites.delete(id);
  }
}

// A failed read must never be interpreted as permission to create a page.
async function readWriteSnapshot(page: string): Promise<string | null> {
  return (await space.pageExists(page)) ? await space.readPage(page) : null;
}

/**
 * Called from Lua's ai.writePage() to request approval before writing.
 * Shows a modal with the actual diff of what will be written.
 */
export async function requestWriteApproval(
  page: string,
  newContent: string,
  runId?: string,
  expected?: string | null,
  abortSignal?: AbortSignal,
): Promise<{ success: boolean; error?: string }> {
  const signal = signalForRun(runId) ?? abortSignal;
  signal?.throwIfAborted();
  const currentContent = await readWriteSnapshot(page);
  if (expected !== undefined && currentContent !== expected)
    return {
      success: false,
      error: "Note changed before approval. Read it again.",
    };
  signal?.throwIfAborted();
  if (aiSettings?.chat?.skipToolApproval) {
    await space.writePage(page, newContent);
    return { success: true };
  }

  const writeId = `write_${Date.now()}_${crypto.randomUUID()}`;

  // Read current content and compute diff
  const isNewPage = currentContent === null;
  const diff = computeApprovalDiff(currentContent ?? "", newContent);

  if (pendingApprovals.size || pendingWrites.size) {
    return {
      success: false,
      error: "Another approval is pending. Retry after it is resolved.",
    };
  }
  return new Promise((resolve, reject) => {
    const pending: PendingWrite = {
      signal,
      resolve: (result) => {
        if (result.approved) {
          resolve({ success: true });
        } else {
          resolve({
            success: false,
            error: result.feedback
              ? `Write rejected: ${result.feedback}`
              : "Write rejected by user",
          });
        }
      },
      page,
      newContent,
      currentContent,
      diff,
    };
    pendingWrites.set(writeId, pending);
    bindApprovalAbort(writeId, pending, pendingWrites);

    (async () => {
      try {
        const html = await asset.readAsset(
          "silverbullet-ai",
          "assets/tool-approval-modal.html",
        );
        const script = await asset.readAsset(
          "silverbullet-ai",
          "assets/tool-approval-modal.js",
        );

        const initScript = `
        globalThis.toolApprovalData = ${JSON.stringify({
          approvalId: writeId,
          toolName: isNewPage ? `Create: ${page}` : `Write: ${page}`,
          args: { page, contentLength: newContent.length },
          hasDiffSupport: true,
          isWriteApproval: true,
        })};
        ${script}
      `;

        signal?.throwIfAborted();
        await editor.showPanel("modal", 20, html, initScript);
        if (signal?.aborted) await editor.hidePanel("modal");
      } catch (e) {
        log.error("Error showing write approval modal:", e);
        pendingWrites.delete(writeId);
        pending.cleanup?.();
        reject(e);
      }
    })();
  });
}

/**
 * Called from modal JS to get diff data for a write operation.
 */
export function getWriteDiff(writeId: string): {
  diff?: DiffLine[];
  error?: string;
} {
  const pending = pendingWrites.get(writeId);
  if (!pending) {
    return { error: "Write approval not found" };
  }
  return { diff: pending.diff };
}

/**
 * Formats a tool call for display as a fenced code block.
 * Uses ```tool-call syntax which triggers the code widget for rendering.
 * Stores summary (not full result) to keep markdown compact.
 */
function formatToolCallDisplay(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  success: boolean,
  summary: string,
): string {
  const data = { id: toolCallId, name: toolName, args, summary, success };
  const json = JSON.stringify(data);
  return `\`\`\`toolcall\n${json}\n\`\`\`\n`;
}

function parseToolCallArguments(
  json: string,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(json);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {
        ok: false,
        error: "Tool arguments must be a JSON object",
      };
    }
    return { ok: true, args: parsed as Record<string, unknown> };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Decides whether a tool call must be approved by the user before running.
 * Lua tools opt in via `requiresApproval`; MCP tools require approval unless their
 * server is marked `trusted`. A global `skipToolApproval` setting overrides both.
 */
export function toolRequiresApproval(
  toolDef: LuaToolDefinition | undefined,
  skipToolApproval: boolean | undefined,
): boolean {
  if (skipToolApproval) return false;
  if (toolDef?.requiresApproval) return true;
  if (toolDef?.source === "mcp" && toolDef?.trusted !== true) return true;
  return false;
}

/**
 * Processes tool calls: executes them, formats display text, and builds result messages
 */
// Normalizes a tool's `attachPaths` return (a Lua array deserializes to an array
// or an object) into a string[].
function parseAttachPaths(raw: unknown): string[] | undefined {
  if (!raw) return undefined;
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === "object"
      ? Object.values(raw as Record<string, unknown>)
      : [];
  const paths = arr.filter((p): p is string => typeof p === "string");
  return paths.length ? paths : undefined;
}

// Resolves attach-paths into carrier messages (image/pdf parts or handler text)
// the model sees next turn. Confined to the agent's allowedReadPaths.
async function buildAttachmentCarriers(
  paths: string[],
  permissions?: PathPermissions,
): Promise<ChatMessage[]> {
  if (paths.length === 0) return [];
  const kinds = supportedAttachmentKinds();
  const handlerExts = await getFileHandlerExts();
  const seen = new Set<string>();
  const messages: ChatMessage[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const attachment = await resolveFileToAttachment(
      path,
      kinds,
      handlerExts,
      permissions?.allowedReadPaths,
    );
    if (attachment) messages.push(attachmentMessage(attachment));
  }
  return messages;
}

async function processToolCalls(
  toolCalls: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>,
  luaTools: Map<string, LuaToolDefinition>,
  onToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
    result: ToolExecutionResult,
  ) => void,
  permissions?: PathPermissions,
  context?: ToolExecutionContext,
): Promise<{
  toolCallsText: string;
  toolMessages: ChatMessage[];
  attachmentMessages: ChatMessage[];
  writeOutcomeUncertain: boolean;
}> {
  let toolCallsText = "";
  const toolMessages: ChatMessage[] = [];
  const attachPaths: string[] = [];
  let writeOutcomeUncertain = false;
  const emitToolCall = onToolCall ?? (() => {});

  for (const toolCall of toolCalls) {
    const toolName = toolCall.function.name;
    const parsedArgs = parseToolCallArguments(toolCall.function.arguments);
    const args = parsedArgs.ok ? parsedArgs.args : {};
    log.debug(`Executing tool: ${toolName}`, args);

    if (!parsedArgs.ok) {
      const parseErrorResult: ToolExecutionResult = {
        success: false,
        error: `Invalid tool arguments: ${parsedArgs.error}`,
      };
      const errorContent = `Error: ${parseErrorResult.error}`;
      toolCallsText += formatToolCallDisplay(
        toolCall.id,
        toolName,
        args,
        false,
        errorContent,
      );
      emitToolCall(toolName, args, parseErrorResult);
      toolMessages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: toolCall.id,
            toolName,
            output: { type: "text", value: `Error: ${parseErrorResult.error}` },
          },
        ],
      });
      continue;
    }

    const toolDef = luaTools.get(toolName);
    if (toolRequiresApproval(toolDef, aiSettings?.chat?.skipToolApproval)) {
      const approvalResult = await requestToolApproval(
        toolName,
        args,
        context?.abortSignal,
      );
      if (!approvalResult.approved) {
        const feedbackMsg = approvalResult.feedback
          ? `User feedback: ${approvalResult.feedback}`
          : "Please ask what to do differently.";
        const rejectedContent = `Tool execution was rejected by user. ${feedbackMsg}`;
        const rejectedResult: ToolExecutionResult = {
          success: false,
          result: rejectedContent,
        };
        toolCallsText += formatToolCallDisplay(
          toolCall.id,
          toolName,
          args,
          false,
          rejectedContent,
        );
        emitToolCall(toolName, args, rejectedResult);
        toolMessages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: toolCall.id,
              toolName,
              output: { type: "text", value: rejectedContent },
            },
          ],
        });
        continue;
      }
    }

    const result = await executeTool(
      toolName,
      args,
      luaTools,
      permissions,
      context,
    );
    if (!result.success && !toolDef?.readOnly) writeOutcomeUncertain = true;
    const fullResult = result.success
      ? result.result || ""
      : `Error: ${result.error}${!toolDef?.readOnly ? " The operation may have had effects. Verify the current state before repeating any write or external action." : ""}`;

    // Cache full result for later retrieval
    if (result.success && fullResult) {
      await cacheToolResult(toolCall.id, fullResult);
    }

    // Use tool-provided summary or generate default
    const summary = result.success
      ? (result.summary ?? generateDefaultSummary(toolName, args, fullResult))
      : `Error: ${result.error}`;

    // Ensure result object has the summary for callbacks
    result.summary = summary;

    // Display uses summary (stored in markdown)
    toolCallsText += formatToolCallDisplay(
      toolCall.id,
      toolName,
      args,
      result.success,
      summary,
    );

    emitToolCall(toolName, args, result);

    // LLM message uses full result
    toolMessages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: toolCall.id,
          toolName,
          output: { type: "text", value: fullResult },
        },
      ],
    });

    if (result.attachPaths) attachPaths.push(...result.attachPaths);
  }

  const attachmentMessages = await buildAttachmentCarriers(
    attachPaths,
    permissions,
  );
  return {
    toolCallsText,
    toolMessages,
    attachmentMessages,
    writeOutcomeUncertain,
  };
}

export type AgenticChatOptions = {
  messages: ChatMessage[];
  tools: Tool[];
  luaTools: Map<string, LuaToolDefinition>;
  provider: ProviderInterface;
  onToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
    result: ToolExecutionResult,
  ) => void;
  maxIterations?: number;
  permissions?: PathPermissions;
  abortSignal?: AbortSignal;
  runId?: string;
  onCheckpoint?: (checkpoint: RunCheckpoint) => Promise<void>;
  enableResearch?: boolean;
  steering?: Experimental_Steering;
  onProgress?: (message: string) => void;
  compaction?: import("./context.ts").CompactionState;
  onCompaction?: (
    state: import("./context.ts").CompactionState,
  ) => Promise<void>;
  onUsage?: (usage: Usage) => Promise<void>;
};

export type AgenticChatResult = {
  messages: ChatMessage[];
  finalResponse: string;
  finalReasoning?: string;
  toolCallsText: string;
  usage?: Usage;
};

export type StreamingAgenticChatOptions = AgenticChatOptions & {
  onChunk?: (chunk: string) => void;
  onReasoningChunk?: (chunk: string) => void;
  onPreview?: (message: import("ai").UIMessage) => void;
  onPreviewLimited?: () => void;
};

export function runAgenticChat(
  options: AgenticChatOptions,
): Promise<AgenticChatResult> {
  return runSDKChat(options, false);
}

export function runStreamingAgenticChat(
  options: StreamingAgenticChatOptions,
): Promise<AgenticChatResult> {
  return runSDKChat(options, true);
}

async function runSDKChat(
  options: StreamingAgenticChatOptions,
  streaming: boolean,
): Promise<AgenticChatResult> {
  const {
    provider,
    messages,
    luaTools,
    permissions = { allowUnsafeLua: aiSettings?.chat?.allowUnsafeLua },
    onToolCall,
    maxIterations = MAX_TOOL_ITERATIONS,
  } = options;
  options.abortSignal?.throwIfAborted();
  if (!provider.languageModel) {
    // The local mock provider is used by SilverBullet's development fixtures.
    const response = streaming
      ? await provider.streamChat({ ...options, onComplete: undefined })
      : await provider.chat(messages);
    if (response.usage) await options.onUsage?.(response.usage);
    return {
      messages: [
        ...messages,
        { role: "assistant", content: response.content ?? "" },
      ],
      finalResponse: response.content ?? "",
      finalReasoning: response.reasoning,
      toolCallsText: "",
      usage: response.usage,
    };
  }
  let toolCallsText = "";
  let pendingAttachments: ChatMessage[] = [];
  const responseMessages: ModelMessage[] = [];
  const permitted = filterCapabilities(luaTools, permissions);
  const sdkTools = toSDKTools(
    options.tools.filter((tool) => permitted.has(tool.function.name)),
  );
  const runId = options.runId ?? crypto.randomUUID();
  const timeout = aiSettings?.chat?.runTimeoutMs;
  const tokenLimit = aiSettings?.chat?.runMaxTokens;
  for (const [name, value] of [
    ["runTimeoutMs", timeout],
    ["runMaxTokens", tokenLimit],
  ] as const)
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    )
      throw new Error(
        `chat.${name} must be a positive integer no greater than 2147483647`,
      );
  const signals = [
    options.abortSignal,
    timeout ? AbortSignal.timeout(timeout) : undefined,
  ].filter((s): s is AbortSignal => !!s);
  const signal = signals.length
    ? AbortSignal.any(signals)
    : new AbortController().signal;
  const interimMessages: ModelMessage[] = [];
  let inFlight: PendingTool | undefined;
  let checkpointFailure: Error | undefined;
  let researchFailure: unknown;
  const checkpoint = async () => {
    if (checkpointFailure) throw checkpointFailure;
    try {
      await options.onCheckpoint?.({
        messages: [...messages, ...responseMessages, ...interimMessages],
        inFlight,
      });
    } catch (cause) {
      checkpointFailure = new Error(
        "Could not persist the tool checkpoint. Execution stopped before any further actions.",
        { cause },
      );
      throw checkpointFailure;
    }
  };
  const usageTotal: Usage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  const accountUsage = async (usage: import("ai").LanguageModelUsage) => {
    const delta = toUsage(usage);
    usageTotal.prompt_tokens += delta.prompt_tokens;
    usageTotal.completion_tokens += delta.completion_tokens;
    usageTotal.total_tokens += delta.total_tokens;
    await options.onUsage?.(delta);
  };
  const checkBudget = () => {
    signal.throwIfAborted();
    if (tokenLimit && usageTotal.total_tokens >= tokenLimit)
      throw new Error(
        "Run token budget reached. Completed work has been saved.",
      );
  };
  const contextWindow =
    aiSettings?.chat?.contextWindowTokens ??
    (provider.name
      ? await getModelContextLimit(provider.modelName, provider.name)
      : null) ??
    64000;
  let executedTools = false;
  let stopAfterToolError = false;
  if (
    options.enableResearch !== false &&
    permitted.has("search_notes") &&
    permitted.has("read_note")
  ) {
    sdkTools.research_notes = researchTool({
      model: provider.languageModel,
      providerOptions: provider.providerOptions,
      permissions,
      maxSteps: aiSettings?.chat?.researchMaxSteps,
      contextWindow,
      onUsage: accountUsage,
      beforeRequest: () => {
        checkBudget();
        if (checkpointFailure) throw checkpointFailure;
        if (researchFailure) throw researchFailure;
      },
      onCheckpoint: async (records) => {
        if (!inFlight) throw new Error("Research has no active parent tool");
        inFlight = { ...inFlight, research: { messages: records } };
        await checkpoint();
      },
      onProgress: (name, input) =>
        options.onProgress?.(`Research: ${name} ${JSON.stringify(input)}`),
    });
  }
  const prepareContext = createContextManager({
    model: provider.languageModel,
    providerOptions: provider.providerOptions,
    abortSignal: signal,
    maxChars: aiSettings?.chat?.contextMaxChars,
    contextWindow,
    toolTokens: estimateTokenCount(
      JSON.stringify(
        await Promise.all(
          Object.entries(sdkTools).map(async ([name, tool]) => ({
            name,
            description: tool.description,
            schema: await asSchema(tool.inputSchema).jsonSchema,
          })),
        ),
      ),
    ),
    onUsage: accountUsage,
    beforeRequest: checkBudget,
    state: options.compaction,
    cacheKey: await hashSHA256(
      JSON.stringify([
        typeof provider.languageModel === "string"
          ? provider.languageModel
          : [provider.languageModel.provider, provider.languageModel.modelId],
        provider.providerOptions,
        permissions,
        messages.filter((m) => m.role === "system"),
      ]),
    ),
    onCompaction: options.onCompaction,
  });
  for (const [name, definition] of Object.entries(sdkTools)) {
    const researchExecute =
      name === "research_notes" ? definition.execute : undefined;
    definition.toModelOutput = ({ output }: { output: unknown }) => ({
      type: "text" as const,
      value: boundedToolOutput(
        String(output),
        aiSettings?.chat?.toolResultMaxChars ?? 12000,
      ),
    });
    definition.execute = async (input, executionOptions) => {
      const { toolCallId, abortSignal } = executionOptions;
      signal.throwIfAborted();
      if (checkpointFailure) throw checkpointFailure;
      if (researchFailure) throw researchFailure;
      if (stopAfterToolError)
        throw new Error(
          "A previous write failed. Verify its outcome before further actions.",
        );
      inFlight = {
        toolCallId,
        toolName: name,
        input,
        ...(researchExecute ? { research: { messages: [] } } : {}),
      };
      await checkpoint();
      executedTools = true;
      let value: string;
      if (researchExecute) {
        try {
          value = String(await researchExecute(input, executionOptions));
        } catch (error) {
          researchFailure = error;
          throw error;
        }
        onToolCall?.(name, input as Record<string, unknown>, {
          success: true,
          result: value,
        });
      } else {
        const processed = await processToolCalls(
          [
            {
              id: toolCallId,
              function: { name, arguments: JSON.stringify(input) },
            },
          ],
          luaTools,
          onToolCall,
          permissions,
          { abortSignal: abortSignal ?? signal, runId },
        );
        stopAfterToolError ||= processed.writeOutcomeUncertain;
        toolCallsText += processed.toolCallsText;
        pendingAttachments.push(...processed.attachmentMessages);
        const result = processed.toolMessages[0];
        const output =
          result?.role === "tool" && result.content[0]?.type === "tool-result"
            ? result.content[0].output
            : undefined;
        value = output?.type === "text" ? output.value : "";
      }
      interimMessages.push(
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId, toolName: name, input }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId,
              toolName: name,
              output: { type: "text", value },
            },
          ],
        },
      );
      inFlight = undefined;
      await checkpoint();
      return value;
    };
  }
  const settings = {
    model: provider.languageModel,
    messages,
    tools: sdkTools,
    providerOptions: provider.providerOptions,
    maxRetries: 0,
    allowSystemInMessages: true,
    stopWhen: isStepCount(maxIterations),
    // Serial execution preserves note edit order and approval dialogue order.
    toolCallConcurrency: 1,
    prepareStep: async ({
      experimental_steeringMessages = [],
    }: {
      experimental_steeringMessages?: UserModelMessage[];
    }) => {
      checkBudget();
      if (checkpointFailure) throw checkpointFailure;
      if (researchFailure) throw researchFailure;
      if (stopAfterToolError)
        throw new Error(
          "A tool that can modify data failed. Completed work has been saved. Verify its outcome before continuing; the operation has not been retried.",
        );
      const attachments = pendingAttachments;
      pendingAttachments = [];
      responseMessages.push(...attachments, ...experimental_steeringMessages);
      if (experimental_steeringMessages.length) await checkpoint();
      const prepared = await prepareContext([...messages, ...responseMessages]);
      checkBudget();
      return { messages: prepared };
    },
    onStepEnd: async (step: import("ai").StepResult<ToolSet>) => {
      prepareContext.observeUsage(step.usage.inputTokens);
      if (checkpointFailure || researchFailure || inFlight?.research) {
        await accountUsage(step.usage);
      }
      if (checkpointFailure) throw checkpointFailure;
      if (researchFailure) throw researchFailure;
      if (inFlight?.research) {
        // A failed child must retain its completed evidence for recovery.
        throw new Error(
          "Research interrupted. Completed findings have been saved.",
        );
      }
      responseMessages.push(...step.response.messages);
      interimMessages.length = 0;
      inFlight = undefined;
      await accountUsage(step.usage);
      await checkpoint();
    },
  };
  const execute = async (
    tools: ToolSet,
    steering?: Experimental_Steering,
  ): Promise<AgenticChatResult> => {
    let text: string;
    let reasoning: string | undefined;
    let finishReason;
    if (streaming) {
      const { messages: inputMessages, ...agentSettings } = settings;
      const agent = new ToolLoopAgent({ ...agentSettings, tools });
      const result = await agent.stream({
        messages: inputMessages,
        abortSignal: signal,
        experimental_steering: steering,
      });
      const fullReasoning = await consumeAgentStream(
        result.fullStream,
        options,
      );
      signal.throwIfAborted();
      text = await result.text;
      reasoning = fullReasoning || undefined;
      finishReason = await result.finishReason;
    } else {
      const { messages: inputMessages, ...agentSettings } = settings;
      const agent = new ToolLoopAgent({ ...agentSettings, tools });
      const result = await agent.generate({
        messages: inputMessages,
        abortSignal: signal,
        experimental_steering: steering,
      });
      signal.throwIfAborted();
      text = result.text;
      reasoning = result.reasoningText;
      finishReason = result.finishReason;
    }
    if (finishReason === "tool-calls") {
      const warning =
        "\n\n⚠️ Maximum tool iterations reached. Response may be incomplete.";
      text += warning;
      responseMessages.push({
        role: "assistant",
        content: [{ type: "text", text: warning.trim() }],
      });
      if (streaming) options.onChunk?.(warning);
    }
    return {
      messages: [...messages, ...responseMessages, ...pendingAttachments],
      finalResponse: text,
      finalReasoning: reasoning,
      toolCallsText,
      usage: { ...usageTotal },
    };
  };
  const unregister = registerRun(runId, signal);
  try {
    return await execute(sdkTools, options.steering);
  } catch (error) {
    // Retry only before tools have run, so a failed request cannot repeat edits.
    if (
      executedTools ||
      !options.tools.length ||
      !(error instanceof Error) ||
      !/does not support tools/i.test(error.message)
    )
      throw error;
    if (currentModel) currentModel.supportsTools = false;
    await editor.flashNotification(
      `Model ${provider.modelName} does not support tools, continuing without them`,
      "info",
    );
    // Preserve instructions already accepted before the provider rejected tools.
    const acceptedInstructions = responseMessages.filter(
      (message) => message.role === "user",
    );
    responseMessages.length = 0;
    responseMessages.push(...acceptedInstructions);
    return await execute({});
  } finally {
    unregister();
  }
}
