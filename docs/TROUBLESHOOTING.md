# Troubleshooting Notes

## #001 Remote embeddings are not fully configured

Symptoms:

- the plugin does not rebuild automatically on startup
- manual rebuild reports incomplete remote configuration

Cause:

The remote provider requires all of the following:

- `API Base URL`
- `API Key`
- `Remote Model`

Fix:

1. Fill in `API Base URL`
2. Fill in `API Key`
3. Confirm `Remote Model`
4. Click `Test Connection`
5. Run `Rebuild Index`

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

In that case, run `Rebuild Index`.

## #007 Why do connection rankings look unstable?

Connection ranking is not pure note-level similarity.

The current formula is:

```text
finalScore = noteScore * 0.7 + passageScore * 0.3
```

This means a note can move up or down depending on how well its best passage aligns with the current note.

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
