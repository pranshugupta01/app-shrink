import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Extensions probed when an import specifier omits one, in resolution order. */
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

export interface TsconfigAliases {
  /** Directory the `paths` patterns are relative to. */
  baseUrl: string;
  paths: Record<string, string[]>;
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
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

/**
 * Expands `base` into the concrete files a bundler would try, in order:
 * the literal path, the literal path with each known extension, and finally
 * the path as a directory index. When `base` already carries an extension the
 * stem is also retried against the other extensions, which is what lets a
 * TypeScript project import `'./controller.js'` and resolve `controller.ts`.
 */
async function firstExistingFile(base: string): Promise<string | null> {
  const extension = path.extname(base);

  if (extension) {
    if (await isFile(base)) return base;
    const stem = base.slice(0, -extension.length);
    for (const candidate of CODE_EXTENSIONS) {
      const file = `${stem}${candidate}`;
      if (await isFile(file)) return file;
    }
  } else {
    for (const candidate of CODE_EXTENSIONS) {
      const file = `${base}${candidate}`;
      if (await isFile(file)) return file;
    }
  }

  if (await isDirectory(base)) {
    for (const candidate of CODE_EXTENSIONS) {
      const file = path.join(base, `index${candidate}`);
      if (await isFile(file)) return file;
    }
  }

  return null;
}

/** tsconfig files routinely contain comments and trailing commas. */
function stripJsonComments(source: string): string {
  return source
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (match, comment) =>
      comment ? '' : match,
    )
    .replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Reads `compilerOptions.baseUrl` / `compilerOptions.paths` from the project's
 * tsconfig (or jsconfig). `extends` is not followed - "basic aliases" only.
 */
export async function loadTsconfigAliases(rootDir: string): Promise<TsconfigAliases | null> {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(rootDir, name);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(stripJsonComments(raw));
    } catch {
      continue;
    }

    const options = parsed?.compilerOptions ?? {};
    const baseUrl = path.resolve(rootDir, options.baseUrl ?? '.');
    const patterns = options.paths;

    if (!patterns || typeof patterns !== 'object') {
      if (options.baseUrl) return { baseUrl, paths: {} };
      continue;
    }

    const paths: Record<string, string[]> = {};
    for (const [pattern, targets] of Object.entries(patterns)) {
      if (Array.isArray(targets) && targets.every((entry) => typeof entry === 'string')) {
        paths[pattern] = targets as string[];
      }
    }
    return { baseUrl, paths };
  }

  return null;
}

/**
 * Matches `request` against one `paths` pattern (`@app/*` -> `src/*`).
 * Returns the substituted candidate path, or null when the pattern misses.
 */
function applyAliasPattern(pattern: string, targets: string[], request: string): string | null {
  const star = pattern.indexOf('*');
  if (star === -1) {
    return pattern === request ? (targets[0] ?? null) : null;
  }

  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!request.startsWith(prefix) || !request.endsWith(suffix)) return null;
  if (request.length < prefix.length + suffix.length) return null;

  const captured = request.slice(prefix.length, request.length - suffix.length);
  const target = targets[0];
  if (target === undefined) return null;
  return target.includes('*') ? target.replace('*', captured) : target;
}

export interface ResolveContext {
  /** Absolute path of the file containing the import specifier. */
  fromFile: string;
  /** Project root, used to locate tsconfig path aliases. */
  rootDir: string;
}

/**
 * Resolves an import specifier to an absolute file on disk.
 *
 * Handles relative (`./x`, `../x`), absolute, and tsconfig `paths` aliases.
 * Bare package specifiers (`hono`, `lodash`) resolve to `null`: they live in
 * `node_modules` and are not something the transpiler can inline.
 *
 * Alias patterns are tried longest-first so `@app/todos/list` wins over `@app/*`.
 */
export async function resolveModule(request: string, ctx: ResolveContext): Promise<string | null> {
  if (!request) return null;

  if (request.startsWith('.')) {
    const base = path.resolve(path.dirname(ctx.fromFile), request);
    return firstExistingFile(base);
  }

  if (path.isAbsolute(request)) {
    return firstExistingFile(request);
  }

  const aliases = await loadTsconfigAliases(ctx.rootDir);
  if (!aliases) return null;

  if (aliases.paths[request]) {
    for (const target of aliases.paths[request]) {
      const resolved = await firstExistingFile(path.resolve(aliases.baseUrl, target));
      if (resolved) return resolved;
    }
  }

  const patterns = Object.keys(aliases.paths).sort((a, b) => b.length - a.length);
  for (const pattern of patterns) {
    const candidate = applyAliasPattern(pattern, aliases.paths[pattern], request);
    if (!candidate) continue;
    const resolved = await firstExistingFile(path.resolve(aliases.baseUrl, candidate));
    if (resolved) return resolved;
  }

  return null;
}
