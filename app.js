/* ============================================================
   Toolkit: Metadata stripper · QR generator · PDF -> PNGs
   Pure client-side. Libraries come from CDNs (see index.html).
   ============================================================ */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/* ---------- shared helpers ---------- */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) => {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < 2);
  return n.toFixed(n < 10 ? 2 : 1) + ' ' + u[i];
};
const getExt = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const baseName = (name) => (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name);
const ascii = (u8, i, n) => String.fromCharCode(...u8.subarray(i, i + n));
function concat(parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
function wireDrop(el, onFiles) {
  ['dragenter', 'dragover'].forEach((e) => el.addEventListener(e, (ev) => { ev.preventDefault(); el.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((e) => el.addEventListener(e, (ev) => { ev.preventDefault(); el.classList.remove('over'); }));
  el.addEventListener('drop', (ev) => onFiles([...ev.dataTransfer.files]));
}

/* ---------- tabs ---------- */
function showTab(id) {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.panel === id));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === id));
}
$$('.tab').forEach((b) => b.addEventListener('click', () => {
  showTab(b.dataset.panel);
  history.replaceState(null, '', '#' + b.dataset.panel);
}));
if (['strip', 'qr', 'pdf'].includes(location.hash.slice(1))) showTab(location.hash.slice(1));

/* ============================================================
   1) METADATA STRIPPER
   Each stripper takes a Uint8Array and returns a Uint8Array.
   ============================================================ */

/* ----- JPEG: drop APPn (EXIF/XMP/IPTC/Photoshop…) + COM; keep ICC profile + Adobe APP14 ----- */
function stripJpeg(u8) {
  const out = [u8.subarray(0, 2)];
  let i = 2;
  while (i < u8.length) {
    if (u8[i] !== 0xFF) { out.push(u8.subarray(i)); break; }
    const m = u8[i + 1];
    if (m === 0xFF) { i++; continue; }
    if (m === 0xD9 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { out.push(u8.subarray(i, i + 2)); i += 2; continue; }
    if (m === 0xDA) { out.push(u8.subarray(i)); break; } // start of scan: rest is image data
    const len = (u8[i + 2] << 8) | u8[i + 3];
    const end = i + 2 + len;
    let keep = true;
    if (m >= 0xE1 && m <= 0xEF) {
      keep = false;
      if (m === 0xE2 && ascii(u8, i + 4, 11) === 'ICC_PROFILE') keep = true;
      if (m === 0xEE && ascii(u8, i + 4, 5) === 'Adobe') keep = true;
    }
    if (m === 0xFE) keep = false; // comments
    if (keep) out.push(u8.subarray(i, end));
    i = end;
  }
  return concat(out);
}

/* ----- PNG: keep only structural/color chunks ----- */
function stripPng(u8) {
  const keep = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT']);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [u8.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= u8.length) {
    const len = dv.getUint32(i);
    const type = ascii(u8, i + 4, 4);
    const end = i + 12 + len;
    if (keep.has(type)) out.push(u8.subarray(i, end));
    i = end;
    if (type === 'IEND') break; // also drops any trailing junk
  }
  return concat(out);
}

/* ----- GIF: drop comment / plain-text / non-NETSCAPE application extensions ----- */
function stripGif(u8) {
  const out = [];
  let i = 0;
  out.push(u8.subarray(0, 6)); i = 6;
  const packed = u8[i + 4];
  let lsdLen = 7;
  if (packed & 0x80) lsdLen += 3 * (1 << ((packed & 7) + 1));
  out.push(u8.subarray(i, i + lsdLen)); i += lsdLen;
  const skipSub = (p) => { while (u8[p] !== 0 && p < u8.length) p += u8[p] + 1; return p + 1; };
  while (i < u8.length) {
    const b = u8[i];
    if (b === 0x3B) { out.push(u8.subarray(i, i + 1)); break; }
    if (b === 0x21) {
      const label = u8[i + 1];
      let end;
      if (label === 0xFF) {
        const isNet = ascii(u8, i + 3, 11).startsWith('NETSCAPE') || ascii(u8, i + 3, 11).startsWith('ANIMEXTS');
        end = skipSub(i + 2); // sub-blocks start with block-size byte (11)
        if (isNet) out.push(u8.subarray(i, end));
      } else {
        end = skipSub(i + 2);
        if (label === 0xF9) out.push(u8.subarray(i, end)); // graphic control (timing/transparency)
      }
      i = end;
    } else if (b === 0x2C) {
      const p = u8[i + 9];
      let hdr = 10;
      if (p & 0x80) hdr += 3 * (1 << ((p & 7) + 1));
      const end = skipSub(i + hdr + 1);
      out.push(u8.subarray(i, end));
      i = end;
    } else { break; }
  }
  return concat(out);
}

