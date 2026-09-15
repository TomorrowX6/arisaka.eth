import { $, $$, menubar, menu, shortcut, report, decorate, actionIcon, formatSize } from '/ui.js';
import { HOME, DOCUMENTS, normalize, basename, parent } from '/filesystem.js';
import { activeProfile } from '/preferences.js';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function hex(bytes, maximum = 65536) {
  const lines = [];
  for (let offset = 0; offset < Math.min(bytes.length, maximum); offset += 16) {
    const row = bytes.subarray(offset, offset + 16);
    const numbers = Array.from(row, (byte) => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47);
    const text = Array.from(row, (byte) => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.').join('');
    lines.push(offset.toString(16).padStart(8, '0') + '  ' + numbers + '  ' + text);
  }
  if (bytes.length > maximum) lines.push('…');
  return lines.join('\n');
}

function parse(line) {
  const tokens = [];
  let word = '', quote = '', escaped = false, started = false;
  const flush = () => { if (started) tokens.push({ text: word }); word = ''; started = false; };
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (escaped) { word += char; escaped = false; started = true; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (char === quote) quote = ''; else word += char; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) flush();
    else if (char === '|' || char === '>') { flush(); tokens.push({ operator: char === '>' && line[i + 1] === '>' ? (i++, '>>') : char }); }
    else { word += char; started = true; }
  }
  if (quote || escaped) throw new Error('bash: syntax error');
  flush();
  const pipeline = [[]]; let redirect;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.operator === '|') { if (!pipeline.at(-1).length) throw new Error('bash: syntax error'); pipeline.push([]); }
    else if (token.operator) {
      if (!tokens[i + 1] || tokens[i + 1].operator || i + 2 !== tokens.length) throw new Error('bash: syntax error');
      redirect = { path: tokens[++i].text, append: token.operator === '>>' };
    } else pipeline.at(-1).push(token.text);
  }
  return { pipeline, redirect };
}

