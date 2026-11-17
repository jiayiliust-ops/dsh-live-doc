# Publishing

This repository is ready to publish as `dsh-live-doc` on npm and as a GitHub
repository. The metadata already points at `jiayiliust-ops`; change the three
URLs in `package.json` (`repository`, `homepage`, `bugs`) and the README install
commands if you publish under a different account.

## 1. Push to GitHub

The repository is initialized with the first commit on `main`.

```bash
# create an empty repository named dsh-live-doc on GitHub first, then:
git remote add origin git@github.com:jiayiliust-ops/dsh-live-doc.git
git push -u origin main
git tag v1.0.0
git push origin v1.0.0
```

Check the rendered README and `docs/hero.svg` on GitHub. The repository should
show CI green after the first push (Node 22.19 and 24).

## 2. Publish to npm

The name `dsh-live-doc` is unscoped and was free when this was written; verify
before publishing:

```bash
npm view dsh-live-doc version   # expect a 404 until the first publish
npm login
npm publish --access public
```

`publishConfig.access` is already `public`, and the package has no install
scripts, no dependencies, and no build step.

Verify from a clean directory:

```bash
npm view dsh-live-doc version
npm pack dsh-live-doc --dry-run
```

## 3. Install the published package

```bash
dsh plugin --profile web add dsh-live-doc
```

Or in DSH Desktop: **Plugins → Add plugin** → `dsh-live-doc`. Reload the page once
so the browser half registers.

## 4. Release checklist

- [ ] `npm test` passes.
- [ ] `npm pack --dry-run` lists `src`, `locale`, `docs`, `icon.svg`,
      `cordis.patch.yml`, `README.md`, `LICENSE`, `CHANGELOG.md`.
- [ ] Version bumped in `package.json`, `CHANGELOG.md` updated.
- [ ] Git tag matches the npm version.
- [ ] Installed from the published package in a clean profile; created a
      document, edited a paragraph, read the edit back, exported `.docx`, opened
      it in Word.
- [ ] The plugin page shows the localized title, description, and icon.

## 5. Later versions

```bash
npm version patch|minor|major
# update CHANGELOG.md and commit
git push && git push --tags
npm publish
```

Keep the `dsh.compatibility.dsh` range in `package.json` honest: it currently
declares `>=0.2.1-rc.2 <0.3.0-0`, which is the range the Host and browser APIs in
this plugin were written against.

## What not to publish

- The local `dsh-live-doc-*.tgz` (ignored by `.gitignore`; regenerate with
  `npm pack` when testing the tarball install path).
- Personal document data under `~/.dsh/live-doc/`; it is never in the package.
- Screenshots containing chats, names, or user avatars.
