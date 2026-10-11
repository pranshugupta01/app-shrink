import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveModule } from '../src/utils/resolver';

let root: string;
let fromFile: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'app-shrink-resolver-'));

  await fs.mkdir(path.join(root, 'src', 'controllers'), { recursive: true });
  await fs.mkdir(path.join(root, 'src', 'lib'), { recursive: true });
  await fs.mkdir(path.join(root, 'routes'), { recursive: true });

  await fs.writeFile(
    path.join(root, 'tsconfig.json'),
    `{
      // comments and trailing commas must not break parsing
      "compilerOptions": {
        "baseUrl": ".",
        "paths": {
          "@app/*": ["src/*"],
        },
      },
    }`,
    'utf8',
  );

  await fs.writeFile(path.join(root, 'src', 'controllers', 'todos.ts'), 'export const list = 1;\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'lib', 'index.ts'), 'export const x = 1;\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'util.js'), 'module.exports = {};\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'legacy.cjs'), 'module.exports = {};\n', 'utf8');
  fromFile = path.join(root, 'routes', 'app.ts');
  await fs.writeFile(fromFile, '', 'utf8');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const resolve = (request: string) => resolveModule(request, { fromFile, rootDir: root });

describe('resolveModule', () => {
  it('resolves a relative specifier that already carries an extension', async () => {
    expect(await resolve('../src/controllers/todos.ts')).toBe(
      path.join(root, 'src', 'controllers', 'todos.ts'),
    );
  });

  it('appends a source extension when the specifier omits one', async () => {
    expect(await resolve('../src/controllers/todos')).toBe(
      path.join(root, 'src', 'controllers', 'todos.ts'),
    );
  });

  it('retries the stem when a .js specifier points at a .ts file', async () => {
    expect(await resolve('../src/controllers/todos.js')).toBe(
      path.join(root, 'src', 'controllers', 'todos.ts'),
    );
  });

  it('keeps a genuine .js file', async () => {
    expect(await resolve('../src/util')).toBe(path.join(root, 'src', 'util.js'));
    expect(await resolve('../src/legacy.cjs')).toBe(path.join(root, 'src', 'legacy.cjs'));
  });

  it('falls back to /index.* for a directory specifier', async () => {
    expect(await resolve('../src/lib')).toBe(path.join(root, 'src', 'lib', 'index.ts'));
  });

  it('honours tsconfig path aliases', async () => {
    expect(await resolve('@app/controllers/todos')).toBe(
      path.join(root, 'src', 'controllers', 'todos.ts'),
    );
  });

  it('returns null for bare package specifiers', async () => {
    expect(await resolve('express')).toBeNull();
    expect(await resolve('@babel/parser')).toBeNull();
  });

  it('returns null when nothing on disk matches', async () => {
    expect(await resolve('../src/does-not-exist')).toBeNull();
  });
});
