// Turns the tree built by capture.js into Text (Markdown), HTML, or HTML + CSS.
(() => {
  const W = (globalThis.Webshots ||= {});
  if (W.render) return;

  const isEl = n => n.text == null;
  const IND = '\u0001'; // indentation that survives line trimming
  const PRE = '\u0002'; // placeholder for preformatted blocks
  const BR = '\u0003'; // "start a new line" from a block; several in a row still make one line break
  const TABLE_ROLE = /^(grid|table|treegrid)$/;
  const CELL_ROLE = /^(gridcell|cell|columnheader|rowheader)$/;
  const VOID = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'wbr']);
  const NO_INLINE = new Set(['svg', 'canvas', 'iframe', 'select', 'textarea', 'pre', 'video', 'audio', 'object']);

  const escText = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = s => escText(s).replace(/"/g, '&quot;');
  const plain = n => (isEl(n) ? (n.tag === 'br' ? '\n' : n.kids.map(plain).join('')) : n.text);
  const size = n => (n.size ? `${n.size[0]}×${n.size[1]}` : '');

  // ---------- Text (Markdown) ----------

  function renderText(ir) {
    const st = { pre: [] };
    return tidy(md(ir, st, {}))
      .replace(/\u0002(\d+)\u0002/g, (_, i) => st.pre[i])
      .replace(/\u0001/g, ' ')
      .replace(/ +$/gm, '');
  }

  function tidy(s, tight = false) {
    return s
      .replace(/[\s\u0003]*\u0003[\s\u0003]*/g, m => ((m.match(/\n/g) || []).length > 1 ? '\n\n' : '\n'))
      .split('\n')
      .map(l => l.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(tight ? /\n{2,}/g : /\n{3,}/g, tight ? '\n' : '\n\n')
      .trim();
  }

  const oneLine = s => tidy(s, true).replace(/\n/g, ' ');

  // o.pre: keep whitespace; o.cell: inside a table cell, keep it to one line
  function md(n, st, o) {
    if (!isEl(n)) return o.pre ? n.text : n.text.replace(/\s+/g, ' ');
    const sub = n.pre ? { ...o, pre: true } : o;
    const kids = () => n.kids.map(k => md(k, st, sub)).join('');
    const role = n.attrs.role || '';

    switch (n.tag) {
      case 'br': return '\n';
      case 'hr': return '\n\n---\n\n';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const t = oneLine(kids());
        return o.cell || !t ? t : `\n\n${'#'.repeat(+n.tag[1])} ${t}\n\n`;
      }
      case 'p': return `\n\n${kids()}\n\n`;
      case 'pre': {
        const code = plain(n).replace(/^\n+|\s+$/g, '');
        if (o.cell) return oneLine(code);
        st.pre.push('```\n' + code + '\n```');
        return `\n\n${PRE}${st.pre.length - 1}${PRE}\n\n`;
      }
      case 'code': {
        if (o.pre) return kids();
        const t = oneLine(kids());
        return t && '`' + t + '`';
      }
      case 'blockquote': return `\n\n${tidy(kids()).split('\n').map(l => `> ${l}`).join('\n')}\n\n`;
      case 'a': return link(n, kids(), o);
      case 'img': return image(n);
      case 'svg': return graphic(n);
      case 'canvas': return `[canvas ${size(n)}: drawn pixels, content not captured]`;
      case 'video': case 'audio': return `[${n.tag}]`;
      case 'embed': case 'object': return '[embedded content]';
      case 'progress': case 'meter': return `[${n.tag}: ${n.info.value} of ${n.info.max}]`;
      case 'iframe':
        return n.info?.crossOrigin
          ? `${BR}[iframe from another site, not captured${n.attrs.src ? `: ${n.attrs.src}` : ''}]${BR}`
          : `${BR}${kids()}${BR}`;
      case 'input': case 'select': case 'textarea': return field(n, o);
      case 'button': return button(n, kids());
      case 'ul': case 'ol': return list(n, st, sub);
      case 'table':
        if (role !== 'presentation' && role !== 'none') {
          const t = table(n, st);
          if (t) return t;
        }
        break;
    }
    if (TABLE_ROLE.test(role) && n.tag !== 'table') {
      const t = ariaTable(n, st);
      if (t) return t;
    }
    if (role === 'button' && !o.cell) return button(n, kids());

    const d = n.display || 'block';
    if (d === 'contents' || d.startsWith('inline')) return kids();
    if (d === 'table-cell') return ` ${kids()} `;
    if (n.row && !sub.pre) return row(n, st, sub);
    return `${BR}${kids()}${BR}`;
  }

  // Flex rows: items side by side on one line
  function row(n, st, o) {
    const parts = n.kids.map(k => ({ el: isEl(k), t: tidy(md(k, st, o), true) })).filter(p => p.t);
    if (parts.some(p => p.t.includes('\n'))) return `${BR}${parts.map(p => p.t).join('\n')}${BR}`;
    const sep = n.spaced ? ' | ' : ' ';
    return `${BR}${parts.map((p, i) => (i ? (p.el && parts[i - 1].el ? sep : ' ') : '') + p.t).join('')}${BR}`;
  }

  function link(n, inner, o) {
    const href = n.attrs.href || '';
    const text = tidy(inner);
    const label = text || n.attrs['aria-label'] || n.attrs.title || '';
    if (!href || href.startsWith('#') || o.cell || !label) return inner || label;
    if (text.includes('\n')) return `${BR}${text}\n(link: ${href})${BR}`;
    return `${/^\s/.test(inner) ? ' ' : ''}[${label}](${href})${/\s$/.test(inner) ? ' ' : ''}`;
  }

  function image(n) {
    const alt = (n.attrs.alt || n.attrs.title || n.attrs['aria-label'] || '').trim();
    if (alt) return `[image: ${alt}]`;
    const [w = 0, h = 0] = n.size || [];
    return w >= 48 && h >= 48 ? `[image ${w}×${h}]` : '';
  }

  // SVG charts keep their text (axis labels, values); icons keep their label
  function graphic(n) {
    const { texts = [], label = '' } = n.info || {};
    if (texts.length) return `${BR}[graphic${label ? ` "${label}"` : ''} ${size(n)}, text inside: ${texts.join(' · ')}]${BR}`;
    return label ? `[icon: ${label}]` : '';
  }

  function button(n, inner) {
    const text = oneLine(inner);
    if (text.length > 80) return `${BR}${inner}${BR}`; // a big clickable card, not a button label
    const label = n.attrs['aria-label'] || text || n.attrs.title || '';
    return label ? `[button: ${label}]` : '';
  }

  function field(n, o) {
    const f = n.info || {};
    const t = f.type;
    const label = !f.hasLabelEl && f.label ? f.label : '';
    if (t === 'checkbox' || t === 'radio') {
      const box = t === 'checkbox' ? (f.checked ? '[x]' : '[ ]') : f.checked ? '(•)' : '( )';
      return label && !o.cell ? ` ${box} ${label} ` : ` ${box} `;
    }
    if (/^(submit|button|reset|image)$/.test(t)) return ` [button: ${f.value || label || t}] `;
    const value = (f.value || '').replace(/\s+/g, ' ').trim();
    if (o.cell) return value;
    const kind = t === 'select' || t === 'textarea' ? t : t === 'text' ? 'input' : `input ${t}`;
    return ` [${kind}${label ? ` "${label}"` : ''}: ${value || '(empty)'}] `;
  }

  function list(n, st, o) {
    let i = parseInt(n.attrs.start, 10) || 1;
    const items = [];
    for (const k of n.kids) {
      if (!isEl(k)) continue;
      const body = tidy(md(k, st, o), true);
      if (!body) continue;
      const marker = k.tag === 'li' ? (n.tag === 'ol' ? `${i++}. ` : '- ') : '';
      const pad = IND.repeat(marker.length || 2);
      items.push(body.split('\n').map((l, j) => (j ? (l ? pad + l : l) : marker + l)).join('\n'));
    }
    return items.length ? `\n\n${items.join('\n')}\n\n` : '';
  }

  // ---------- Tables ----------

  const cellText = (c, st, pipes = true) => {
    const t = oneLine(md(c, st, { cell: true }));
    return pipes ? t.replace(/\|/g, '\\|') : t;
  };

  // rows: [{ head, cells: [string] }]. The first header row becomes the Markdown header.
  function mdTable(rows) {
    rows = rows.filter(r => r.cells.length);
    if (!rows.length) return '';
    const n = Math.max(...rows.map(r => r.cells.length));
    const top = [];
    while (rows.length && rows[0].head) top.push(rows.shift());
    const header = top.shift();
    // Extra header rows (e.g. filter rows) only matter if they have text
    const body = [...top.filter(r => r.cells.some(Boolean)), ...rows];
    const line = cells => `| ${Array.from({ length: n }, (_, i) => cells[i] ?? '').join(' | ')} |`;
    return [line(header ? header.cells : []), `|${' --- |'.repeat(n)}`, ...body.map(r => line(r.cells))].join('\n');
  }

  // Merged cells can't be shown in Markdown, so those tables stay as minimal HTML
  function htmlTable(rows, st) {
    const span = (c, a) => (c.attrs[a] > 1 ? ` ${a}="${c.attrs[a]}"` : '');
    const tr = r =>
      `<tr>${r.cells.map(c => `<${c.tag}${span(c, 'colspan')}${span(c, 'rowspan')}>${escText(cellText(c, st, false))}</${c.tag}>`).join('')}</tr>`;
    return ['<table>', ...rows.filter(r => r.cells.length).map(tr), '</table>'].join('\n');
  }

  function table(n, st) {
    const rows = [];
    let caption = '';
    (function collect(node, head) {
      for (const k of node.kids) {
        if (!isEl(k) || k.tag === 'table') continue;
        if (k.tag === 'tr') rows.push({ head, cells: k.kids.filter(c => c.tag === 'td' || c.tag === 'th') });
        else if (k.tag === 'caption') caption = oneLine(md(k, st, {}));
        else collect(k, head || k.tag === 'thead');
      }
    })(n, false);
    if (!rows.some(r => r.cells.length)) return '';
    const title = caption ? `Table: ${caption}\n` : '';
    if (rows.some(r => r.cells.some(c => c.attrs.colspan > 1 || c.attrs.rowspan > 1))) {
      return `\n\n${title}${htmlTable(rows, st)}\n\n`;
    }
    const parsed = rows.map(r => ({
      head: r.head || (r.cells.length > 0 && r.cells.every(c => c.tag === 'th')),
      cells: r.cells.map(c => cellText(c, st)),
    }));
    return `\n\n${title}${mdTable(parsed)}\n\n`;
  }

  function findAll(n, test, out = []) {
    for (const k of n.kids || []) {
      if (!isEl(k)) continue;
      if (test(k)) out.push(k);
      else if (k.tag !== 'table' && !TABLE_ROLE.test(k.attrs.role || '')) findAll(k, test, out);
    }
    return out;
  }

  // Div-based data grids (AG Grid, MUI, ...). Pinned columns live in separate containers,
  // so row parts with the same aria-rowindex are merged and sorted by aria-colindex.
  function ariaTable(n, st) {
    const rows = findAll(n, k => k.attrs.role === 'row');
    if (!rows.length) return '';
    const byIndex = new Map();
    const order = [];
    for (const r of rows) {
      const idx = r.attrs['aria-rowindex'];
      const key = idx ?? Symbol();
      let entry = byIndex.get(key);
      if (!entry) {
        entry = { idx: idx != null ? +idx : null, cells: [] };
        byIndex.set(key, entry);
        order.push(entry);
      }
      entry.cells.push(...findAll(r, k => CELL_ROLE.test(k.attrs.role || '')));
    }
    if (order.every(e => e.idx != null)) order.sort((a, b) => a.idx - b.idx);
    const out = order.map(e => {
      if (e.cells.every(c => c.attrs['aria-colindex'])) e.cells.sort((a, b) => a.attrs['aria-colindex'] - b.attrs['aria-colindex']);
      return {
        head: e.cells.length > 0 && e.cells.every(c => c.attrs.role === 'columnheader'),
        cells: e.cells.map(c => cellText(c, st)),
      };
    });
    const t = mdTable(out);
    return t && `\n\n${t}\n\n`;
  }

  // ---------- HTML ----------

  const decls = n => (n.styles || []).map(([p, v]) => `${p}: ${v}`).join('; ');

  function renderHTML(ir, withStyles) {
    const r = { withStyles, classes: withStyles ? sharedStyles(ir) : new Map() };
    const lines = [];
    emit(ir, 0, lines, r);
    const css = [...r.classes].map(([d, name]) => `.${name} { ${d} }`);
    return (css.length ? `<style>\n${css.join('\n')}\n</style>\n` : '') + lines.join('\n');
  }

  // Styles used by more than one element become classes, so repeated rows stay small
  function sharedStyles(ir) {
    const count = new Map();
    (function walk(n) {
      if (!isEl(n)) return;
      const d = decls(n);
      if (d) count.set(d, (count.get(d) || 0) + 1);
      n.kids.forEach(walk);
    })(ir);
    const classes = new Map();
    for (const [d, c] of count) if (c > 1) classes.set(d, `ws${classes.size + 1}`);
    return classes;
  }

  function openTag(n, r) {
    const attrs = { ...n.attrs };
    const f = n.info;
    if (n.tag === 'input' && f) {
      if (f.type === 'checkbox' || f.type === 'radio') {
        if (f.checked) attrs.checked = '';
      } else if (f.value) {
        attrs.value = f.value;
      }
    }
    if (n.size && /^(img|svg|canvas|video|iframe|embed|object)$/.test(n.tag)) [attrs.width, attrs.height] = n.size;
    if (r.withStyles) {
      const d = decls(n);
      if (r.classes.has(d)) attrs.class = [attrs.class, r.classes.get(d)].filter(Boolean).join(' ');
      else if (d) attrs.style = d;
    }
    const a = Object.entries(attrs).map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escAttr(v)}"`));
    return `<${n.tag}${a.join('')}>`;
  }

  function emit(n, depth, lines, r) {
    const pad = '  '.repeat(depth);
    if (!isEl(n)) {
      const t = n.text.replace(/\s+/g, ' ').trim();
      if (t) lines.push(pad + escText(t));
      return;
    }
    const open = openTag(n, r);
    const close = `</${n.tag}>`;
    const f = n.info || {};
    switch (n.tag) {
      case 'svg': {
        const inner = (f.texts || []).map(t => `<text>${escText(t)}</text>`);
        if (f.label && !n.attrs['aria-label']) inner.unshift(`<title>${escText(f.label)}</title>`);
        if (inner.length <= 1) lines.push(pad + open + inner.join('') + close);
        else lines.push(pad + open, ...inner.map(t => `${pad}  ${t}`), pad + close);
        return;
      }
      case 'canvas':
        lines.push(`${pad}${open}${close} <!-- drawn pixels, not captured -->`);
        return;
      case 'textarea':
        lines.push(pad + open + escText(f.value || '') + close);
        return;
      case 'pre':
        lines.push(pad + open + escText(plain(n)) + close);
        return;
      case 'select':
        lines.push(
          pad + open,
          ...(f.options || []).map(
            o => `${pad}  <option${o.value !== o.text ? ` value="${escAttr(o.value)}"` : ''}${o.selected ? ' selected' : ''}>${escText(o.text)}</option>`,
          ),
          ...(f.moreOptions ? [`${pad}  <!-- ${f.moreOptions} more options -->`] : []),
          pad + close,
        );
        return;
      case 'iframe':
        if (f.crossOrigin) {
          lines.push(`${pad}${open}${close} <!-- from another site, not captured -->`);
        } else {
          lines.push(`${pad}<!-- iframe${n.attrs.src ? ` ${escText(n.attrs.src)}` : ''} -->`);
          n.kids.forEach(k => emit(k, depth, lines, r));
        }
        return;
    }
    if (VOID.has(n.tag)) {
      lines.push(pad + open);
      return;
    }
    const inline = inlineHTML(n, r, true);
    if (inline != null && inline.length <= 200) {
      lines.push(pad + open + inline + close);
      return;
    }
    lines.push(pad + open);
    n.kids.forEach(k => emit(k, depth + 1, lines, r));
    lines.push(pad + close);
  }

  // Short runs of text and inline elements stay on one line: <td><a href="…">Order 1</a></td>
  function inlineHTML(n, r, top) {
    let out = '';
    for (const k of n.kids) {
      if (!isEl(k)) {
        out += escText(k.text.replace(/\s+/g, ' '));
        continue;
      }
      if (NO_INLINE.has(k.tag) || !(k.display || '').startsWith('inline')) return null;
      if (VOID.has(k.tag)) {
        out += openTag(k, r);
        continue;
      }
      const inner = inlineHTML(k, r, false);
      if (inner == null) return null;
      out += openTag(k, r) + inner + `</${k.tag}>`;
    }
    out = out.replace(/ {2,}/g, ' ');
    return top ? out.trim() : out;
  }

  // ---------- Snapshot = header + body ----------

  const pad2 = n => String(n).padStart(2, '0');
  const stamp = (d = new Date()) =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

  W.render = { text: renderText, html: ir => renderHTML(ir, false), css: ir => renderHTML(ir, true) };

  W.snapshot = ({ root, region = null, selection, mode = 'text' }) => {
    const { ir, truncated } = W.capture({ root, region, styles: mode === 'css' });
    const body = W.render[mode](ir);
    const info = [`URL: ${W.cleanUrl(location.href)}`];
    if (document.title.trim()) info.push(`Title: ${document.title.trim()}`);
    info.push(`Captured: ${stamp()}`, `Selection: ${selection}`);
    if (mode === 'css') info.push(`Viewport: ${innerWidth}×${innerHeight}`);
    if (truncated) info.push('Note: very large selection, the output was cut off');
    const text =
      mode === 'text'
        ? `${info.join('\n')}\n\n${body}\n`
        : `<!--\n${info.map(l => l.replace(/--/g, '- -')).join('\n')}\n-->\n${body}\n`;
    return { text, ext: mode === 'text' ? 'md' : 'html', empty: !body.trim() };
  };
})();
