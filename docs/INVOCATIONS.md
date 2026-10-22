# Universal Invocation Integration

Contracts: [API](API.md), [execution](EXECUTION.md), [quoting](QUOTING.md). All prices in the local environment are synthetic. Support for a specific model is declared by the catalog's published `text_features`, rather than the provider name.

## Application Server

The UAI token is stored on the application server. The browser calls its own server, which creates a `UaiClient` with `baseUrl` and `token`, checks `/health`, and passes a verified identity through `forIdentity`. Do not take an account, project, or identity from the browser without checking the owner's permissions. See [external authentication](EXTERNAL_AUTH.md).

Each user invocation receives a persistent idempotency key. Store it together with the accepted `request_id`. After a network error, repeat the same call with the same bytes and key, or connect to the accepted request. A new key means new work and a possible new charge.

```ts
const result = await client.ai.run({
  account_id: accountId,
  profile: 'configured-text-profile',
  input: {
    messages: [{role: 'user', content: [
      {type: 'text', text: 'Describe the image.'},
      {type: 'image', asset_id: inputAssetId},
      {type: 'text', text: 'Keep the answer brief.'}
    ]}]
  },
  parameters: {max_output_tokens: 512},
  execution: {max_attempts: 4},
  billing: {refused: 'platform'}
}, {
  key: savedInvocationKey,
  onAccepted: async accepted => saveRequestId(accepted.request_id),
  onAttempt: async () => clearProvisionalOutput(),
  onDelta: async delta => appendProvisionalOutput(delta.text),
  persist: async snapshot => saveResultDurably(snapshot)
});
```

The application chooses the profile, parameters, and budget limit from the published configuration. This example is not a ready-to-use model configuration. With `estimated_actual`, the initial reservation follows the estimate; the actual charge may differ, including debt after a cache miss. `isInsufficientCredits(error)` lets the application show a top-up option without creating another invocation.

## Request and delivery flow

![Sequence from quoting and acceptance through provider execution, permanent application storage and delivery acknowledgement](diagrams/request-delivery.svg)

This is the successful quote-based path, with UAI execution roles grouped into one participant. Your application must save the final result before acknowledging delivery. Streaming, reconnects and explicit cancellation follow the rules below.

## Streaming and Delivery

`ai.stream(body, {key, signal})` returns `accepted`, `attempt`, `delta`, and `result` events. A delta has a request, attempt, generation, sequence, and optional `field_path`. The SDK discards duplicates and outdated attempts. On `attempt`, the application clears provisional output. `live_incomplete` means part of the stream was missed; the final object remains the source of the result.

`delivery.field_paths`, for example `['/reply']`, streams selected JSON string fields as they arrive. These fragments remain provisional until the full schema is validated. With tools, exactly one call is validated; UAI returns the name and arguments, while the application decides whether to execute the tool.

A disconnected connection or abort stops viewing. To stop the work, explicitly call `requests.cancel(requestId, key)`. Use `ai.resumeStream(requestId)` to recover; this does not create a new provider dispatch. Old deltas are not stored as financial events; recovery may include a gap and deliver only the final result.

`ai.run` calls `persist` first, then ACK. If persistence fails, ACK is not sent. With low-level `ai.stream`, the application stores the result itself and calls `requests.acknowledge` with `result_version` and `manifest_hash` from `delivery`. After ACK, UAI's temporary result may be deleted: the application must display its own stored copy.

`execution_status` describes the work outcome; `settlement_status` describes whether financial settlement is complete. A `refused` outcome is not retried. By default, the platform bears refusal usage; the application may explicitly select `actual_usage`. Unknown provider usage does not become zero. `usage.attempts` exposes individual models and costs; `usage.summary.scope='all_attempts'` includes all attempts.

## Images and Wallet

`assets.upload` uploads the source file with SHA-256, type, and size. The order of image blocks determines image placement within the message. Preserve keeps the original bytes; transformation must be explicitly enabled in configuration. Images not used in blocks are rejected by the real text adapter.

Accepted input use extends retention and holds the file for an active request. Result GET and ACK do not extend retention or delete shared input. Use `assets.renew(id, key)` to extend retention. If a file has already expired or been deleted, the application uploads its own original again; `reupload` only helps while the old content is available. The application stores the permanent media library.

`wallets.subscribe(walletId, {signal})` delivers an initial snapshot, followed by changes with increasing `revision`; after a disconnect it rereads the snapshot. `available_units` already excludes reservations. The application stores integer monetary values as strings, applies only newer revisions, and separately displays `reserved_units` and negative available balances.

## Embeddings

The `embeddings.generate` capability uses the shared `ai.run`/`ai.stream`, but does not deliver provisional vectors. Input is `input: {texts: ['first line', 'second line']}`; the `dimensions` parameter is optional. OpenAI `text-embedding-3-small`, `text-embedding-3-large`, and Voyage `voyage-4` are registered; local implementation does not establish live availability.

The profile publishes an `input_mode: 'embedding_batch'` calculation, without image assets. OpenAI uses `cl100k_base`; Voyage uses a conservative UTF-8 bound. An accepted batch is one work item and one reservation. Output contains `model`, `revision: null`, `dimensions`, and `data`; ordering is normalized by index. Details and reasons for the unknown revision are in the [model capabilities guide](MODEL_CAPABILITIES.md).

Shared limits: 128 strings, 16384 coordinates, and a 512 KiB result; dimensions and token limits are model-specific. Large allows 3072; Voyage allows 256/512/1024/2048 and query/document without truncation. See the [model and limit table](MODEL_CAPABILITIES.md). Missing or duplicate indices, wrong dimensions, and nonnumeric coordinates mean the entire batch is defective. The application stores vectors permanently after persist-before-ACK.

The protocol was checked against the [official embeddings API](https://developers.openai.com/api/reference/resources/embeddings/methods/create) on 2026-09-25. Synthetic test tariffs are not OpenAI prices.

## Additional model capabilities

The [model capabilities guide](MODEL_CAPABILITIES.md) describes optional/null JSON Schema and local refs, forced tool choice emulation, `priority`, `ai.forecast`, Recraft Styles/Vectorize, and Quiver. Forecasts do not reserve funds; new Quiver profiles have a cap without overdraft.
