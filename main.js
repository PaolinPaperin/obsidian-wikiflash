'use strict';

/*
 * WikiFlash — Xcode-style yellow flash on wikilink completion.
 *
 * Hand-authored CommonJS (no build step). Obsidian provides `obsidian` and the
 * bundled CodeMirror 6 modules to plugins at runtime via require(), so there is
 * no node_modules / esbuild here — keeps the iCloud-synced vault clean.
 *
 * How it works:
 *   - A StateField holds an ephemeral DecorationSet of `.wikiflash-hit` marks.
 *   - A ViewPlugin watches editor updates. Two triggers, both flashing brackets:
 *       1. CREATION — on a doc change, when the caret sits between a freshly
 *          auto-paired empty pair `[[|]]` (the moment you type `[[` and Obsidian
 *          inserts `]]`). Flashes the opening `[[` and closing `]]` as separate
 *          bracket marks, so text typed inside the link is never covered by an
 *          in-flight creation flash. Doesn't re-fire as you type the name.
 *       2. NAVIGATION — on a pure selection change (no doc edit), when the caret
 *          moves INTO an existing non-empty `[[name]]` (arrow or click). Flashes
 *          the `[[` and `]]` brackets only, leaving the name alone. Fires once on
 *          entry (tracked via the enclosing-link key), not on every move inside.
 *     Both schedule addFlash effects, then removeFlash after the animation. Raw
 *     brackets are drawn whenever the caret is inside the link, so they render.
 *   - Detection is purely positional. It does NOT hook Obsidian's link
 *     suggester, so there is no private-API fragility.
 *
 * Appearance (box colour / bracket text colour / opacity / duration / corner
 * radius) is driven by CSS custom properties set on <body> from the plugin
 * settings; styles.css reads them. The JS clear-timer reads the duration from
 * the live settings too.
 *
 * Scope: Live Preview / source editing (CM6). Not Reading view.
 */

const { Plugin, PluginSettingTab, Setting, Notice } = require('obsidian');
const { StateField, StateEffect } = require('@codemirror/state');
const { Decoration, EditorView, ViewPlugin } = require('@codemirror/view');

// The CSS custom properties we set on each window's <body> (and clear on unload).
const WF_VARS = [
  '--wikiflash-bg-start',
  '--wikiflash-bg-end',
  '--wikiflash-text',
  '--wikiflash-duration',
  '--wikiflash-radius',
];

const DEFAULT_SETTINGS = {
  enabled: true,
  color: '#fff34d', // box colour — clean yellow, like Xcode's brace flash
  text: '#111111', // bracket text colour during the flash (pick white for dark boxes)
  opacity: 1, // full, saturated — blooms then fades to 0
  duration: 600, // ms — total animation; the colour holds before the final fade
  radius: 3, // px — corner rounding of the highlight box (Xcode-style)
};

// Live copy of settings the module-scope ViewPlugin reads (plugin keeps it fresh).
let currentSettings = Object.assign({}, DEFAULT_SETTINGS);

// Effects the ViewPlugin dispatches and the StateField consumes.
const addFlash = StateEffect.define(); // value: { id, from, to }
const removeFlash = StateEffect.define(); // value: id (number)

let nextId = 1;

function bracketRanges(from, to) {
  return [
    { from, to: from + 2 },
    { from: to - 2, to },
  ];
}

/** If the caret sits between a just-created empty bracket pair `[[|]]` (what you
 *  get the instant you type `[[` and Obsidian auto-adds `]]`), return bracket
 *  ranges for the opening `[[` and closing `]]`; otherwise null. */
function detectBracketPair(state) {
  const head = state.selection.main.head;
  if (state.sliceDoc(head - 2, head) !== '[[') return null;
  if (state.sliceDoc(head, head + 2) !== ']]') return null;
  return bracketRanges(head - 2, head + 2);
}

/** The `[[...]]` token strictly enclosing the caret on its line, or null.
 *  `empty` is true for `[[]]`. */
function findEnclosingWikilink(state) {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const re = /\[\[([^\[\]\n]*)\]\]/g;
  let m;
  while ((m = re.exec(line.text)) !== null) {
    const from = line.from + m.index;
    const to = from + m[0].length;
    if (head > from && head < to) return { from, to, empty: m[1].length === 0 };
  }
  return null;
}

