# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The plugin glyph no longer inflates the header.** `DocumentIcon` was written
  to take a pixel number but three call sites rendered it as a component
  (`h(DocumentIcon, { size })`), so `width`/`height` received a props object, the
  `<svg>` lost its intrinsic size and stretched to fill its flex row: the panel
  header grew to several hundred pixels, with a giant icon where a 15 px glyph
  belongs. It now takes props with a default, every call site matches, and the
  header is back to a single 46 px row (42 px in the empty state, 18 px in the
  sidebar row).

### Changed

- **The panel's own title row is gone while a document is open.** Its buttons
  (新建 / 分栏 / 紧凑, and the document picker when the tab strip is collapsed)
  moved into the document title row, which doubles as the drag handle for the
  floating panel — drag it to move, double-click to reset — and the window
  controls (maximize, close) sit at the end of that row. The title row only
  appears for the empty panel and for split view, where one pane is too narrow
  to carry the panel controls. The panel now starts with the document title, so
  the top of the panel is one row shorter.
- **Collapsing is row-based; widths are proportional.** No region remembers a
  pixel height any more, so a reflow can no longer leave a scrolling band, a
  half-cut row or a blank gap behind:
  - the tab strip disappears as a whole — a single open document never shows
    one, and a collapsed strip swaps in a document picker in the header;
  - the formatting toolbar folds as a whole, from the pane's title row or from
    its grip;
  - the document takes exactly the height a hidden row freed.
- **The outline and the page are kept as percentages** of the space around
  them: the outline is `clamp(120px, 18%, 340px)` of the body, the page is
  `clamp(420px, 95%, 1400px)` of what is left beside the outline. Hiding the
  outline gives its share back to the page, and resizing the window or the
  floating panel re-divides both instead of keeping old pixels. Both dividers
  still adjust them, and the values are stored in `dsh.liveDoc.layout`.
- Every grip also answers a plain click, and a **Compact** button collapses the
  tab strip and the toolbar together. A first-run hint names the regions.

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
