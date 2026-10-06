import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Node } from '@babel/types';
import {
  HTTP_METHODS,
  extractParams,
  joinPaths,
  memberChain,
  nextSegmentToParam,
  normalizeRoutePath,
  parseSource,
  staticString,
  walk,
} from '../utils/ast';
import {
  ModelDef,
  ParsedSchema,
  parsePrismaSchema,
} from '../utils/schema-converter';
import { resolveModule } from '../utils/resolver';
import { isFunctionNode } from '../utils/ast-extractor';

export type Framework = 'express' | 'next-app' | 'next-pages';

/**
 * A handler that was written as a reference rather than an inline function,
 * e.g. `router.get('/', listTodos)` or `router.get('/', controller.list)`.
 * `importSpecifier` is the raw string from the import statement, when the
 * binding could be traced back to one.
 */
export interface HandlerRef {
  /** Local binding as written at the call site. */
  localName: string;
  /** Property accessed on that binding, for namespace imports. */
  property: string | null;
  /** Raw import specifier the binding came from, e.g. `../controllers/todos`. */
  importSpecifier: string | null;
}

export interface RouteDef {
  method: string;
  path: string;
  sourceFile: string;
  framework: Framework;
  /** Raw path as written in source, before mount-prefix resolution. */
  rawPath: string;
  params: string[];
  usesBody: boolean;
  usesQuery: boolean;
  /** The primary handler function AST node, when one could be isolated. */
  handler: Node | null;
  /** Set when the handler is an imported/local reference instead of inline. */
  handlerRef?: HandlerRef | null;
}

export interface StaticAssetSource {
  /** Absolute directory containing the built/static frontend. */
  dir: string;
  /** URL prefix the assets were served under in the source app. */
  mount: string;
  kind: 'public' | 'build' | 'out' | 'dist';
}

export interface AnalysisResult {
  targetDir: string;
  routes: RouteDef[];
  models: ModelDef[];
  schemaSql: string;
  schema: ParsedSchema | null;
  staticAssets: StaticAssetSource[];
  /** Absolute path of the source SQLite database, when one is detectable. */
  sourceDatabase: string | null;
  /** Files that were parsed as route candidates. */
  routeFiles: string[];
  /** Source files considered part of the app (for footprint reporting). */
  scannedFiles: number;
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  '.cache',
  'coverage',
  '__tests__',
  '__pycache__',
  '.idea',
  '.vscode',
  'dist-shrunk',
]);

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

async function listFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await listFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Reads a static property name off `a.b` / `a['b']`. */
function memberKey(node: Node): string | null {
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return null;
  const property = (node as any).property as Node;
  if (property.type === 'Identifier' && !(node as any).computed) return property.name;
  if (property.type === 'StringLiteral') return property.value;
  return null;
}

/**
 * Describes a handler that was passed by reference instead of written inline.
 * Inline functions yield null, since the transpiler reads them from the AST.
 */
function describeHandlerRef(
  handler: Node | null,
  bindings: Map<string, string>,
): HandlerRef | null {
  if (!handler || isFunctionNode(handler)) return null;

  if (handler.type === 'Identifier') {
    return {
      localName: handler.name,
      property: null,
      importSpecifier: bindings.get(handler.name) ?? null,
    };
  }

  if (handler.type === 'MemberExpression' || handler.type === 'OptionalMemberExpression') {
    const object = (handler as any).object as Node;
    const property = memberKey(handler);
    if (object.type !== 'Identifier' || !property) return null;
    return {
      localName: object.name,
      property,
      importSpecifier: bindings.get(object.name) ?? null,
    };
  }

  return null;
}

/** Extracts `import x from './y'` / `const x = require('./y')` bindings. */
function collectImportBindings(ast: Node): Map<string, string> {
  const bindings = new Map<string, string>();
  walk(ast, (node) => {
    if (node.type === 'ImportDeclaration' && typeof node.source.value === 'string') {
      for (const specifier of node.specifiers) {
        bindings.set(specifier.local.name, node.source.value);
      }
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      const init = node.init;
      if (
        init &&
        init.type === 'CallExpression' &&
        memberChain(init.callee as Node) === 'require' &&
        init.arguments[0]?.type === 'StringLiteral'
      ) {
        bindings.set(node.id.name, (init.arguments[0] as any).value);
      }
    }
  });
  return bindings;
}

