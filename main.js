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
  // Box ("flash") and bracket-text colours are per-theme: the matching pair is
  // chosen from the active window's light/dark mode and re-picked on theme change.
  colorLight: '#fff34d', // box colour in light mode — clean yellow, like Xcode
  colorDark: '#fff34d', // box colour in dark mode
  textLight: '#111111', // bracket text colour during the flash, light mode
  textDark: '#111111', // bracket text colour during the flash, dark mode
  opacity: 1, // full, saturated — blooms then fades to 0
  duration: 600, // ms — total animation; the colour holds before the final fade
  radius: 3, // px — corner rounding of the highlight box (Xcode-style)
};

const PREVIEW_DESC = 'A sample wikilink using the light-mode colours. Replays when settings change or when you press Replay.';
const DARK_PREVIEW_DESC = 'A sample wikilink using the dark-mode colours.';
const RESET_DEFAULTS_DESC = 'Restore the default colours, opacity, duration, and corner radius.';
const SLIDER_SETTINGS_HEADING = 'Flash shape and timing';

const ENABLED_SETTING = {
  name: 'Enable flash',
  desc: 'Animate a highlight when a [[wikilink]] is completed or entered.',
  key: 'enabled',
};

const COLOR_SETTING_GROUPS = [
  {
    heading: 'Light mode',
    items: [
      {
        name: 'Box colour (light)',
        desc: 'Colour of the highlight box in light mode. Default is a vivid yellow, like Xcode.',
        key: 'colorLight',
      },
      {
        name: 'Bracket text colour (light)',
        desc: 'Colour of the [[ ]] characters during the flash in light mode. Use black for light boxes.',
        key: 'textLight',
      },
    ],
  },
  {
    heading: 'Dark mode',
    items: [
      {
        name: 'Box colour (dark)',
        desc: 'Colour of the highlight box in dark mode.',
        key: 'colorDark',
      },
      {
        name: 'Bracket text colour (dark)',
        desc: 'Colour of the [[ ]] characters during the flash in dark mode. Use white for dark boxes (e.g. teal).',
        key: 'textDark',
      },
    ],
  },
];

