# WikiFlash

An [Obsidian](https://obsidian.md) plugin that briefly flashes a wikilink's
`[[ ]]` brackets — the same momentary cue Xcode gives when you close a `{}` block
and it flashes the matching brace.

It fires in two situations:

- **When you create a link** — the instant you type `[[` and Obsidian auto-adds
  the closing `]]`, the brackets flash.
- **When you navigate into a link** — moving the cursor into an existing
  `[[wikilink]]` (arrow keys or a click) flashes its `[[` and `]]`, leaving the
  link text untouched.

The flash pops to full colour, holds briefly, then fades smoothly back to the
brackets' resting colour — no jarring snap.

## Settings

Everything is customizable under **Settings → WikiFlash**:

| Setting | What it does |
|---|---|
| **Enable flash** | Master on/off. |
| **Box colour** | Colour of the highlight box (default: a vivid yellow, like Xcode). |
| **Bracket text colour** | Colour of the `[[ ]]` characters during the flash. Use white for a dark box, black for a light one. |
| **Opacity** | Starting intensity before the fade. |
| **Duration** | How long the flash lasts, in milliseconds. |
| **Corner radius** | Roundness of the highlight box. |

Respects your system **Reduce motion** setting (no animation when enabled).

## How it works

WikiFlash adds a small CodeMirror 6 editor extension: a `StateField` holds an
ephemeral set of highlight decorations, and a `ViewPlugin` detects link creation
(a doc change producing an empty `[[]]`) and link navigation (a cursor move into
an existing link). It never modifies your note content — the highlight is a
purely visual overlay that is added and then removed on a timer.

It works in **Live Preview** and **Source** editing modes. It does not hook
Obsidian's link suggester, so there's no reliance on private APIs.

## Installation

### From the Community Plugins browser (once published)

Settings → Community plugins → Browse → search for **WikiFlash** → Install →
Enable.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [latest release](../../releases/latest).
2. Copy them into `<your vault>/.obsidian/plugins/wikiflash/`.
3. Reload Obsidian, then enable **WikiFlash** under Settings → Community plugins.

## Development

This plugin is hand-authored CommonJS — there is **no build step**. Obsidian
provides the `obsidian` and `@codemirror/*` modules at runtime, so `main.js` is
the source you edit directly. To work on it, copy `main.js`, `manifest.json`,
and `styles.css` into a vault's `.obsidian/plugins/wikiflash/` folder and use
**Reload plugin** while iterating.

## License

[MIT](LICENSE)