export function createConsole(controls) {
  const { fs, windows } = controls;
  const sessions = [];
  let active;
  let second;
  let embedded;
  let counter = 0;
  let player = '';
  let fontSize = 13;
  const bytes = (value) => typeof value === 'string' ? encoder.encode(value) : value || new Uint8Array();
  const string = (value) => typeof value === 'string' ? value : decoder.decode(value || new Uint8Array());
  function persist() {
    try { localStorage.setItem('arisaka/konsole/' + player, JSON.stringify(sessions.map((item) => ({ cwd: item.cwd, history: item.history.slice(-100), lines: [...item.output.children].slice(-100).map((node) => ({ text: node.textContent, command: node.classList.contains('command') })) })))); } catch {}
  }
  function prompt(session) {
    session.label.textContent = activeProfile().username + '@arisaka:' + session.cwd.replace(HOME, '~') + '$';
    if (session === active) {
      windows.setTitle('console', session.cwd.replace(HOME, '~') + ' : bash — Konsole', 'console');
      $('#console-directory').textContent = session.cwd;
    }
    renderTabs();
  }
  function output(session, value, command = false) {
    const line = document.createElement('div'); line.className = 'shell-line' + (command ? ' command' : '');
    line.textContent = string(value).slice(0, 65536); session.output.append(line);
    while (session.output.childElementCount > 200) session.output.firstElementChild.remove();
    session.scroll.scrollTop = session.scroll.scrollHeight; persist();
  }
  async function execute(session, args, input) {
    const [name, ...values] = args;
    if (!name) return '';
    const targets = values.filter((value) => !value.startsWith('-'));
    const flags = values.filter((value) => value.startsWith('-')).join('');
    const target = targets[0];
    const path = normalize(target || '.', session.cwd);
    if (name === 'help') return 'ls  cd  pwd  cat  xxd  strings  base64  sha256sum  file\necho  printf  head  tail  wc  grep  mkdir  touch  cp  mv  rm\nopen  edit  node  clear  history  exit';
    if (name === 'pwd') return session.cwd;
    if (name === 'whoami') return activeProfile().username;
    if (name === 'echo') return values.join(' ') + (flags.includes('n') ? '' : '\n');
    if (name === 'printf') return (values[0] || '').replace(/%s/g, () => values.splice(1, 1)[0] || '').replaceAll('\\n', '\n').replaceAll('\\t', '\t');
    if (name === 'clear') { session.output.replaceChildren(); return ''; }
    if (name === 'history') return session.history.map((text, i) => String(i + 1).padStart(4) + '  ' + text).join('\n');
    if (name === 'exit') { if (session === embedded) $('#files-terminal-panel').hidden = true; else closeSession(session); return ''; }
    if (name === 'cd') { const next = target ? path : HOME; await fs.entries(next); session.cwd = next; return ''; }
    if (name === 'ls') {
      const files = (await fs.entries(path)).filter((file) => flags.includes('a') || !file.name.startsWith('.'));
      const username = activeProfile().username;
      return flags.includes('l') ? files.map((file) => (file.kind === 'directory' ? 'drwxr-xr-x' : file.writable ? '-rw-r--r--' : '-r--r--r--') + ' ' + username + ' ' + username + ' ' + String(file.size ?? 0).padStart(7) + ' ' + file.name).join('\n') : files.map((file) => file.name + (file.kind === 'directory' ? '/' : '')).join('  ');
    }
    if (name === 'open' || name === 'xdg-open') { await controls.openFile(path); return ''; }
    if (name === 'edit' || name === 'kate') {
      let text = '';
      try { text = await fs.readText(path); } catch (error) { if (!error.message.startsWith('ENOENT')) throw error; }
      controls.edit(target || 'untitled.js', text, path); return '';
    }
    if (['node', 'python', 'python3'].includes(name)) {
      const inline = values[0] === '-c';
      await controls.run(inline ? values[1] || '' : await fs.readText(path), (text) => output(session, text), { language: name === 'node' ? 'javascript' : 'python', filename: inline ? '<string>' : path });
      return '';
    }
    if (name === 'mkdir') { for (const item of targets) await fs.mkdir(normalize(item, session.cwd)); return ''; }
    if (name === 'touch') { for (const item of targets) { const p = normalize(item, session.cwd); let value = ''; try { value = await fs.read(p); } catch {} await fs.writeFile(p, value); } return ''; }
    if (name === 'rm') { for (const item of targets) await fs.remove(normalize(item, session.cwd), values.some((value) => /^-[rRf]*[rR]/.test(value))); return ''; }
    if (name === 'cp' || name === 'mv') {
      if (targets.length !== 2) throw new Error(name + ': missing file operand');
      let destination = normalize(targets[1], session.cwd);
      try { await fs.entries(destination); destination += '/' + basename(path); } catch {}
      if (name === 'cp') await fs.writeFile(destination, await fs.read(path), false); else await fs.rename(path, destination);
      return '';
    }
    if (!['cat', 'xxd', 'strings', 'base64', 'sha256sum', 'file', 'head', 'tail', 'wc', 'grep'].includes(name)) throw new Error('bash: ' + name + ': command not found');
    let content;
    if (name === 'grep') content = input !== undefined ? bytes(input) : await fs.read(normalize(targets[1] || '', session.cwd));
    else if (name === 'cat' && targets.length > 1) {
      const parts = await Promise.all(targets.map((value) => fs.read(normalize(value, session.cwd))));
      content = new Uint8Array(parts.reduce((n, part) => n + part.length, 0)); let offset = 0;
      for (const part of parts) { content.set(part, offset); offset += part.length; }
    } else content = input !== undefined ? bytes(input) : await fs.read(path);
    if (name === 'cat') return content;
    if (name === 'xxd') {
      if (flags.includes('r')) { const value = string(content).replace(/\s/g, ''); if (!/^(?:[a-fA-F0-9]{2})*$/.test(value)) throw new Error('xxd: invalid hex'); return Uint8Array.from(value.match(/../g) || [], (byte) => parseInt(byte, 16)); }
      return flags.includes('p') ? Array.from(content, (byte) => byte.toString(16).padStart(2, '0')).join('') : hex(content);
    }
    if (name === 'strings') return Array.from(content, (byte) => String.fromCharCode(byte)).join('').match(/[\x20-\x7e]{4,}/g)?.join('\n') || '';
    if (name === 'base64') {
      if (flags.includes('d')) return Uint8Array.from(atob(string(content).trim()), (char) => char.charCodeAt(0));
      let binary = ''; for (let i = 0; i < content.length; i += 8192) binary += String.fromCharCode(...content.subarray(i, i + 8192)); return btoa(binary);
    }
    if (name === 'sha256sum') return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', content)), (byte) => byte.toString(16).padStart(2, '0')).join('') + (input === undefined ? '  ' + target : '  -');
    if (name === 'head' || name === 'tail') {
      const n = values.indexOf('-n'); const count = n >= 0 ? Math.max(0, Number(values[n + 1]) || 0) : 10;
      const lines = string(content).split('\n'); return (name === 'head' ? lines.slice(0, count) : lines.slice(-count)).join('\n');
    }
    if (name === 'wc') { const text = string(content); return flags.includes('c') ? String(content.length) : flags.includes('l') ? String(text.split('\n').length - 1) : `${text.split('\n').length - 1} ${text.trim().split(/\s+/).filter(Boolean).length} ${content.length}`; }
    if (name === 'grep') { const query = flags.includes('i') ? (target || '').toLowerCase() : target || ''; return string(content).split('\n').filter((line) => (flags.includes('i') ? line.toLowerCase() : line).includes(query)).join('\n'); }
    const signature = Array.from(content.subarray(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return (target || '-') + ': ' + (signature.startsWith('89504e47') ? 'PNG image data' : signature.startsWith('4d546864') ? 'Standard MIDI data' : signature.startsWith('0061736d') ? 'WebAssembly binary module' : signature.startsWith('52494646') ? 'RIFF / WAVE audio' : signature.startsWith('504b0304') ? 'Zip archive data' : 'UTF-8 text / data');
  }
  async function submit(session, text) {
    if (!text.trim()) return;
    session.history.push(text); session.historyIndex = session.history.length;
    output(session, session.label.textContent + ' ' + text, true); session.input.value = ''; session.input.disabled = true;
    try {
      const parsed = parse(text); let result;
      for (const command of parsed.pipeline) result = await execute(session, command, result);
      if (parsed.redirect) {
        const path = normalize(parsed.redirect.path, session.cwd);
        let content = bytes(result);
        if (parsed.redirect.append) { let previous = new Uint8Array(); try { previous = await fs.read(path); } catch {} const joined = new Uint8Array(previous.length + content.length); joined.set(previous); joined.set(content, previous.length); content = joined; }
        await fs.writeFile(path, content);
      } else if (result?.length) output(session, string(result).replace(/\n$/, ''));
    } catch (error) { output(session, error.message); }
    finally { session.input.disabled = false; prompt(session); session.input.focus(); session.scroll.scrollTop = session.scroll.scrollHeight; persist(); }
  }
  function makeSession(container, cwd = HOME) {
    const session = { id: ++counter, cwd, history: [], historyIndex: 0 };
    const node = document.createElement('section'); node.className = 'console-session';
    const scroll = document.createElement('div'); scroll.className = 'console-scroll';
    const output = document.createElement('div'); output.className = 'session-output'; output.setAttribute('role', 'log');
    const form = document.createElement('form'); form.className = 'session-form';
    const label = document.createElement('label'); label.htmlFor = 'shell-' + session.id;
    const input = document.createElement('input'); input.id = label.htmlFor; input.autocomplete = 'off'; input.spellcheck = false; input.autocapitalize = 'off'; input.maxLength = 2000; input.setAttribute('aria-label', '终端命令');
    Object.assign(session, { node, scroll, output, form, label, input });
    form.append(label, input); scroll.append(output, form); node.append(scroll); container.append(node);
    form.addEventListener('submit', (event) => { event.preventDefault(); void submit(session, input.value); });
    node.addEventListener('pointerdown', () => { if (session !== embedded) { active = session; prompt(session); } });
    input.addEventListener('keydown', async (event) => {
      if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); session.historyIndex = Math.max(0, Math.min(session.history.length, session.historyIndex + (event.key === 'ArrowUp' ? -1 : 1))); input.value = session.history[session.historyIndex] || ''; }
      else if (shortcut(event, 'l')) { event.preventDefault(); session.output.replaceChildren(); }
      else if (shortcut(event, 'c')) { event.preventDefault(); controls.stop(); output(session, session.label.textContent + ' ' + input.value + '^C', true); input.value = ''; }
      else if (event.key === 'Tab') {
        event.preventDefault();
        const match = /(?:^|\s)([^\s]*)$/.exec(input.value);
        if (!match) return;
        const partial = match[1], folder = partial.includes('/') ? normalize(partial.slice(0, partial.lastIndexOf('/') + 1), session.cwd) : session.cwd;
        try {
          const prefix = partial.slice(partial.lastIndexOf('/') + 1);
          const matches = (await fs.entries(folder)).filter((item) => item.name.startsWith(prefix) && !item.locked);
          if (matches.length === 1) input.value = input.value.slice(0, input.value.length - prefix.length) + matches[0].name + (matches[0].kind === 'directory' ? '/' : ' ');
          else if (matches.length) output(session, matches.map((item) => item.name).join('  '));
        } catch {}
      }
    });
    prompt(session); return session;
  }
  function renderTabs() {
    const tabs = $('#console-tabs'); if (!tabs) return; tabs.replaceChildren();
    for (const session of sessions) {
      const node = document.createElement('div'); node.className = 'document-tab' + (session === active ? ' selected' : '');
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(session === active));
      button.textContent = basename(session.cwd) + ' : bash'; button.prepend(actionIcon('tab-new'));
      button.addEventListener('click', () => activate(session));
      const close = document.createElement('button'); close.type = 'button'; close.className = 'tab-close'; close.textContent = '×'; close.setAttribute('aria-label', '关闭终端标签'); close.addEventListener('click', () => closeSession(session));
      node.append(button, close); tabs.append(node);
    }
  }
  function activate(session) {
    active = session;
    for (const item of sessions) item.node.hidden = item !== active && item !== second;
    prompt(session); session.input.focus();
  }
  function newSession(cwd = active?.cwd || HOME) {
    const session = makeSession($('#console-sessions'), cwd); sessions.push(session); activate(session); persist(); return session;
  }
  function closeSession(session = active) {
    if (!session) return;
    const index = sessions.indexOf(session); sessions.splice(index, 1); session.node.remove(); if (second === session) second = null;
    if (!sessions.length) { newSession(); windows.close('console'); }
    else activate(sessions[Math.min(index, sessions.length - 1)]);
    persist();
  }
  function split() {
    if (second) { second = null; activate(active); }
    else { const previous = active; newSession(active.cwd); second = previous; second.node.hidden = false; }
    $('#console-split').setAttribute('aria-pressed', String(Boolean(second)));
  }
  const copy = () => navigator.clipboard.writeText(getSelection()?.toString() || '');
  const paste = async () => { active.input.value += (await navigator.clipboard.readText()).slice(0, 2000); active.input.focus(); };
  const find = () => { $('#console-findbar').hidden = false; $('#console-search').focus(); };
  const definitions = {
    '文件': () => [{ label: '新建标签页', icon: 'tab-new', shortcut: 'Ctrl+Shift+T', action: () => newSession() }, { label: '拆分视图', icon: 'view-split-left-right', checked: Boolean(second), action: split }, null, { label: '关闭标签页', shortcut: 'Ctrl+Shift+W', action: () => closeSession() }],
    '编辑': [{ label: '复制', icon: 'edit-copy', shortcut: 'Ctrl+Shift+C', action: copy }, { label: '粘贴', icon: 'edit-paste', shortcut: 'Ctrl+Shift+V', action: paste }, null, { label: '查找…', icon: 'edit-find', shortcut: 'Ctrl+Shift+F', action: find }],
    '视图': () => [{ label: '放大', icon: 'zoom-in', action: () => { fontSize = Math.min(24, fontSize + 1); $('#console-sessions').style.fontSize = fontSize + 'px'; } }, { label: '缩小', icon: 'zoom-out', action: () => { fontSize = Math.max(10, fontSize - 1); $('#console-sessions').style.fontSize = fontSize + 'px'; } }, { label: '清空滚动历史', action: () => active.output.replaceChildren() }, { label: '显示菜单栏', checked: !$('#console-menubar').hidden, shortcut: 'Ctrl+Shift+M', action: () => { $('#console-menubar').hidden = !$('#console-menubar').hidden; } }],
  };
  menubar($('#console-menubar'), definitions);
  const actions = { '#console-new': () => newSession(), '#console-split': split, '#console-copy': copy, '#console-paste': paste, '#console-find': find, '#console-find-close': () => { $('#console-findbar').hidden = true; }, '#console-menu': () => menu([...definitions['文件'](), null, ...definitions['编辑'], null, ...definitions['视图']()], $('#console-menu')) };
  for (const [selector, action] of Object.entries(actions)) $(selector).addEventListener('click', () => Promise.resolve().then(action).catch(report));
  $('#console-search').addEventListener('input', (event) => {
    const query = event.target.value.toLowerCase();
    for (const row of active.output.children) row.classList.toggle('terminal-match', Boolean(query) && row.textContent.toLowerCase().includes(query));
    active.output.querySelector('.terminal-match')?.scrollIntoView({ block: 'nearest' });
  });
  $('#console-window').addEventListener('keydown', (event) => {
    let action;
    if (shortcut(event, 't', true)) action = () => newSession();
    else if (shortcut(event, 'w', true)) action = () => closeSession();
    else if (shortcut(event, 'c', true)) action = copy;
    else if (shortcut(event, 'v', true)) action = paste;
    else if (shortcut(event, 'f', true)) action = find;
    else if (shortcut(event, 'm', true)) action = () => { $('#console-menubar').hidden = !$('#console-menubar').hidden; };
    if (action) { event.preventDefault(); Promise.resolve().then(action).catch(report); }
  }, true);
  $('#console-window').addEventListener('window:open', () => active?.input.focus());
  function setPlayer(value) {
    player = value; sessions.splice(0); $('#console-sessions').replaceChildren(); second = null; active = null; embedded = null; $('#files-terminal').replaceChildren();
    let saved;
    try { saved = JSON.parse(localStorage.getItem('arisaka/konsole/' + player) || '[]'); } catch {}
    for (const item of (Array.isArray(saved) ? saved : []).slice(0, 8)) {
      const session = newSession(typeof item.cwd === 'string' ? normalize(item.cwd) : HOME);
      session.history = (item.history || []).filter((value) => typeof value === 'string').slice(-100); session.historyIndex = session.history.length;
      for (const line of (item.lines || []).slice(-100)) output(session, line.text, line.command);
    }
    if (!sessions.length) newSession();
  }
  return {
    setPlayer,
    open: async (cwd) => { if (cwd) { await fs.entries(cwd); active.cwd = cwd; prompt(active); } windows.open('console'); active.input.focus(); },
    embedded: async (cwd) => { await fs.entries(cwd); if (!embedded) embedded = makeSession($('#files-terminal'), cwd); embedded.cwd = cwd; prompt(embedded); embedded.input.focus(); },
  };
}
