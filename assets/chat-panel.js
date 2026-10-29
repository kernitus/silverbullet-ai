// Wait for SilverBullet CSS to load and inject custom Space Styles
(async function initTheme() {
  await Promise.race([
    new Promise((resolve) => setTimeout(resolve, 75)),
    new Promise((resolve) => {
      const link = document.querySelector('link[href*="main.css"]');
      if (link) link.onload = resolve;
    }),
  ]);

  try {
    const customStyles = await syscall("editor.getUiOption", "customStyles");
    if (customStyles) {
      // customStyles is a string of <style> blocks built by SilverBullet core;
      // extract only the CSS text so no other markup can be injected
      for (const match of customStyles.matchAll(
        /<style[^>]*>([\s\S]*?)<\/style>/gi,
      )) {
        const styleEl = document.createElement("style");
        styleEl.textContent = match[1];
        document.head.appendChild(styleEl);
      }
    }
  } catch (e) {
    console.warn("Could not load custom styles:", e);
  }
})();

// Needs to match the key in src/chat-panel.ts
const CHAT_HISTORY_KEY = "ai.panelChatHistory.sdk.v1";

(function () {
  const messagesContainer = document.getElementById("messages");
  const userInput = document.getElementById("user-input");
  const stopBtn = document.getElementById("stop-btn");
  const sendBtn = document.getElementById("send-btn");
  const newChatBtn = document.getElementById("new-chat-btn");
  const exportBtn = document.getElementById("export-btn");
  const closeBtn = document.getElementById("close-btn");
  const panelTitleEl = document.getElementById("panel-title");
  const clearAgentBtn = document.getElementById("clear-agent-btn");
  const tokenDisplayEl = document.getElementById("token-display");
  const tokenCountEl = document.getElementById("token-count");
  const reasoningIndicatorEl = document.getElementById("reasoning-indicator");
  const modelDisplayEl = document.getElementById("model-display");
  const modelNameEl = document.getElementById("model-name");
  const overflowBtn = document.getElementById("overflow-btn");
  const overflowMenu = document.getElementById("overflow-menu");
  const overflowExportBtn = document.getElementById("overflow-export-btn");
  const overflowReasoningBtn = document.getElementById(
    "overflow-reasoning-btn",
  );
  const overflowNewChatBtn = document.getElementById("overflow-new-chat-btn");
  const overflowModelNameEl = document.getElementById("overflow-model-name");
  const overflowTokenCountEl = document.getElementById("overflow-token-count");
  const overflowContextLimitEl = document.getElementById(
    "overflow-context-limit",
  );

  let chatHistory = [];
  let chatData = { id: null, messages: [] };
  let currentStreamId = null;
  let isStreaming = false;

  function formatNumber(n) {
    return n.toLocaleString();
  }

  let lastReasoningEnabled = false;

  async function updateChatStatus() {
    try {
      const status = await syscall(
        "system.invokeFunction",
        "silverbullet-ai.getChatStatus",
      );

      // Update model name (header and overflow menu)
      const modelName = status.model.name || "--";
      modelNameEl.textContent = modelName;
      overflowModelNameEl.textContent = modelName;
      modelDisplayEl.title = status.model.name
        ? `Model: ${status.model.name} (click to change)`
        : "Click to select a model";

      // Update token display (header and overflow menu)
      const tokenCount = formatNumber(status.tokens.total_tokens);
      const contextLimit = status.model.contextLimit
        ? formatNumber(status.model.contextLimit)
        : "--";
      tokenCountEl.textContent = tokenCount;
      overflowTokenCountEl.textContent = tokenCount;
      overflowContextLimitEl.textContent = contextLimit;

      // Update reasoning status
      lastReasoningEnabled = status.reasoning?.enabled ?? false;
      reasoningIndicatorEl.classList.remove("enabled", "disabled");
      if (lastReasoningEnabled) {
        reasoningIndicatorEl.classList.add("enabled");
        reasoningIndicatorEl.title =
          "Reasoning display enabled (click to disable)";
      } else {
        reasoningIndicatorEl.classList.add("disabled");
        reasoningIndicatorEl.title =
          "Reasoning display disabled (click to enable)";
      }

      // Update overflow menu toggle states
      overflowReasoningBtn.classList.toggle("enabled", lastReasoningEnabled);
      document.getElementById("overflow-reasoning-label").textContent =
        lastReasoningEnabled ? "Reasoning (on)" : "Reasoning (off)";
    } catch (e) {
      console.error("Failed to update chat status:", e);
      reasoningIndicatorEl.classList.add("disabled");
    }
  }

  async function toggleReasoning() {
    try {
      await syscall(
        "system.invokeFunction",
        "silverbullet-ai.toggleReasoningEnabled",
      );
      await updateChatStatus();
      if (!isStreaming) await renderAllMessages();
    } catch (e) {
      console.error("Failed to toggle reasoning:", e);
    }
  }

  function generateChatId() {
    return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  let autocompleteVisible = false;
  let autocompleteItems = [];
  let selectedIndex = -1;
  let triggerStartPos = -1;

  async function queryPages(searchTerm) {
    try {
      const currentPage = await syscall("editor.getCurrentPage");
      if (!currentPage) {
        return [];
      }
      const completeEvent = {
        pageName: currentPage,
        linePrefix: "[[" + searchTerm,
        pos: searchTerm.length + 2,
        parentNodes: [],
      };
      const results = await syscall(
        "event.dispatch",
        "editor:complete",
        completeEvent,
      );

      const allOptions = [];
      for (const result of results) {
        if (result && result.options) {
          allOptions.push(...result.options);
        }
      }

      const searchLower = searchTerm.toLowerCase();
      const seen = new Set();
      return allOptions
        .filter((opt) => {
          if (seen.has(opt.label)) return false;
          seen.add(opt.label);
          if (searchTerm) {
            const label = (opt.label || "").toLowerCase();
            const displayLabel = (opt.displayLabel || "").toLowerCase();
            if (
              !label.includes(searchLower) &&
              !displayLabel.includes(searchLower)
            ) {
              return false;
            }
          }
          return true;
        })
        .sort((a, b) => (b.boost || 0) - (a.boost || 0))
        .slice(0, 15);
    } catch (e) {
      console.error("Failed to query pages:", e);
      return [];
    }
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  async function renderMarkdownToElement(content, element) {
    const html = await syscall("markdown.markdownToHtml", content);
    const finalHtml = await syscall(
      "system.invokeFunction",
      "silverbullet-ai.postProcessToolCallHtml",
      html,
    );
    // loadPanelAssets in src/chat-panel.ts bundles DOMPurify ahead of this script.
    // The else branch should never run.
    if (typeof DOMPurify !== "undefined") {
      element.innerHTML = DOMPurify.sanitize(finalHtml, {
        ADD_TAGS: ["details", "summary"],
        ADD_ATTR: ["open"],
      });
    } else {
      element.textContent = content;
    }
  }

  function showAutocomplete(items) {
    const dropdown = document.getElementById("autocomplete-dropdown");
    autocompleteItems = items;
    selectedIndex = items.length > 0 ? 0 : -1;

    if (items.length === 0) {
      hideAutocomplete();
      return;
    }

    dropdown.innerHTML = items
      .map((item, i) => {
        const label = escapeHtml(item.displayLabel || item.label);
        const detail = item.detail
          ? `<span class="detail">${escapeHtml(item.detail)}</span>`
          : "";
        const cssClass = item.cssClass || "";
        return `<div class="autocomplete-item ${i === 0 ? "selected" : ""} ${cssClass}" data-index="${i}">
          <span class="page-name">${label}</span>${detail}
        </div>`;
      })
      .join("");

    dropdown.classList.remove("hidden");
    autocompleteVisible = true;
  }

  function hideAutocomplete() {
    document.getElementById("autocomplete-dropdown").classList.add("hidden");
    autocompleteVisible = false;
    autocompleteItems = [];
    selectedIndex = -1;
    triggerStartPos = -1;
  }

  function selectAutocompleteItem(index) {
    if (index < 0 || index >= autocompleteItems.length) return;

    const item = autocompleteItems[index];
    const text = userInput.value;
    const cursorPos = userInput.selectionStart;

    const before = text.slice(0, triggerStartPos);
    const after = text.slice(cursorPos);

    const insertText = item.apply || item.label;
    const newText = before + "[[" + insertText + "]]" + after;
    const newCursorPos = triggerStartPos + insertText.length + 4;

    userInput.value = newText;
    userInput.setSelectionRange(newCursorPos, newCursorPos);

    hideAutocomplete();
    userInput.focus();
  }

  function updateSelection(newIndex) {
    if (newIndex < 0) newIndex = autocompleteItems.length - 1;
    if (newIndex >= autocompleteItems.length) newIndex = 0;

    const items = document.querySelectorAll(".autocomplete-item");
    items.forEach((item, i) => {
      item.classList.toggle("selected", i === newIndex);
    });
    selectedIndex = newIndex;
    items[newIndex]?.scrollIntoView({ block: "nearest" });
  }

  async function loadHistory() {
    try {
      const stored = await syscall(
        "system.invokeFunction",
        "silverbullet-ai.getPanelChatHistory",
      );
      if (stored && stored.messages) {
        chatData = stored;
        chatHistory = chatData.messages;
        await updateChatStatus();
        await renderAllMessages();
        if (stored.run?.status === "streaming") {
          isStreaming = true;
          currentStreamId = stored.run.id;
          sendBtn.disabled = true;
          userInput.disabled = true;
          stopBtn.hidden = false;
          const element = await renderMessage("assistant", "", true);
          void pollForChunks(currentStreamId, element);
        } else if (stored.run && stored.run.status !== "complete") {
          await renderMessage(
            "assistant",
            stored.run.error ||
              "The previous turn was interrupted. Completed work has been kept. Continue when ready.",
          );
        }
      } else {
        chatData = { id: generateChatId(), messages: [] };
      }
      await updateChatStatus();
    } catch (e) {
      console.error("Failed to load chat history:", e);
    }
  }

  async function saveHistory() {
    // The worker persists checkpoints; the iframe must not overwrite them.
    chatData.messages = chatHistory;
  }

  async function renderMessage(role, content, streaming = false) {
    const msgEl = document.createElement("div");
    msgEl.className = "message " + role + (streaming ? " streaming" : "");

    if (role === "assistant" && !streaming && content) {
      try {
        await renderMarkdownToElement(content, msgEl);
      } catch (e) {
        console.error("Failed to render markdown:", e);
        msgEl.textContent = content;
      }
    } else {
      msgEl.textContent = content;
    }

    messagesContainer.appendChild(msgEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return msgEl;
  }

  function messageText(message) {
    if (typeof message.content === "string")
      return message.content.replace(
        /<context\b[^>]*>[\s\S]*?<\/context>\s*/g,
        "",
      );
    return message.content
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "reasoning" && lastReasoningEnabled) return part.text;
        if (part.type === "tool-call") return `**Tool: ${part.toolName}**`;
        if (part.type === "tool-result") return `Tool result: ${part.toolName}`;
        if (part.type === "image") return "[Image attachment]";
        if (part.type === "file")
          return `[File: ${part.filename || part.mediaType}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  async function renderAllMessages() {
    messagesContainer.innerHTML = "";

    if (chatHistory.length === 0) {
      messagesContainer.innerHTML = `
        <div class="empty-state" id="empty-state">
          <h4>Start a conversation</h4>
          <p>Ask anything about your notes or something.</p>
        </div>
      `;
      return;
    }

    for (const msg of chatHistory) {
      if (msg.role !== "system") {
        const content = messageText(msg);
        if (content) {
          const element = await renderMessage(
            msg.role === "tool" ? "assistant" : msg.role,
            content,
          );
          if (Array.isArray(msg.content))
            for (const part of msg.content) {
              if (part.type !== "tool-result" && part.type !== "tool-call")
                continue;
              const details = document.createElement("details");
              const summary = document.createElement("summary");
              summary.textContent =
                part.type === "tool-call" ? "Arguments" : "Result";
              const pre = document.createElement("pre");
              pre.textContent = JSON.stringify(
                part.type === "tool-call" ? part.input : part.output,
                null,
                2,
              );
              details.append(summary, pre);
              element.appendChild(details);
            }
        }
      }
    }
  }

  async function pollForChunks(streamId, messageEl) {
    while (isStreaming && currentStreamId === streamId) {
      try {
        const result = await syscall(
          "system.invokeFunction",
          "silverbullet-ai.getPanelChatChunk",
          streamId,
        );

        if (result.chunks && result.chunks.length > 0) {
          const currentText = messageEl.textContent;
          messageEl.textContent = currentText + result.chunks.join("");
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        if (result.statusMessage) {
          userInput.placeholder = `🔧 ${result.statusMessage}`;
        }

        if (result.status === "complete") {
          isStreaming = false;
          messageEl.classList.remove("streaming");
          const fullResponse = messageEl.textContent;
          try {
            await renderMarkdownToElement(fullResponse, messageEl);
          } catch (e) {
            console.error("Failed to render markdown:", e);
          }
          if (!Array.isArray(result.messages))
            throw new Error("Chat completed without SDK messages");
          chatHistory = result.messages;
          await renderAllMessages();
          await saveHistory();
          await updateChatStatus();
          break;
        } else if (result.status === "error" || result.status === "cancelled") {
          isStreaming = false;
          if (result.messages) {
            chatHistory = result.messages;
            await renderAllMessages();
          }
          const errorElement = await renderMessage("assistant", "");
          await showChatError(errorElement, result.error || "Stopped");
          await updateChatStatus();
          break;
        }

        // TODO: Add a config option for this, it might be kind of aggressive since we're polling and not really streaming
        await new Promise((r) => setTimeout(r, 50));
      } catch (e) {
        console.error("Polling error:", e);
        isStreaming = false;
        await syscall(
          "system.invokeFunction",
          "silverbullet-ai.cancelPanelChat",
          streamId,
        ).catch(() => {});
        await showChatError(messageEl, e.message);
        await updateChatStatus();
        break;
      }
    }

    stopBtn.hidden = true;
    stopBtn.disabled = false;
    sendBtn.disabled = false;
    userInput.disabled = false;
    userInput.placeholder = "Type a message...";
    userInput.focus();
  }

  async function showChatError(messageEl, message) {
    isStreaming = false;
    messageEl.classList.remove("streaming");
    const errorEl = document.createElement("div");
    errorEl.className = "chat-error";
    errorEl.textContent = message;
    messageEl.appendChild(errorEl);
    // A failed turn may have completed edits. Never resubmit it automatically.
    userInput.value = "";
    userInput.placeholder = "Continue from the saved conversation...";
    sendBtn.disabled = false;
    userInput.disabled = false;
    stopBtn.hidden = true;
  }

  async function stopChat() {
    if (!currentStreamId) return;
    stopBtn.disabled = true;
    try {
      await syscall(
        "system.invokeFunction",
        "silverbullet-ai.cancelPanelChat",
        currentStreamId,
      );
    } catch (error) {
      stopBtn.disabled = false;
      console.error("Failed to stop chat:", error);
    }
  }

  async function sendMessage() {
    const content = userInput.value.trim();
    if (!content || isStreaming) return;

    chatHistory.push({ role: "user", content });
    await renderAllMessages();

    userInput.value = "";
    userInput.style.height = "auto";

    sendBtn.disabled = true;
    userInput.disabled = true;

    const assistantEl = await renderMessage("assistant", "", true);
    isStreaming = true;

    try {
      const result = await syscall(
        "system.invokeFunction",
        "silverbullet-ai.startPanelChat",
        chatHistory,
        chatData.id,
        { attachPage: document.getElementById("attach-page").checked },
      );

      if (result.streamId) {
        document.getElementById("attach-page").checked = false;
        currentStreamId = result.streamId;
        isStreaming = true;
        stopBtn.hidden = false;
        stopBtn.disabled = false;

        pollForChunks(result.streamId, assistantEl);
      } else if (result.error) {
        showChatError(assistantEl, result.error);
      }
    } catch (e) {
      console.error("Failed to start chat:", e);
      showChatError(assistantEl, e.message);
    }

    await saveHistory();
  }

  async function newChat() {
    if (isStreaming) return;
    const id = generateChatId();
    await syscall(
      "system.invokeFunction",
      "silverbullet-ai.resetPanelChatHistory",
      id,
    );
    chatData = { id, messages: [] };
    chatHistory = [];
    await saveHistory();
    await renderAllMessages();
    try {
      await syscall(
        "system.invokeFunction",
        "silverbullet-ai.resetSessionTokenUsage",
      );
    } catch (e) {
      console.error("Failed to reset token usage:", e);
    }
    await updateChatStatus();
    userInput.focus();
  }

  async function exportChat() {
    if (chatHistory.length === 0) return;
    try {
      await syscall("system.invokeFunction", "silverbullet-ai.exportPanelChat");
    } catch (e) {
      console.error("Failed to export chat:", e);
    }
  }

  function closePanel() {
    syscall("system.invokeFunction", "silverbullet-ai.closeAIAssistant");
  }

  let displayedAgentRef = undefined;

  function updateAgentIndicator(agent) {
    displayedAgentRef = agent?.ref ?? null;
    if (agent && agent.aiagent) {
      const agentName =
        agent.aiagent.name || agent.ref.split("/").pop() || agent.ref;
      panelTitleEl.textContent = agentName;
      panelTitleEl.classList.add("has-agent");
      panelTitleEl.title = "Click to change agent";
      clearAgentBtn.classList.remove("hidden");
    } else {
      panelTitleEl.textContent = "AI Assistant";
      panelTitleEl.classList.remove("has-agent");
      panelTitleEl.title = "Click to select agent";
      clearAgentBtn.classList.add("hidden");
    }
  }

  async function loadCurrentAgent() {
    try {
      const agent = await syscall(
        "system.invokeFunction",
        "silverbullet-ai.chatAgentState",
        "get",
      );
      updateAgentIndicator(agent);
      await updateChatStatus();
    } catch (e) {
      console.error("Failed to load current agent:", e);
    }
  }

  async function clearAgent() {
    try {
      await syscall(
        "system.invokeFunction",
        "silverbullet-ai.chatAgentState",
        "clear",
      );
      updateAgentIndicator(null);
      await updateChatStatus();
    } catch (e) {
      console.error("Failed to clear agent:", e);
    }
  }

  userInput.addEventListener("input", async function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 120) + "px";

    const text = this.value;
    const cursorPos = this.selectionStart;
    const textBeforeCursor = text.slice(0, cursorPos);

    // Check for [[ pattern first (wiki-link style)
    const bracketMatch = textBeforeCursor.match(/\[\[([\w\-/\s]*)$/);
    // and also @filename
    const atMatch = textBeforeCursor.match(/(?:^|[^\w])@([\w\-/]*)$/);

    if (bracketMatch) {
      triggerStartPos = cursorPos - bracketMatch[1].length - 2; // -2 for [[
      const pages = await queryPages(bracketMatch[1]);
      showAutocomplete(pages);
    } else if (atMatch) {
      triggerStartPos = cursorPos - atMatch[1].length - 1; // -1 for @
      const pages = await queryPages(atMatch[1]);
      showAutocomplete(pages);
    } else {
      hideAutocomplete();
    }
  });

  userInput.addEventListener("keydown", function (e) {
    if (autocompleteVisible) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        updateSelection(selectedIndex + 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        updateSelection(selectedIndex - 1);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selectAutocompleteItem(selectedIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideAutocomplete();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        selectAutocompleteItem(selectedIndex);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener("click", sendMessage);
  stopBtn.addEventListener("click", stopChat);
  newChatBtn.addEventListener("click", newChat);
  exportBtn.addEventListener("click", exportChat);
  closeBtn.addEventListener("click", closePanel);
  clearAgentBtn.addEventListener("click", clearAgent);

  // Overflow menu handlers
  overflowBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    overflowMenu.classList.toggle("hidden");
  });

  overflowExportBtn.addEventListener("click", function () {
    overflowMenu.classList.add("hidden");
    exportChat();
  });

  overflowNewChatBtn.addEventListener("click", function () {
    overflowMenu.classList.add("hidden");
    newChat();
  });

  overflowReasoningBtn.addEventListener("click", function () {
    overflowMenu.classList.add("hidden");
    toggleReasoning();
  });

  // Close overflow menu when clicking outside
  document.addEventListener("click", function (e) {
    if (
      !overflowMenu.classList.contains("hidden") &&
      !e.target.closest(".overflow-menu-container")
    ) {
      overflowMenu.classList.add("hidden");
    }
  });

  modelDisplayEl.addEventListener("click", async function () {
    try {
      await syscall(
        "system.invokeCommand",
        "AI: Select Text Model from Config",
      );
      await updateChatStatus();
    } catch (e) {
      console.error("Failed to open model selector:", e);
    }
  });

  reasoningIndicatorEl.addEventListener("click", toggleReasoning);

  panelTitleEl.addEventListener("click", async function () {
    try {
      const agent = await syscall(
        "system.invokeFunction",
        "silverbullet-ai.selectAgent",
      );
      if (agent !== null && agent !== undefined) {
        updateAgentIndicator(agent);
        await updateChatStatus();
      }
    } catch (e) {
      console.error("Failed to open agent selector:", e);
    }
  });

  document
    .getElementById("autocomplete-dropdown")
    .addEventListener("click", function (e) {
      const item = e.target.closest(".autocomplete-item");
      if (item) {
        selectAutocompleteItem(parseInt(item.dataset.index));
      }
    });

  userInput.addEventListener("blur", function () {
    setTimeout(hideAutocomplete, 150);
  });

  // Handle toggle shortcut (Ctrl/Cmd+Shift+A) when panel has focus
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      closePanel();
    }
  });

  // Handle link clicks - navigate internal links using SilverBullet
  messagesContainer.addEventListener("click", function (e) {
    const link = e.target.closest("a");
    if (!link) return;

    const href = link.getAttribute("href");
    if (!href) return;

    // External links - let browser handle normally
    if (href.startsWith("http://") || href.startsWith("https://")) {
      return;
    }

    // Internal page links - use editor.navigate
    e.preventDefault();
    const pageName = decodeURIComponent(href);
    syscall("editor.navigate", pageName);
  });

  loadHistory();
  loadCurrentAgent();
  userInput.focus();

  // Poll for agent changes triggered externally (e.g. command palette)
  setInterval(async function () {
    if (displayedAgentRef === undefined) return; // not yet initialized
    try {
      const state = await syscall(
        "system.invokeFunction",
        "silverbullet-ai.getPollState",
      );
      if (state.agentRef !== displayedAgentRef) {
        await loadCurrentAgent();
      }
    } catch (_e) {
      // ignore transient polling errors
    }
  }, 1500);
})();
