import { mountMidi } from '/midi.js';
import { HOME, fileType } from '/filesystem.js';
import { apiFetch } from '/transport.js';

const escape = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const header = (title) => '<div class="workbench-head"><span>' + escape(title) + '</span></div>';
const wrap = (title, body) => header(title) + '<div class="workbench-body">' + body + '</div>';

async function fetchFile(record, name, signal) {
  const file = record.files.find((entry) => entry.name === name);
  if (!file) throw new Error('文件不存在');
  const response = await apiFetch(file.url, { signal, cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('文件读取失败');
  return response;
}

function recovered(node, value, controls) {
  node.replaceChildren();
  node.className = 'recovered';
  node.hidden = false;
  const title = document.createElement('h3');
  title.textContent = '结果';
  node.append(title);
  if (value.letter) {
    const letter = document.createElement('p');
    letter.className = 'letter-text';
    letter.textContent = value.letter;
    node.append(letter);
  }
  for (const text of [value.code, value.receipt].filter(Boolean)) {
    const code = document.createElement('code');
    code.textContent = text;
    node.append(code);
  }
  const actions = document.createElement('div');
  actions.className = 'button-row';
  if (value.code) {
    const fill = document.createElement('button');
    fill.className = 'button subtle small';
    fill.type = 'button';
    fill.textContent = '填入 →';
    fill.addEventListener('click', () => controls.fill(value.code), { signal: controls.signal });
    actions.append(fill);
  }
  if (value.receipt) {
    const save = document.createElement('button');
    save.className = 'text-button';
    save.type = 'button';
    save.textContent = '保存回执 ↗';
    save.addEventListener('click', () => controls.saveReceipt(value.receipt), { signal: controls.signal });
    actions.append(save);
  }
  node.append(actions);
}

export async function mountWorkbench(node, record, controls) {
  const q = (selector) => node.querySelector(selector);
  const on = (selector, event, callback) => q(selector).addEventListener(event, callback, { signal: controls.signal });
  const file = (name) => fetchFile(record, name, controls.signal);
  const error = (err) => { if (!controls.signal.aborted) controls.toast(err.message); };
  const handled = (selector, action) => on(selector, 'click', async () => {
    const button = q(selector);
    button.disabled = true;
    try { await action(); } catch (err) { error(err); }
    finally { button.disabled = false; }
  });

  if (record.widget === 'artifacts') {
    node.innerHTML = wrap(String(record.id).padStart(2, '0'), '<div class="artifact-list"></div>');
    for (const entry of record.files) {
      const row = document.createElement('div'); row.className = 'artifact-row';
      const name = document.createElement('button'); name.type = 'button'; name.className = 'artifact-name'; name.textContent = entry.name;
      const kind = document.createElement('span'); kind.textContent = fileType(entry.name).label;
      const download = document.createElement('button'); download.type = 'button'; download.textContent = '下载';
      name.addEventListener('click', () => void controls.openFile(HOME + '/' + String(record.id).padStart(2, '0') + '/' + entry.name).catch(error), { signal: controls.signal });
      download.addEventListener('click', async () => {
        download.disabled = true;
        try { controls.download(entry.name, await (await file(entry.name)).blob()); }
        catch (err) { error(err); }
        finally { download.disabled = false; }
      }, { signal: controls.signal });
      row.append(name, kind, download); q('.artifact-list').append(row);
    }
    return;
  }

  if (record.widget === 'terminal') {
    node.innerHTML = header('terminal') +
      '<div class="terminal-screen" role="log" aria-label="终端输出" aria-live="polite"></div>' +
      '<form class="terminal-form"><label class="terminal-prompt" for="terminal-input">archive:~ $</label>' +
      '<input id="terminal-input" aria-label="终端命令" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="240">' +
      '<button class="text-button" type="submit" aria-label="运行终端命令">ENTER ↵</button></form>';
    let cwd = '/archive';
    let historyIndex = 0;
    const history = [];
    const output = (text, type = '') => {
      const line = document.createElement('div');
      line.className = 'terminal-line ' + type;
      line.textContent = text;
      q('.terminal-screen').append(line);
      while (q('.terminal-screen').childElementCount > 150) q('.terminal-screen').firstElementChild.remove();
      q('.terminal-screen').scrollTop = q('.terminal-screen').scrollHeight;
    };
    on('.terminal-form', 'submit', async (event) => {
      event.preventDefault();
      const command = q('#terminal-input').value.trim();
      if (!command) return;
      q('#terminal-input').value = '';
      history.push(command);
      historyIndex = history.length;
      if (command === 'clear') { q('.terminal-screen').replaceChildren(); return; }
      output(cwd + ' $ ' + command, 'command');
      q('.terminal-form button').disabled = true;
      try {
        const result = await controls.api('/api/terminal', { command, cwd }, controls.signal);
        cwd = result.cwd;
        q('.terminal-prompt').textContent = (cwd === '/archive' ? 'archive:~' : 'archive:.cache') + ' $';
        if (result.output) output(result.output);
      } catch (err) { error(err); }
      finally { q('.terminal-form button').disabled = false; }
    });
    on('#terminal-input', 'keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      historyIndex = Math.max(0, Math.min(history.length, historyIndex + (event.key === 'ArrowUp' ? -1 : 1)));
      q('#terminal-input').value = history[historyIndex] || '';
    });
    return;
  }

  if (record.widget === 'http') {
    node.innerHTML = wrap('/api/echo',
      '<div class="http-request"><span class="method">GET</span><code>/api/echo</code></div>' +
      '<form class="http-form"><label for="etag-input">Headers<input id="etag-input" type="text" maxlength="300" autocomplete="off" spellcheck="false"></label>' +
      '<button class="button subtle" type="submit">发送 ↗</button></form>' +
      '<pre class="console-output" role="log" aria-live="polite"></pre>');
    on('.http-form', 'submit', async (event) => {
      event.preventDefault();
      const button = q('.http-form button');
      button.disabled = true;
      try {
        const value = q('#etag-input').value.trim();
        const headersInput = {};
        if (value) {
          const split = value.indexOf(':');
          if (split < 1) throw new Error('Header 格式：name: value');
          headersInput[value.slice(0, split).trim()] = value.slice(split + 1).trim();
        }
        const response = await apiFetch('/api/echo', {
          headers: headersInput,
          cache: 'no-store', credentials: 'same-origin', signal: controls.signal,
        });
        const text = await response.text();
        const headers = ['etag', 'cache-control', 'content-type', 'x-afterimage']
          .filter((name) => response.headers.has(name)).map((name) => name + ': ' + response.headers.get(name));
        q('.console-output').textContent = 'HTTP ' + response.status + ' ' + response.statusText + '\n' + headers.join('\n') + '\n\n' + (text || '[no body]');
      } catch (err) { error(err); }
      finally { button.disabled = false; }
    });
    return;
  }

  if (record.widget === 'midi') {
    node.innerHTML = wrap('afterimage.mid',
      '<div class="midi-toolbar"><label for="midi-track">音轨<select id="midi-track" aria-label="选择 MIDI 音轨"></select></label>' +
      '<label for="midi-speed">播放速度<select id="midi-speed"><option value="0.25">0.25×</option><option value="0.5" selected>0.50×</option><option value="1">1.00×</option></select></label>' +
      '<button class="button subtle" type="button" id="midi-play">播放 ▷</button></div>' +
      '<canvas class="midi-canvas" width="840" height="250" role="img" aria-label="四轨 MIDI 试奏谱面"></canvas>' +
      '<div class="midi-keys" aria-label="演奏按键"><button type="button" data-lane="0">D</button><button type="button" data-lane="1">F</button><button type="button" data-lane="2">J</button><button type="button" data-lane="3">K</button></div>' +
      '<div class="midi-status"><span id="midi-score">00 / 00</span><span id="midi-state"></span></div>');
    const buffer = await (await file('afterimage.mid')).arrayBuffer();
    if (controls.signal.aborted) return;
    return mountMidi(node, buffer, controls);
  }

  if (record.widget === 'shop') {
    node.innerHTML = wrap('/api/shop',
      '<div class="shop-wallet"><div class="wallet-item"><strong class="wallet-number" id="cards-balance">—</strong><span class="wallet-label">张卡片</span></div>' +
      '<div class="wallet-item"><strong class="wallet-number" id="stands-balance">—</strong><span class="wallet-label">个立牌</span></div></div>' +
      '<div class="shop-counter"><div class="stand-art" aria-hidden="true">✧</div><div class="shop-info"><h3>立牌</h3><p>1 张卡片 / 个</p></div>' +
      '<form class="shop-buy-form"><label for="shop-quantity">数量<input id="shop-quantity" type="number" min="1" max="9" step="1" value="1" required></label><button class="button subtle" type="submit">取得报价</button></form></div>' +
      '<div id="shop-quote" hidden><pre class="console-output" id="quote-output"></pre><button class="button subtle small" id="checkout-button" type="button">按此报价结算 →</button></div>' +
      '<div class="shop-redeem"><p>便笺<br><span class="muted">4 张卡片 + 1 个立牌</span></p><button class="button primary small" id="redeem-button" type="button">兑换 ↗</button></div>' +
      '<div class="shop-tools"><button class="text-button" id="refresh-shop" type="button">刷新 ↻</button><button class="text-button" id="reset-shop" type="button">重置账本</button></div>' +
      '<div id="shop-letter" hidden></div>');
    let quoteId;
    const wallet = (result) => {
      q('#cards-balance').textContent = result.cards;
      q('#stands-balance').textContent = result.stands;
      if (result.code) recovered(q('#shop-letter'), { code: result.code }, controls);
      else q('#shop-letter').hidden = true;
    };
    wallet(await controls.api('/api/shop', undefined, controls.signal));
    on('.shop-buy-form', 'submit', async (event) => {
      event.preventDefault();
      const button = q('.shop-buy-form button');
      button.disabled = true;
      try {
        const quote = await controls.api('/api/shop/quote', { item: 'stand', quantity: Number(q('#shop-quantity').value) }, controls.signal);
        quoteId = quote.quoteId;
        q('#quote-output').textContent = 'QUOTE ' + quote.quoteId + '\n数量：' + quote.quantity + '\n应付：' + quote.cost + ' 张卡片\n有效期：5 分钟 / 仅限本账本使用一次';
        q('#shop-quote').hidden = false;
      } catch (err) { error(err); }
      finally { button.disabled = false; }
    });
    handled('#checkout-button', async () => {
      wallet(await controls.api('/api/shop/checkout', { quoteId }, controls.signal));
      quoteId = undefined;
      q('#shop-quote').hidden = true;
        controls.toast('已结算');
    });
    handled('#redeem-button', async () => wallet(await controls.api('/api/shop/redeem', {}, controls.signal)));
    handled('#refresh-shop', async () => wallet(await controls.api('/api/shop', undefined, controls.signal)));
    handled('#reset-shop', async () => {
      wallet(await controls.api('/api/shop/reset', {}, controls.signal));
      q('#shop-quote').hidden = true;
      quoteId = undefined;
      controls.toast('已重置');
    });
    return;
  }

  if (record.widget === 'qr') {
    node.innerHTML = wrap('fragments',
      '<div class="qr-layout"><div class="qr-grid" aria-label="二维码拼图"></div><div class="qr-controls">' +
      '<div class="rotate-controls"><button class="button subtle" id="rotate-left" type="button" disabled>↶ 左转</button><button class="button subtle" id="rotate-right" type="button" disabled>↷ 右转</button></div>' +
      '<button class="button primary" id="scan-qr" type="button">识别 ↗</button><button class="button subtle" id="export-qr" type="button">导出 ↓</button>' +
      '<p id="qr-selection" class="mono"></p></div></div><p class="inline-message" id="qr-message" role="status"></p><div id="qr-result" hidden></div>');
    const manifest = await (await file('fragments.json')).json();
    const bitmaps = await Promise.all(manifest.files.map(async (name) => createImageBitmap(await (await file(name)).blob())));
    if (controls.signal.aborted) { bitmaps.forEach((bitmap) => bitmap.close()); return; }
    const pieces = [];
    let counter = 0;
    for (let i = 0; i < 9; i++) pieces.push(i === 4 ? null : { image: bitmaps[counter], name: manifest.files[counter++], turns: 0 });
    let selected = null;
    const buttons = [];
    const canvases = [];
    for (let i = 0; i < 9; i++) {
      if (i === 4) {
        const missing = document.createElement('div');
        missing.className = 'qr-empty';
        missing.textContent = '';
        q('.qr-grid').append(missing);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'qr-tile';
      button.setAttribute('aria-label', '第 ' + (i + 1) + ' 格碎片');
      button.setAttribute('aria-pressed', 'false');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = manifest.tileSize;
      button.append(canvas);
      buttons[i] = button;
      canvases[i] = canvas;
      button.addEventListener('click', () => {
        if (selected === null) selected = i;
        else if (selected === i) selected = null;
        else { [pieces[i], pieces[selected]] = [pieces[selected], pieces[i]]; selected = null; }
        draw();
      }, { signal: controls.signal });
      q('.qr-grid').append(button);
    }
    function draw() {
      for (let i = 0; i < 9; i++) {
        if (i === 4) continue;
        const ctx = canvases[i].getContext('2d');
        const side = manifest.tileSize;
        ctx.save();
        ctx.clearRect(0, 0, side, side);
        ctx.translate(side / 2, side / 2);
        ctx.rotate(pieces[i].turns * Math.PI / 2);
        ctx.drawImage(pieces[i].image, -side / 2, -side / 2);
        ctx.restore();
        buttons[i].classList.toggle('selected', selected === i);
        buttons[i].setAttribute('aria-pressed', String(selected === i));
      }
      q('#rotate-left').disabled = q('#rotate-right').disabled = selected === null;
      q('#qr-selection').textContent = selected === null ? '' : String(selected + 1) + ' · ' + pieces[selected].name;
    }
    function compose() {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = manifest.tileSize * 3;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      canvases.forEach((tile, i) => ctx.drawImage(tile, i % 3 * manifest.tileSize, Math.floor(i / 3) * manifest.tileSize));
      return canvas;
    }
    on('#rotate-left', 'click', () => { if (selected !== null) { pieces[selected].turns = (pieces[selected].turns + 3) % 4; draw(); } });
    on('#rotate-right', 'click', () => { if (selected !== null) { pieces[selected].turns = (pieces[selected].turns + 1) % 4; draw(); } });
    on('#scan-qr', 'click', () => {
      const canvas = compose();
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      const result = window.jsQR(pixels.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
      if (result && /^[a-z0-9]{20}$/.test(result.data)) {
        q('#qr-message').textContent = '';
        q('#qr-message').className = 'inline-message success';
        recovered(q('#qr-result'), { code: result.data }, controls);
      } else {
        q('#qr-message').textContent = '未识别';
        q('#qr-message').className = 'inline-message error';
      }
    });
    on('#export-qr', 'click', () => compose().toBlob((blob) => blob && controls.download('afterglow-restored-qr.png', blob), 'image/png'));
    draw();
    return () => bitmaps.forEach((bitmap) => bitmap.close());
  }

  if (record.widget === 'audio') {
    const url = record.files.find((item) => item.name === 'last-broadcast.wav').url;
    node.innerHTML = wrap('last-broadcast.wav',
      '<div class="audio-card"><div class="record-art" aria-hidden="true"></div><div><p>STEREO / PCM 16-BIT / 8 kHz</p></div></div>' +
      '<audio controls preload="metadata" src="' + escape(url) + '" aria-label="播放 WAV"></audio>');
    return () => { const audio = q('audio'); audio.pause(); audio.removeAttribute('src'); audio.load(); };
  }

  if (record.widget === 'images') {
    const before = record.files.find((item) => item.name === 'before.png').url;
    const after = record.files.find((item) => item.name === 'after.png').url;
    node.innerHTML = wrap('before.png / after.png',
      '<div class="image-pair"><figure><img src="' + escape(before) + '" width="384" height="256" alt="第一次曝光的星图"><figcaption>EXPOSURE A / BEFORE</figcaption></figure>' +
      '<figure><img src="' + escape(after) + '" width="384" height="256" alt="第二次曝光的星图"><figcaption>EXPOSURE B / AFTER</figcaption></figure></div>' +
      '<div class="image-compare" aria-hidden="true"><img src="' + escape(before) + '" alt=""><img id="overlay-image" src="' + escape(after) + '" alt=""></div>' +
      '<label class="compare-range" for="image-mix"><span>叠图</span><input id="image-mix" type="range" min="0" max="100" value="50"></label>');
    on('#image-mix', 'input', () => { q('#overlay-image').style.opacity = Number(q('#image-mix').value) / 100; });
    return;
  }

  if (['signature', 'wasm', 'final'].includes(record.widget)) {
    const wasm = record.widget === 'wasm';
    const final = record.widget === 'final';
    const length = wasm ? 20 : final ? 32 : 64;
    const label = wasm ? 'input (20 ASCII)' : 'key material (' + length + ' hex)';
    const title = wasm ? 'glass.wasm' : final ? 'last-letter.json' : 'sealed-letter.json';
    node.innerHTML = wrap(title,
      '<form class="decrypt-form"><label for="seal-input">' + label + '<input id="seal-input" type="text" minlength="' + length + '" maxlength="' + length + '" required autocomplete="off" spellcheck="false" autocapitalize="none"></label>' +
      '<button class="button primary" type="submit">' + (wasm ? '运行' : '解密') + ' ↗</button></form>' +
      '<p class="inline-message" id="seal-message" role="status"></p><div id="seal-result" hidden></div>');
    const sealName = wasm ? 'sealed-receipt.json' : final ? 'last-letter.json' : 'sealed-letter.json';
    const sealed = await (await file(sealName)).json();
    let instance;
    if (wasm) instance = (await WebAssembly.instantiate(await (await file('glass.wasm')).arrayBuffer())).instance;
    on('.decrypt-form', 'submit', async (event) => {
      event.preventDefault();
      const button = q('.decrypt-form button');
      button.disabled = true;
      q('#seal-message').textContent = '处理中';
      try {
        const input = q('#seal-input').value.trim();
        let material;
        if (wasm) {
          if (!/^[a-z0-9]{20}$/.test(input)) throw new Error('输入应为 20 位小写字母或数字。');
          material = new TextEncoder().encode(input);
          new Uint8Array(instance.exports.memory.buffer).set(material, 0);
          if (instance.exports.verify(0, material.length) !== 1) throw new Error('verify: 0');
        } else {
          if (!new RegExp('^[0-9a-fA-F]{' + length + '}$').test(input)) throw new Error('格式错误');
          material = Uint8Array.from(input.match(/../g), (byte) => parseInt(byte, 16));
        }
        let opened;
        try { opened = await openSeal(sealed, material); }
        catch { throw new Error('解密失败'); }
        q('#seal-message').textContent = '';
        q('#seal-message').className = 'inline-message success';
        recovered(q('#seal-result'), opened, controls);
      } catch (err) {
        q('#seal-message').textContent = err.message;
        q('#seal-message').className = 'inline-message error';
      } finally { button.disabled = false; }
    });
    return;
  }
  throw new Error('加载失败');
}

async function openSeal(sealed, material) {
  const bytes = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', material), 'AES-GCM', false, ['decrypt']);
  const ciphertext = bytes(sealed.ciphertext);
  const tag = bytes(sealed.tag);
  const data = new Uint8Array(ciphertext.length + tag.length);
  data.set(ciphertext);
  data.set(tag, ciphertext.length);
  const cleartext = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: bytes(sealed.nonce), additionalData: new TextEncoder().encode(sealed.context), tagLength: 128,
  }, key, data);
  return JSON.parse(new TextDecoder().decode(cleartext));
}