interface MountRecord {
  prefix: string;
  localName: string;
  file: string;
}

interface RoutableCall {
  receiver: string;
  method: string;
  path: string;
  handler: Node | null;
  handlerRef: HandlerRef | null;
  usesBody: boolean;
  usesQuery: boolean;
}

function collectCalls(ast: Node): {
  calls: RoutableCall[];
  mounts: MountRecord[];
  staticMounts: string[];
} {
  const calls: RoutableCall[] = [];
  const mounts: MountRecord[] = [];
  const staticMounts: string[] = [];
  const bindings = collectImportBindings(ast);

  walk(ast, (node) => {
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
    const callee = node.callee as Node;
    if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return;

    const receiver = memberChain(callee.object as Node);
    const property =
      callee.property.type === 'Identifier'
        ? callee.property.name
        : callee.property.type === 'StringLiteral'
          ? callee.property.value
          : null;
    if (!receiver || !property) return;

    if (property === 'use' || property === 'all') {
      const prefix = staticString(node.arguments[0] as Node);
      const target = node.arguments[1] as Node | undefined;
      if (prefix && target) {
        if (target.type === 'Identifier' && receiver !== 'express') {
          mounts.push({ prefix, localName: target.name, file: '' });
        } else if (
          (target.type === 'CallExpression' || target.type === 'OptionalCallExpression') &&
          memberChain(target.callee as Node) === 'express.static'
        ) {
          staticMounts.push(prefix);
        }
      }
      return;
    }

    if (!(HTTP_METHODS as readonly string[]).includes(property)) return;
    const routePath = staticString(node.arguments[0] as Node);
    if (routePath === null) return;

    const handler = [...node.arguments].reverse().find((arg) => {
      const t = (arg as Node).type;
      return (
        t === 'ArrowFunctionExpression' ||
        t === 'FunctionExpression' ||
        t === 'Identifier' ||
        t === 'MemberExpression' ||
        t === 'OptionalMemberExpression'
      );
    }) as Node | undefined;

    const chains = new Set<string>();
    if (handler && (handler.type === 'ArrowFunctionExpression' || handler.type === 'FunctionExpression')) {
      walk(handler, (child) => {
        const chain = memberChain(child);
        if (chain) chains.add(chain);
      });
    }

    calls.push({
      receiver,
      method: property.toUpperCase(),
      path: routePath,
      handler: handler ?? null,
      handlerRef: describeHandlerRef(handler ?? null, bindings),
      usesBody: [...chains].some((c) => c.endsWith('.body')),
      usesQuery: [...chains].some((c) => c.endsWith('.query')),
    });
  });

  return { calls, mounts, staticMounts };
}

function nextRoutePath(targetDir: string, file: string, framework: Framework): string {
  const rel = path.relative(targetDir, file);
  const segments = rel.split(path.sep);

  if (framework === 'next-app') {
    const appIndex = segments.lastIndexOf('app');
    const parts = segments.slice(appIndex + 1, -1).map(nextSegmentToParam).filter(Boolean);
    return normalizeRoutePath(`/${parts.join('/')}`);
  }

  const apiIndex = segments.lastIndexOf('api');
  const parts = segments.slice(apiIndex + 1).map((s, i, arr) => {
    const withoutExt = i === arr.length - 1 ? s.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '') : s;
    if (withoutExt === 'index') return '';
    return nextSegmentToParam(withoutExt);
  });
  return normalizeRoutePath(`/${parts.filter(Boolean).join('/')}`);
}

