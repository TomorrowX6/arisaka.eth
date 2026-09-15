// KDE color-scheme interchange and global shortcut definitions. No game data.
const hex = value => value.toString(16).padStart(2, '0');
const colorKeys = {
  bg: ['Colors:View', 'BackgroundNormal'],
  panel: ['Colors:Window', 'BackgroundNormal'],
  raised: ['Colors:Button', 'BackgroundNormal'],
  sidebar: ['Colors:View', 'BackgroundAlternate'],
  ink: ['Colors:View', 'ForegroundNormal'],
  muted: ['Colors:View', 'ForegroundInactive'],
  line: ['Colors:Window', 'DecorationFocus'],
  accent: ['Colors:Selection', 'BackgroundNormal'],
};

export function parseColorScheme(source) {
  if (typeof source !== 'string' || source.length > 65536 || source.includes('\0')) throw Error('无效的配色文件');
  const groups = new Map(); let group;
  for (const raw of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (/^\[[^\[\]\r\n]+\]$/.test(line)) { group = line.slice(1, -1); if (!groups.has(group)) groups.set(group, new Map()); continue; }
    const index = line.indexOf('=');
    if (!group || index < 1) continue;
    groups.get(group).set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  const colors = {};
  for (const [key, [section, name]] of Object.entries(colorKeys)) {
    const value = groups.get(section)?.get(name);
    if (value === undefined) continue;
    if (/^#[\da-f]{6}$/i.test(value)) { colors[key] = value.toLowerCase(); continue; }
    if (!/^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*\d{1,3})?$/.test(value)) throw Error('无效的 RGB 颜色：' + name);
    const channels = value.split(',').map(Number);
    if (channels.some(channel => channel > 255)) throw Error('RGB 颜色超出范围：' + name);
    colors[key] = '#' + channels.slice(0, 3).map(hex).join('');
  }
  if (!colors.bg || !colors.ink || !colors.panel || !colors.accent) throw Error('配色文件缺少必要颜色');
  return { name: (groups.get('General')?.get('Name') || 'Custom').slice(0, 80), colors };
}

export function serializeColorScheme(colors, name = 'Arisaka') {
  const groups = new Map([['General', new Map([['Name', String(name).replace(/[\r\n\0=]/g, ' ').slice(0, 80)]])]]);
  for (const [key, [section, property]] of Object.entries(colorKeys)) {
    const value = colors[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw Error('无效颜色：' + key);
    if (!groups.has(section)) groups.set(section, new Map());
    groups.get(section).set(property, value.slice(1).match(/../g).map(pair => parseInt(pair, 16)).join(','));
  }
  for (const section of ['Colors:Window', 'Colors:Button', 'Colors:Selection']) {
    if (!groups.has(section)) continue;
    groups.get(section).set('ForegroundNormal', section === 'Colors:Selection' ? '255,255,255' : groups.get('Colors:View')?.get('ForegroundNormal') || '239,240,241');
  }
  const source = [...groups].map(([section, values]) => '[' + section + ']\n' + [...values].map(([key, value]) => key + '=' + value).join('\n')).join('\n\n') + '\n';
  parseColorScheme(source);
  return source;
}

export const shortcutActions = Object.freeze([
  ['launcher', '应用程序启动器', 'Meta, Alt+F1'],
  ['runner', 'KRunner', 'Alt+Space, Alt+F2'],
  ['files', 'Dolphin', 'Meta+E'],
  ['console', 'Konsole', 'Ctrl+Alt+T'],
  ['lock', '锁定屏幕', 'Meta+L'],
  ['show-desktop', '显示桌面', 'Meta+D'],
  ['overview', '桌面概览', 'Meta+W'],
  ['clipboard', '剪贴板', 'Meta+V'],
  ['screenshot', 'Spectacle', 'PrintScreen'],
  ['window-next', '下一个窗口', 'Alt+Tab'],
  ['window-previous', '上一个窗口', 'Alt+Shift+Tab'],
  ['window-close', '关闭窗口', 'Alt+F4'],
  ['window-maximize', '最大化 / 还原', 'Meta+ArrowUp'],
  ['window-minimize', '最小化', 'Meta+ArrowDown'],
  ['window-left', '向左平铺', 'Meta+ArrowLeft'],
  ['window-right', '向右平铺', 'Meta+ArrowRight'],
  ['desktop-next', '下一个桌面', 'Ctrl+Alt+ArrowRight'],
  ['desktop-previous', '上一个桌面', 'Ctrl+Alt+ArrowLeft'],
  ['move-next', '窗口移到下一个桌面', 'Ctrl+Alt+Shift+ArrowRight'],
  ['move-previous', '窗口移到上一个桌面', 'Ctrl+Alt+Shift+ArrowLeft'],
]);
const modifiers = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const specialKeys = ['Space', 'Tab', 'Enter', 'Escape', 'Delete', 'Backspace', 'Home', 'End', 'PageUp', 'PageDown', 'PrintScreen', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
export function normalizeShortcut(input) {
  if (typeof input !== 'string' || input.length > 100) throw Error('无效快捷键');
  if (!input.trim()) return '';
  const result = input.split(',').map(binding => {
    const parts = binding.trim().split('+').map(part => part.trim());
    if (parts.length === 1 && parts[0] === 'Meta') return 'Meta';
    const key = parts.pop();
    if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(key) && !specialKeys.includes(key)) throw Error('无效按键：' + key);
    if (parts.some(part => !modifiers.includes(part)) || new Set(parts).size !== parts.length) throw Error('无效修饰键');
    if (!parts.length && !/^(?:F\d+|PrintScreen)$/.test(key)) throw Error('需要 Ctrl、Alt 或 Meta 修饰键');
    if (parts.length === 1 && parts[0] === 'Shift') throw Error('需要 Ctrl、Alt 或 Meta 修饰键');
    return [...modifiers.filter(part => parts.includes(part)), key].join('+');
  });
  if (result.length > 2 || new Set(result).size !== result.length) throw Error('最多设置两个不同的快捷键');
  return result.join(', ');
}
export function shortcutBinding(settings, id) {
  return settings.shortcuts?.[id] ?? shortcutActions.find(action => action[0] === id)?.[2] ?? '';
}
export function validateShortcuts(settings) {
  const assigned = new Map();
  for (const [id, label] of shortcutActions) {
    for (const value of normalizeShortcut(shortcutBinding(settings, id)).split(', ').filter(Boolean)) {
      if (assigned.has(value)) throw Error(value + '：' + assigned.get(value) + ' / ' + label);
      assigned.set(value, label);
    }
  }
  return true;
}
export function eventShortcut(event) {
  if (event.key === 'Meta') return 'Meta';
  if (['Control', 'Shift', 'Alt', 'Dead', 'Unidentified'].includes(event.key)) return '';
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : event.code === 'Space' || event.key === ' ' ? 'Space' : event.key;
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', key].filter(Boolean).join('+');
}
export function matchesShortcut(event, settings, id) {
  if (event.isComposing || event.target?.closest?.('[data-shortcut],dialog[open]')) return false;
  const current = eventShortcut(event);
  return Boolean(current) && shortcutBinding(settings, id).split(', ').includes(current);
}
