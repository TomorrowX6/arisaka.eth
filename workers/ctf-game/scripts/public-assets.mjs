import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import publicAssets from '../src/public-assets.json' with { type: 'json' };

// Build-time policy, not an expanded Worker route. A module must be explicitly
// public before another public module can import it. Never whitelist a whole
// directory just to make a broken desktop boot.
export function inspectPublicDependencies(sources, files = publicAssets) {
  const allowed = new Set(files), origin = 'https://static.invalid'; let dependencies = 0;
  if (allowed.size !== files.length || files.some(path => !/^\/(?!\/)[a-zA-Z0-9_./-]*$/.test(path) || /\/\./.test(path) || path.includes('..') || /^\/(?:scripts|src|test|_puzzles)(?:\/|$)/.test(path))) throw Error('Unsafe or duplicate public asset declaration');
  const check = (dependency, parent) => {
    const url = new URL(dependency, origin + parent);
    if (url.origin !== origin || !allowed.has(url.pathname)) throw Error('Unpublished desktop dependency: ' + parent + ' → ' + dependency);
    dependencies++;
  };
  for (const [path, source] of sources) {
    if (!allowed.has(path)) throw Error('Unpublished desktop source: ' + path);
    if (path.endsWith('.html')) {
      for (const tag of source.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
        const resource = tag[0].match(/\b(?:src|href)=["']([^"']+)["']/i)?.[1]; if (resource) check(resource, path);
      }
    } else if (path.endsWith('.js')) {
      const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
      const visit = node => {
        let value;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) value = literal(node.moduleSpecifier);
        else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) value = literal(node.arguments[0]);
        else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ['Worker', 'SharedWorker'].includes(node.expression.text)) {
          const argument = node.arguments?.[0]; value = literal(argument);
          if (argument && ts.isNewExpression(argument) && ts.isIdentifier(argument.expression) && argument.expression.text === 'URL') value = literal(argument.arguments?.[0]);
        }
        if (value !== undefined && value !== null) check(value, path); ts.forEachChild(node, visit);
      };
      visit(tree);
    }
  }
  return { sources: sources.size, dependencies };
}

export async function verifyPublicAssets(root) {
  inspectPublicDependencies(new Map()); // Validate paths before any filesystem access.
  const sources = new Map();
  for (const path of publicAssets) {
    if (path === '/') continue;
    const file = resolve(root, 'public', path.slice(1));
    if (!(await stat(file)).isFile()) throw Error('Missing public asset: ' + path);
    if (path === '/index.html' || /^\/[^/]+\.js$/.test(path)) sources.set(path, await readFile(file, 'utf8'));
  }
  return inspectPublicDependencies(sources);
}