const SLIDER_SETTINGS = [
  {
    name: 'Opacity',
    desc: 'Starting intensity of the flash before it fades to transparent.',
    key: 'opacity',
    min: 0.1,
    max: 1,
    step: 0.05,
  },
  {
    name: 'Duration',
    desc: 'How long the fade lasts, in milliseconds.',
    key: 'duration',
    min: 120,
    max: 1200,
    step: 20,
  },
  {
    name: 'Corner radius',
    desc: 'Roundness of the highlight box, in pixels.',
    key: 'radius',
    min: 0,
    max: 12,
    step: 1,
  },
];

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
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    // Migrate pre-1.2 single-colour settings into the per-theme pairs, seeding
    // both light and dark from the old value so existing users keep their look.
    if (loaded) {
      if (loaded.color !== undefined) {
        if (loaded.colorLight === undefined) this.settings.colorLight = loaded.color;
        if (loaded.colorDark === undefined) this.settings.colorDark = loaded.color;
      }
      if (loaded.text !== undefined) {
        if (loaded.textLight === undefined) this.settings.textLight = loaded.text;
        if (loaded.textDark === undefined) this.settings.textDark = loaded.text;
      }
      delete this.settings.color;
      delete this.settings.text;
    }
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
    // Light/dark toggle (and theme swaps) fire 'css-change' — re-pick the
    // matching per-theme colours for every styled window.
    this.registerEvent(this.app.workspace.on('css-change', () => this.applyStyle()));
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
    // Each window carries its own theme class, so pick per-doc: a popout can be
    // in a different mode than the main window.
    const dark = doc.body.classList.contains('theme-dark');
    const color = dark ? this.settings.colorDark : this.settings.colorLight;
    const text = dark ? this.settings.textDark : this.settings.textLight;
    const s = doc.body.style;
    s.setProperty('--wikiflash-bg-start', hexToRgba(color, this.settings.opacity));
    s.setProperty('--wikiflash-bg-end', hexToRgba(color, 0));
    s.setProperty('--wikiflash-text', text);
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
    this.previewEls = new Set();
  }

  /** Re-run the flash animation on every preview swatch by toggling the class
   *  (remove → force reflow → add). Each bracket span carries its own
   *  theme-specific `--wikiflash-*` vars, so light and dark previews can render
   *  side by side while still flashing the opening and closing brackets only. */
  replayPreview() {
    const els = Array.from(this.previewEls).filter((el) => el && el.isConnected);
    if (!els.length) return;
    for (const el of els) {
      this.applyPreviewStyle(el, el.dataset.wikiflashPreviewMode);
      el.removeClass('wikiflash-hit');
    }
    void els[0].offsetWidth;
    for (const el of els) el.addClass('wikiflash-hit');
  }

  styleSettingsDoc(doc) {
    if (!doc || !this.plugin.styledDocs) return;
    this.plugin.styledDocs.add(doc);
    this.plugin.applyStyleToDoc(doc);
  }

  applyPreviewStyle(el, mode) {
    const boxKey = mode === 'dark' ? 'colorDark' : 'colorLight';
    const textKey = mode === 'dark' ? 'textDark' : 'textLight';
    const s = el.style;
    s.setProperty('--wikiflash-bg-start', hexToRgba(this.plugin.settings[boxKey], this.plugin.settings.opacity));
    s.setProperty('--wikiflash-bg-end', hexToRgba(this.plugin.settings[boxKey], 0));
    s.setProperty('--wikiflash-text', this.plugin.settings[textKey]);
    s.setProperty('--wikiflash-text-rest', mode === 'dark' ? '#b7b5ac' : '#6f6a60');
    s.setProperty('--wikiflash-duration', this.plugin.settings.duration + 'ms');
    s.setProperty('--wikiflash-radius', this.plugin.settings.radius + 'px');
  }

  createPreviewBracket(frame, mode, text) {
    const el = frame.createSpan({ cls: 'wikiflash-hit wikiflash-preview-bracket', text });
    el.dataset.wikiflashPreviewMode = mode;
    this.applyPreviewStyle(el, mode);
    this.previewEls.add(el);
    return el;
  }

  renderPreview(setting, mode) {
    const dark = mode === 'dark';
    setting.setName(dark ? 'Dark preview' : 'Light preview').setDesc(dark ? DARK_PREVIEW_DESC : PREVIEW_DESC);
    this.styleSettingsDoc(setting.settingEl.ownerDocument);
    const frame = setting.controlEl.createSpan({
      cls: dark ? 'wikiflash-preview-frame wikiflash-preview-frame-dark' : 'wikiflash-preview-frame wikiflash-preview-frame-light',
    });
    const open = this.createPreviewBracket(frame, mode, '[[');
    frame.createSpan({ cls: 'wikiflash-preview-link-text', text: 'WikiFlash' });
    const close = this.createPreviewBracket(frame, mode, ']]');
    return () => {
      this.previewEls.delete(open);
      this.previewEls.delete(close);
    };
  }

  renderPreviewControls(setting) {
    setting.setName('Preview controls').setDesc('Replay both light and dark samples without changing settings.');
    setting.addButton((button) => {
      button
        .setButtonText('Replay previews')
        .setTooltip('Replay both preview animations')
        .onClick(() => this.replayPreview());
    });
  }

  renderResetDefaults(setting) {
    setting.setName('Reset defaults').setDesc(RESET_DEFAULTS_DESC);
    setting.addButton((button) => {
      button
        .setButtonText('Reset')
        .setTooltip('Restore the default WikiFlash appearance')
        .onClick(async () => {
          button.setDisabled(true);
          try {
            await this.resetDefaults();
          } finally {
            button.setDisabled(false);
          }
        });
    });
  }

  async resetDefaults() {
    this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
    await this.plugin.saveSettings();
    this.refreshSettingsView();
  }

  refreshSettingsView() {
    setTimeout(() => {
      if (typeof this.update === 'function') {
        this.update();
      } else if (this.app.setting && typeof this.app.setting.openTabById === 'function') {
        this.app.setting.openTabById(this.id);
      } else if (this.app.setting && typeof this.app.setting.refreshCurrentPage === 'function') {
        this.app.setting.refreshCurrentPage();
      } else {
        this.display();
      }
      setTimeout(() => this.replayPreview(), 0);
    }, 0);
  }

  renderEnabled(setting) {
    setting.setName(ENABLED_SETTING.name).setDesc(ENABLED_SETTING.desc);
    setting.addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
        this.plugin.settings.enabled = value;
        await this.plugin.saveSettings();
        this.replayPreview();
      })
    );
  }

  renderColorSetting(setting, item) {
    setting
      .setName(item.name)
      .setDesc(item.desc)
      .addColorPicker((cp) =>
        cp.setValue(this.plugin.settings[item.key]).onChange(async (value) => {
          this.plugin.settings[item.key] = value;
          await this.plugin.saveSettings();
          this.replayPreview();
        })
      );
  }

  renderSliderSetting(setting, item) {
    setting
      .setName(item.name)
      .setDesc(item.desc)
      .addSlider((slider) =>
        slider
          .setLimits(item.min, item.max, item.step)
          .setValue(this.plugin.settings[item.key])
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings[item.key] = value;
            await this.plugin.saveSettings();
            this.replayPreview();
          })
      );
  }

  // Obsidian 1.13+: declarative settings are searchable in the new Settings UI.
  // Older Obsidian builds ignore this method and use display() below.
  getSettingDefinitions() {
    return [
      {
        name: ENABLED_SETTING.name,
        desc: ENABLED_SETTING.desc,
        aliases: ['enabled', 'toggle flash', 'turn off flash'],
        render: (setting) => this.renderEnabled(setting),
      },
      ...COLOR_SETTING_GROUPS.map((group) => ({
        type: 'group',
        heading: group.heading,
        items: group.items.map((item) => ({
          name: item.name,
          desc: item.desc,
          aliases: [item.key],
          render: (setting) => this.renderColorSetting(setting, item),
        })),
      })),
      {
        name: 'Light preview',
        desc: PREVIEW_DESC,
        searchable: false,
        render: (setting) => this.renderPreview(setting, 'light'),
      },
      {
        name: 'Dark preview',
        desc: DARK_PREVIEW_DESC,
        searchable: false,
        render: (setting) => this.renderPreview(setting, 'dark'),
      },
      {
        name: 'Preview controls',
        desc: 'Replay both light and dark samples without changing settings.',
        aliases: ['replay preview', 'test preview', 'animation preview'],
        render: (setting) => this.renderPreviewControls(setting),
      },
      {
        type: 'group',
        heading: SLIDER_SETTINGS_HEADING,
        items: SLIDER_SETTINGS.map((item) => ({
          name: item.name,
          desc: item.desc,
          aliases: [item.key],
          render: (setting) => this.renderSliderSetting(setting, item),
        })),
      },
      {
        name: 'Reset defaults',
        desc: RESET_DEFAULTS_DESC,
        aliases: ['restore defaults', 'default colours', 'default colors', 'reset colours', 'reset colors'],
        render: (setting) => this.renderResetDefaults(setting),
      },
    ];
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    this.styleSettingsDoc(containerEl.ownerDocument);

    this.renderEnabled(new Setting(containerEl));

    for (const group of COLOR_SETTING_GROUPS) {
      new Setting(containerEl).setName(group.heading).setHeading();
      group.items.forEach((item) => this.renderColorSetting(new Setting(containerEl), item));
    }

    this.renderPreview(new Setting(containerEl), 'light');
    this.renderPreview(new Setting(containerEl), 'dark');
    this.renderPreviewControls(new Setting(containerEl));

    new Setting(containerEl).setName(SLIDER_SETTINGS_HEADING).setHeading();
    SLIDER_SETTINGS.forEach((item) => this.renderSliderSetting(new Setting(containerEl), item));

    this.renderResetDefaults(new Setting(containerEl));
  }
}