/* ----- RIFF (WebP / WAV): drop chosen chunks, fix sizes + VP8X flags ----- */
function stripRiff(u8, drop, isWebp) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const parts = [];
  let i = 12;
  while (i + 8 <= u8.length) {
    const id = ascii(u8, i, 4);
    const size = dv.getUint32(i + 4, true);
    const end = Math.min(u8.length, i + 8 + size + (size & 1));
    if (!drop.has(id)) {
      let chunk = u8.slice(i, end);
      if (isWebp && id === 'VP8X') chunk[8] &= ~(0x08 | 0x04); // clear EXIF + XMP flags
      parts.push(chunk);
    }
    i = end;
  }
  const body = concat(parts);
  const head = u8.slice(0, 12);
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  return concat([head, body]);
}

/* ----- MP4 / MOV / M4A / 3GP: blank udta/meta/uuid/XMP_ in place + zero timestamps.
        Boxes are overwritten as 'free' of the SAME size so chunk offsets stay valid. ----- */
function stripMp4(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const containers = new Set(['moov', 'trak', 'mdia']);
  const wipeNames = new Set(['udta', 'meta', 'uuid', 'XMP_']);
  const wipe = (i, size, hdr) => {
    u8.fill(0, i + hdr, i + size);
    u8[i + 4] = 0x66; u8[i + 5] = 0x72; u8[i + 6] = 0x65; u8[i + 7] = 0x65; // 'free'
  };
  const zeroTimes = (i, hdr) => {
    const v = u8[i + hdr];
    const n = v === 1 ? 16 : 8;
    u8.fill(0, i + hdr + 4, i + hdr + 4 + n);
  };
  const walk = (start, end, parent) => {
    let i = start;
    while (i + 8 <= end) {
      let size = dv.getUint32(i);
      const type = ascii(u8, i + 4, 4);
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(i + 8)); hdr = 16; }
      else if (size === 0) size = end - i;
      if (size < hdr || i + size > end) break;
      if (wipeNames.has(type) && (type !== 'meta' || parent !== 'top')) wipe(i, size, hdr);
      else if (type === 'meta' && parent === 'top') wipe(i, size, hdr);
      else if (type === 'mvhd' || type === 'tkhd' || type === 'mdhd') zeroTimes(i, hdr);
      else if (containers.has(type)) walk(i + hdr, i + size, type);
      i += size;
    }
  };
  walk(0, u8.length, 'top');
  return u8;
}

/* ----- MP3: strip ID3v2 (head) + ID3v1 (tail) ----- */
function stripMp3(u8) {
  let s = 0, e = u8.length;
  if (ascii(u8, 0, 3) === 'ID3') {
    const size = (u8[6] << 21) | (u8[7] << 14) | (u8[8] << 7) | u8[9];
    s = 10 + size + ((u8[5] & 0x10) ? 10 : 0);
  }
  if (e - s >= 128 && ascii(u8, e - 128, 3) === 'TAG') e -= 128;
  return u8.slice(s, e);
}

/* ----- PDF via pdf-lib: delete Info dict + XMP ----- */
async function stripPdf(u8) {
  const { PDFDocument, PDFName } = PDFLib;
  const doc = await PDFDocument.load(u8, { updateMetadata: false, ignoreEncryption: true });
  doc.setTitle(''); doc.setAuthor(''); doc.setSubject(''); doc.setKeywords([]);
  doc.setProducer(''); doc.setCreator('');
  try { doc.catalog.delete(PDFName.of('Metadata')); } catch (_) {}
  try {
    const info = doc.context.trailerInfo.Info;
    if (info) { doc.context.delete(info); delete doc.context.trailerInfo.Info; }
  } catch (_) {}
  return await doc.save({ useObjectStreams: false });
}

