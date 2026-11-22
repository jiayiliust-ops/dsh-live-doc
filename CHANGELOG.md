# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] — 2026-11-18

### Changed

- **The panel is now a free-floating sidebar.** Drag its header to move it
  anywhere, resize it from any of the eight edges and corners, and it snaps
  flush to a screen edge when released near one — which is how it becomes a
  right- or left-hand sidebar instead of an overlay stuck to the top-right
  corner. Position and size are remembered per browser.
- A **maximize / restore** button expands the panel to the viewport and puts it
  back exactly where it was. Double-clicking the header resets it to the docked
  default. On window resize the geometry is re-clamped so the header can never
  be dragged off screen.
- The old single-width grip is gone; the legacy `dsh.liveDoc.width` preference
  is still read once when no geometry has been saved yet.

## [1.2.0] — 2026-11-18

### Added

- **Images.** Paste, drop or pick an image in the panel, or let the agent write
  `![caption](relative/path.png)`: the file is copied into the document's asset
  folder (`$DSH_HOME/live-doc/assets/<docId>/`) and served over a fenced GET
  route (`/live-doc/asset`). Image blocks carry a caption and a 25/50/75/100 %
  display width, and embed into the exported `.docx` as real media parts.
  Remote `http(s)` images render in the panel but are never downloaded, so an
  export cannot make a network request.
- **Tables.** A GFM table written by the agent (`| a | b |` + `| --- | --- |`)
  becomes an editable table block: rectangular grid storage, header row,
  add/remove row and column, 500 ms autosave. The `.docx` export emits a real
  `<w:tbl>` with a repeated header row, not a pieced-together paragraph.
- **Outline.** A floating outline of headings 1-3 with scroll-spy highlighting
  and click-to-jump; hidden by default below two headings, toggleable per pane.
- **Tabs and split panes.** Several documents open as tabs; a split view shows
  two of them side by side. A pane that names its document no longer takes over
  the host's active document (`state` gained a non-selecting read), so the two
  panes cannot steal the active document from each other or from the agent
  tools that default to it.
- `doc_append` / `doc_insert` now accept `cwd`-relative image paths and copy
  them in; `doc_replace` can rewrite a table from Markdown while keeping the
  block id.

### Changed

- Word count and document previews include table cell text.
- `retype` refuses to turn a paragraph into an image or a table (those are
  inserted as new blocks), so a stray toolbar click cannot destroy a block.
- The DOCX writer gained table borders, a header shading fill, image content
  types and per-image relationships.

### Fixed

- A panel edit that only changed a table or an image caption was journaled with
  empty before/after text; the journal now records rendered Markdown.

## [1.1.0] — 2026-11-17

### Added

- A left-sidebar entry "协作文档 / Live document" that opens a full-page
  document workspace at any time, even without an active chat session. The
  workspace lists documents, edits blocks, creates documents, and exports,
  using the same host API and edit journal as the floating panel.
- The floating panel and header button remain available for editing beside the
  conversation.

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
