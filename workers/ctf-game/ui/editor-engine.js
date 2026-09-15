import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, keymap, rectangularSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, selectAll, indentMore, indentLess } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, search, openSearchPanel, closeSearchPanel } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { cpp } from '@codemirror/lang-cpp';
import { tags } from '@lezer/highlight';

const language = new Compartment();
const wrapping = new Compartment();
const fontSize = new Compartment();
const colors = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syntax-keyword)' },
  { tag: tags.string, color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syntax-function)' },
  { tag: [tags.typeName, tags.className], color: 'var(--syntax-type)' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--syntax-operator)' },
  { tag: tags.propertyName, color: 'var(--syntax-property)' },
]);
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--ink)', fontSize: 'var(--mono-size)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--ink)', padding: '4px 0', minHeight: '100%' },
  '.cm-line': { padding: '0 8px' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--muted)', borderRight: '1px solid var(--edge)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--panel)', color: 'var(--ink)' },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: '#3daee955' },
  '.cm-matchingBracket': { backgroundColor: '#3daee944', outline: '1px solid #3daee9' },
  '.cm-foldGutter': { width: '13px' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--ink)' },
  '.cm-search': { padding: '7px', display: 'flex', flexWrap: 'wrap', gap: '5px', alignItems: 'center' },
  '.cm-search label': { fontSize: '12px', whiteSpace: 'nowrap' },
  '.cm-search input': { background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--ink)', borderRadius: '3px', padding: '3px 5px', maxWidth: '180px' },
  '.cm-search input[type=checkbox]': { width: 'auto', margin: '0 4px' },
  '.cm-search button': { background: 'var(--panel)', color: 'var(--ink)', border: '1px solid var(--border)', borderRadius: '3px', padding: '3px 7px' },
  '.cm-searchMatch': { backgroundColor: '#fdbc4b44', outline: '1px solid #fdbc4b' },
  '.cm-searchMatch-selected': { backgroundColor: '#3daee955' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--ink)' },
}, { dark: true });

function languageFor(name) {
  return /\.py$/i.test(name) ? python() : /\.sql$/i.test(name) ? sql() : /\.(?:c|h|cpp|hpp|cc)$/i.test(name) ? cpp() : /\.json$/i.test(name) ? json() : /\.(?:[cm]?js|jsx|ts)$/i.test(name) ? javascript({ typescript: /\.ts$/.test(name) }) : [];
}

export function createState(text, name, onUpdate, actions = {}) {
  return EditorState.create({ doc: text, extensions: [
    theme, EditorView.cspNonce.of(document.querySelector('meta[name="csp-nonce"]')?.content || ''),
    lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), rectangularSelection(),
    history(), indentOnInput(), bracketMatching(), foldGutter(), syntaxHighlighting(colors), highlightSelectionMatches(), search({ top: false }),
    EditorState.tabSize.of(2), language.of(languageFor(name)), wrapping.of([]), fontSize.of([]),
    EditorView.contentAttributes.of({ 'aria-label': '编辑器内容', spellcheck: 'false', autocapitalize: 'off' }),
    keymap.of([
      { key: 'Mod-s', run: () => { actions.save?.(); return true; } },
      { key: 'Mod-Shift-s', run: () => { actions.saveAs?.(); return true; } },
      ...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap, indentWithTab,
    ]),
    EditorView.updateListener.of(onUpdate),
  ] });
}
export function createView(parent, state) { return new EditorView({ parent, state }); }
export function setLanguage(view, name) { view.dispatch({ effects: language.reconfigure(languageFor(name)) }); }
export function setWrap(view, enabled) { view.dispatch({ effects: wrapping.reconfigure(enabled ? EditorView.lineWrapping : []) }); }
export function setFontSize(view, size) { view.dispatch({ effects: fontSize.reconfigure(EditorView.theme({ '&': { fontSize: size + 'px' } })) }); }
export { undo, redo, selectAll, indentMore, indentLess, openSearchPanel, closeSearchPanel };
