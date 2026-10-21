# x-ollama-cloud

OpenClaw provider plugin: Ollama Cloud models through an AxonHub gateway (OpenAI format).

- Provider `x-ollama-cloud/`, shown in the model picker as **X Ollama Cloud**.
- Models: every model the key can see (use a key restricted to the Ollama Cloud channel), discovered live from AxonHub's `/v1/models`. New models appear after a Refresh in the model picker, or once the 60 s discovery cache expires.
- Embedding and other non-chat models are filtered out.
- Adding a key never replaces the primary model chosen in the UI.

## API address and key

Set them in the OpenClaw UI (**Plugins → X Ollama Cloud → Settings**) or with env vars. The UI setting wins.

| Setting | UI field | Env var | Example |
| ------- | -------- | ------- | ------- |
| API address | `baseUrl` | `X_OLLAMA_CLOUD_BASE_URL` | `https://axonhub.example.com/v1` |
| API key | `apiKey` | `X_OLLAMA_CLOUD_API_KEY` | API key |
| Context window | `contextWindow` | `X_OLLAMA_CLOUD_CONTEXT_WINDOW` | optional, default: the value AxonHub reports |
| Streaming | `streaming` | `X_OLLAMA_CLOUD_STREAMING` | `false` (default) |

The key can also be saved as an auth profile under **Settings → Model providers**, or with `openclaw models auth paste-api-key --provider x-ollama-cloud`. Order: UI `apiKey`, then the auth profile, then the env var.

Streaming is off by default. AxonHub's Ollama Cloud channel ends streamed responses without a terminal event (`stream ended without terminal event`) and answers 502, while the same request without streaming succeeds. Turn it on once the channel streams correctly.

With Docker Compose, the container only sees variables passed under `environment:`, e.g. `- X_OLLAMA_CLOUD_API_KEY=${X_OLLAMA_CLOUD_API_KEY}`.

## Install into an OpenClaw container

The plugin lives on the data volume, so it survives redeploys.

```sh
C=<openclaw container>
docker exec $C rm -rf /data/plugins/x-ollama-cloud
docker cp . $C:/data/plugins/x-ollama-cloud
# OpenClaw ignores plugin dirs that are not root-owned or are group-writable
docker exec $C sh -c 'rm -rf /data/plugins/x-ollama-cloud/.git && chown -R root:root /data/plugins/x-ollama-cloud && chmod 755 /data/plugins/x-ollama-cloud && chmod 644 /data/plugins/x-ollama-cloud/*'
docker exec $C openclaw plugins install --link /data/plugins/x-ollama-cloud --force
```

## Update after editing

Run the first three commands above again, then:

```sh
docker exec $C openclaw plugins reload x-ollama-cloud
```