function nextExportedHandlers(ast: Node): { method: string; handler: Node }[] {
  const found: { method: string; handler: Node }[] = [];
  walk(ast, (node) => {
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const decl = node.declaration as any;
      if (decl.type === 'FunctionDeclaration' && decl.id && HTTP_METHODS.includes(decl.id.name.toLowerCase())) {
        found.push({ method: decl.id.name.toUpperCase(), handler: decl });
      }
      if (decl.type === 'VariableDeclaration') {
        for (const d of decl.declarations) {
          if (d.id?.type === 'Identifier' && HTTP_METHODS.includes(d.id.name.toLowerCase()) && d.init) {
            found.push({ method: d.id.name.toUpperCase(), handler: d.init });
          }
        }
      }
    }
  });
  return found;
}

export async function analyze(targetDir: string): Promise<AnalysisResult> {
  const root = path.resolve(targetDir);
  if (!(await isDirectory(root))) {
    throw new Error(`Target directory does not exist: ${root}`);
  }

  const allFiles = await listFiles(root);
  const codeFiles = allFiles.filter((f) => CODE_EXT.has(path.extname(f)));

  const prismaSchemaPath = path.join(root, 'prisma', 'schema.prisma');
  const drizzleCandidates = allFiles.filter((f) =>
    /(^|\/)schema\.(ts|js)$/.test(path.relative(root, f)) && /(drizzle|db|database)/i.test(f),
  );

  let schema: ParsedSchema | null = null;
  let sourceDatabase: string | null = null;

  if (await exists(prismaSchemaPath)) {
    const source = await fs.readFile(prismaSchemaPath, 'utf8');
    schema = parsePrismaSchema(source);
    const url = schema.url;
    if (url && url.startsWith('file:')) {
      sourceDatabase = path.resolve(path.dirname(prismaSchemaPath), url.slice('file:'.length));
    }
  } else if (drizzleCandidates.length > 0) {
    // Drizzle schemas are converted on a best-effort basis by the transpiler's
    // schema pass; fall back to an empty model set when nothing is recognisable.
    schema = { models: [], sql: '', provider: 'sqlite', url: null };
  }

  const routes: RouteDef[] = [];
  const routeFiles: string[] = [];

  const nextAppFiles: string[] = [];
  const nextPagesFiles: string[] = [];
  const expressCandidateFiles: string[] = [];

  for (const file of codeFiles) {
    const rel = path.relative(root, file).split(path.sep);
    const base = path.basename(file).replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
    const isAppRoute = rel.includes('app') && base === 'route';
    const isPagesApi = rel.includes('pages') && rel.includes('api');

    if (isAppRoute) nextAppFiles.push(file);
    else if (isPagesApi) nextPagesFiles.push(file);
    else expressCandidateFiles.push(file);
  }

  // ---- Express-style route extraction -------------------------------------
  const pendingMounts: { prefix: string; target: string; from: string }[] = [];
  const expressResults: { file: string; calls: RoutableCall[] }[] = [];
  const expressStaticMounts: string[] = [];

  for (const file of expressCandidateFiles) {
    let ast: Node;
    try {
      ast = parseSource(await fs.readFile(file, 'utf8'), file);
    } catch {
      continue;
    }
    const { calls, mounts, staticMounts } = collectCalls(ast);
    expressStaticMounts.push(...staticMounts);
    if (calls.length === 0) {
      if (mounts.length > 0) routeFiles.push(file);
      continue;
    }
    expressResults.push({ file, calls });
    routeFiles.push(file);

    const bindings = collectImportBindings(ast);
    for (const mount of mounts) {
      const request = bindings.get(mount.localName);
      if (!request) continue;
      const resolved = await resolveModule(request, { fromFile: file, rootDir: root });
      if (resolved) pendingMounts.push({ prefix: mount.prefix, target: resolved, from: file });
    }
  }

  // Resolve mount prefixes, then propagate them through nested routers.
  const prefixByFile = new Map<string, string>();
  for (const mount of pendingMounts) {
    if (!prefixByFile.has(mount.target)) prefixByFile.set(mount.target, mount.prefix);
  }
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const mount of pendingMounts) {
      const parentPrefix = prefixByFile.get(mount.from);
      if (parentPrefix === undefined) continue;
      const childPrefix = joinPaths(parentPrefix, mount.prefix);
      if (prefixByFile.get(mount.target) !== childPrefix) {
        prefixByFile.set(mount.target, childPrefix);
        changed = true;
      }
    }
    if (!changed) break;
  }

  for (const { file, calls } of expressResults) {
    const prefix = prefixByFile.get(file) ?? null;
    for (const call of calls) {
      const fullPath = joinPaths(prefix, call.path);
      routes.push({
        method: call.method,
        path: fullPath,
        sourceFile: file,
        framework: 'express',
        rawPath: call.path,
        params: extractParams(fullPath),
        usesBody: call.usesBody,
        usesQuery: call.usesQuery,
        handler: call.handler,
        handlerRef: call.handlerRef,
      });
    }
  }

  // ---- Next.js extraction --------------------------------------------------
  const nextTargets: { files: string[]; framework: Framework }[] = [
    { files: nextAppFiles, framework: 'next-app' },
    { files: nextPagesFiles, framework: 'next-pages' },
  ];
  for (const { files, framework } of nextTargets) {
    for (const file of files) {
      let ast: Node;
      try {
        ast = parseSource(await fs.readFile(file, 'utf8'), file);
      } catch {
        continue;
      }
      routeFiles.push(file);
      const routePath = nextRoutePath(root, file, framework);
      const bindings = collectImportBindings(ast);

      if (framework === 'next-app') {
        for (const { method, handler } of nextExportedHandlers(ast)) {
          const chains = new Set<string>();
          walk(handler, (child) => {
            const chain = memberChain(child);
            if (chain) chains.add(chain);
          });
          routes.push({
            method,
            path: routePath,
            sourceFile: file,
            framework,
            rawPath: routePath,
            params: extractParams(routePath),
            usesBody: [...chains].some((c) => c.startsWith('request.body') || c.endsWith('.json')),
            usesQuery: [...chains].some((c) => c.includes('searchParams')),
            handler,
            handlerRef: describeHandlerRef(handler, bindings),
          });
        }
      } else {
        const { calls } = collectCalls(ast);
        for (const call of calls) {
          const fullPath = joinPaths(routePath, call.path);
          routes.push({
            method: call.method,
            path: fullPath,
            sourceFile: file,
            framework,
            rawPath: call.path,
            params: extractParams(fullPath),
            usesBody: call.usesBody,
            usesQuery: call.usesQuery,
            handler: call.handler,
            handlerRef: call.handlerRef,
          });
        }
      }
    }
  }

  // ---- Static assets -------------------------------------------------------
  const staticAssets: StaticAssetSource[] = [];
  const publicMount = expressStaticMounts.length > 0 ? expressStaticMounts[0] : '/';
  for (const candidate of [
    { dir: 'public', kind: 'public' as const },
    { dir: 'out', kind: 'out' as const },
    { dir: 'build', kind: 'build' as const },
    { dir: 'dist', kind: 'dist' as const },
  ]) {
    const full = path.join(root, candidate.dir);
    if (!(await isDirectory(full))) continue;
    if (staticAssets.some((a) => a.dir === full)) continue;
    staticAssets.push({
      dir: full,
      kind: candidate.kind,
      mount: candidate.kind === 'public' ? publicMount : '/',
    });
  }

  const deduped = new Map<string, RouteDef>();
  for (const route of routes) {
    deduped.set(`${route.method} ${route.path} @${route.sourceFile}`, route);
  }

  return {
    targetDir: root,
    routes: [...deduped.values()],
    models: schema?.models ?? [],
    schemaSql: schema?.sql ?? '',
    schema,
    staticAssets,
    sourceDatabase,
    routeFiles: [...new Set(routeFiles)],
    scannedFiles: allFiles.length,
  };
}


export function resolveMount(call: any, file: string): string | null {
  // app.use("/prefix", router) -> the prefix that needs to be prepended to
  // every route the sub-router declares.  Returns null when the call is not
  // a router mount.
  if (call?.type !== "CallExpression") return null;
  const args = call.arguments ?? [];
  if (args.length !== 2) return null;
  const first = args[0];
  if (first?.type !== "StringLiteral" && first?.type !== "Literal") return null;
  const prefix = String(first.value);
  if (!prefix.startsWith("/")) return null;
  return prefix.replace(/\/$/, "");
}
