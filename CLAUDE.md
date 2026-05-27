# CLAUDE.md

Obsidian plugin: an Apple Notes-style drill-down file explorer. Runs on both mobile and desktop.

## Build

- `npm run build` — type-checks and bundles `src/` into `main.js` (the shipped artifact).
- `npm run dev` — esbuild watch mode.
- Source lives in `src/`. The committed `main.js` is the built output and must be rebuilt and committed whenever `src/` changes.

## Releases

Releases are fully automated by `.github/workflows/release.yml`. Do not bump versions or create tags/releases by hand — the workflow owns the version.

- **Every push to `main` bumps the patch version and publishes a GitHub Release**, unless the commit message contains `[skip ci]` (GitHub then skips the workflow run entirely).
- On each release the workflow: increments the patch in `manifest.json` and `package.json`, adds the new version to `versions.json`, rebuilds `main.js`, commits the bump back to `main`, creates a matching tag (e.g. `1.0.7` — no `v` prefix, to satisfy Obsidian's release contract), and attaches `main.js`, `manifest.json`, and `styles.css` to the Release.
- To ship a change, just merge it to `main`. To merge something without releasing (docs, CI tweaks), put `[skip ci]` in the merge/squash commit message.

Prerequisite: the workflow pushes to `main` with the default `GITHUB_TOKEN`, so the repo needs "Read and write permissions" under Settings → Actions → General → Workflow permissions, and no branch protection that blocks the Actions bot from pushing to `main`.

## Git workflow

Always `git fetch origin` before checking status or comparing with remote. The local repo may be behind if the CI workflow pushed version bumps.
