import { normalizeShortcut, shortcutActions, validateShortcuts } from '/desktop-config.js';

const PROFILE_KEY = 'arisaka/plasma/profiles/v1';
const SETTINGS_KEY = 'arisaka/plasma/settings/';
const encoder = new TextEncoder();
const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const unhex = (text) => Uint8Array.from(text.match(/../g) || [], (byte) => parseInt(byte, 16));
const color = (value) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);

export const themes = [
  { id: 'breeze-dark', name: 'Breeze 深色', dark: true, colors: ['#232629', '#31363b', '#eff0f1', '#3daee9'] },
  { id: 'breeze-light', name: 'Breeze 浅色', dark: false, colors: ['#ffffff', '#eff0f1', '#232629', '#3daee9'] },
  { id: 'breeze-twilight', name: 'Breeze 暮光', dark: false, colors: ['#ffffff', '#eff0f1', '#232629', '#3daee9'] },
  { id: 'nord', name: 'Nord', dark: true, colors: ['#242933', '#2e3440', '#eceff4', '#88c0d0'] },
  { id: 'dracula', name: 'Dracula', dark: true, colors: ['#21222c', '#282a36', '#f8f8f2', '#bd93f9'] },
  { id: 'contrast', name: '高对比度', dark: true, colors: ['#080808', '#151515', '#ffffff', '#ffd75e'] },
  { id: 'custom', name: '自定义配色', dark: true, colors: ['#232629', '#31363b', '#eff0f1', '#3daee9'] },
];
export const wallpapers = [
  { id: 'breeze', name: 'Breeze', color: '#1a506b' },
  { id: 'mountain', name: 'Mountain', color: '#476480', file: '/wallpapers/mountain.jpg' },
  { id: 'flow', name: 'Flow', color: '#6373c2', file: '/wallpapers/flow.jpg' },
  { id: 'scarlet', name: 'Scarlet Tree', color: '#74334c', file: '/wallpapers/scarlet.jpg' },
  { id: 'aurora', name: '极光', color: '#25594e' },
  { id: 'midnight', name: '午夜', color: '#272342' },
  { id: 'sand', name: '沙丘', color: '#936e57' },
  { id: 'solid', name: '纯色', color: '#1c2734' },
  { id: 'custom', name: '自定义图片', color: '#38454f' },
];
export const defaults = Object.freeze({
  theme: 'breeze-dark', accent: '#3daee9', wallpaper: 'breeze', wallpaperColor: '#1c2734',
  wallpaperImage: '', wallpaperMode: 'cover', customColors: {},
  fontFamily: 'Noto Sans', fontSize: 13, monoFont: 'Hack', monoSize: 13, scale: 100,
  panelPosition: 'bottom', panelSize: 48, panelFloating: true, panelAutoHide: false,
  desktopCount: 4, desktopNames: ['桌面 1', '桌面 2', '桌面 3', '桌面 4'], showDesktopIcons: true,
  singleClick: false, animations: true, reducedTransparency: false, titlebarDoubleClick: 'maximize',
  focusFollowsMouse: false, snapWindows: true, taskCurrentDesktop: false,
  pinnedApps: ['files', 'console', 'editor', 'http', 'settings'],
  timeZone: 'Asia/Shanghai', hour24: true, showSeconds: false, weekStart: 1,
  volume: 70, muted: false, notifications: true, doNotDisturb: false,
  lockMinutes: 0, lockOnStart: false, rememberWindows: true,
  cursorSize: 24, nightLight: false, nightWarmth: 20,
  shortcuts: {},
});

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function cleanSettings(input = {}) {
  if (!input || typeof input !== 'object') input = {};
  const result = structuredClone(defaults);
  const choices = {
    theme: themes.map((item) => item.id), wallpaper: wallpapers.map((item) => item.id),
    wallpaperMode: ['cover', 'contain', 'repeat'], panelPosition: ['bottom', 'top', 'left', 'right'],
    fontFamily: ['Noto Sans', 'sans-serif', 'serif'], monoFont: ['Hack', 'monospace', 'Noto Sans Mono'],
    titlebarDoubleClick: ['maximize', 'shade', 'none'],
  };
  for (const [key, values] of Object.entries(choices)) if (values.includes(input[key])) result[key] = input[key];
  for (const key of ['accent', 'wallpaperColor']) if (color(input[key])) result[key] = input[key];
  for (const [key, value] of Object.entries(defaults)) if (typeof value === 'boolean' && typeof input[key] === 'boolean') result[key] = input[key];
  const ranges = { fontSize: [10, 20], monoSize: [10, 24], scale: [85, 150], panelSize: [38, 72], desktopCount: [1, 8], volume: [0, 100], lockMinutes: [0, 120], cursorSize: [16, 48], nightWarmth: [0, 70], weekStart: [0, 1] };
  for (const [key, [min, max]] of Object.entries(ranges)) if (Number.isFinite(input[key])) result[key] = Math.round(Math.max(min, Math.min(max, input[key])));
  try { if (typeof input.timeZone === 'string') { new Intl.DateTimeFormat('zh-CN', { timeZone: input.timeZone }).format(); result.timeZone = input.timeZone; } } catch {}
  if (Array.isArray(input.desktopNames)) result.desktopNames = input.desktopNames.slice(0, 8).map((name, i) => String(name || '桌面 ' + (i + 1)).slice(0, 32));
  while (result.desktopNames.length < result.desktopCount) result.desktopNames.push('桌面 ' + (result.desktopNames.length + 1));
  if (Array.isArray(input.pinnedApps)) result.pinnedApps = [...new Set(input.pinnedApps.filter((id) => typeof id === 'string' && /^[a-z-]{1,30}$/.test(id)))].slice(0, 20);
  if (typeof input.wallpaperImage === 'string' && input.wallpaperImage.length <= 2_000_000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z\d+/]+=*$/.test(input.wallpaperImage)) result.wallpaperImage = input.wallpaperImage;
  for (const [key, value] of Object.entries(input.customColors || {})) if (['bg', 'panel', 'raised', 'sidebar', 'ink', 'muted', 'line', 'accent'].includes(key) && color(value)) result.customColors[key] = value;
  for (const [id] of shortcutActions) {
    if (typeof input.shortcuts?.[id] === 'string') {
      try { result.shortcuts[id] = normalizeShortcut(input.shortcuts[id]); } catch {}
    }
  }
  return result;
}

