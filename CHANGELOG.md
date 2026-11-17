# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-11-17

First public release.

### Added

- Host plugin (`live-doc` row) with eight agent tools: `doc_create`,
  `doc_append`, `doc_insert`, `doc_replace`, `doc_delete`, `doc_read`,
  `doc_export`, `doc_list`.
- Browser panel registered in `shell.overlay`, plus a session-header toggle.
  Block editing for headings 1–3, paragraphs, bullet/number lists, quotes,
  code, dividers; bold/italic/underline; per-block 450 ms autosave.
- Block model with per-block revisions and authorship (`ai` / `user`); the
  browser saves with `baseRev`, and a same-paragraph collision keeps the user
  text and flags the model on its next read.
- Edit journal drained by `doc_read` with before/after snippets; agent rewrites
  clear the journal for that block.
- Dependency-free DOCX writer: A4 page setup, Word heading/quote/code styles,
  real bullet and decimal numbering, inline formatting, hyperlinks, and atomic
  ZIP packaging with `node:zlib`.
- Markdown export; a Markdown side export does not steal the `.docx` default
  destination.
- Atomic per-document JSON persistence under `$DSH_HOME/live-doc/` (or
  `$DSH_LIVE_DOC_DIR`), reloaded on plugin start.
- English and Chinese plugin-page metadata, detail document, and icon.
- `node:test` suite covering the block store, conflict rules, insertion order,
  export-path rules, ZIP/DOCX structure, the tool compiler, and the manifest.
- GitHub Actions CI on Node 22 and 24; no install step needed.

### Known limits

- Text blocks only: no tables, images, footnotes, headers/footers, or pagination.
- Existing `.docx` files are not imported.
- One active document per profile, shared by every session.
- DOCX output uses conservative default layout.
