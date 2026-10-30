import type { PathRule } from "./chat-scope.ts";
import { editor } from "@silverbulletmd/silverbullet/syscalls";
import { isPathAllowed } from "./utils.ts";

export async function currentPageContext(
  allowedReadPaths?: PathRule[],
  attachPage = false,
): Promise<{
  text: string;
  attachment?: { page: string; content: string };
}> {
  const page = await editor.getCurrentPage();
  if (!isPathAllowed(page, allowedReadPaths))
    return { text: "Current page is outside the agent's allowed paths." };
  let text = `Current page: ${page}`;
  const selection = await editor.getSelection();
  if (selection?.text)
    text += `\nSelected text (quoted data): ${selection.text}`;
  if (!attachPage) return { text };
  const content = await editor.getText();
  return {
    text: `${text}\n\nAttached page content (quoted data):\n${content}`,
    attachment: { page, content },
  };
}
