# Architecture

`dsh-live-doc` is one DeepSeek Harness bundle with two halves and no build step:

| Path | Runs in | Purpose |
| --- | --- | --- |
| `src/host/index.js` | Harness Host | plugin entry, `doc_*` tools, `/live-doc/api/*` route, prompt section |
| `src/host/store.js` | Harness Host | block document model, Markdown ↔ HTML, edit journal, persistence |
| `src/host/docx.js` | Harness Host | dependency-free DOCX package writer |
| `src/host/tool.js` | Harness Host | parameter-DSL compiler for the tool registry |
| `src/client/index.js` | Browser | floating panel, header toggle, polling and autosave |

The browser module is loaded through `window.__ModuleLoader__`; its id is the
package name (`dsh-live-doc`). `cordis.patch.yml` inserts the single Host row
`live-doc`; no second row may point at the same entry point.

## Host lifecycle

`apply(ctx)` runs once per plugin load:

1. Build one `DocumentStore` at `$DSH_LIVE_DOC_DIR`, else
   `$DSH_HOME/live-doc`, else `~/.dsh/live-doc`. Loading a directory reads every
   `*.json` file and ignores damaged ones, then selects the newest document.
2. `ctx.inject(['tools'], …)` registers the eight tools and keeps their disposers
   in one `ctx.effect` so unloading removes them.
3. `ctx.inject(['systemPrompt'], …)` adds `live-doc:coedit`, the short
   co-editing contract the model reads on every turn.
4. `ctx.inject(['webServer'], …)` registers the prefix route `/live-doc/api`.

The Host half declares `inject: ['tools', 'webServer', 'systemPrompt',
'workingDirectory']`. Without one of those services the plugin stays inactive
instead of throwing.

## Document model

```jsonc
// <store>/<docId>.json
{
  "id": "doc_...",
  "title": "课程论文",
  "path": "/workspace/课程论文.docx",   // default export target
  "cwd": "/workspace",                   // session cwd at creation
  "createdAt": 1794..., "updatedAt": 1794...,
  "rev": 7,                              // monotonic document revision
  "blocks": [
    {
      "id": "b_...",
      "type": "p",                       // h1 h2 h3 p ul ol quote code hr
      "html": "正文 <strong>加粗</strong>",
      "rev": 6,
      "by": "user",                      // ai | user
      "ts": 1794...
    }
  ],
  "pending": [ /* edits the model has not read yet */ ],
  "exportedAt": 1794...
}
```

Invariants:

- Block ids are stable for the lifetime of a block. Inserting never renumbers
  existing blocks, so an id the model read remains valid.
- `doc.rev` increases on every mutation. `block.rev` records the document
  revision at which that block last changed.
- `html` is always sanitized before it is stored; the model and the DOCX writer
  never see arbitrary tags.
- Writes are atomic (`<id>.json.tmp` then `rename`) so a crash cannot leave a
  half-written document.

## Concurrency and conflict rules

There is one writer of a JSON file (the Host process), but two editors of its
content: the agent through tools and the user through the browser route.

| Situation | Result |
| --- | --- |
| Agent appends while the user edits another paragraph | both applied; different blocks, no interference |
| User saves with `baseRev` equal to the block's current rev | normal save; block becomes `by: "user"` and enters the journal |
| User saves while the block's `rev` moved **and** its author is `ai` | user text wins, `conflict: true`, journal entry marked as a conflict |
| Agent `doc_replace` with a wrong `expect` prefix | rejected with the current text; model must re-read |
| Agent `doc_replace` on a user-edited block | allowed only when the model was asked to rewrite; the block's journal entries are cleared because the rewrite supersedes them |
| Agent `doc_delete` | removes the block and its journal entries |

The journal is bounded: at most 200 entries per document, each before/after
snippet truncated to 8,000 characters. `doc_read` drains the unseen entries and
marks them seen; a subsequent read reports only newer edits.

## RPC surface

All browser requests are `POST /live-doc/api/<method>` with
`content-type: application/json` and `x-live-doc: 1`.

