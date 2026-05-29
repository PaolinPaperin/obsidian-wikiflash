# AGENTS.md — WikiFlash (Obsidian plugin)

A small Obsidian plugin that flashes a wikilink's `[[ ]]` brackets, Xcode-style.
This file is the source of truth for how to work on it and how to publish it.

- **GitHub repo:** `obsidian-wikiflash` (public). Resolve the owner/URL at runtime
  with `git remote -v` or `gh repo view` — do not hardcode it here.
- **Plugin id:** `wikiflash` · **name:** WikiFlash
- **Current version:** 1.0.0 · **minAppVersion:** 1.4.0

## What it does

Two triggers, both flashing only the **brackets** (never the link text):

1. **Creation** — the instant you type `[[` and Obsidian auto-adds `]]`, the empty
   `[[]]` flashes.
2. **Navigation** — moving the caret into an existing non-empty `[[link]]` (arrow
   or click) flashes its `[[` and `]]`, once on entry.

Animation is pop → hold → fade. The bracket text fades from the chosen colour
back to the theme's natural bracket colour (`--text-faint`) in sync with the box,
with `animation-fill-mode: forwards`, so there is **no snap** at the end.

## Files

| File | Role | Publish? |
|---|---|---|
| `main.js` | the whole plugin (hand-authored) | ✅ ship + release asset |
| `manifest.json` | metadata | ✅ ship + release asset |
| `styles.css` | flash CSS | ✅ ship + release asset |
| `versions.json` | `{ "1.0.0": "1.4.0" }` (version → minAppVersion) | ✅ in repo |
| `README.md`, `LICENSE` | required by the store | ✅ in repo |
| `data.json` | a USER'S settings — **gitignored, never publish** | ❌ |

## Architecture (no build step!)

Hand-authored **CommonJS**. There is **no esbuild / TypeScript / node_modules**.
Obsidian provides `obsidian` and the `@codemirror/*` modules at runtime via
`require()`, so `main.js` IS the source — edit it directly.

- `wikiFlashField` (CM6 `StateField`) holds an ephemeral `DecorationSet` of
  `.wikiflash-hit` marks; consumes `addFlash` / `removeFlash` effects.
- `wikiFlashDetector` (CM6 `ViewPlugin`) runs the two triggers; tracks the
  enclosing-link key so navigation fires once on entry.
- `scheduleFlash` adds marks next tick, retires them after `duration+60ms`.
- `safeDispatch` skips dispatch if the view was torn down (closed pane).
- Appearance is driven by CSS custom properties set on `<body>` in `applyStyle`
  (`--wikiflash-bg-start/-end`, `--wikiflash-text`, `--wikiflash-duration`,
  `--wikiflash-radius`); `styles.css` reads them. Cleaned up in `onunload`.
- Settings: `enabled`, `color` (box), `text` (bracket text), `opacity`,
  `duration`, `radius`.

## Rendering gotchas (learned the hard way)

- In **Live Preview**, a *resolved* `[[link]]` is replaced by a pill; the brackets
  are NOT in the DOM. Brackets are raw/visible only when the link is **empty**
  (`[[]]`), being composed (suggester open), or the caret is **inside** a revealed
  link. The creation flash works because empty `[[]]` is always raw.
- **Programmatic caret moves do NOT trigger Obsidian's bracket-reveal** — only
  real arrow/click input does. So scripted DOM checks of the *navigation* flash
  are unreliable; verify navigation **logic** deterministically and test the
  *render* by hand.
- The natural bracket colour is `var(--text-faint)` (e.g. `#B7B5AC` in the Minimal
  theme). The fade targets that var so the return to rest is seamless.

## Dev / test workflow

The live/install copy lives in the vault at `<your-vault>/.obsidian/plugins/wikiflash/`
(an iCloud-synced Obsidian vault). Edit there to iterate, then copy `main.js` +
`manifest.json` + `styles.css` back into this repo (and vice-versa). Keep
`node_modules`/`.git` OUT of the iCloud vault.

Use the `obsidian` CLI (Obsidian must be running):
- `obsidian plugin:reload id=wikiflash` after editing `main.js`/`styles.css`.
- `obsidian dev:errors [clear]` to check for JS errors.
- `obsidian eval code='…'` to inspect/exercise the editor.
- `obsidian dev:screenshot path=/tmp/x.png` for visuals.

**Testing rule (important):** `obsidian eval` that inserts/moves the caret acts on
the *active* note. The vault owner edits live, so **always guard**: create a
dedicated scratch note (e.g. `__wfX.md`), operate ONLY if the active file is that
scratch path, then **delete it** afterward. **Restore any setting you change for
testing** (e.g. a temporarily long `duration`). A scripted test once nearly wrote
into a real note — don't repeat that.

## Security posture — keep it this way

No network, no filesystem (beyond Obsidian's sandboxed `loadData`/`saveData`), no
`child_process`/`eval`/`Function`, no `innerHTML`, **zero dependencies**. Every
dispatch is **effects-only** — the plugin NEVER mutates note content. The single
regex is linear (no ReDoS). The store now **auto-scans every version** for
security + quality, so preserve these properties on every change.

## Publishing — the CURRENT process (as of May 2026)

⚠️ The old "open a PR to `obsidianmd/obsidian-releases`" flow is **RETIRED**.
Submission is now the **Developer Dashboard** at **community.obsidian.md** with
automated review (code-quality + security, results in minutes, in-app within ~24h
on pass). Every version is auto-reviewed, not just the first.

**Division of labor:**
- **Codex can** create the GitHub release (below).
- **Only the repo owner can** do the dashboard submission — it needs their
  **Obsidian account** login in the browser. Steps for them: community.obsidian.md
  → sign in → link GitHub → **Plugins → New plugin** → paste the repo URL → agree
  to policies → **Submit**. The dashboard reads `manifest.json` from the default
  branch HEAD.

### Cutting a release (Codex does this)
1. Bump `version` in `manifest.json` (SemVer) and add the entry to `versions.json`.
2. Commit + push to `main`.
3. `gh release create <version> main.js manifest.json styles.css --title "<version>" --notes "…"`
   - **Tag = the version exactly, NO `v` prefix** (e.g. `1.0.1`).
   - Attach the three files as **individual assets** (not a zip).
4. Verify: `gh release view <version> --json tagName,assets`.

### Resubmitting after review feedback
Fix in the repo → **increment the version** → cut a new release → the dashboard
re-reviews. There is no separate "update" PR.

## Conventions
- Public repo: end commit messages with the `Co-Authored-By: Codex …` trailer.
- Commit/push only when the owner asks.
- Don't add a build step or dependencies without a strong reason — the no-build
  simplicity is intentional (clean vault, trivial review surface).
