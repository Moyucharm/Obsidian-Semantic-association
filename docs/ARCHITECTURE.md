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
3. registers file events
4. auto-opens the Connections view if configured
5. triggers a full rebuild when needed

### Full Rebuild

`rebuildIndex()`:

1. clears previous error logs
2. clears in-memory index state
3. runs `ReindexService.indexAll(...)`
4. saves the index snapshot
5. updates UI progress and runtime logs

## Connections Ranking

`ConnectionsService` uses a two-stage flow with a blended score:

1. retrieve note-level candidates
2. rerank candidates using the best passage match
3. compute:

```text
finalScore = noteScore * 0.7 + passageScore * 0.3
```

`ConnectionResult` keeps:

- `score`
- `noteScore`
- `passageScore`

## Snapshot Compatibility

The current snapshot version is `3`.

Snapshot compatibility checks include:

- `embeddingProvider`
- `remoteBaseUrl`
- `remoteModel`
- `embeddingDimension`
- `chunkingStrategy`

If any of these change, the snapshot is skipped and the user is asked to rebuild the index.

## Local Files

Local test configuration is stored in `data.json`. This file and `debug-artifacts/` are ignored by `.gitignore` and should not be committed.

## Build

```bash
npm run build
```

Build outputs:

- `main.js`
- `dist/main.js`
- `dist/manifest.json`
- `dist/styles.css`
