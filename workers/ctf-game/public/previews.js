// A thumbnail is a visual copy only: no window registration, IDs, or interactive controls.
const appearance = [
  'display', 'position', 'inset', 'box-sizing', 'width', 'height', 'min-width', 'min-height',
  'max-width', 'max-height', 'margin', 'padding', 'overflow', 'overflow-x', 'overflow-y',
  'flex', 'flex-direction', 'flex-wrap', 'align-items', 'align-content', 'align-self',
  'justify-content', 'order', 'gap', 'grid-template-columns', 'grid-template-rows',
  'grid-column', 'grid-row', 'grid-auto-flow', 'place-items', 'aspect-ratio',
  'color', 'background-color', 'background-image', 'background-size', 'background-position',
  'background-repeat', 'border', 'border-radius', 'box-shadow', 'opacity', 'visibility',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
  'white-space', 'text-align', 'text-overflow', 'text-decoration', 'text-transform',
  'overflow-wrap', 'word-break', 'list-style', 'object-fit', 'object-position',
  'vertical-align', 'transform', 'transform-origin', 'filter', 'clip-path', 'z-index',
];
const scrollPositions = new WeakMap();
document.addEventListener('scroll', event => {
  const node = event.target;
  if (node instanceof Element && node.closest('.window')) scrollPositions.set(node, { top: node.scrollTop, left: node.scrollLeft });
}, { capture: true, passive: true });

export function createWindowPreview(windowNode, { width = 248, height = 144 } = {}) {
  const frame = document.createElement('div');
  frame.className = 'window-thumbnail';
  frame.setAttribute('aria-hidden', 'true');
  frame.inert = true;
  width = Math.max(48, Math.min(480, Number(width) || 248));
  height = Math.max(32, Math.min(320, Number(height) || 144));
  Object.assign(frame.style, { position: 'relative', width: width + 'px', height: height + 'px', overflow: 'hidden', pointerEvents: 'none', flexShrink: '0' });

  const rect = windowNode.getBoundingClientRect();
  const layout = getComputedStyle(windowNode);
  // Minimized windows retain their actual layout dimensions in the window registry.
  const sourceWidth = windowNode.offsetWidth || parseFloat(layout.width) || rect.width || parseFloat(windowNode.style.width) || 760;
  const sourceHeight = windowNode.offsetHeight || parseFloat(layout.height) || rect.height || parseFloat(windowNode.style.height) || 540;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const copy = windowNode.cloneNode(true);
  const originals = [windowNode, ...windowNode.querySelectorAll('*')];
  const copies = [copy, ...copy.querySelectorAll('*')];
  const scrolling = [];

  // Bound expensive computed-style work for unusually large application documents.
  // Remaining nodes still retain their ordinary class/inline styles.
  for (let index = 0; index < originals.length; index++) {
    const source = originals[index], target = copies[index];
    if (index < 1200) {
      const computed = getComputedStyle(source);
      for (const property of appearance) target.style.setProperty(property, computed.getPropertyValue(property));
    }
    for (const attribute of [...target.attributes]) {
      if (attribute.name === 'id' || attribute.name === 'name' || attribute.name === 'autofocus'
        || attribute.name.startsWith('on') || ['data-window', 'data-task', 'data-launch', 'data-motion-state'].includes(attribute.name)
        || attribute.name.startsWith('aria-') || attribute.name === 'for') target.removeAttribute(attribute.name);
    }
    target.removeAttribute('contenteditable');
    target.removeAttribute('tabindex');
    target.style.setProperty('animation', 'none', 'important');
    target.style.setProperty('transition', 'none', 'important');
    target.style.setProperty('pointer-events', 'none', 'important');
    const position = source.getClientRects().length
      ? { top: source.scrollTop, left: source.scrollLeft }
      : scrollPositions.get(source) || { top: source.scrollTop, left: source.scrollLeft };
    if (position.top || position.left) scrolling.push({ node: target, ...position });
    if (source instanceof HTMLCanvasElement && source.width && source.height) {
      try { target.getContext('2d')?.drawImage(source, 0, 0); } catch { /* An unavailable canvas remains blank. */ }
    } else if (source instanceof HTMLInputElement) {
      target.value = source.type === 'password' ? '' : source.value;
      target.checked = source.checked;
    } else if (source instanceof HTMLTextAreaElement) {
      target.value = source.value;
      target.textContent = source.value;
    } else if (source instanceof HTMLSelectElement) target.selectedIndex = source.selectedIndex;
  }
  copy.querySelectorAll('script, style, link, iframe, object, embed, audio, video').forEach(node => node.remove());
  copy.classList.remove('window', 'dragging', 'resizing');
  copy.classList.add('window-thumbnail-content');
  copy.removeAttribute('role');
  copy.removeAttribute('hidden');
  copy.inert = true;
  for (const [property, value] of Object.entries({
    position: 'absolute', display: 'flex', 'flex-direction': 'column',
    left: (width - sourceWidth * scale) / 2 + 'px', top: (height - sourceHeight * scale) / 2 + 'px',
    right: 'auto', bottom: 'auto', width: sourceWidth + 'px', height: sourceHeight + 'px',
    'min-width': '0', 'min-height': '0', 'max-width': 'none', 'max-height': 'none',
    margin: '0', opacity: '1', visibility: 'visible', transform: 'scale(' + scale + ')',
    'transform-origin': 'top left', translate: 'none', scale: 'none', overflow: 'hidden',
  })) copy.style.setProperty(property, value, 'important');
  frame.append(copy);
  // Scroll ranges exist only after the caller has attached and laid out the thumbnail.
  if (scrolling.length) requestAnimationFrame(() => {
    if (frame.isConnected) for (const { node, top, left } of scrolling) { node.scrollTop = top; node.scrollLeft = left; }
  });
  return frame;
}
