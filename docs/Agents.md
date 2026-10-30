# Agents

Agents are customizable personas that configure how the Assistant behaves. Each agent has its own system prompt and can optionally restrict which tools are available.  You can also optionally provide additional context to the agent, such as providing links to other notes in the space or http urls for documentation/etc.

Currently, Agents are only used in the Assistant chat panel.

## Chat with one note or folder

Use **AI: Chat with Current Note** or **AI: Chat with Folder** from the command palette. The folder command provides a searchable picker of folders containing notes. Each command starts a fresh conversation using the standard assistant without creating or changing an agent definition.

The panel displays the note or folder. Note scope matches exactly one note, excluding child notes. Folder scope includes notes in that folder and its subfolders, but excludes similarly named folders. The scope stays fixed when you navigate and is restored when you reopen the panel. Reads, searches, edits and research subagents inherit the restrictions. Unrestricted Lua, custom Lua tools and MCP tools are unavailable in scoped chats.

Use **New** in the panel to return to a normal chat and your configured agent. Stop any running turn before opening another scoped chat. **Attach current page** only includes content when the current page is inside the scope.

## Configuration

### Setting a Default Agent

Set a default agent in your Space Lua config using the agent's key (for Lua agents) or `name` field (for page agents):

```lua
config.set("ai", {
  chat = {
    defaultAgent = "myCustomAgent"
  }
})
```

## Creating Custom Agents

### Method 1: Lua Definition

Add agents directly in a Space Lua block:

```lua
ai.agents.myagent = {
  name = "My Custom Agent",
  description = "Does something specific",
  systemPrompt = "You are a specialized assistant that...",
  toolsExclude = {"eval_lua"}  -- optional: exclude dangerous tools
}
```

### Method 2: Page-Based Agents

Create a page with the `meta/template/aiAgent` tag. The `aiagent.name` field is used for both display and as a short lookup key in config:

```yaml
---
tags: meta/template/aiAgent
aiagent:
  name: "tasks"
  description: "Helps manage tasks and todos"
  systemPrompt: |
    You are a task management assistant for SilverBullet.
    Help users organize, prioritize, and track their tasks.
    Use wiki-links [[like this]] when referencing pages.
    Be concise and action-oriented.
  tools:
    - read_note
    - update_note
    - list_pages
---
```

With the above, you can set `defaultAgent = "tasks"` in your config.

## Example Agents

### Task Manager Agent

A focused agent for managing tasks and todos. This example shows using a custom `list_tasks` tool alongside built-in tools:

```yaml
---
tags: meta/template/aiAgent
aiagent:
  name: "tasks"
  description: "Helps manage tasks and todos"
  systemPrompt: |
    You are a task management assistant for SilverBullet.
    Help users organize, prioritize, and track their tasks.
    Use wiki-links [[like this]] when referencing pages.
    Be concise and action-oriented.
  tools:
    - list_tasks
    - read_note
    - update_note
---
```