| Method | Request | Response |
| --- | --- | --- |
| `state` | `{ docId? }` | `{ doc, activeId, docs, busy }` |
| `probe` | `{}` | `{ id, rev, updatedAt, count }` |
| `create` | `{ title?, cwd? }` | `{ doc, docs }` |
| `select` | `{ docId }` | `{ doc, activeId, docs, busy }` |
| `patch` | `{ docId, blockId, html, baseRev }` | `{ ok, changed, conflict, rev, block }` |
| `retype` | `{ docId, blockId, type }` | `{ ok, rev, block }` |
| `insertBlock` | `{ docId, after?, type, html }` | `{ ok, rev, block }` |
| `insertAfter` | `{ docId, after, markdown }` | `{ ok, rev, blocks }` |
| `deleteBlock` | `{ docId, blockId }` | `{ ok, rev }` |
| `rename` | `{ docId, title }` | `{ ok, title, rev }` |
| `export` | `{ docId, file? }` | `{ ok, path, bytes, rev }` |

The handler rejects non-POST requests, cross-origin requests whose `Origin` is
present and not the Harness origin, requests without the custom header, JSON
bodies over 2 MB, and unknown methods.

## Browser panel

- Registered in `shell.overlay` (a click-through layer; the panel opts back into
  pointer events) with `order: 20`; the header button is registered in
  `conversation.session.header.actions`.
- While open, it polls `state` every 900 ms with the current `docId`. When the
  host reports a different `activeId` (agent created or switched documents), the
  panel fetches that document and follows it.
- When closed, it probes every 2 s and opens automatically for a document touched
  in the last 12 hours unless the user dismissed that id in this browser session.
- A local edit updates the block immediately, marks it dirty, and schedules a
  `patch` 450 ms later. Poll results never replace a dirty or focused block's
  text; if the server text also changed, the block shows a “click to update”
  affordance.
- The export button flushes dirty blocks first.
- The panel renders `<style>` with its component, so unmounting removes it; it
  uses `--dsw-alias-*` theme tokens and the host's locale service for visible text.

## Markdown, HTML, and DOCX

Agent input is Markdown, one non-empty line per block. `markdownToBlocks` maps
headings, list markers, quotes, fences, and horizontal rules; `mdToHtml` handles
inline code, bold, italic, strikethrough, and links. `sanitizeHtml` is the only
way bytes enter the store.

For DOCX, `inlineRuns` tokenizes the sanitized HTML and emits `<w:r>` runs with
`b`/`i`/`u`/strike/code/link properties. `zip()` writes deflate-compressed local
and central directory records plus the EOCD, using `crc32` and `deflateRawSync`
from `node:zlib`. The package contains:

```
[Content_Types].xml
_rels/.rels
docProps/core.xml
docProps/app.xml
word/document.xml
word/styles.xml
word/numbering.xml
word/settings.xml
word/_rels/document.xml.rels
```

`word/document.xml` carries the A4 `sectPr`; headings, quote, and code are named
styles; list paragraphs reference `numId` 1 (bullet) or 2 (decimal) in
`numbering.xml`.

## Tests

`npm test` runs `node:test`:

- `test/store.test.js` — parsing, round-trip, conflict rules, insert order,
  journal lifecycle, export-path rules, persistence.
- `test/docx.test.js` — ZIP central directory, decompression, required parts,
  heading/numbering/bold tags, escaped text, empty document.
- `test/tool.test.js` — parameter DSL, definition validation, client wrapper,
  manifest, one-row patch.

Everything runs with Node built-ins; CI has no install step.

## Extending

- **New block type**: add it to `BLOCK_TYPES` and `markdownToBlocks`, render it in
  `Block`, add a `paragraphProperties`/`inlineRuns` path in `docx.js`, and a
  style in `stylesXml`.
- **Tables** need a `table` block with rows/cells, cell-level editing in the
  panel, and a `w:tbl` writer. The block id + revision model already fits; the
  open question is the editor surface.
- **Images** need attachment storage and a `word/media` relationship; keep them
  out of the JSON model and store only an attachment reference.
