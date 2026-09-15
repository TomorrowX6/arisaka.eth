import { $, $$, askText, askSave, decorate, menubar, report, shortcut } from '/ui.js';
import { DOCUMENTS, basename, normalize } from '/filesystem.js';
import { pickFile } from '/files.js';
import { floodFill, rotatePixels } from '/pixels.js';

export const paintLayout = `<nav id="paint-menubar" class="native-menubar"></nav>
  <div class="native-toolbar"><button id="paint-new" data-icon="document-new">新建…</button><button id="paint-open" data-icon="document-open">打开…</button><button id="paint-save" data-icon="document-save">保存</button><button id="paint-save-as" data-icon="document-save-as">另存为…</button><span class="toolbar-separator"></span><button id="paint-undo" data-icon="edit-undo" aria-label="撤销" disabled></button><button id="paint-redo" data-icon="edit-redo" aria-label="重做" disabled></button><span class="toolbar-spacer"></span><select id="paint-zoom" aria-label="缩放"><option value="0.25">25%</option><option value="0.5">50%</option><option value="1" selected>100%</option><option value="2">200%</option><option value="4">400%</option><option value="8">800%</option></select></div>
  <div class="paint-workspace"><aside class="paint-tools" aria-label="绘图工具">${[['pencil','铅笔'],['eraser','橡皮擦'],['line','直线'],['rectangle','矩形'],['ellipse','椭圆'],['fill','填充'],['picker','取色器']].map(([value, label]) => `<button type="button" data-paint-tool="${value}" aria-pressed="${value === 'pencil'}">${label}</button>`).join('')}<label>颜色<input id="paint-color" type="color" value="#232629"></label><label>宽度<input id="paint-width" type="number" min="1" max="64" value="3"></label><label class="setting-check"><input id="paint-solid" type="checkbox">实心</label></aside><div id="paint-scroll" class="paint-scroll"><canvas id="paint-canvas" width="640" height="480" aria-label="图像编辑画布" tabindex="0"></canvas></div></div>
  <div class="paint-palette">${['#000000','#ffffff','#808080','#c0c0c0','#da4453','#f67400','#fdbc4b','#27ae60','#1abc9c','#3daee9','#1d345c','#9b59b6','#bd93f9','#74334c','#936e57','#38454f'].map(value => `<button type="button" data-paint-color="${value}" aria-label="${value}"></button>`).join('')}</div>
  <footer class="statusbar"><span id="paint-status">640 × 480</span><span id="paint-coordinates"></span><span class="toolbar-spacer"></span><span id="paint-path"></span></footer>`;

