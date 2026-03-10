# Semantic Connections Architecture

## Overview

The plugin uses a single embedding provider, `remote`, and sends requests to an OpenAI-compatible `/v1/embeddings` endpoint.

The default remote model is `BAAI/bge-m3`. Internally the plugin only works with one dense vector per text, represented as `number[]`.

## Layers

### UI

- `src/views/connections-view.ts`
- `src/views/lookup-view.ts`
- `src/settings.ts`

This layer renders views, commands, and settings. It does not own indexing or retrieval logic.

### Indexing

- `src/indexing/scanner.ts`
- `src/indexing/chunker.ts`
- `src/indexing/reindex-service.ts`
- `src/indexing/reindex-queue.ts`

This layer scans markdown files, splits them into chunks, runs full rebuilds, and processes incremental updates.

### Embeddings

- `src/embeddings/provider.ts`
- `src/embeddings/remote-provider.ts`
- `src/embeddings/embedding-service.ts`

`EmbeddingService` is the single entry point used by indexing and search. The main operations are:

- `embed(text)`
- `embedBatch(texts)`

### Storage

- `src/storage/note-store.ts`
- `src/storage/chunk-store.ts`
- `src/storage/vector-store.ts`

The on-disk index is composed of:

- `index-store.json`
- `index-vectors.bin`

### Search

- `src/search/connections-service.ts`
- `src/search/lookup-service.ts`
- `src/search/passage-selector.ts`

## Chunking Strategy

The current chunking strategy is `paragraph-first-v2`.

Main behavior:

1. Split markdown into sections by heading.
2. Remove YAML frontmatter before chunking.
3. Keep the heading in metadata instead of inserting it directly into chunk text.
4. Prefer paragraph boundaries when building chunks.
5. Merge very short adjacent paragraphs when possible.
6. Split overly long paragraphs again using sentence, clause, or whitespace boundaries.

Current limits:

- `minChunkLength = 50`
- `maxChunkLength = 1200`

These limits are local safety guards for indexing and are not remote model token limits.

Note: `ReindexService` enforces the same `1200` character limit on the final embedding payload
(`{heading}\n\n{text}`), so when a heading is present the allowed `text` length is reduced and the chunk
may be split again during indexing.

## Heading Context

Chunks still store:

- `heading`
- `text`
- `order`

When building the embedding payload, `ReindexService` sends:

```text
{heading}

{text}
```

If a chunk has no heading, only the text is sent.

This keeps rendered passage text clean while still letting embeddings use heading context.

Heading context is truncated to 200 characters (with an ellipsis) before being prepended, to keep
payloads bounded and avoid extremely long headings dominating embeddings.

## Remote Provider

### Request Format

The plugin sends requests like:

```http
POST {baseUrl}/v1/embeddings
Authorization: Bearer {apiKey}
Content-Type: application/json
```

```json
{
  "model": "BAAI/bge-m3",
  "input": ["text 1", "text 2"]
}
```

### Response Shape

The plugin expects:

```json
{
  "data": [
    { "embedding": [0.1, 0.2] },
    { "embedding": [0.3, 0.4] }
  ]
}
```

### Input Safety

Before sending a remote request, the plugin:

- strips frontmatter
- skips empty chunks
- splits overly long chunks locally
- validates the final `heading + text` payload length again
- avoids calling `embedBatch([])`

## Indexing Flow

### Startup

Startup order in `src/main.ts`:

1. `loadSettings()`
2. `createServices()`
3. register views, commands, and settings
4. `onLayoutReady()`

### Layout Ready

`onLayoutReady()`:

1. loads runtime and error logs
2. attempts to restore the saved index snapshot
3. registers file events (used for incremental indexing when enabled)
4. auto-opens the Connections view if configured
5. reminds the user to rebuild the index when needed (no automatic full rebuild by default)

The plugin tracks `lastFullRebuildAt` and shows a startup reminder when the last full rebuild is older
than 7 days. Rebuilds are user-triggered (command or Settings UI) to avoid surprise remote API usage.

### Full Rebuild

`rebuildIndex()`:

1. clears previous error logs
2. clears in-memory index state
3. runs `ReindexService.indexAll(...)`
4. saves the index snapshot
5. updates UI progress and runtime logs

## Connections Ranking

`ConnectionsService` retrieves related notes by searching chunk vectors directly and then aggregating
chunk hits back to notes. This avoids "big note semantic dilution" where a note-level mean vector can
become too generic to be recalled.

High-level flow:

1. choose a query vector for the current note (prefer the persisted note-level vector; fall back to
   the mean of current chunk vectors when missing)
2. search across all chunk vectors (`id` contains `#`) and collect the topK chunk hits
3. group hits by `notePath` (derived from `chunkId`)
4. for each candidate note:
   - filter passages by `minPassageScore`
   - sort passages by similarity and truncate to `maxPassagesPerNote`
   - compute `passageScore` using log-sum-exp aggregation (softmax pooling)
   - rank notes using `finalScore = passageScore`
   - expose `noteScore` as the best passage score for UI display

`ConnectionResult` keeps:

- `score` (finalScore)
- `noteScore` (best passage score)
- `passageScore` (aggregated)
- `passages` (all matched passages after thresholding)

## Snapshot Compatibility

The current snapshot version is `3`.

Snapshot compatibility checks include:

- `embeddingProvider`
- `remoteBaseUrl`
- `remoteModel`
- `embeddingDimension`
- `chunkingStrategy`
- `noteVectorStrategy`

If any of these change, the snapshot is skipped and the user is asked to rebuild the index.

## Local Files

Local test configuration is stored in `data.json`. This file and `debug-artifacts/` are ignored by `.gitignore` and should not be committed.

## Build

```bash
npm run build
```

Build outputs:

- `main.js`
- `dist/main.js` (dist is cleaned on production builds)
- `dist/manifest.json`
- `dist/styles.css`
