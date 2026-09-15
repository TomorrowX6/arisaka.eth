import { $, $$, menubar, shortcut, report, decorate, formatSize } from '/ui.js';
import { basename, parent } from '/filesystem.js';
import { hex } from '/console.js';
import { icon } from '/desktop.js';

export function createViewer(controls) {
  let file;
  let url;
  let scale = 1;
  let rotation = 0;
  let page = 0;
  let pages = [];
  let sequence = [];
  let request = 0;
  let pdf, pdfModule, pdfRender, pdfTextLayer, pdfSequence = 0, pdfWidth = 620;
  let pdfTextPages = new Set();
  const sheet = $('#viewer-sheet');
  function revoke() { if (url) URL.revokeObjectURL(url); url = null; }
  function setZoom(value) {
    scale = Math.max(.1, Math.min(4, value));
    sheet.style.zoom = String(scale);
    $('#viewer-zoom').value = String(Math.round(scale * 100));
    if (!$('#viewer-zoom').value) { $('#viewer-zoom-label').textContent = Math.round(scale * 100) + '%'; }
    else $('#viewer-zoom-label').textContent = '';
  }
  function fit() {
    const content = $('#viewer-content');
    const image = $('img', sheet);
    const width = image ? image.naturalWidth : file?.type === 'pdf' ? pdfWidth : 620;
    if (width) setZoom(Math.min(1, Math.max(.1, (content.clientWidth - 50) / width)));
  }
  function renderPage() {
    pdfRender?.cancel();
    pdfTextLayer?.cancel(); pdfTextLayer = null;
    pdfSequence++;
    sheet.replaceChildren();
    if (!file) return;
    if (file.type === 'image') {
      const image = document.createElement('img'); image.src = url; image.alt = file.name; image.style.rotate = rotation + 'deg'; image.addEventListener('load', fit, { once: true }); sheet.append(image);
    } else if (file.type === 'audio') {
      const art = document.createElement('div'); art.className = 'media-cover'; art.innerHTML = icon('audio');
      const audio = document.createElement('audio'); audio.src = url; audio.controls = true; sheet.append(art, audio);
    } else if (file.type === 'pdf') {
      void renderPdfPage(pdfSequence).catch(report);
    } else {
      const pre = document.createElement('pre'); pre.textContent = pages[page] || ''; pre.className = file.type === 'hex' ? 'hex-page' : 'document-page'; sheet.append(pre);
    }
    $('#viewer-page').value = String(page + 1);
    $('#viewer-pages').textContent = '/ ' + Math.max(1, pages.length);
    $('#viewer-path').textContent = file.path;
    $('#viewer-size').textContent = formatSize(file.bytes.length);
    $('#viewer-format').textContent = file.type === 'pdf' ? 'PDF' : file.type === 'hex' ? 'Hex' : file.type === 'image' ? '图像' : file.type === 'audio' ? '音频' : 'UTF-8';
    $$('[data-page]').forEach((button) => button.classList.toggle('selected', Number(button.dataset.page) === page));
    $('#viewer-window').dataset.viewer = file.type;
    const app = file.type === 'image' ? 'Gwenview' : file.type === 'audio' ? 'Haruna' : file.type === 'hex' ? 'Okteta' : 'Okular';
    controls.windows.setTitle('viewer', file.name + ' — ' + app, file.type === 'image' ? 'image' : file.type === 'audio' ? 'audio' : 'viewer');
    $('#viewer-rotate').hidden = file.type !== 'image';
    $('#viewer-page-controls').hidden = ['image', 'audio'].includes(file.type);
    $('#viewer-sidebar-title').textContent = file.type === 'image' ? '文件夹' : '缩略图';
  }
  async function renderPdfPage(token) {
    if (!pdf) return;
    const documentPage = await pdf.getPage(page + 1);
    if (token !== pdfSequence) return;
    const viewport = documentPage.getViewport({ scale: 1 });
    const resolution = Math.min(2, devicePixelRatio || 1);
    if (viewport.width * viewport.height * resolution * resolution > 32_000_000) throw new Error('PDF 页面尺寸过大');
    pdfWidth = viewport.width;
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page';
    canvas.width = Math.ceil(viewport.width * resolution); canvas.height = Math.ceil(viewport.height * resolution);
    canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px';
    const surface = document.createElement('div'); surface.className = 'pdf-surface';
    surface.style.width = viewport.width + 'px'; surface.style.height = viewport.height + 'px';
    surface.append(canvas); sheet.append(surface);
    pdfRender = documentPage.render({ canvasContext: canvas.getContext('2d'), viewport: documentPage.getViewport({ scale: resolution }) });
    try { await pdfRender.promise; } catch (error) { if (error.name !== 'RenderingCancelledException') throw error; }
    if (token !== pdfSequence) return;
    const content = await documentPage.getTextContent();
    if (token !== pdfSequence) return;
    pages[page] = pdfContentText(content); pdfTextPages.add(page);
    const text = document.createElement('div'); text.className = 'textLayer';
    surface.append(text);
    pdfTextLayer = new pdfModule.TextLayer({ textContentSource: content, container: text, viewport });
    try { await pdfTextLayer.render(); } catch (error) { if (token === pdfSequence) throw error; }
    if (token !== pdfSequence) return;
    const thumbnail = $('#viewer-thumbnails [data-page="' + page + '"] pre');
    if (thumbnail) thumbnail.textContent = pages[page].slice(0, 700);
    if ($('#viewer-zoom').value === 'fit' || scale === 1) fit();
  }
  function pdfContentText(content) {
    return content.items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join('').trimEnd();
  }
  async function readPdfText(index, currentPdf = pdf) {
    if (pdfTextPages.has(index)) return pages[index];
    const content = await (await currentPdf.getPage(index + 1)).getTextContent();
    if (currentPdf !== pdf) throw new Error('已取消');
    pages[index] = pdfContentText(content); pdfTextPages.add(index);
    const thumbnail = $('#viewer-thumbnails [data-page="' + index + '"] pre');
    if (thumbnail) thumbnail.textContent = pages[index].slice(0, 700);
    return pages[index];
  }
  async function open(path, mode) {
    const generation = ++request;
    const bytes = await controls.fs.read(path); if (generation !== request) return;
    revoke(); pdfRender?.cancel(); pdfTextLayer?.cancel(); pdfTextLayer = null; pdfSequence++; await pdf?.destroy(); pdf = null; pdfTextPages = new Set();
    if (generation !== request) return;
    page = 0; rotation = 0; setZoom(1);
    const name = basename(path);
    const type = mode === 'hex' || /\.(mid|wasm|bin|zip)$/i.test(name) ? 'hex' : /\.pdf$/i.test(name) ? 'pdf' : /\.(png|jpe?g|webp)$/i.test(name) ? 'image' : /\.(wav|mp3|ogg)$/i.test(name) ? 'audio' : 'text';
    file = { path, name, bytes, type };
    if (type === 'pdf') {
      pdfModule ??= await import('/vendor/pdf.mjs');
      pdfModule.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
      const loaded = await pdfModule.getDocument({
        data: bytes.slice(), isEvalSupported: false, useSystemFonts: true,
        cMapUrl: '/vendor/pdf-cmaps/', cMapPacked: true,
        standardFontDataUrl: '/vendor/pdf-fonts/', wasmUrl: '/vendor/pdf-wasm/',
      }).promise;
      if (generation !== request) { await loaded.destroy(); return; }
      if (loaded.numPages > 1000) { await loaded.destroy(); throw new Error('PDF 超过 1000 页'); }
      pdf = loaded; pages = Array.from({ length: loaded.numPages }, () => '');
    } else if (type === 'image' || type === 'audio') {
      const mime = type === 'audio' ? 'audio/wav' : /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
      url = URL.createObjectURL(new Blob([bytes], { type: mime })); pages = [''];
    } else {
      const lines = (type === 'hex' ? hex(bytes) : new TextDecoder().decode(bytes)).split('\n');
      pages = [];
      for (let i = 0; i < Math.max(1, lines.length); i += type === 'hex' ? 256 : 70) pages.push(lines.slice(i, i + (type === 'hex' ? 256 : 70)).join('\n'));
    }
    const thumbnails = $('#viewer-thumbnails'); thumbnails.replaceChildren();
    if (type === 'image') {
      sequence = (await controls.fs.entries(parent(path))).filter((item) => /\.(png|jpe?g|webp)$/i.test(item.name)); if (generation !== request) return;
      for (const entry of sequence) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'viewer-file' + (entry.path === path ? ' selected' : ''); button.innerHTML = icon('image');
        const text = document.createElement('span'); text.textContent = entry.name; button.append(text); button.addEventListener('click', () => void open(entry.path).catch(report)); thumbnails.append(button);
      }
    } else {
      sequence = [];
      pages.forEach((text, index) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'page-thumbnail'; button.dataset.page = index;
        const preview = document.createElement('pre'); preview.textContent = text.slice(0, 700);
        const label = document.createElement('span'); label.textContent = index + 1;
        button.append(preview, label); button.addEventListener('click', () => { page = index; renderPage(); }); thumbnails.append(button);
      });
    }
    renderPage(); controls.windows.open('viewer'); if (type === 'text') requestAnimationFrame(fit);
  }
  async function next(delta) {
    if (!file) return;
    if (file.type === 'image') {
      const index = sequence.findIndex((entry) => entry.path === file.path) + delta;
      if (sequence[index]) await open(sequence[index].path);
    } else { page = Math.max(0, Math.min(pages.length - 1, page + delta)); renderPage(); }
  }
  const download = () => file && controls.download(file.name, new Blob([file.bytes]));
  const edit = async () => {
    if (!file) return;
    const selected = file, currentPdf = pdf;
    if (selected.type === 'pdf') {
      let size = 0;
      for (let index = 0; index < pages.length; index++) {
        if (selected !== file || currentPdf !== pdf) return;
        size += (await readPdfText(index, currentPdf)).length;
        if (size > 8_000_000) throw new Error('文档文本超过 8 MB');
      }
      if (selected === file) controls.edit(selected.name + '.txt', pages.join('\n\n'), null);
    } else controls.edit(selected.name, new TextDecoder().decode(selected.bytes), selected.path);
  };
  const toggleSide = () => { $('#viewer-sidebar').hidden = !$('#viewer-sidebar').hidden; $('#viewer-side').setAttribute('aria-pressed', String(!$('#viewer-sidebar').hidden)); };
  const find = () => { $('#viewer-findbar').hidden = false; $('#viewer-search').focus(); };
  menubar($('#viewer-menubar'), {
    '文件': [{ label: '打开…', icon: 'document-open', shortcut: 'Ctrl+O', action: () => controls.pickFile('view') }, { label: '另存为…', icon: 'document-save-as', shortcut: 'Ctrl+Shift+S', action: download }, null, { label: '关闭', action: () => controls.windows.close('viewer') }],
    '视图': () => [{ label: '侧栏', checked: !$('#viewer-sidebar').hidden, shortcut: 'F7', action: toggleSide }, null, { label: '放大', icon: 'zoom-in', action: () => setZoom(scale + .1) }, { label: '缩小', icon: 'zoom-out', action: () => setZoom(scale - .1) }, { label: '适合宽度', icon: 'zoom-fit-best', action: fit }, { label: '实际大小', icon: 'zoom-original', action: () => setZoom(1) }],
    '编辑': [{ label: '用 Kate 打开', action: edit }, { label: '复制', icon: 'edit-copy', action: () => navigator.clipboard.writeText(getSelection()?.toString() || '') }, { label: '查找…', icon: 'edit-find', shortcut: 'Ctrl+F', action: find }],
    '转到': [{ label: '上一页', icon: 'go-previous', action: () => next(-1) }, { label: '下一页', icon: 'go-next', action: () => next(1) }],
    '工具': [{ label: '十六进制', action: () => file && open(file.path, 'hex') }, { label: '旋转', action: () => { rotation = (rotation + 90) % 360; renderPage(); } }],
  });
  const actions = { '#viewer-open': () => controls.pickFile('view'), '#viewer-download': download, '#viewer-edit': edit, '#viewer-hex': () => file && open(file.path, 'hex'), '#viewer-side': toggleSide, '#viewer-prev': () => next(-1), '#viewer-next': () => next(1), '#viewer-zoom-out': () => setZoom(scale - .1), '#viewer-zoom-in': () => setZoom(scale + .1), '#viewer-fit': fit, '#viewer-rotate': () => { rotation = (rotation + 90) % 360; renderPage(); }, '#viewer-find': find, '#viewer-find-close': () => { $('#viewer-findbar').hidden = true; } };
  for (const [selector, action] of Object.entries(actions)) $(selector).addEventListener('click', () => Promise.resolve().then(action).catch(report));
  $('#viewer-zoom').addEventListener('change', (event) => event.target.value === 'fit' ? fit() : setZoom(Number(event.target.value) / 100));
  $('#viewer-page').addEventListener('change', (event) => { page = Math.max(0, Math.min(pages.length - 1, Number(event.target.value) - 1 || 0)); renderPage(); });
  let findGeneration = 0;
  $('#viewer-search').addEventListener('input', async (event) => {
    const query = event.target.value;
    const token = ++findGeneration;
    if (file?.type === 'pdf' && pdf && query) {
      const currentPdf = pdf;
      for (let index = 0; index < pages.length; index++) {
        if (!pdfTextPages.has(index)) {
          try { await readPdfText(index, currentPdf); if (token !== findGeneration || pdf !== currentPdf) return; }
          catch (error) { if (pdf === currentPdf) report(error); return; }
        }
        if (pages[index].toLowerCase().includes(query.toLowerCase())) { page = index; renderPage(); $('#viewer-find-result').textContent = String(index + 1); return; }
      }
      $('#viewer-find-result').textContent = '0'; return;
    }
    const index = pages.findIndex((text) => text.toLowerCase().includes(query.toLowerCase()));
    $('#viewer-find-result').textContent = query && index < 0 ? '0' : '';
    if (query && index >= 0 && file && ['text', 'hex'].includes(file.type)) {
      page = index; renderPage();
      const pre = $('pre', sheet), text = pages[page], start = text.toLowerCase().indexOf(query.toLowerCase());
      const mark = document.createElement('mark'); mark.textContent = text.slice(start, start + query.length);
      pre.replaceChildren(document.createTextNode(text.slice(0, start)), mark, document.createTextNode(text.slice(start + query.length))); mark.scrollIntoView({ block: 'nearest' });
    }
  });
  $('#viewer-window').addEventListener('window:close', () => $('audio', sheet)?.pause());
  $('#viewer-window').addEventListener('keydown', (event) => {
    if (shortcut(event, 'f')) { event.preventDefault(); find(); }
    else if (shortcut(event, 'o')) { event.preventDefault(); void controls.pickFile('view'); }
    else if (event.key === 'F7') { event.preventDefault(); toggleSide(); }
  });
  decorate($('#viewer-window'));
  return { open, reset: () => { request++; pdfSequence++; findGeneration++; pdfRender?.cancel(); pdfTextLayer?.cancel(); pdfTextLayer = null; void pdf?.destroy(); pdf = null; pdfTextPages = new Set(); revoke(); file = null; pages = []; sheet.replaceChildren(); $('#viewer-thumbnails').replaceChildren(); } };
}
