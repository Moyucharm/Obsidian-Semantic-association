# Troubleshooting Notes

## #001 The plugin does not rebuild automatically on startup

Symptoms:

- the plugin shows a reminder to rebuild (or you see an empty index) but does not rebuild automatically
- manual rebuild reports incomplete remote configuration

Cause:

This is expected behavior.

Full rebuilds are user-triggered to avoid surprise remote API usage.

In addition, the remote provider requires all of the following before a rebuild can work:

- `API Base URL`
- `API Key`
- `Remote Model`

Fix:

1. Fill in `API Base URL` (`API 基础 URL`)
2. Fill in `API Key` (`API 密钥`)
3. Confirm `Remote Model` (`远程模型`)
4. Click `Test Connection` (`测试连接`)
5. Run `Rebuild Index` (`重建索引`) when you want to refresh the index

Optional:

- Enable incremental indexing in Settings if you want background updates between full rebuilds.

## #002 Test Connection succeeds but rebuild fails

Symptoms:

- `Test Connection` succeeds
- `Rebuild Index` still fails for some files

Cause:

`Test Connection` only validates a small request. It does not cover:

- real batch sizes
- long documents
- problematic document structures
- final `heading + text` payload length

## #003 Rebuild reports `400 invalid parameter`

Check in this order:

1. `errorCode`
2. `stage`
3. `details`

Common details:

- `status=400`
- `input_count=...`
- `index_mode=full`
- `index_mode=incremental`
- `task_type=modify`

Useful local error codes:

- `ERR_INDEX_CHUNK_TEXT_LIMIT_INVALID`
- `ERR_INDEX_CHUNK_SPLIT_STALLED`
- `ERR_INDEX_CHUNK_SPLIT_EMPTY`
- `ERR_INDEX_CHUNK_PAYLOAD_EMPTY`
- `ERR_INDEX_CHUNK_PAYLOAD_TOO_LONG`
- `ERR_INDEX_CHUNK_EMBED_REQUEST`
- `ERR_INDEX_CHUNK_VECTOR_COUNT_MISMATCH`
- `ERR_INDEX_NOTE_EMBED_REQUEST`

Recommended checks:

1. Temporarily reduce `Batch Size` to `1`
2. Use `filePath` in the error log to locate the source file
3. Inspect oversized paragraphs, headings, tables, code blocks, or unusual frontmatter

## #004 Why do errors appear only after scanning finishes?

This is expected.

The rebuild flow is roughly:

1. scan files and collect metadata
2. chunk text
3. build final `heading + text` payloads
4. request embeddings

That means scanning can finish before payload validation or remote request errors appear.

## #005 Why not split into the smallest chunks possible?

Very small chunks usually hurt retrieval quality:

- they lose context
- they become easier to match on noise
- they increase request count
- they make ranking less stable

The current strategy prefers paragraph-sized chunks and only splits further when necessary.

## #006 Why is the saved snapshot marked incompatible after an upgrade?

This usually happens when one of the compatibility keys changed, especially:

- remote model
- remote base URL
- embedding dimension
- chunking strategy
- note vector strategy

In that case, run `Rebuild Index`.

## #007 Why do connection rankings look unstable?

Connection ranking is not pure note-level similarity.

The current formula is:

```text
finalScore = bestPassage.score
```

`passageScore` is still computed via log-sum-exp over the top passages and exposed for transparency,
but the UI headline score follows the best matching snippet so the ranking matches what you see.

## #010 Why do I see fewer connections or no passages?

Symptoms:

- fewer notes show up than expected
- a note shows up, but no passages are shown

Cause:

Connections are computed in two stages:

1. note-level recall returns candidates
2. chunk-level passage matching applies a similarity threshold

If `minSimilarityScore` is too high, fewer results will survive the soft threshold (the UI will still
show a small top-N fallback and mark results below the threshold as "weak").

Fix:

1. Lower the relevance threshold (`minSimilarityScore`)
2. Increase `maxPassagesPerNote` (or set it to `0` to disable truncation)
3. Rebuild the index if you suspect stale or missing chunk vectors

## #008 Will local config or logs be committed?

No.

These are ignored by `.gitignore`:

- `data.json`
- `debug-artifacts/`

## #009 Build and deployment

Build command:

```bash
npm run build
```

Files to deploy into the Obsidian plugin directory:

- `main.js` or `dist/main.js`
- `manifest.json` or `dist/manifest.json`
- `styles.css` or `dist/styles.css`

Note:

- Production builds clean `dist/` before copying files, so `dist/` should only contain these three outputs.

## #011 Where are logs stored?

The plugin writes logs to JSON files in the plugin data directory:

- `error-log.json`
- `runtime-log.json`

The exact path depends on your vault config directory, but it is typically under:

- `.obsidian/plugins/semantic-connections/`
