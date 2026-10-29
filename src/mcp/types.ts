export type McpToolDef = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpListToolsResult = {
  tools: McpToolDef[];
};

export type McpContentItem = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

export type McpCallToolResult = {
  content?: McpContentItem[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
};
