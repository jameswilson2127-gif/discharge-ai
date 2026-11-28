// invpdf.js — builds a small A4 PDF (title, patient box, tables) directly in the browser,
// so "Download investigations PDF" works without a print dialog or any outside library.
// Uses the built-in Helvetica fonts (WinAnsi), so it stays tiny and needs no font files.

const W = 595.28, H = 841.89, M = 36; // A4 in points, margin
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,
  278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,
  944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,
  278,556,500,722,500,500,500,334,260,334,584];
// Characters outside Latin-1 that WinAnsi still has.
const WIN = { "–": 0x96, "—": 0x97, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "…": 0x85, "€": 0x80, "™": 0x99 };

function clean(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim()
    .replace(/[↑]/g, "H").replace(/[↓]/g, "L").replace(/[≥]/g, ">=").replace(/[≤]/g, "<=").replace(/[×]/g, "x")
    // µ, ³ and ² are missing from some PDF viewers' stand-in fonts: write them the way lab reports type them.
    .replace(/[µμ]/g, "u").replace(/³/g, "^3").replace(/²/g, "^2");
}
function charCode(ch) {
  if (WIN[ch]) return WIN[ch];
  const c = ch.charCodeAt(0);
  return c < 256 ? c : 63; // "?"
}
function width(s, size, bold) {
  let w = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? HELV[c - 32] : 556;
  }
  return (w / 1000) * size * (bold ? 1.06 : 1);
}
function wrap(s, max, size, bold) {
  const words = clean(s).split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (width(t, size, bold) <= max || !cur) cur = t;
    else { lines.push(cur); cur = w; }
    // a single very long word: hard-break it
    while (width(cur, size, bold) > max && cur.length > 1) {
      let i = cur.length - 1;
      while (i > 1 && width(cur.slice(0, i), size, bold) > max) i--;
      lines.push(cur.slice(0, i)); cur = cur.slice(i);
    }
  }
  if (cur || !lines.length) lines.push(cur);
  return lines;
}
const pdfStr = (s) => `(${[...s].map((ch) => {
  const c = charCode(ch);
  if (c === 40 || c === 41 || c === 92) return "\\" + ch;
  return String.fromCharCode(c);
}).join("")})`;

/**
 * @param {{title:string, subtitle?:string, patient?:[string,string][], tables:{head:string[], rows:string[][]}[], footer?:string}} d
 * @returns {Blob}
 */
export function invPdf(d) {
  const pages = [];
  let ops = [], y = H - M;
  const newPage = () => { if (ops.length) pages.push(ops.join("\n")); ops = []; y = H - M; };
  const text = (s, x, yy, size, bold) => ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${yy.toFixed(2)} Td ${pdfStr(s)} Tj ET`);
  const line = (x1, y1, x2, y2) => ops.push(`${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  const fill = (x, yy, w, h) => ops.push(`0.94 0.95 0.95 rg ${x.toFixed(2)} ${yy.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 g`);
  const avail = W - 2 * M;

  // Title
  const centre = (s, size, bold) => { s = clean(s); text(s, (W - width(s, size, bold)) / 2, y - size, size, bold); y -= size + 6; };
  centre(d.title || "INVESTIGATIONS", 15, true);
  if (d.subtitle) centre(d.subtitle, 10.5, true);
  y -= 6;

  // Generic table drawer with wrapping, header repeat and page breaks.
  const drawTable = (head, rows, widths, size = 9, headFill = true) => {
    const pad = 3.5, lh = size * 1.25;
    const rowLines = (cells, bold) => cells.map((c, i) => wrap(c, widths[i] - 2 * pad, size, bold));
    const rowH = (ls) => Math.max(...ls.map((l) => l.length)) * lh + 2 * pad;
    const drawRow = (cells, bold, shade) => {
      const ls = rowLines(cells, bold), h = rowH(ls);
      if (y - h < M + 20) { newPage(); if (head && !bold) drawRow(head, true, headFill); }
      let x = M;
      if (shade) fill(M, y - h, widths.reduce((a, b) => a + b, 0), h);
      ops.push("0.5 w 0.55 G");
      ls.forEach((cl, i) => {
        cl.forEach((t, k) => text(t, x + pad, y - pad - size * 0.95 - k * lh, size, bold));
        line(x, y, x, y - h);
        x += widths[i];
      });
      line(x, y, x, y - h); line(M, y, x, y); line(M, y - h, x, y - h);
      y -= h;
    };
    if (head) drawRow(head, true, headFill);
    for (const r of rows) drawRow(r, false, false);
    y -= 10;
  };

  // Patient box: 3 columns of "Label: value"
  if (d.patient && d.patient.length) {
    const cells = d.patient.map(([k, v]) => `${clean(k)}: ${clean(v) || "______________"}`);
    const rows = [];
    for (let i = 0; i < cells.length; i += 3) rows.push([cells[i] || "", cells[i + 1] || "", cells[i + 2] || ""]);
    drawTable(null, rows, [avail / 3, avail / 3, avail / 3], 9.5, false);
  }

  for (const t of d.tables) {
    const n = t.head.length || (t.rows[0] || []).length;
    if (!n) continue;
    const size = n > 6 ? 8 : 9;
    // First column fits its longest label (within limits); the rest share the remaining width.
    const firstW = Math.min(Math.max(...[t.head[0] || "", ...t.rows.map((r) => r[0] || "")].map((s) => width(clean(s), size, true))) + 10, avail * (n > 3 ? 0.34 : 0.4));
    const widths = n === 1 ? [avail] : [Math.max(firstW, 70), ...Array(n - 1).fill((avail - Math.max(firstW, 70)) / (n - 1))];
    drawTable(t.head, t.rows, widths, size);
  }

  if (d.footer) { const s = clean(d.footer); if (y < M + 24) newPage(); text(s, M, M - 4 + 8, 7.5, false); }
  newPage();

  // Assemble the PDF file.
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const pagesId = objs.length + 1 + pages.length * 2 + 1; // placeholder, fixed below
  const kids = [];
  const pageObjs = pages.map((content, i) => {
    const total = pages.length;
    const withNo = `${content}\nBT /F1 7.5 Tf ${(W - M - 40).toFixed(2)} ${(M - 18).toFixed(2)} Td ${pdfStr(`Page ${i + 1} of ${total}`)} Tj ET`;
    const c = add(`<< /Length ${withNo.length} >>\nstream\n${withNo}\nendstream`);
    const p = add(`__PAGE__${c}`);
    kids.push(p);
    return p;
  });
  const pagesObj = add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);
  for (const p of pageObjs) {
    const c = Number(objs[p - 1].slice(8));
    objs[p - 1] = `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`;
  }
  void pagesId;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return new Blob([bytes], { type: "application/pdf" });
}