/* ----- DOCX / XLSX / PPTX: blank docProps ----- */
async function stripOffice(u8) {
  const zip = await JSZip.loadAsync(u8);
  const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>';
  const app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"/>';
  const cust = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"/>';
  if (zip.file('docProps/core.xml')) zip.file('docProps/core.xml', core);
  if (zip.file('docProps/app.xml')) zip.file('docProps/app.xml', app);
  if (zip.file('docProps/custom.xml')) zip.file('docProps/custom.xml', cust);
  return await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/* ----- fallback: browser-decodable images -> clean PNG via canvas ----- */
async function canvasPng(file) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/* ----- detect type by magic bytes first, extension second ----- */
function sniff(u8, name) {
  const e = getExt(name);
  if (u8[0] === 0xFF && u8[1] === 0xD8) return 'jpeg';
  if (u8[0] === 0x89 && ascii(u8, 1, 3) === 'PNG') return 'png';
  if (ascii(u8, 0, 4) === 'GIF8') return 'gif';
  if (ascii(u8, 0, 4) === 'RIFF' && ascii(u8, 8, 4) === 'WEBP') return 'webp';
  if (ascii(u8, 0, 4) === 'RIFF' && ascii(u8, 8, 4) === 'WAVE') return 'wav';
  if (ascii(u8, 0, 4) === '%PDF') return 'pdf';
  if (ascii(u8, 4, 4) === 'ftyp') {
    const brand = ascii(u8, 8, 4);
    if (['heic', 'heix', 'heim', 'heis', 'hevc', 'mif1', 'msf1', 'avif', 'avis'].includes(brand)) return 'heif';
    return 'mp4';
  }
  if (ascii(u8, 0, 3) === 'ID3' || (e === 'mp3' && u8[0] === 0xFF)) return 'mp3';
  if (u8[0] === 0x50 && u8[1] === 0x4B && ['docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm', 'dotx', 'xltx', 'potx'].includes(e)) return 'office';
  return 'unknown';
}

async function stripFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(buf, file.name);
  const ext = getExt(file.name);
  let out, outName = `${baseName(file.name)}-clean${ext ? '.' + ext : ''}`, mime = file.type || 'application/octet-stream';
  switch (kind) {
    case 'jpeg': out = stripJpeg(buf); break;
    case 'png': out = stripPng(buf); break;
    case 'gif': out = stripGif(buf); break;
    case 'webp': out = stripRiff(buf, new Set(['EXIF', 'XMP ']), true); break;
    case 'wav': out = stripRiff(buf, new Set(['LIST', 'bext', 'iXML', 'id3 ', 'ID3 ', '_PMX']), false); break;
    case 'mp4': out = stripMp4(buf); break;
    case 'mp3': out = stripMp3(buf); break;
    case 'pdf': out = await stripPdf(buf); break;
    case 'office': out = await stripOffice(buf); break;
    default:
      if ((file.type || '').startsWith('image/') || ['bmp', 'avif', 'ico', 'tif', 'tiff', 'heic', 'heif'].includes(ext) || kind === 'heif') {
        try {
          out = await canvasPng(file);
          outName = `${baseName(file.name)}-clean.png`; mime = 'image/png';
          return { kind: 'image→png', out, outName, mime, size0: file.size, note: 're-drawn as PNG (format not editable in-place)' };
        } catch (_) { /* fall through */ }
      }
      throw new Error(`Unsupported in-browser (${ext || 'unknown'}). Use: exiftool -all= -overwrite_original "${file.name}"`);
  }
  return { kind, out, outName, mime, size0: file.size, note: '' };
}

/* ----- stripper UI ----- */
const stripResults = [];
const stripList = $('#stripList');

