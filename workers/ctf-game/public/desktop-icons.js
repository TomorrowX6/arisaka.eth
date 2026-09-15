import { applications } from '/applications.js';
import { icon } from '/desktop.js';
import { getSettings, preferenceEvents, profileKey } from '/preferences.js';
import { closeMenu } from '/ui.js';

const APP_DRAG_TYPE = 'application/x-arisaka-desktop-app';
const sourceSelector = '.desktop-icons button[data-launch], #launcher-apps button[data-launch]';
const cellKey = ({ column, row }) => column + ':' + row;

export function createDesktopIcons({ onDrop = () => {} } = {}) {
  const desktop = document.querySelector('#desktop');
  const grid = desktop.querySelector('.desktop-icons');
  const apps = new Map(applications.filter(app => !app.hidden).map(app => [app.id, app]));
  const buttons = new Map([...grid.querySelectorAll('[data-launch]')].map(button => [button.dataset.launch, button]));
  const storageKey = 'arisaka/desktop-icons/v1/' + profileKey();
  let positions = new Map(), dragging = null, suppressClick = false;
  grid.tabIndex = -1;

  function metrics(count = 0) {
    const style = getComputedStyle(grid), root = document.documentElement.style;
    const width = parseFloat(root.getPropertyValue('--work-width')) - 2 * parseFloat(style.getPropertyValue('--desktop-inset-x'));
    const height = parseFloat(root.getPropertyValue('--work-height')) - 2 * parseFloat(style.getPropertyValue('--desktop-inset-y'));
    const cellWidth = parseFloat(style.getPropertyValue('--desktop-cell-width'));
    const cellHeight = parseFloat(style.getPropertyValue('--desktop-cell-height'));
    const columnGap = parseFloat(style.columnGap), rowGap = parseFloat(style.rowGap);
    const rows = Math.max(1, Math.floor((height + rowGap) / (cellHeight + rowGap)));
    return {
      stepX: cellWidth + columnGap, stepY: cellHeight + rowGap,
      columns: Math.max(1, Math.floor((width + columnGap) / (cellWidth + columnGap)), Math.ceil(count / rows)),
      rows,
    };
  }
  const initial = metrics();
  let entries = [...buttons.keys()].map((id, index) => ({ id, column: Math.floor(index / initial.rows), row: index % initial.rows }));
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(saved)) {
      const seen = new Set();
      const valid = saved.filter(entry => {
        if (!entry || !apps.has(entry.id) || seen.has(entry.id)
          || ![entry.column, entry.row].every(value => Number.isSafeInteger(value) && value >= 0 && value < 10000)) return false;
        seen.add(entry.id);
        return true;
      }).map(({ id, column, row }) => ({ id, column, row }));
      if (!saved.length || valid.length) entries = valid;
    }
  } catch {}

  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(entries)); } catch {}
  }
  function firstFree(occupied, rows) {
    let index = 0;
    while (occupied.has(cellKey({ column: Math.floor(index / rows), row: index % rows }))) index++;
    return { column: Math.floor(index / rows), row: index % rows };
  }
  function buttonFor(id) {
    if (!buttons.has(id)) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.launch = id;
      const image = document.createElement('span'); image.className = 'app-icon'; image.innerHTML = icon(id);
      const label = document.createElement('span'); label.textContent = apps.get(id).name;
      button.append(image, label); buttons.set(id, button);
    }
    return buttons.get(id);
  }
  function layout() {
    const { columns, rows } = metrics(entries.length), occupied = new Set();
    positions = new Map();
    // Reserve positions that still fit before relocating icons from outside the work area.
    for (const { id, column, row } of entries) {
      const position = { column, row };
      if (column < columns && row < rows && !occupied.has(cellKey(position))) {
        positions.set(id, position); occupied.add(cellKey(position));
      }
    }
    for (const entry of entries) {
      if (positions.has(entry.id)) continue;
      let position = { column: Math.min(entry.column, columns - 1), row: Math.min(entry.row, rows - 1) };
      if (occupied.has(cellKey(position))) position = firstFree(occupied, rows);
      positions.set(entry.id, position); occupied.add(cellKey(position));
    }
    for (const [id, button] of buttons) if (!positions.has(id)) button.remove();
    for (const { id } of entries) {
      const button = buttonFor(id), position = positions.get(id);
      button.draggable = true;
      button.style.gridColumn = String(position.column + 1);
      button.style.gridRow = String(position.row + 1);
      if (button.parentElement !== grid) grid.append(button);
    }
  }

  const indicator = document.createElement('span');
  indicator.className = 'desktop-drop-target'; indicator.hidden = true; indicator.setAttribute('aria-hidden', 'true');
  grid.append(indicator);
  function dropPosition(event) {
    if (!event.dataTransfer?.types.includes(APP_DRAG_TYPE) || !getSettings().showDesktopIcons
      || event.target.closest('.window,.plasma-panel,#launcher,#shell-overlays,.native-menu')) return null;
    const rect = grid.getBoundingClientRect();
    if (!rect.width || !rect.height || event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) return null;
    const { columns, rows, stepX, stepY } = metrics(entries.length);
    return {
      column: Math.min(columns - 1, Math.floor((event.clientX - rect.left + grid.scrollLeft) / stepX)),
      row: Math.min(rows - 1, Math.floor((event.clientY - rect.top + grid.scrollTop) / stepY)),
    };
  }
  function clearDrag() {
    dragging?.button.classList.remove('dragging');
    dragging = null; indicator.hidden = true;
  }
  function select(id) {
    for (const [other, button] of buttons) button.classList.toggle('selected', id === other);
    buttons.get(id)?.focus({ preventScroll: true });
  }
  function place(id, position) {
    const previous = positions.get(id);
    const occupant = entries.find(entry => entry.id !== id && cellKey(positions.get(entry.id)) === cellKey(position));
    if (occupant) {
      const occupied = new Set([...positions.values()].map(cellKey));
      Object.assign(occupant, previous || firstFree(occupied, metrics().rows));
    }
    const entry = entries.find(entry => entry.id === id);
    if (entry) Object.assign(entry, position);
    else entries.push({ id, ...position });
    layout(); save(); select(id);
  }

  document.addEventListener('dragstart', event => {
    const button = event.target.closest(sourceSelector);
    if (!button || !event.dataTransfer || !apps.has(button.dataset.launch)) return;
    closeMenu();
    const id = button.dataset.launch;
    event.dataTransfer.setData(APP_DRAG_TYPE, id);
    event.dataTransfer.effectAllowed = grid.contains(button) ? 'move' : 'copyMove';
    dragging = { id, button }; suppressClick = true;
    button.classList.add('dragging');
    if (grid.contains(button)) select(id);
  });
  desktop.addEventListener('dragover', event => {
    const position = dropPosition(event);
    indicator.hidden = !position;
    if (!position) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = dragging && positions.has(dragging.id) ? 'move' : 'copy';
    const { stepX, stepY } = metrics();
    indicator.style.left = position.column * stepX + 'px';
    indicator.style.top = position.row * stepY + 'px';
  });
  desktop.addEventListener('dragleave', event => {
    if (!desktop.contains(event.relatedTarget)) indicator.hidden = true;
  });
  desktop.addEventListener('drop', event => {
    const position = dropPosition(event), id = event.dataTransfer?.getData(APP_DRAG_TYPE);
    if (position && apps.has(id)) {
      event.preventDefault(); place(id, position); onDrop();
    }
    clearDrag();
  });
  document.addEventListener('dragend', clearDrag);
  document.addEventListener('pointerdown', () => { suppressClick = false; }, true);
  for (const type of ['click', 'dblclick']) document.addEventListener(type, event => {
    if (suppressClick && event.detail && event.target.closest(sourceSelector)) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  window.addEventListener('resize', layout);
  preferenceEvents.addEventListener('appearance', layout);
  window.addEventListener('pagehide', clearDrag);
  layout();
  return {
    remove(id) {
      entries = entries.filter(entry => entry.id !== id);
      layout(); save();
      (grid.querySelector('button') || grid).focus({ preventScroll: true });
    },
  };
}
