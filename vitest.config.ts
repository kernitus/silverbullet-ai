import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["e2e-tests/**", "codex-account/**", "integration-tests/**", "mcp-bridge/**", "node_modules/**", "silverbullet/**"],
  },
});
