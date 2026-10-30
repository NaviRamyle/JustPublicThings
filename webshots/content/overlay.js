// The on-page picker: hover to highlight, click an element or drag an area,
// and the capture is copied to the clipboard.
(() => {
  const W = (globalThis.Webshots ||= {});
  if (W.toggle) return;

  const MODES = [
    { id: 'text', label: 'Text', title: 'Markdown-style text. Smallest output; tables become Markdown tables.' },
    { id: 'html', label: 'HTML', title: 'Cleaned-up HTML structure.' },
    { id: 'css', label: 'HTML + CSS', title: 'HTML plus the styles that change how it looks.' },
  ];
  const DRAG_START = 6; // px the pointer must move before a click becomes a drag
  const LARGE = 120000; // characters (~30k tokens)
  const TOAST_MS = 8000;

  const CSS = `
    * { box-sizing: border-box; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .shield { position: fixed; inset: 0; cursor: crosshair; pointer-events: auto; }
    .box, .sel { position: fixed; display: none; pointer-events: none; border: 2px solid #2563eb; background: rgba(37, 99, 235, .12); }
    .sel { border-style: dashed; background: rgba(37, 99, 235, .08); }
    .tag { position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px; padding: 2px 6px; border-radius: 4px;
      background: #2563eb; color: #fff; font-size: 11px; white-space: nowrap; }
    .flip .tag { bottom: auto; top: 100%; margin: 4px 0 0; }
    .bar { position: fixed; top: 12px; left: 0; right: 0; width: max-content; margin: 0 auto; display: flex; align-items: center; gap: 8px;
      padding: 6px; border-radius: 10px; background: #111827; color: #f9fafb; pointer-events: auto;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .3); max-width: calc(100vw - 24px); flex-wrap: wrap; }
    .bar.bottom { top: auto; bottom: 12px; }
    .seg { display: flex; padding: 2px; border-radius: 8px; background: #374151; }
    button { all: unset; cursor: pointer; padding: 5px 10px; border-radius: 6px; color: inherit; white-space: nowrap; }
    button:hover { background: rgba(255, 255, 255, .12); }
    button:focus-visible { outline: 2px solid #60a5fa; outline-offset: 1px; }
    .seg button[aria-pressed="true"] { background: #f9fafb; color: #111827; }
    .hint { padding: 0 4px; color: #9ca3af; font-size: 12px; }
    .x { padding: 5px 8px; }
    .toast { position: fixed; right: 16px; bottom: 16px; width: 340px; max-width: calc(100vw - 32px); padding: 12px 14px;
      border-radius: 10px; background: #111827; color: #f9fafb; pointer-events: auto; box-shadow: 0 8px 24px rgba(0, 0, 0, .3); }
    .toast .x { position: absolute; top: 6px; right: 6px; }
    .title { padding-right: 24px; font-weight: 600; }
    .meta { margin-top: 2px; color: #9ca3af; font-size: 12px; }
    .warn { margin-top: 6px; color: #fbbf24; font-size: 12px; }
    .actions { display: flex; gap: 6px; margin-top: 10px; }
    .actions button { background: #374151; }
    .actions button:hover { background: #4b5563; }
    .offscreen { position: fixed; left: -9999px; top: 0; opacity: 0; }
  `;

  const storage = globalThis.chrome?.storage?.local;
  let mode = 'text';
  let ui = null;

  W.toggle = () => {
    const picking = ui?.picking;
    close();
    if (!picking) open();
  };

  function h(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    parent?.append(e);
    return e;
  }

  function open() {
    const host = document.createElement('webshots-overlay');
    const hostStyle = {
      position: 'fixed', inset: '0', width: '100%', height: '100%', 'max-width': 'none', 'max-height': 'none',
      margin: '0', padding: '0', border: '0', background: 'transparent', overflow: 'visible',
      display: 'block', 'z-index': '2147483647', 'pointer-events': 'none',
    };
    for (const [k, v] of Object.entries(hostStyle)) host.style.setProperty(k, v, 'important');
    // Built with DOM calls and an adopted stylesheet so strict page CSPs don't block it
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];

    const shield = h('div', 'shield', root);
    const box = h('div', 'box', root);
    const boxTag = h('span', 'tag', box);
    const sel = h('div', 'sel', root);
    const selTag = h('span', 'tag', sel);
    const bar = h('div', 'bar', root);
    const seg = h('div', 'seg', bar);
    const modeButtons = MODES.map(m => {
      const b = h('button', '', seg, m.label);
      b.title = m.title;
      b.dataset.mode = m.id;
      b.onclick = () => setMode(m.id);
      return b;
    });
    const visible = h('button', '', bar, 'Visible area');
    visible.title = 'Capture everything you can see in the window';
    h('span', 'hint', bar, 'Click an element or drag an area · ↑ ↓ parent/child · Esc to cancel');
    const x = h('button', 'x', bar, '✕');
    x.title = 'Cancel (Esc)';
    x.setAttribute('aria-label', 'Cancel');

    // Inside an open modal <dialog> the rest of the page is inert, so attach there instead
    let parent = document.documentElement;
    try { parent = document.querySelector('dialog:modal') || parent; } catch {}
    host.setAttribute('popover', 'manual');
    parent.appendChild(host);
    // The top layer keeps the overlay above the page's own dialogs and popovers
    try { host.showPopover(); } catch {}

    ui = { host, root, shield, box, boxTag, sel, selTag, bar, modeButtons, picking: true, target: null, hit: null, stack: [], drag: null, frame: 0, timer: 0 };
    W.overlayHost = host;

    shield.addEventListener('pointermove', onMove);
    shield.addEventListener('pointerdown', onDown);
    shield.addEventListener('pointerup', onUp);
    visible.onclick = () => captureRegion(new DOMRect(0, 0, innerWidth, innerHeight), `visible area ${innerWidth}×${innerHeight}`);
    x.onclick = close;
    addEventListener('keydown', onKey, true);
    addEventListener('scroll', onScroll, true);

    setMode(mode, false);
    storage?.get('mode', r => r?.mode && ui?.picking && setMode(r.mode, false));
  }

  function setMode(id, save = true) {
    if (!MODES.some(m => m.id === id)) return;
    mode = id;
    ui?.modeButtons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === id)));
    if (save) storage?.set({ mode: id });
  }

  // ---------- Picking ----------

  function elementAt(x, y) {
    const topmost = scope => scope.elementsFromPoint(x, y).find(e => e !== ui.host);
    let el = topmost(document);
    // Look inside web components
    for (let i = 0; el && i < 20; i++) {
      const sr = W.shadowOf(el);
      const inner = sr && topmost(sr);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el === document.documentElement ? null : el;
  }

  function place(node, r) {
    Object.assign(node.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    node.classList.toggle('flip', r.top < 24);
  }

  function setTarget(el) {
    ui.target = el;
    if (!el) {
      ui.box.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    place(ui.box, r);
    ui.boxTag.textContent = `${W.describe(el)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  const dragRect = (d, e) =>
    new DOMRect(Math.min(d.x, e.clientX), Math.min(d.y, e.clientY), Math.abs(e.clientX - d.x), Math.abs(e.clientY - d.y));

  // Move the toolbar to the other edge when the pointer comes near it
  function keepBarAway(x, y) {
    const r = ui.bar.getBoundingClientRect();
    if (x < r.left - 40 || x > r.right + 40) return;
    const atBottom = ui.bar.classList.contains('bottom');
    if (!atBottom && y < r.bottom + 24) ui.bar.classList.add('bottom');
    else if (atBottom && y > r.top - 24) ui.bar.classList.remove('bottom');
  }

  function onMove(e) {
    const { drag } = ui;
    if (drag) {
      if (!drag.active && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > DRAG_START) {
        drag.active = true;
        ui.box.style.display = 'none';
      }
      if (drag.active) {
        const r = dragRect(drag, e);
        place(ui.sel, r);
        ui.selTag.textContent = `${Math.round(r.width)}×${Math.round(r.height)}`;
      }
      return;
    }
    keepBarAway(e.clientX, e.clientY);
    ui.point = [e.clientX, e.clientY];
    if (!ui.frame) {
      ui.frame = requestAnimationFrame(() => {
        if (!ui?.picking) return;
        ui.frame = 0;
        const hit = elementAt(...ui.point);
        if (hit !== ui.hit) {
          ui.hit = hit;
          ui.stack = [];
          setTarget(hit);
        }
      });
    }
  }

  function onDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    ui.drag = { x: e.clientX, y: e.clientY, active: false };
    ui.shield.setPointerCapture(e.pointerId);
  }

  function onUp(e) {
    const d = ui.drag;
    ui.drag = null;
    if (!d) return;
    if (!d.active) {
      if (ui.target) captureElement(ui.target);
      return;
    }
    const r = dragRect(d, e);
    if (r.width < 4 || r.height < 4) ui.sel.style.display = 'none';
    else captureRegion(r);
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (!ui.picking) return;
    else if (e.key === 'ArrowUp' && ui.target) {
      const parent = ui.target.parentElement || ui.target.getRootNode().host;
      if (!parent || parent === document.documentElement) return;
      ui.stack.push(ui.target);
      setTarget(parent);
    } else if (e.key === 'ArrowDown' && ui.stack.length) setTarget(ui.stack.pop());
    else if (e.key === 'Enter' && ui.target) captureElement(ui.target);
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onScroll() {
    if (ui?.picking && ui.target) setTarget(ui.target);
  }

  // ---------- Capturing ----------

  function captureElement(el) {
    run({ root: el, region: null, selection: `element ${W.describe(el)}` });
  }

  function captureRegion(r, label) {
    const where = `area ${Math.round(r.width)}×${Math.round(r.height)} px at (${Math.round(r.left)}, ${Math.round(r.top)})`;
    run({ root: W.regionRoot(r), region: r, selection: label || where });
  }

  function endPicking() {
    cancelAnimationFrame(ui.frame);
    removeEventListener('scroll', onScroll, true);
    for (const el of [ui.shield, ui.box, ui.sel, ui.bar]) el.remove();
    ui.picking = false;
  }

  async function run(sel) {
    endPicking();
    let result;
    try {
      result = W.snapshot({ ...sel, mode });
    } catch (err) {
      console.error('[Webshots]', err);
      toast({ error: String(err?.message || err) });
      return;
    }
    if (result.empty) {
      toast({ error: 'Nothing visible was found in that selection.' });
      return;
    }
    toast({ result, copied: await copy(result.text) });
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
    // Fallback for pages that block the async clipboard API
    if (!ui) return false;
    const ta = h('textarea', 'offscreen', ui.root);
    ta.value = text;
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }

  const pad2 = n => String(n).padStart(2, '0');
  const fileStamp = (d = new Date()) =>
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;

  function download({ text, ext }) {
    const a = h('a', '', ui.root);
    a.href = URL.createObjectURL(new Blob([text], { type: ext === 'md' ? 'text/markdown' : 'text/html' }));
    a.download = `webshot-${(location.hostname || 'page').replace(/[^\w.-]/g, '_')}-${fileStamp()}.${ext}`;
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  function toast({ result, copied, error }) {
    if (!ui) return;
    const t = h('div', 'toast', ui.root);
    t.setAttribute('role', 'status');
    if (error) {
      h('div', 'title', t, 'Nothing captured');
      h('div', 'meta', t, error);
    } else {
      const n = result.text.length;
      const title = h('div', 'title', t, copied ? 'Copied to clipboard' : 'Ready, but the page blocked copying');
      const label = MODES.find(m => m.id === mode).label;
      h('div', 'meta', t, `${label} · ${n.toLocaleString()} characters · ~${Math.ceil(n / 4).toLocaleString()} tokens`);
      if (n > LARGE) h('div', 'warn', t, 'That’s a lot for Copilot. Try Text mode or a smaller selection.');
      const actions = h('div', 'actions', t);
      h('button', '', actions, 'Copy again').onclick = async () => {
        title.textContent = (await copy(result.text)) ? 'Copied to clipboard' : 'Copy failed. Use Download instead.';
      };
      h('button', '', actions, `Download .${result.ext}`).onclick = () => download(result);
    }
    const x = h('button', 'x', t, '✕');
    x.setAttribute('aria-label', 'Close');
    x.onclick = close;
    // Hide after a while, unless the pointer is on it
    ui.timer = setTimeout(close, TOAST_MS);
    t.onpointerenter = () => clearTimeout(ui?.timer);
    t.onpointerleave = () => ui && (ui.timer = setTimeout(close, TOAST_MS / 2));
  }

  function close() {
    if (!ui) return;
    cancelAnimationFrame(ui.frame);
    clearTimeout(ui.timer);
    removeEventListener('keydown', onKey, true);
    removeEventListener('scroll', onScroll, true);
    ui.host.remove();
    ui = null;
    W.overlayHost = null;
  }
})();