let profiles = read(PROFILE_KEY, {});
if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) profiles = {};
profiles.users = Array.isArray(profiles.users) ? profiles.users.filter((user) => user && typeof user === 'object' && (user.id === 'default' || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(user.id)) && /^[a-z_][a-z\d_-]{0,23}$/.test(user.username)).slice(0, 8) : [];
profiles.users = profiles.users.filter((user, index, all) => all.findIndex(item => item.id === user.id || item.username === user.username) === index).map(user => ({
  ...user, name: String(user.name || user.username).slice(0, 40), avatar: String(user.avatar || user.username).slice(0, 4), color: color(user.color) ? user.color : '#3daee9',
}));
if (!profiles.users.length) profiles.users.push({ id: 'default', username: 'user', name: 'Arisaka', avatar: 'A', color: '#3daee9', created: Date.now() });
if (!profiles.users.some((user) => user.id === profiles.active)) profiles.active = profiles.users[0].id;
let settings = cleanSettings(read(SETTINGS_KEY + profiles.active, {}));
export const preferenceEvents = new EventTarget();

function saveProfiles(next) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(next));
  profiles = next;
  preferenceEvents.dispatchEvent(new Event('users'));
}
export function activeProfile() { const { password, ...user } = profiles.users.find((user) => user.id === profiles.active); return { ...user, protected: Boolean(password) }; }
export function listProfiles() { return profiles.users.map(({ password, ...user }) => ({ ...user, protected: Boolean(password) })); }
export function profileKey() { return profiles.active; }
export function getSettings() { return structuredClone(settings); }
export function getSetting(key) { return settings[key]; }

export function applyAppearance(input = settings) {
  const value = cleanSettings(input);
  const root = document.documentElement;
  root.dataset.theme = value.theme;
  root.dataset.wallpaper = value.wallpaper;
  root.dataset.panel = value.panelPosition;
  root.dataset.floating = String(value.panelFloating);
  root.dataset.autohide = String(value.panelAutoHide);
  root.dataset.motion = value.animations ? 'on' : 'off';
  root.dataset.transparency = value.reducedTransparency ? 'reduced' : 'normal';
  root.dataset.desktopIcons = String(value.showDesktopIcons);
  root.style.setProperty('--accent', value.accent);
  root.style.setProperty('--ui-font', value.fontFamily + ', "Noto Sans CJK SC", "Microsoft YaHei", sans-serif');
  root.style.setProperty('--mono', value.monoFont + ', "Noto Sans Mono", monospace');
  root.style.setProperty('--ui-font-size', value.fontSize * value.scale / 100 + 'px');
  root.style.setProperty('--mono-size', value.monoSize + 'px');
  root.style.setProperty('--panel-size', value.panelSize + 'px');
  root.style.setProperty('--wallpaper-color', value.wallpaperColor);
  root.style.setProperty('--night-opacity', value.nightLight ? String(value.nightWarmth / 220) : '0');
  const cursor = '<svg xmlns="http://www.w3.org/2000/svg" width="' + value.cursorSize + '" height="' + value.cursorSize + '" viewBox="0 0 24 24"><path d="M3 2v18l4.7-4.6 3.4 7 3.2-1.6-3.4-6.7H18Z" fill="#232629" stroke="#eff0f1" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  root.style.setProperty('--desktop-cursor', 'url("data:image/svg+xml;base64,' + btoa(cursor) + '") 3 2, default');
  const background = wallpapers.find((wallpaper) => wallpaper.id === value.wallpaper);
  root.style.setProperty('--wallpaper-image', background?.file ? `url("${background.file}")` : value.wallpaper === 'custom' && value.wallpaperImage ? `url("${value.wallpaperImage}")` : 'none');
  root.style.setProperty('--wallpaper-fit', value.wallpaperMode === 'repeat' ? 'auto' : value.wallpaperMode);
  root.style.setProperty('--wallpaper-repeat', value.wallpaperMode === 'repeat' ? 'repeat' : 'no-repeat');
  for (const key of ['bg', 'panel', 'raised', 'sidebar', 'ink', 'muted', 'line']) {
    if (value.theme === 'custom' && value.customColors[key]) root.style.setProperty('--' + key, value.customColors[key]);
    else root.style.removeProperty('--' + key);
  }
  preferenceEvents.dispatchEvent(new CustomEvent('appearance', { detail: value }));
}
export function saveSettings(input) {
  validateShortcuts(input);
  const next = cleanSettings(input);
  localStorage.setItem(SETTINGS_KEY + profiles.active, JSON.stringify(next));
  settings = next;
  applyAppearance();
  preferenceEvents.dispatchEvent(new CustomEvent('change', { detail: getSettings() }));
}
export function updateSettings(patch) { saveSettings({ ...settings, ...patch }); }