async function handleStrip(files) {
  for (const f of files) {
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `<div class="name">${esc(f.name)}<div class="meta">working…</div></div>`;
    stripList.appendChild(li);
    try {
      const r = await stripFile(f);
      const blob = new Blob([r.out], { type: r.mime });
      stripResults.push({ name: r.outName, blob });
      const diff = r.size0 - blob.size;
      li.innerHTML = `
        <div class="name">${esc(f.name)}
          <div class="meta">${esc(r.kind)} · ${fmtBytes(r.size0)} → ${fmtBytes(blob.size)}${diff > 0 ? ' (−' + fmtBytes(diff) + ')' : ''} ${r.note ? '· ' + esc(r.note) : ''}</div>
        </div>
        <span class="tag ok">cleaned</span>
        <button class="btn small">Download</button>`;
      $('button', li).addEventListener('click', () => saveBlob(blob, r.outName));
    } catch (err) {
      li.innerHTML = `<div class="name">${esc(f.name)}<div class="meta">${esc(err.message || err)}</div></div><span class="tag bad">failed</span>`;
    }
    $('#stripZip').disabled = stripResults.length === 0;
    $('#stripClear').disabled = false;
  }
}
$('#stripInput').addEventListener('change', (e) => { handleStrip([...e.target.files]); e.target.value = ''; });
wireDrop($('#stripDrop'), handleStrip);
$('#stripClear').addEventListener('click', () => {
  stripResults.length = 0; stripList.innerHTML = '';
  $('#stripZip').disabled = true; $('#stripClear').disabled = true;
});
$('#stripZip').addEventListener('click', async () => {
  const zip = new JSZip();
  const used = new Set();
  for (const r of stripResults) {
    let n = r.name, k = 1;
    while (used.has(n)) n = r.name.replace(/(\.[^.]*)?$/, `-${k++}$1`);
    used.add(n); zip.file(n, r.blob);
  }
  saveBlob(await zip.generateAsync({ type: 'blob' }), 'cleaned-files.zip');
});

/* ============================================================
   2) QR CODE GENERATOR
   ============================================================ */
const qrCanvas = $('#qrCanvas');
let qrState = null;

function drawQR() {
  const text = $('#qrText').value;
  const err = $('#qrErr');
  err.textContent = '';
  $('#qrEmpty').style.display = text ? 'none' : '';
  if (!text) { qrCanvas.getContext('2d').clearRect(0, 0, qrCanvas.width, qrCanvas.height); qrState = null; return; }
  try {
    const qr = qrcode(0, $('#qrEcc').value);
    qr.addData(text, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    const margin = Math.max(0, +$('#qrMargin').value || 0);
    const target = Math.min(2048, Math.max(128, +$('#qrSize').value || 512));
    const cell = Math.max(1, Math.floor(target / (n + margin * 2)));
    const px = cell * (n + margin * 2);
    qrCanvas.width = qrCanvas.height = px;
    const ctx = qrCanvas.getContext('2d');
    ctx.fillStyle = $('#qrBg').value; ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = $('#qrFg').value;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
    qrState = { qr, n, margin };
  } catch (e) {
    err.textContent = 'Too much data for a QR code at this error-correction level. Shorten it or lower the level.';
    qrState = null;
  }
}
['qrText', 'qrSize', 'qrMargin', 'qrEcc', 'qrFg', 'qrBg'].forEach((id) => $('#' + id).addEventListener('input', drawQR));
$('#qrPng').addEventListener('click', () => {
  if (!qrState) return;
  qrCanvas.toBlob((b) => saveBlob(b, 'qr-code.png'), 'image/png');
});
$('#qrSvg').addEventListener('click', () => {
  if (!qrState) return;
  const { qr, n, margin } = qrState;
  const dim = n + margin * 2;
  let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
    if (qr.isDark(r, c)) path += `M${c + margin} ${r + margin}h1v1h-1z`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" width="${dim * 10}" height="${dim * 10}"><rect width="100%" height="100%" fill="${$('#qrBg').value}"/><path d="${path}" fill="${$('#qrFg').value}"/></svg>`;
  saveBlob(new Blob([svg], { type: 'image/svg+xml' }), 'qr-code.svg');
});
drawQR();

/* ============================================================
   3) PDF -> PNGs
   ============================================================ */
let pdfDoc = null, pdfName = 'document', pdfPages = [];

async function initPdfjs() {
  const url = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  try {
    // Blob worker avoids cross-origin worker errors (e.g. when opened via file://)
    const code = await (await fetch(url)).text();
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  } catch (_) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = url;
  }
}
const pdfjsReady = initPdfjs();

const setStatus = (t) => { $('#pdfStatus').textContent = t; };