`list_tasks` is not a built-in tool, but you can create custom tools in Space Lua. See [[Tools#Defining Custom Tools]] for how to create your own tools.

### Research Assistant (Read-Only)

A safe agent that can only read and search, not modify:

```yaml
---
tags: meta/template/aiAgent
aiagent:
  name: "Research Mode"
  description: "Read-only research assistant"
  systemPrompt: |
    You help research and find information in the user's notes.
    You cannot modify any pages - only read and search.
    Provide detailed answers with references to relevant pages.
  tools:
    - read_note
    - list_pages
    - get_page_info
    - navigate
---
```

This agent restricts tools to only the built-in read-only tools, preventing any page modifications.

### Sandboxed Agent with Path Restrictions

An agent that can only operate on pages within a specific folder:

```yaml
---
tags: meta/template/aiAgent
aiagent:
  name: "Sandbox Agent"
  description: "Can only access pages under Sandbox/"
  systemPrompt: |
    You help the user with notes in the Sandbox folder.
    You cannot access or modify pages outside this area.
  allowedReadPaths: ["Sandbox/"]
  allowedWritePaths: ["Sandbox/"]
---
```

This agent can read and write pages under `Sandbox/` but will get an error if it tries to access other pages via tools that support path permissions.

> **Note:** Path permissions only apply to tools that declare `readPathParam` or `writePathParam`. Tools like `eval_lua` can bypass these restrictions. For a true sandbox, combine path permissions with a tool whitelist.

### Writing Assistant with Context

An agent with additional context embedded from wiki-links:

```yaml
---
tags: meta/template/aiAgent
aiagent:
  name: "Writing Helper"
  description: "Helps improve and edit writing"
  systemPrompt: |
    You are a writing assistant. Help users improve their prose,
    fix grammar, and structure their notes effectively.
---

Use the following style guide when editing:

[[Style Guide]]

And follow these formatting conventions:

[[Formatting Rules]]
```

**Note**: Wiki-links in the page body will be resolved and their content included as context.

### Personalized Agent with Profile

An agent that knows about you by referencing your profile page:

```yaml
---
tags: meta/template/aiAgent
aiagent:
  name: "Personal Assistant"
  description: "Knows my preferences and location"
  systemPrompt: |
    You are my personal assistant. Use my profile below to personalize responses.
    For example, use my location for weather queries and timezone for scheduling.
---

[[Profile]]
```

Create a `Profile` page with your info:

```markdown
---
tags: meta
---
# Profile
Location: San Francisco, CA
Timezone: America/Los_Angeles
Preferred language: English
```

### Minimal Agent

The simplest valid agent:

```yaml
---
tags: meta/template/aiAgent
aiagent:
  description: "A helpful assistant"
  systemPrompt: "You are a helpful assistant. Be concise."
---
```

## Agent Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Display name and lookup key for the agent. Use this in `defaultAgent` config. |
| `description` | string | Brief description shown in picker |
| `systemPrompt` | string | The system prompt for the LLM |
| `tools` | string[] | Whitelist - only these tools are available |
| `toolsExclude` | string[] | Blacklist - these tools are removed |
| `inheritBasePrompt` | boolean | Prepend base system prompt (default: true) |
| `allowedReadPaths` | string[] | Path prefixes tools can read from (e.g., `["Journal/", "Notes/"]`) |
| `allowedWritePaths` | string[] | Path prefixes tools can write to (e.g., `["Journal/"]`) |

### Base Prompt Inheritance

By default, agents inherit the base system prompt which includes SilverBullet markdown syntax, tool usage guidance, and the llms.txt documentation link. Set `inheritBasePrompt: false` to completely replace the base prompt with your own.

### Tool Filtering Precedence

- If `tools` is set, **only** those tools are available (whitelist mode)
- If `toolsExclude` is set (and `tools` is not), those tools are removed from all available tools (blacklist mode)
- If both are set, `tools` takes precedence and `toolsExclude` is ignored

**Tip:** Use `tools` (whitelist) for restrictive agents that should only have specific capabilities. Use `toolsExclude` (blacklist) when you want most tools but need to block a few dangerous ones like `eval_lua`.

### Path Permissions

Restrict which pages an agent can read from or write to using path prefixes:

```yaml
---
tags: meta/template/aiAgent
aiagent:
  name: "Journal Assistant"
  description: "Helps with journal entries only"
  allowedReadPaths: ["Journal/", "Daily/"]
  allowedWritePaths: ["Journal/"]
---
```

Or in Lua:

```lua
ai.agents.journal = {
  name = "Journal Assistant",
  allowedReadPaths = {"Journal/", "Daily/"},
  allowedWritePaths = {"Journal/"}
}
```

**How it works:**
- If `allowedReadPaths` is set:
  - Tools with `readPathParam` can only read pages starting with those prefixes
  - Wiki-links in the agent's page body are filtered (only allowed pages included as context)
  - Current page name and selection are included only within allowed paths; full content requires **Attach current page**
- If `allowedWritePaths` is set, tools with `writePathParam` can only write to pages starting with those prefixes
- If not set, no path restrictions apply

This is useful for creating restricted agents that can only operate on specific areas of your space.

### Note search

Agents can call `search_notes` to find notes with literal text matching, fuzzy title or path matching, or semantic search. Use `nextOffset` for subsequent result pages and `surroundingLines` for nearby text. Results respect `allowedReadPaths`. Text mode works without embeddings;
semantic mode requires `indexEmbeddings` and a configured embedding model.
Include `search_notes` in an agent's `tools` list if it uses a whitelist, or add it
to `toolsExclude` to disable search for that agent.

## Usage

1. **Select Agent**: Run `AI: Select Agent` command
2. **Clear Agent**: Run `AI: Clear Agent` command

## Research subagents and capabilities

The `research_notes` tool delegates a focused question to a separate SDK agent. It searches and reads notes, then returns findings with note and line references. It uses the parent model and inherits read permissions. It cannot edit notes, run Lua, use MCP or spawn another agent. With an explicit `tools` list, include `research_notes`, `search_notes` and `read_note` to enable it. Add `research_notes` to `toolsExclude` to disable it.

Path restrictions are enforced by built-in TypeScript tools. An agent with `allowedReadPaths` or `allowedWritePaths` receives only those built-in tools, because custom Lua and MCP metadata cannot enforce a filesystem sandbox. Restricted agents also skip custom Lua context enrichment and automatic wiki-link expansion. An empty path list grants no access; a folder grants access to that exact note name and its descendants, not similarly named folders.

`eval_lua` is disabled by default. Unrestricted agents may explicitly enable it with `allowUnsafeLua = true` in the agent definition or `ai.chat` configuration. Approval is still required unless the user has explicitly disabled tool approvals. Path restrictions always override the opt-in. Other custom Lua handlers remain trusted code for unrestricted agents; their metadata does not make them safe to run in a restricted agent.

Start a new chat before changing to a restricted agent or changing its path permissions. Previously saved messages may contain information outside the new scope, so the panel refuses to carry that history into the restricted conversation.


## Native note editing

`create_note` creates a page only when it does not exist. `edit_note` replaces a unique exact text match; read the note first and include enough surrounding text to identify one occurrence. Both tools respect read and write permissions and use diff approvals, unless approvals have explicitly been disabled. A changed page invalidates its pending edit. Restricted agents cannot edit notes containing Space Lua. Include these tools in an explicit `tools` list to enable editing without unrestricted Lua.