async function passwordDigest(password, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 210_000, salt: unhex(salt) }, material, 256)));
}
export async function authenticateProfile(id, password = '') {
  const user = profiles.users.find((item) => item.id === id);
  if (!user) return false;
  if (!user.password) return true;
  if (!/^[a-f0-9]{32}$/.test(user.password.salt) || !/^[a-f0-9]{64}$/.test(user.password.hash)) return false;
  const actual = await passwordDigest(password, user.password.salt);
  let difference = 0;
  for (let index = 0; index < actual.length; index++) difference |= actual.charCodeAt(index) ^ user.password.hash.charCodeAt(index);
  return difference === 0;
}
export async function createProfile({ username, name, password = '', avatar = '', color: tint = '#3daee9' }) {
  if (profiles.users.length >= 8) throw new Error('最多 8 个用户');
  if (!/^[a-z_][a-z\d_-]{0,23}$/.test(username)) throw new Error('用户名格式无效');
  if (profiles.users.some((user) => user.username === username)) throw new Error('用户名已存在');
  if (password && password.length < 4) throw new Error('密码至少需要 4 个字符');
  const user = { id: crypto.randomUUID(), username, name: String(name || username).slice(0, 40), avatar: String(avatar || name || username).slice(0, 2).toUpperCase(), color: color(tint) ? tint : '#3daee9', created: Date.now() };
  if (password) { const salt = hex(crypto.getRandomValues(new Uint8Array(16))); user.password = { salt, hash: await passwordDigest(password, salt) }; }
  saveProfiles({ ...profiles, users: [...profiles.users, user] });
  return user.id;
}
export async function editProfile(id, patch, currentPassword = '') {
  if (!await authenticateProfile(id, currentPassword)) throw new Error('密码错误');
  const users = structuredClone(profiles.users);
  const user = users.find((item) => item.id === id);
  if (!user) throw new Error('用户不存在');
  if (typeof patch.name === 'string' && patch.name.trim()) user.name = patch.name.trim().slice(0, 40);
  if (typeof patch.avatar === 'string' && patch.avatar.trim()) user.avatar = [...patch.avatar.trim()].slice(0, 2).join('');
  if (color(patch.color)) user.color = patch.color;
  if (patch.password !== undefined) {
    if (patch.password && patch.password.length < 4) throw new Error('密码至少需要 4 个字符');
    if (!patch.password) delete user.password;
    else { const salt = hex(crypto.getRandomValues(new Uint8Array(16))); user.password = { salt, hash: await passwordDigest(patch.password, salt) }; }
  }
  saveProfiles({ ...profiles, users });
}
export async function removeProfile(id, password = '') {
  if (profiles.users.length === 1 || id === profiles.active) throw new Error('无法删除当前用户');
  if (!await authenticateProfile(id, password)) throw new Error('密码错误');
  const response = await fetch('/api/profile/delete', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Afterglow': '1', 'X-Desktop-Profile': profiles.active },
    body: JSON.stringify({ profile: id }),
  });
  if (!response.ok) throw new Error((await response.json()).error || '删除存档失败');
  saveProfiles({ ...profiles, users: profiles.users.filter((user) => user.id !== id) });
  localStorage.removeItem(SETTINGS_KEY + id);
}
export async function activateProfile(id, password = '') {
  if (!await authenticateProfile(id, password)) throw new Error('密码错误');
  saveProfiles({ ...profiles, active: id });
  sessionStorage.setItem('arisaka/unlocked/' + id, '1');
  sessionStorage.removeItem('arisaka/locked/' + id);
  location.reload();
}
applyAppearance();
