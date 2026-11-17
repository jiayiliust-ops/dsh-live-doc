# Contributing

Thanks for taking the time to improve `dsh-live-doc`. This file covers the
development loop and the checks a pull request should pass.

## Ground rules

- Keep the plugin **dependency-free**. `package.json` must not gain a
  `dependencies` block; the host uses only Node built-ins and the browser half
  only the host's React module table.
- Keep the source **plain ESM / plain browser JavaScript**. There is no build
  step, and there should not be one unless the format forces it.
- Write JSDoc on exported functions and on non-obvious private helpers. Match the
  existing style: two-space indentation, semicolons, single quotes.
- All user-visible browser text goes through the `T` dictionary in
  `src/client/index.js`; add both `ZH` and `EN` entries.
- Do not add network calls, telemetry, or filesystem scans.

## Development loop

```bash
git clone https://github.com/jiayiliust-ops/dsh-live-doc.git
cd dsh-live-doc
npm test
```

To try it inside a running Harness:

1. Install this directory as a bundle (DSH Desktop: **Plugins → Add plugin** with
   the absolute directory path, or `dsh plugin --profile web add <dir>`).
2. Reload the browser page once. The panel registers in `shell.overlay`.
3. After changing host code, **restart DSH** (or re-enable the plugin row). Node
   caches imported ESM modules, so re-enabling alone may keep an older
   `store.js` alive even though `index.js` was re-imported.
4. After changing `src/client/index.js`, reload the page.

Use `DSH_LIVE_DOC_DIR=/tmp/live-doc-dev` while iterating so test documents do not
mix with your real ones.

## What to test manually

- Create a document, append three paragraphs, edit one in the panel, then
  `doc_read` — the read must list the edit with before/after.
- Edit the same paragraph while the agent rewrites it; your text must survive and
  the next read must flag the conflict.
- Insert in the middle (`doc_insert after=<id>`); the following paragraph must
  keep its id.
- Export `.docx` and open it in Word (or run the `test/docx.test.js` checks); check
  headings, bullets, numbering, and that Chinese text is not mojibake.
- Export `.md` after a `.docx` export, then export with no path: it must still
  target the `.docx` file.

## Pull requests

- One focused change per PR.
- Run `npm test`; add a test for every behavior change in the store, the DOCX
  writer, or the manifest.
- Update `CHANGELOG.md` under an `Unreleased` heading.
- If the change is user-visible, update both READMEs.
- Describe what you verified manually and what remains unverified.

## Reporting bugs

Include the DSH version (`dsh --version` or the Desktop About box), the Node
version, the panel screenshot if relevant, and the document JSON if it does not
contain private text. Security issues: see [SECURITY.md](SECURITY.md).