async function openPdf(data, name) {
  await pdfjsReady;
  try {
    pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    pdfName = baseName(name) || 'document';
    pdfPages = [];
    $('#pdfGrid').innerHTML = '';
    $('#pdfRun').disabled = false;
    $('#pdfZip').disabled = true;
    setStatus(`Loaded "${name}" — ${pdfDoc.numPages} pages. Hit "Convert pages".`);
  } catch (e) {
    pdfDoc = null; $('#pdfRun').disabled = true;
    setStatus('Could not open that PDF: ' + (e.message || e));
  }
}
async function loadPdfFile(files) {
  const f = files.find((x) => x.type === 'application/pdf' || /\.pdf$/i.test(x.name));
  if (!f) { setStatus('That doesn\'t look like a PDF.'); return; }
  setStatus('Reading file…');
  await openPdf(new Uint8Array(await f.arrayBuffer()), f.name);
}
$('#pdfInput').addEventListener('change', (e) => { loadPdfFile([...e.target.files]); e.target.value = ''; });
wireDrop($('#pdfDrop'), loadPdfFile);

$('#pdfUrlGo').addEventListener('click', async () => {
  const raw = $('#pdfUrl').value.trim();
  if (!raw) return;
  if (/^file:/i.test(raw)) {
    let n = raw.split('/').pop();
    try { n = decodeURIComponent(n); } catch (_) {}
    setStatus(`Browsers can't read file:/// paths. Find "${n}" on your drive and drag it onto the drop box above.`);
    return;
  }
  try {
    setStatus('Downloading…');
    const res = await fetch(raw);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const name = decodeURIComponent(raw.split('?')[0].split('/').pop() || 'document.pdf');
    await openPdf(new Uint8Array(await res.arrayBuffer()), name);
  } catch (e) {
    setStatus('Couldn\'t download that link (the site probably blocks cross-origin requests). Download the PDF yourself and drop it in.');
  }
});

function parseRange(str, max) {
  if (!str.trim()) return Array.from({ length: max }, (_, i) => i + 1);
  const set = new Set();
  for (const part of str.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) if (p >= 1 && p <= max) set.add(p);
  }
  return [...set].sort((x, y) => x - y);
}

$('#pdfRun').addEventListener('click', async () => {
  if (!pdfDoc) return;
  const pages = parseRange($('#pdfRange').value, pdfDoc.numPages);
  if (!pages.length) { setStatus('No valid pages in that range.'); return; }
  const scale = +$('#pdfScale').value;
  const grid = $('#pdfGrid'), bar = $('#pdfBar'), fill = $('div', bar);
  grid.innerHTML = ''; pdfPages = [];
  $('#pdfRun').disabled = true; $('#pdfZip').disabled = true;
  bar.hidden = false; fill.style.width = '0%';
  const pad = String(pdfDoc.numPages).length;

  for (let k = 0; k < pages.length; k++) {
    const num = pages[k];
    setStatus(`Rendering page ${num} (${k + 1}/${pages.length})…`);
    try {
      const page = await pdfDoc.getPage(num);
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const name = `${pdfName}-p${String(num).padStart(pad, '0')}.png`;
      pdfPages.push({ name, blob });
      const url = URL.createObjectURL(blob);
      const d = document.createElement('div');
      d.className = 'thumb';
      d.innerHTML = `<img src="${url}" alt="page ${num}" loading="lazy" /><span>Page ${num} · ${fmtBytes(blob.size)}</span><a class="btn small" href="${url}" download="${esc(name)}">Download PNG</a>`;
      grid.appendChild(d);
      page.cleanup();
    } catch (e) {
      const d = document.createElement('div');
      d.className = 'thumb'; d.innerHTML = `<span>Page ${num} failed</span>`;
      grid.appendChild(d);
    }
    fill.style.width = ((k + 1) / pages.length * 100) + '%';
  }
  setStatus(`Done — ${pdfPages.length} PNG${pdfPages.length === 1 ? '' : 's'} ready.`);
  $('#pdfRun').disabled = false;
  $('#pdfZip').disabled = pdfPages.length === 0;
});

$('#pdfZip').addEventListener('click', async () => {
  if (!pdfPages.length) return;
  const zip = new JSZip();
  pdfPages.forEach((p) => zip.file(p.name, p.blob));
  const bar = $('#pdfBar'), fill = $('div', bar);
  bar.hidden = false;
  setStatus('Zipping…');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (m) => { fill.style.width = m.percent + '%'; });
  saveBlob(blob, `${pdfName}-pages.zip`);
  setStatus(`Zipped ${pdfPages.length} pages.`);
});
