(async () => {
  const { providerKey } = globalThis.codexAccount;
  let state = globalThis.codexAccount.state;
  let closed = false;
  document.getElementById("close").onclick = async () => {
    closed = true;
    await syscall("editor.hidePanel", "modal");
  };
  document.getElementById("logout").onclick = async () => {
    closed = true;
    await syscall(
      "system.invokeFunction",
      "silverbullet-ai.codexAccountLogout",
      providerKey,
    );
    await syscall("editor.hidePanel", "modal");
  };
  while (!closed) {
    const status = document.getElementById("status");
    if (state.status === "authenticated") {
      status.textContent = `Using ChatGPT plan${state.user?.email ? `: ${state.user.email}` : ""}. Refresh the model list to select an available model.`;
      document.getElementById("code").textContent = "";
      document.getElementById("verify").hidden = true;
      break;
    }
    if (state.status !== "pending") {
      status.textContent =
        "Sign-in ended or expired. Close this window and start sign-in again.";
      break;
    }
    status.textContent = "Open the sign-in page and enter this code:";
    document.getElementById("code").textContent = state.userCode ?? "";
    const link = document.getElementById("verify");
    const url = new URL(state.verificationUrl);
    if (url.protocol !== "https:" || url.hostname !== "auth.openai.com")
      throw new Error("Unexpected sign-in URL");
    link.href = url.href;
    link.hidden = false;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(5, state.interval ?? 5) * 1000),
    );
    if (closed) break;
    try {
      state = await syscall(
        "system.invokeFunction",
        "silverbullet-ai.codexAccountStatus",
        providerKey,
      );
    } catch (error) {
      status.textContent = `Could not check sign-in: ${error.message}`;
      break;
    }
  }
})();