/** Dispatch effects only if the view is still live — a flash timer can fire
 *  after its pane was closed, and dispatching into a torn-down view throws. */
function safeDispatch(view, effects) {
  if (!view.dom || !view.dom.isConnected) return;
  try {
    view.dispatch({ effects });
  } catch (e) {
    /* view was torn down between the guard and dispatch — ignore */
  }
}

/** Flash each given { from, to } range: add marks now (next tick), then retire
 *  them after the animation. Each range gets its own id. */
function scheduleFlash(view, ranges) {
  if (!ranges.length) return;
  const ids = ranges.map(() => nextId++);
  const clearDelay = currentSettings.duration + 60;
  setTimeout(() => {
    safeDispatch(view, ranges.map((r, i) => addFlash.of({ id: ids[i], from: r.from, to: r.to })));
    setTimeout(() => {
      safeDispatch(view, ids.map((id) => removeFlash.of(id)));
    }, clearDelay);
  }, 0);
}

const wikiFlashField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    // Keep any in-flight flash pinned to its text as the doc edits around it.
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addFlash)) {
        const mark = Decoration.mark({
          class: 'wikiflash-hit',
          attributes: { 'data-wikiflash-id': String(e.value.id) },
        });
        deco = deco.update({ add: [mark.range(e.value.from, e.value.to)], sort: true });
      } else if (e.is(removeFlash)) {
        const id = String(e.value);
        deco = deco.update({
          filter: (from, to, value) =>
            !value.spec ||
            !value.spec.attributes ||
            value.spec.attributes['data-wikiflash-id'] !== id,
        });
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function linkKey(link) {
  return link ? link.from + ':' + link.to : null;
}

const wikiFlashDetector = ViewPlugin.fromClass(
  class {
    constructor(view) {
      // Seed the enclosing-link key so opening a note with the caret already
      // inside a link doesn't spuriously flash on the first update.
      this.lastLinkKey = linkKey(findEnclosingWikilink(view.state));
    }

    update(update) {
      if (!currentSettings.enabled) return;
      // IME safety: never react mid-composition (Italian accents etc.).
      if (update.view.composing) return;

      // 1) CREATION: typing `[[` auto-pairs to `[[]]` — flash only brackets.
      if (update.docChanged) {
        const pairRanges = detectBracketPair(update.state);
        if (pairRanges) scheduleFlash(update.view, pairRanges);
      }

      // 2) NAVIGATION: a pure cursor move into an existing non-empty link —
      //    flash its `[[` and `]]` brackets once on entry.
      const link = findEnclosingWikilink(update.state);
      const key = linkKey(link);
      if (
        update.selectionSet &&
        !update.docChanged &&
        key !== this.lastLinkKey &&
        link &&
        !link.empty
      ) {
        scheduleFlash(update.view, bracketRanges(link.from, link.to));
      }
      // Always keep the key in sync (incl. after edits shift positions).
      this.lastLinkKey = key;
    }
  }
);

function hexToRgba(hex, alpha) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return `rgba(255, 243, 77, ${alpha})`;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

module.exports = class WikiFlashPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    currentSettings = this.settings;

    // Style the main window plus any popout windows already open. Each window
    // has its own document, so the custom properties must be set on each.
    this.styledDocs = new Set([document]);
    this.app.workspace.iterateAllLeaves((leaf) => {
      const doc = leaf.view && leaf.view.containerEl && leaf.view.containerEl.ownerDocument;
      if (doc) this.styledDocs.add(doc);
    });
    this.registerEvent(
      this.app.workspace.on('window-open', (workspaceWindow, win) => {
        this.styledDocs.add(win.document);
        this.applyStyleToDoc(win.document);
      })
    );
    this.registerEvent(
      this.app.workspace.on('window-close', (workspaceWindow, win) => {
        this.clearStyleFromDoc(win.document);
        this.styledDocs.delete(win.document);
      })
    );
    this.applyStyle();

    this.registerEditorExtension([wikiFlashField, wikiFlashDetector]);
    this.addSettingTab(new WikiFlashSettingTab(this.app, this));

    // Lets you preview the flash without typing a link — flashes the brackets of
    // the link the caret is in (purely visual; never edits the note).
    this.addCommand({
      id: 'test-flash',
      name: 'Test flash',
      editorCallback: (editor) => {
        const view = editor.cm;
        if (!view) return;
        const link = findEnclosingWikilink(view.state);
        if (!link) {
          new Notice('Place the cursor inside a [[link]] to test the flash.');
          return;
        }
        scheduleFlash(view, bracketRanges(link.from, link.to));
      },
    });
  }

  onunload() {
    if (this.styledDocs) for (const doc of this.styledDocs) this.clearStyleFromDoc(doc);
  }

  applyStyle() {
    for (const doc of this.styledDocs) this.applyStyleToDoc(doc);
  }

  applyStyleToDoc(doc) {
    if (!doc || !doc.body) return;
    const s = doc.body.style;
    s.setProperty('--wikiflash-bg-start', hexToRgba(this.settings.color, this.settings.opacity));
    s.setProperty('--wikiflash-bg-end', hexToRgba(this.settings.color, 0));
    s.setProperty('--wikiflash-text', this.settings.text);
    s.setProperty('--wikiflash-duration', this.settings.duration + 'ms');
    s.setProperty('--wikiflash-radius', this.settings.radius + 'px');
  }

  clearStyleFromDoc(doc) {
    if (!doc || !doc.body) return;
    const s = doc.body.style;
    WF_VARS.forEach((p) => s.removeProperty(p));
  }

  async saveSettings() {
    await this.saveData(this.settings);
    currentSettings = this.settings;
    this.applyStyle();
  }
};

class WikiFlashSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Re-run the flash animation on the preview swatch by toggling the class
   *  (remove → force reflow → add). The swatch reads the same `--wikiflash-*`
   *  vars `applyStyle` just set, so it mirrors the current settings. */
  replayPreview() {
    const el = this.previewEl;
    if (!el) return;
    el.removeClass('wikiflash-hit');
    void el.offsetWidth;
    el.addClass('wikiflash-hit');
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const preview = new Setting(containerEl)
      .setName('Preview')
      .setDesc('A sample flash using your current settings. Replays when you change a value below.');
    this.previewEl = preview.controlEl.createSpan({ cls: 'wikiflash-hit', text: '[[ ]]' });

    new Setting(containerEl)
      .setName('Enable flash')
      .setDesc('Animate a highlight when a [[wikilink]] is completed.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
          this.plugin.settings.enabled = v;
          await this.plugin.saveSettings();
          this.replayPreview();
        })
      );

    new Setting(containerEl)
      .setName('Box colour')
      .setDesc('Colour of the highlight box. Default is a vivid yellow, like Xcode.')
      .addColorPicker((cp) =>
        cp.setValue(this.plugin.settings.color).onChange(async (v) => {
          this.plugin.settings.color = v;
          await this.plugin.saveSettings();
          this.replayPreview();
        })
      );

    new Setting(containerEl)
      .setName('Bracket text colour')
      .setDesc('Colour of the [[ ]] characters during the flash. Use white for dark boxes (e.g. teal), black for light ones.')
      .addColorPicker((cp) =>
        cp.setValue(this.plugin.settings.text).onChange(async (v) => {
          this.plugin.settings.text = v;
          await this.plugin.saveSettings();
          this.replayPreview();
        })
      );

    new Setting(containerEl)
      .setName('Opacity')
      .setDesc('Starting intensity of the flash before it fades to transparent.')
      .addSlider((sl) =>
        sl
          .setLimits(0.1, 1, 0.05)
          .setValue(this.plugin.settings.opacity)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.opacity = v;
            await this.plugin.saveSettings();
            this.replayPreview();
          })
      );

    new Setting(containerEl)
      .setName('Duration')
      .setDesc('How long the fade lasts, in milliseconds.')
      .addSlider((sl) =>
        sl
          .setLimits(120, 1200, 20)
          .setValue(this.plugin.settings.duration)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.duration = v;
            await this.plugin.saveSettings();
            this.replayPreview();
          })
      );

    new Setting(containerEl)
      .setName('Corner radius')
      .setDesc('Roundness of the highlight box, in pixels.')
      .addSlider((sl) =>
        sl
          .setLimits(0, 12, 1)
          .setValue(this.plugin.settings.radius)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.radius = v;
            await this.plugin.saveSettings();
            this.replayPreview();
          })
      );
  }
}
