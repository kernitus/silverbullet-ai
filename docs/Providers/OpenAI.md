[OpenAI](https://platform.openai.com/) is the default provider for text models.

For other OpenAI-compatible services, see:

- [[Providers/Ollama]] - Local models
- [[Providers/OpenRouter]] - Access many models via one API
- [[Providers/Mistral Ai]] - Mistral AI
- [[Providers/Perplexity Ai]] - Perplexity AI

## Provider Configuration (Recommended)

```lua
local openai_key = "sk-your-openai-key-here"

config.set {
  ai = {
    providers = {
      openai = {
        apiKey = openai_key,
        preferredModels = {"gpt-4o", "gpt-4o-mini"}
      }
    },
    -- Optional: auto-select a default model on startup
    defaultTextModel = "openai:gpt-4o"
  }
}
```

With this configuration:

- Run **"AI: Select Text Model"** to see all available OpenAI models
- **"AI: Refresh Model List"** updates the cached model list
- `preferredModels` appear first in the picker (marked with ★)

## API selection

OpenAI text models use the Responses API through Vercel AI SDK by default.
Text generation, streaming, structured output and note tool calls all use
`/responses`. Conversations remain in SilverBullet; requests set `store: false`,
and the SDK carries tool results and encrypted reasoning between tool steps.

The `api` setting accepts `"responses"` or `"chat"`. For a custom endpoint that
supports Responses, select it explicitly:

```lua
config.set {
  ai = {
    providers = {
      gateway = {
        provider = "openai",
        baseUrl = "https://your-gateway.example/v1",
        apiKey = "your-api-key",
        api = "responses"
      }
    }
  }
}
```

Custom OpenAI-compatible endpoints default to Chat Completions because endpoint
support cannot be inferred from the model name. For a model or server that only
supports Chat Completions, set `api = "chat"`. Individual `textModels` entries
can override their provider's `api` setting. An API error is reported directly;
requests are never silently retried through another API.

Gemini and Mistral use their native SDK providers. Embeddings and image generation
use their own endpoints. Provider-hosted tools such as OpenAI web search require
separate tool configuration; selecting Responses does not enable them automatically.

See [OpenAI's Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
for the API's request and conversation model.

## Legacy Configuration

!!! warning "Deprecated"
    The `textModels` array configuration is deprecated. Please migrate to the `providers` config above.

```lua
config.set {
  ai = {
    keys = {
      OPENAI_API_KEY = "your-openai-key-here"
    },
    textModels = {
      {name = "gpt-4o", provider = "openai", modelName = "gpt-4o"},
      {name = "gpt-4o-mini", provider = "openai", modelName = "gpt-4o-mini"}
    }
  }
}
```

## Provider Options

| Option | Description |
|--------|-------------|
| `apiKey` | Your OpenAI API key |
| `api` | `"responses"` or `"chat"`; Responses is the default for the OpenAI endpoint |
| `baseUrl` | Custom API endpoint (default: `https://api.openai.com/v1`) |
| `useProxy` | Use SilverBullet's proxy (default: `false`) |
| `preferredModels` | Array of model names to show first in the picker |

## Cost

While this plugin is free to use, OpenAI does charge for their API usage. Please see their [pricing page](https://openai.com/pricing) for cost of the various APIs.

See [OpenAI's list of models](https://platform.openai.com/docs/models/overview) for available model names.