export function createPaint(controls) {
  const { fs, windows } = controls, canvas = $('#paint-canvas'), context = canvas.getContext('2d', { willReadFrequently: true });
  let path = '', tool = 'pencil', undo = [], redo = [], version = 0, savedVersion = 0, serial = 0, stroke, closing = false, operation = 0;
  const dirty = () => version !== savedVersion;
  const listen = (id, action, event = 'click') => $('#' + id).addEventListener(event, e => { Promise.resolve().then(() => action(e)).catch(report); });
  const snapshot = () => {
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
    return { data, width, height, version };
  };
  function restore(state) {
    canvas.width = state.width; canvas.height = state.height;
    context.putImageData(new ImageData(new Uint8ClampedArray(state.data), state.width, state.height), 0, 0); version = state.version; refresh();
  }
  function boundHistory() {
    let bytes = undo.reduce((sum, item) => sum + item.data.length, 0) + redo.reduce((sum, item) => sum + item.data.length, 0);
    while (bytes > 32 * 1024 * 1024 && undo.length > 1) bytes -= undo.shift().data.length;
    while (bytes > 32 * 1024 * 1024 && redo.length > 1) bytes -= redo.shift().data.length;
    if (undo.length > 40) undo = undo.slice(-40);
    if (redo.length > 40) redo = redo.slice(-40);
  }
  function changed(before) { undo.push(before); redo = []; version = ++serial; boundHistory(); refresh(); }
  function refresh() {
    const zoom = Number($('#paint-zoom').value);
    canvas.style.width = canvas.width * zoom + 'px'; canvas.style.height = canvas.height * zoom + 'px';
    $('#paint-status').textContent = canvas.width + ' × ' + canvas.height + (dirty() ? ' · 已修改' : '');
    $('#paint-path').textContent = path; $('#paint-undo').disabled = !undo.length; $('#paint-redo').disabled = !redo.length;
    windows.setTitle('paint', (basename(path) || '未命名') + (dirty() ? ' *' : '') + ' — KolourPaint');
    $$('[data-paint-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.paintTool === tool)));
  }
  function dimensions(value) {
    const match = /^\s*(\d+)\s*[x×,]\s*(\d+)\s*$/.exec(value);
    if (!match || +match[1] < 1 || +match[2] < 1 || +match[1] > 2048 || +match[2] > 2048) throw Error('尺寸范围为 1–2048 像素');
    return [+match[1], +match[2]];
  }
  function blank(width = 640, height = 480) {
    canvas.width = width; canvas.height = height; context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
    path = ''; undo = []; redo = []; version = savedVersion = ++serial; refresh();
  }
  async function save(as = false) {
    let target = path;
    if (as || !fs.writable(target) || !/\.png$/i.test(target)) {
      const value = await askText('保存图像', (basename(target) || 'untitled.png').replace(/\.(?:jpe?g|webp|bmp)$/i, '.png'));
      if (!value) return false;
      target = normalize(/\.png$/i.test(value) ? value : value + '.png', DOCUMENTS);
    }
    const token = operation, revision = version;
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(Error('图像编码失败')), 'image/png'));
    await fs.writeFile(target, new Uint8Array(await blob.arrayBuffer()));
    if (token === operation) { path = target; savedVersion = revision; refresh(); }
    return true;
  }
  async function confirm() { if (!dirty()) return true; const result = await askSave(basename(path) || 'untitled.png'); return result === 'discard' || result === 'save' && await save(); }
  async function open(input) {
    if (!await confirm()) return;
    const token = ++operation, bytes = await fs.read(input);
    const bitmap = await createImageBitmap(new Blob([bytes]));
    try {
      if (bitmap.width > 2048 || bitmap.height > 2048) throw Error('图像尺寸超过 2048 × 2048');
      if (token !== operation) return;
      canvas.width = bitmap.width; canvas.height = bitmap.height; context.drawImage(bitmap, 0, 0);
      path = input; undo = []; redo = []; version = savedVersion = ++serial; refresh(); windows.open('paint');
    } finally { bitmap.close(); }
  }
  function position(event) {
    const box = canvas.getBoundingClientRect();
    return [Math.max(0, Math.min(canvas.width - 1, Math.floor((event.clientX - box.left) * canvas.width / box.width))), Math.max(0, Math.min(canvas.height - 1, Math.floor((event.clientY - box.top) * canvas.height / box.height)))];
  }
  function color() { return [...$('#paint-color').value.slice(1).match(/../g).map(value => parseInt(value, 16)), 255]; }
  function style() {
    context.strokeStyle = context.fillStyle = $('#paint-color').value;
    context.lineWidth = Math.max(1, Math.min(64, Number($('#paint-width').value) || 1));
    context.lineCap = context.lineJoin = 'round'; context.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
  }
  function draw(point) {
    style(); const [x, y] = point;
    if (tool === 'pencil' || tool === 'eraser') {
      context.beginPath(); context.moveTo(stroke.last[0] + .5, stroke.last[1] + .5); context.lineTo(x + .5, y + .5); context.stroke(); stroke.last = point;
    } else {
      context.putImageData(new ImageData(stroke.before.data, stroke.before.width, stroke.before.height), 0, 0);
      const [sx, sy] = stroke.start; context.beginPath();
      if (tool === 'line') { context.moveTo(sx + .5, sy + .5); context.lineTo(x + .5, y + .5); }
      else if (tool === 'rectangle') context.rect(Math.min(sx, x), Math.min(sy, y), Math.abs(x - sx), Math.abs(y - sy));
      else context.ellipse((sx + x) / 2, (sy + y) / 2, Math.abs(x - sx) / 2, Math.abs(y - sy) / 2, 0, 0, Math.PI * 2);
      if ($('#paint-solid').checked && tool !== 'line') context.fill(); else context.stroke();
    }
  }
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || stroke) return;
    event.preventDefault(); canvas.focus(); const point = position(event);
    if (tool === 'picker') { $('#paint-color').value = '#' + [...context.getImageData(...point, 1, 1).data].slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join(''); return; }
    const before = snapshot();
    if (tool === 'fill') {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      if (floodFill(pixels, ...point, color())) { context.putImageData(pixels, 0, 0); changed(before); }
      return;
    }
    stroke = { before, start: point, last: point, pointer: event.pointerId }; canvas.setPointerCapture(event.pointerId); draw(point);
  });
  canvas.addEventListener('pointermove', event => {
    const point = position(event); $('#paint-coordinates').textContent = point.join(', ');
    if (stroke?.pointer === event.pointerId) draw(point);
  });
  function finish(event) {
    if (stroke?.pointer !== event.pointerId) return;
    const previous = stroke; stroke = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    context.globalCompositeOperation = 'source-over';
    if (event.type === 'pointercancel') restore(previous.before); else changed(previous.before);
  }
  canvas.addEventListener('pointerup', finish); canvas.addEventListener('pointercancel', finish);
  function history(backward) {
    const source = backward ? undo : redo, target = backward ? redo : undo;
    if (!source.length || stroke) return;
    target.push(snapshot()); restore(source.pop()); boundHistory(); refresh();
  }
  async function resize() {
    const value = await askText('图像尺寸', canvas.width + ' × ' + canvas.height, '宽 × 高'); if (!value) return;
    const [width, height] = dimensions(value), before = snapshot();
    const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height; copy.getContext('2d').drawImage(canvas, 0, 0);
    canvas.width = width; canvas.height = height; context.imageSmoothingEnabled = false; context.drawImage(copy, 0, 0, width, height); changed(before);
  }
  function rotate(clockwise) { if (stroke) return; const before = snapshot(), rotated = rotatePixels(before, clockwise); canvas.width = rotated.width; canvas.height = rotated.height; context.putImageData(new ImageData(rotated.data, rotated.width, rotated.height), 0, 0); changed(before); }
  listen('paint-new', async () => { if (!await confirm()) return; const value = await askText('新建图像', '640 × 480', '宽 × 高'); if (!value) return; const size = dimensions(value); operation++; blank(...size); });
  listen('paint-open', () => pickFile(fs, open)); listen('paint-save', () => save()); listen('paint-save-as', () => save(true));
  listen('paint-undo', () => history(true)); listen('paint-redo', () => history(false)); listen('paint-zoom', refresh, 'change');
  for (const button of $$('[data-paint-tool]')) button.onclick = () => { tool = button.dataset.paintTool; refresh(); };
  for (const button of $$('[data-paint-color]')) { button.style.backgroundColor = button.dataset.paintColor; button.onclick = () => { $('#paint-color').value = button.dataset.paintColor; }; }
  const node = $('#paint-window');
  node.addEventListener('keydown', event => {
    if (shortcut(event, 's')) { event.preventDefault(); void save().catch(report); }
    if (shortcut(event, 'z')) { event.preventDefault(); history(true); }
    if (shortcut(event, 'z', true) || shortcut(event, 'y')) { event.preventDefault(); history(false); }
  });
  node.addEventListener('window:beforeclose', event => {
    if (!dirty()) return; event.preventDefault(); if (closing) return; closing = true;
    void confirm().then(ok => { if (ok) { savedVersion = version; windows.close('paint'); } }).catch(report).finally(() => { closing = false; });
  });
  menubar($('#paint-menubar'), { '文件': [{ label: '新建…', action: () => $('#paint-new').click() }, { label: '打开…', action: () => $('#paint-open').click() }, { label: '保存', shortcut: 'Ctrl+S', action: () => save() }, { label: '另存为…', action: () => save(true) }, null, { label: '关闭', action: () => windows.close('paint') }], '编辑': [{ label: '撤销', shortcut: 'Ctrl+Z', action: () => history(true) }, { label: '重做', shortcut: 'Ctrl+Shift+Z', action: () => history(false) }], '图像': [{ label: '图像尺寸…', action: resize }, { label: '顺时针旋转 90°', action: () => rotate(true) }, { label: '逆时针旋转 90°', action: () => rotate(false) }] });
  decorate(node); blank();
  return { open, reset() { operation++; stroke = null; blank(); } };
}
