# SilverBullet AI Plug

AI chat, search, tools and image generation inside [SilverBullet](https://silverbullet.md/). This fork uses Vercel AI SDK for text generation, streaming, structured output, tool execution, embeddings and images. Configure your own provider credentials or a local service such as Ollama; no Vercel account is required.

OpenAI text models use the Responses API by default. Custom endpoints can select it with `api = "responses"`; see [OpenAI configuration](docs/Providers/OpenAI.md).

Supported providers include Codex accounts, OpenAI, Google Gemini, Mistral, Ollama and services with OpenAI-compatible APIs, including OpenRouter. SilverBullet handles the note interface, Space Lua configuration, tool approvals and path permissions.

Start with `AI: Open Assistant` or `AI: Chat on current page`. The plug can insert and replace note content, so keep backups of your space.

## Features

<!-- start-features -->
- **Interactive Chat**: Multi-turn conversations using the current note as the chat interface
- **AI Assistant Panel**: Right-side chat panel for persistent conversations across pages
- **Note search**: An explicit `search_notes` tool with literal text, title and path matching, pagination, surrounding lines and optional semantic search
- **Context Enrichment**: Wiki-link parsing, template expansion, and custom enrichment functions
- **AI Agents**: Create specialised AI personas with custom system prompts, tool filtering, and page or Lua-based definitions
- **AI Tools**: Built-in tools (read, create, update notes; search, navigate; execute Lua) with custom tool support and approval gates
- **Templated Prompts**: Define custom prompts as pages or in Space Lua with multiple insertion modes
- **Vector Embeddings**: Chunk-based embeddings stored in SilverBullet's datastore for semantic search
- **Note Summaries**: *Experimental* - Generate and index page summaries
- **Image Generation**: DALL-E integration with auto-upload and caption insertion
- **Bundled Prompts**: Generate tags, suggest page names, generate frontmatter, enhance notes
- **Provider Support**: OpenAI, Google Gemini, Ollama, Mistral AI, Perplexity AI, OpenRouter, any OpenAI-compatible API
- **MCP tools**: Connect remote MCP servers through Vercel AI SDK, with tool approval controls

<!-- end-features -->

### Available commands

The list below are the commands available in this plugin.

<!-- start-commands-and-functions -->
- **AI: Generate and insert image using DallE**: Prompts the user for a custom prompt to send to DALL·E, then sends the prompt to DALL·E to generate an image.
The resulting image is then uploaded to the space and inserted into the note with a caption.
- **AI: Chat on current page**: Streams a conversation with the LLM, but uses the current page as a sort of chat history.
New responses are always appended to the end of the page.
- **AI: Execute AI Prompt from Custom Template**: Executes an AI prompt template. Supports two modes:
1. Page-based: Pass SlashCompletionOption with templatePage to read template from a page
2. Direct: Pass SpaceLuaPromptOptions with template string directly
- **AI: Select Text Model from Config**: Prompts the user to select a text model from the configured models.
Supports `textModels` and `providers` configuration with model discovery.
- **AI: Select Image Model from Config**: Prompts the user to select an image model from the configured models.
Supports `imageModels` and `providers` configuration with model discovery.
- **AI: Select Embedding Model from Config**: Prompts the user to select an embedding model from the configured models.
Supports `embeddingModels` and `providers` configuration with model discovery.
- **AI: Refresh Model List**: Command to clear cache and refresh all model lists
- **AI: Refresh Config**: Command to reload AI lua config and reinitialise providers
- **AI: Reset Selected Models**: Command to clear selected models from clientStore and revert to defaults
- **AI: Select Agent**: Prompts the user to select an AI agent from available agents.
- **AI: Clear Agent**: Clears the currently selected AI agent.
- **AI: Test Embedding Generation**: Function to test generating embeddings.  Just puts the result in the current note, but
isn't too helpful for most cases.
- **AI: Search**: Ask the user for a search query, run the search, and navigate to the results page.
Search results are provided by calculating the cosine similarity between the
query embedding and each indexed embedding.
- **AI: Reindex All Embeddings**: Reindex all embeddings for all indexable pages in the space.
Shows progress notifications during the operation.
Doesn't use the queue
- **AI: Connectivity Test**: Command to run connectivity tests (including any configured MCP servers) and navigate to the results page.
- **AI: Run Benchmark**: Runs the AI benchmark suite and navigates to the results page.
- **AI: Open Assistant**: Opens the AI Assistant panel (side panel)
- **AI: Open Assistant (Full Screen)**: Opens the AI Assistant as a full-screen modal (better for mobile)
- **AI: Toggle Assistant Panel**: Toggles the AI Assistant panel

<!-- end-commands-and-functions -->

## Usage

After installing the plug, you can access its features through the command palette. Configuration is done using Space Lua in your `CONFIG` page (or any page with a `space-lua` block).

The assistant panel stores conversations as Vercel AI SDK `ModelMessage` arrays in SilverBullet’s browser client store. Text, tool calls, full tool results, reasoning and provider metadata are retained for subsequent turns. Displayed tool details are separate from the model messages. Legacy panel histories are not imported. Chat on a page remains a Markdown interface.

To use your ChatGPT account’s Codex allowance, configure the [Codex account service](docs/Codex.md), then run **AI: Sign in to Codex Account**. The model picker discovers models available to that account.

The panel supports Stop, recovery from completed SDK steps and instructions during an active run. Use **Send instruction** to queue text for the next step; the panel shows whether it was delivered. Page content is included when you select **Attach current page**; otherwise the agent can use `read_note`. Native `create_note` and `edit_note` tools support restricted agents and preview changes before approval. Long conversations use bounded tool output and SDK-backed summarisation. The `research_notes` tool delegates read-only research with inherited note permissions, displays search and read progress, and saves completed findings for recovery after interruption. Arbitrary Lua requires `allowUnsafeLua = true` and is unavailable to path-restricted agents. See [agent capabilities](docs/Agents.md) and [execution and context settings](docs/Development.md).

### Configuration

SilverBullet v2 uses Space Lua for configuration. Add a `space-lua` block to your `CONFIG` page:

```lua
local openai_key = "sk-your-openai-key-here"

config.set {
  ai = {
    providers = {
      openai = {
        apiKey = openai_key,
        preferredModels = {"gpt-4o", "gpt-4o-mini"}
      },
      ollama = {
        baseUrl = "http://localhost:11434/v1",
        useProxy = false,
        preferredModels = {"llama3.2", "qwen2.5-coder"}
      }
    },

    -- Optional: auto-select a default model on startup
    defaultTextModel = "ollama:llama3.2",

    -- Chat settings (optional)
    chat = {
      userInformation = "I'm a software developer who likes taking notes.",
      userInstructions = "Please give short and concise responses."
    }
  }
}
```

With this configuration:

- **"AI: Select Text Model from Config"** shows all available models from each provider
- **"AI: Refresh Model List"** updates the cached model lists
- `preferredModels` appear first in the picker (marked with ★)

#### Provider Options

| Option | Description |
|--------|-------------|
| `apiKey` | API key for the provider |
| `api` | OpenAI API selection: `"responses"` or `"chat"`. Defaults to Responses for OpenAI and Chat Completions for custom compatible endpoints |
| `baseUrl` | Custom API endpoint |
| `useProxy` | Use SilverBullet's proxy. Set `false` for direct browser requests; the endpoint must allow browser access. |
| `preferredModels` | Models shown first in picker |
| `fetchModels` | Fetch models from API (default: true). Set false if API doesn't support it |
| `provider` | Explicit provider type when key name doesn't match (e.g., `provider = "openai"` for OpenRouter) |

SilverBullet's proxy infers the upstream scheme from the hostname. It uses HTTP for IPv4 addresses and names starting with `localhost` or `host.docker.internal`, and HTTPS otherwise. The plug rejects proxied URLs whose configured scheme differs, before sending the request or API key. For those endpoints, set `useProxy = false` and configure the endpoint to allow browser requests (CORS). Direct requests from an HTTPS SilverBullet page also require an HTTPS endpoint. The plug probes for explicit-scheme support before sending credentials for these URLs. An optional, tested [SilverBullet server patch](patches/README.md) adds that support; it must be applied and deployed separately.

#### Ollama

```lua
config.set {
  ai = {
    providers = {
      ollama = {
        baseUrl = "http://localhost:11434/v1",
        useProxy = false,
        preferredModels = {"llama3.2", "qwen2.5-coder"}
      }
    },
    defaultTextModel = "ollama:llama3.2"
  }
}
```

#### Google Gemini

```lua
config.set {
  ai = {
    providers = {
      gemini = {
        apiKey = "your-google-ai-studio-key",
        preferredModels = {"gemini-2.0-flash", "gemini-1.5-pro"}
      }
    }
  }
}
```

Get your API key from [Google AI Studio](https://aistudio.google.com/app/apikey).

#### OpenRouter

[OpenRouter](https://openrouter.ai/) provides access to many models via one API:

```lua
config.set {
  ai = {
    providers = {
      openrouter = {
        provider = "openai",  -- OpenRouter uses OpenAI-compatible API
        apiKey = "your-openrouter-key",
        baseUrl = "https://openrouter.ai/api/v1",
        preferredModels = {"anthropic/claude-3.5-sonnet", "openai/gpt-4o"}
      }
    }
  }
}
```

#### Multiple Provider Instances

You can configure multiple instances of the same provider type:

```lua
config.set {
  ai = {
    providers = {
      ollamaLocal = {
        provider = "ollama",
        baseUrl = "http://localhost:11434/v1",
        useProxy = false
      },
      ollamaServer = {
        provider = "ollama",
        baseUrl = "http://my-server:11434/v1",
        useProxy = true
      }
    }
  }
}
```

#### Image Generation (DALL-E)

Image models use a separate configuration:

```lua
config.set {
  ai = {
    keys = {
      OPENAI_API_KEY = "your-openai-key"
    },
    imageModels = {
      {name = "dall-e-3", modelName = "dall-e-3", provider = "dalle"}
    }
  }
}
```

#### Chat Custom Instructions

The system prompt includes optional user information and instructions:

```lua
config.set {
  ai = {
    chat = {
      userInformation = "I'm a software developer who likes taking notes.",
      userInstructions = "Please give short and concise responses."
    }
  }
}
```

### Templated Prompts

You can use template notes to create custom prompts. Template notes must have:

- `tags` including `meta/template/aiPrompt`
- `aiprompt` object with a `description` key
- Optionally, `aiprompt.systemPrompt` to override the system prompt

Example template to summarise the current note:

``` markdown
---
tags: meta/template/aiPrompt

aiprompt:
  description: "Generate a summary of the current page."
---

Generate a short and concise summary of the note below.

title: ${@page.name}
Everything below is the content of the note:
${readPage(@page.ref)}
```

Run `AI: Execute AI Prompt from Custom Template` to use your templates.

## Build and test

Use **Bun 1.4.4**, as specified in `.bun-version`. From a clean checkout, install production dependencies and build the complete distribution:

```shell
bun install --production --frozen-lockfile
bun run dist
```

The SilverBullet compiler produces these files in `dist/`:

| File | Purpose |
|------|---------|
| `silverbullet-ai.plug.js` | Compiled plug for the space's `_plug` folder |
| `silverbullet-ai-library.md` | Space Lua functions, widgets and prompt templates for the space root |
| `PLUG.md` | Library Manager entry for published releases |

`bun run build` compiles just the plug to `silverbullet-ai.plug.js` in the repository root.

For development and unit tests:

```shell
bun install --frozen-lockfile
bun run test
```

A production install leaves previously installed development packages in place. Use `bun prune --production` to remove them from an existing checkout.

See [Development](docs/Development.md) for browser tests, integration tests and the AI SDK implementation.

### Continuous integration

Every push to `develop` or `main`, and every pull request targeting either branch, runs the test suite. A separate build job waits for the tests to pass, installs only production dependencies and builds the distribution.

Each successful build uploads the three distribution files as an Actions artefact named `silverbullet-ai-<commit SHA>`, retained for **30 days**. Download it from the Actions run linked to the commit's build check. GitHub requires you to sign in to download artefacts.

The release workflow runs on version tags or through a manual trigger. It tests the code, builds with production dependencies and attaches the distribution files to a GitHub release.

## Installation

Requires SilverBullet **2.11.0 or later**. The plug is built against the SilverBullet 2.12 SDK.

### Development builds

1. Open the commit's build check or the [Build and Test workflow](https://github.com/kernitus/silverbullet-ai/actions/workflows/build.yml).
2. Open a successful run and download its `silverbullet-ai-<commit SHA>` artefact.
3. Extract the archive and copy `silverbullet-ai.plug.js` into your space's `_plug` folder.
4. Copy `silverbullet-ai-library.md` into the space root.
5. Run `Sync: Now` in SilverBullet to load the plug and library.

Repeat these steps to install another build. Actions artefacts support manual installation; they do not provide a SilverBullet subscription URL or automatic updates. `PLUG.md` is intended for published releases, so use the compiled plug and combined library for an artefact installation.

### Published releases

For a release published by this fork, run `Library: Install` and enter:

```text
ghr:kernitus/silverbullet-ai/PLUG.md
```

For a specific version, insert its tag before `/PLUG.md`:

```text
ghr:kernitus/silverbullet-ai@<tag>/PLUG.md
```

Check [GitHub Releases](https://github.com/kernitus/silverbullet-ai/releases) for published tags. Pushes to `develop` produce Actions artefacts; they do not publish releases.

Use one installation method at a time. When switching from a manual installation to Library Manager, remove the manually copied plug and combined library to avoid duplicate definitions.

See the [upstream documentation](https://ai.silverbullet.md/) for additional configuration details and the [local development guide](docs/Development.md) for this fork's build instructions.
