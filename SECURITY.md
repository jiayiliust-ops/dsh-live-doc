# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | yes |
| < 1.0 | no |

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** on
<https://github.com/jiayiliust-ops/dsh-live-doc/security/advisories/new>.
Do not open a public issue for a vulnerability.

Include the DSH version, the plugin version, a minimal reproduction, and the
impact you believe it has. We aim to acknowledge within a few days and to ship a
fix or a mitigation note in the next release.

## Threat model

`dsh-live-doc` is a local Harness plugin with one browser surface:

- **Host half** — registers the `doc_*` tools, the `/live-doc/api/*` route, and
  one system-prompt section. It reads and writes JSON document files and export
  files, all through the DSH process's own permissions.
- **Browser half** — a panel in `shell.overlay` plus a session-header button. It
  calls the same-origin route with `fetch` and an `x-live-doc: 1` header.

The route checks:

1. the request method is `POST`;
2. a present `Origin` header equals the Harness web origin;
3. `x-live-doc: 1` is present (a custom header that cross-site forms cannot set).

The route sits behind DSH's normal browser authentication. There is no network
access, no telemetry, and no credential handling.

## In scope

- Cross-site request forgery against `/live-doc/api/*`.
- HTML injection through document content (the sanitizer must keep only the
  inline vocabulary: `strong`, `b`, `em`, `i`, `u`, `s`, `del`, `code`, `br`, `a`
  with `http(s)`/`mailto` hrefs).
- Path escapes that let a browser request write somewhere the DSH process could
  not otherwise write, or read arbitrary files.
- Denial of service through the route, such as unbounded request bodies or
  unbounded edit journals.

## Out of scope

- The plugin exporting to a path the agent or the authenticated user asks for.
- Documents containing text the user typed; they are local files under
  `$DSH_HOME/live-doc/`.
- Vulnerabilities in DeepSeek Harness itself or in Microsoft Word.
- DOCX layout differences from Microsoft Word.

## Hardening notes

- Request bodies are capped at 2 MB.
- The edit journal keeps at most 200 entries per document and each snippet at
  most 8,000 characters.
- Document files are written atomically (temporary file + rename).
- The sanitizer drops unknown tags, attributes, and non-web link schemes.
