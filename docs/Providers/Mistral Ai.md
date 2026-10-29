[Mistral AI](https://mistral.ai/) is a hosted service that offers an OpenAI-compatible API.

Mistral text generation, tool calls and embeddings use Vercel AI SDK's
`@ai-sdk/mistral` provider. Use `provider = "mistral"` to select it. Tool choice
uses the SDK default, so the model can answer directly or request a tool.

## Provider Configuration (Recommended)

```lua
local mistral_key = "your-mistral-api-key-here"

config.set {
  ai = {
    providers = {
      mistral = {
        provider = "mistral",  -- Select the AI SDK Mistral provider
        apiKey = mistral_key,
        baseUrl = "https://api.mistral.ai/v1",
        preferredModels = {"mistral-large-latest", "mistral-medium"}
      }
    },
    -- Optional: auto-select a default model on startup
    defaultTextModel = "mistral:mistral-large-latest"
  }
}
```

With this configuration:

- Run **"AI: Select Text Model"** to see all available Mistral models
- **"AI: Refresh Model List"** updates the cached model list
- `preferredModels` appear first in the picker (marked with ★)

## Legacy Configuration

!!! warning "Deprecated"
    The `textModels` array configuration is deprecated. Please migrate to the `providers` config above.

```lua
config.set {
  ai = {
    keys = {
      MISTRAL_API_KEY = "your-mistral-api-key-here"
    },
    textModels = {
      {
        name = "mistral-medium",
        modelName = "mistral-medium",
        provider = "mistral",  -- Select the AI SDK Mistral provider
        baseUrl = "https://api.mistral.ai/v1",
        secretName = "MISTRAL_API_KEY"
      }
    }
  }
}
```

## Embedding Configuration

Mistral embeddings use the `mistral-embed` model, which is OpenAI-compatible. Set `provider = "mistral"` and specify the embedding model:

```lua
config.set {
  ai = {
    providers = {
      mistral = {
        provider = "mistral",
        apiKey = mistral_key,
        baseUrl = "https://api.mistral.ai/v1",
      }
    },
    defaultTextModel = "mistral:mistral-large-latest",
    defaultEmbeddingModel = "mistral:mistral-embed"
  }
}
```

## Provider Options

| Option | Description |
|--------|-------------|
| `provider` | Use `"mistral"` for the AI SDK Mistral provider. |
| `apiKey` | Your Mistral API key |
| `baseUrl` | Must be `"https://api.mistral.ai/v1"` |
| `preferredModels` | Array of model names to show first in the picker |

See [Mistral AI Documentation](https://docs.mistral.ai/) for available models.
