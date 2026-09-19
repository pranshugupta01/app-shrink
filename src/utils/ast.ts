import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import type { File, Node } from '@babel/types';

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value.toLowerCase());
}

const PARSER_PLUGINS = [
  'typescript',
  'jsx',
  'decorators-legacy',
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods',
  'topLevelAwait',
  'importAssertions',
  'dynamicImport',
  'objectRestSpread',
  'optionalChaining',
  'nullishCoalescingOperator',
] as const;

/**
 * Parses a source file into a Babel AST. `sourceType: 'unambiguous'` lets us
 * accept both ESM and CommonJS route files without configuration.
 */
export function parseSource(code: string, filename = 'unknown.ts'): File {
  return parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: [...PARSER_PLUGINS] as any,
    sourceFilename: filename,
  });
}

export async function parseFile(filePath: string): Promise<File> {
  const code = await fs.readFile(filePath, 'utf8');
  return parseSource(code, filePath);
}

/** Converts a member expression chain (`a.b.c`) into its dotted string form. */
export function memberChain(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    const object = memberChain(node.object as Node);
    if (!object) return null;
    const property =
      node.property.type === 'Identifier' && !node.computed
        ? node.property.name
        : node.property.type === 'StringLiteral'
          ? node.property.value
          : null;
    if (!property) return null;
    return `${object}.${property}`;
  }
  return null;
}

export function isCallTo(node: Node | null | undefined, chain: string): boolean {
  return (
    !!node &&
    (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') &&
    memberChain(node.callee as Node) === chain
  );
}

/**
 * Resolves the string value of a call/member argument when it is statically
 * known (string literal, template literal without expressions).
 */
export function staticString(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked ?? '').join('');
  }
  return null;
}

/** Walks a subtree without babel/traverse — handy for small lookups. */
export function walk(node: Node | null | undefined, visit: (node: Node, parent: Node | null) => void): void {
  if (!node || typeof node !== 'object') return;
  const current = node as Node;
  visit(current, null);
  walkChildren(current, visit);
}

function walkChildren(parent: Node, visit: (node: Node, parent: Node | null) => void): void {
  for (const key of Object.keys(parent as any)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') {
      continue;
    }
    const value = (parent as any)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') {
          visit(child, parent);
          walkChildren(child, visit);
        }
      }
    } else if (value && typeof value.type === 'string') {
      visit(value, parent);
      walkChildren(value, visit);
    }
  }
}

/**
 * Collects every identifier referenced inside a subtree. Used to detect which
 * request properties a handler touches (`req.body`, `req.query`, ...).
 */
export function referencedChains(node: Node | null | undefined): Set<string> {
  const found = new Set<string>();
  walk(node, (child) => {
    const chain = memberChain(child);
    if (chain) found.add(chain);
  });
  return found;
}

export function normalizeRoutePath(rawPath: string): string {
  let out = rawPath.trim();
  if (!out.startsWith('/')) out = `/${out}`;
  out = out.replace(/\/+$/, '');
  if (out === '') out = '/';
  return out;
}

/** Next.js `app/api/todos/[id]/route.ts` -> `/api/todos/:id` */
export function nextSegmentToParam(segment: string): string {
  const catchAll = segment.match(/^\[\[?\.\.\.(.+?)\]\]?$/);
  if (catchAll) return `:${catchAll[1]}*`;
  const dynamic = segment.match(/^\[(.+?)\]$/);
  if (dynamic) return `:${dynamic[1]}`;
  const routeGroup = segment.match(/^\(.+\)$/);
  if (routeGroup) return '';
  return segment;
}

export function extractParams(routePath: string): string[] {
  return [...routePath.matchAll(/:([A-Za-z0-9_]+)\*?/g)].map((m) => m[1]);
}

/** Joins an Express mount prefix with a router-local path. */
export function joinPaths(prefix: string | null, routePath: string): string {
  if (!prefix) return normalizeRoutePath(routePath);
  const base = prefix.replace(/\/+$/, '');
  const rest = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return normalizeRoutePath(`${base}${rest}` === '' ? '/' : `${base}${rest}`);
}
