import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { analyze, AnalysisResult } from '../src/core/analyzer';
import { transpile, TranspileResult } from '../src/core/transpiler';
import { detectLlmRoute, jobOutputName } from '../src/core/llm-transpiler';
import { pack } from '../src/core/packer';
import { parsePrismaSchema } from '../src/utils/schema-converter';
import { parseSource, walk } from '../src/utils/ast';

const SAMPLE = path.resolve(__dirname, '..', 'examples', 'sample-todo-app');
const CONTROLLER_SAMPLE = path.resolve(__dirname, '..', 'examples', 'sample-controller-app');

let outDir: string;
let analysis: AnalysisResult;
let result: TranspileResult;
let server: string;

beforeAll(async () => {
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-shrink-test-'));
  analysis = await analyze(SAMPLE);
  const packed = await pack(analysis, outDir);
  result = await transpile({
    analysis,
    outDir,
    port: 4321,
    version: '0.0.0-test',
    staticMounts: packed.mounts,
    hasPublic: packed.hasPublic,
  });
  server = await fs.readFile(result.serverFile, 'utf8');
});

afterAll(async () => {
  await fs.rm(outDir, { recursive: true, force: true });
});

describe('prisma -> sqlite conversion', () => {
  it('emits one CREATE TABLE per model', () => {
    const schema = parsePrismaSchema(`
      datasource db { provider = "sqlite" }

      model Post {
        id        String   @id @default(uuid())
        title     String
        published Boolean  @default(false)
        views     Float?
        meta      Json?
        createdAt DateTime @default(now())
      }
    `);

    const [post] = schema.models;
    const byName = Object.fromEntries(post.fields.map((field) => [field.name, field]));

    expect(byName.id.columnType).toBe('TEXT');
    expect(byName.published.columnType).toBe('INTEGER');
    expect(byName.views.columnType).toBe('REAL');
    expect(byName.meta.columnType).toBe('TEXT');
    expect(byName.createdAt.columnType).toBe('DATETIME');
    expect(schema.sql).toContain('id TEXT PRIMARY KEY');
    expect(schema.sql).toContain('DEFAULT 0');
  });

  it('honours @map and @@map renames', () => {
    const schema = parsePrismaSchema(`
      datasource db { provider = "sqlite" }

      model Account {
        id       Int    @id @default(autoincrement())
        fullName String @map("full_name")

        @@map("accounts")
      }
    `);

    expect(schema.models[0].tableName).toBe('accounts');
    expect(schema.models[0].fields[1].columnName).toBe('full_name');
    expect(schema.sql).toContain('CREATE TABLE IF NOT EXISTS accounts');
    expect(schema.sql).toContain('full_name');
  });
});

describe('transpiler: generated server', () => {
  it('writes the three expected artifacts', () => {
    expect(path.basename(result.serverFile)).toBe('server.ts');
    expect(path.basename(result.schemaFile)).toBe('schema.sql');
    expect(path.basename(result.packageFile)).toBe('package.json');
  });

  it('boots a Hono server with healthcheck and CORS', () => {
    expect(server).toContain("import { Hono } from 'hono'");
    expect(server).toContain("import { serve } from '@hono/node-server'");
    expect(server).toContain("import { cors } from 'hono/cors'");
    expect(server).toContain("app.get('/healthz'");
    expect(server).toContain("app.use('*', cors())");
  });

  it('registers every extracted route on the Hono app', () => {
    expect(server).toContain("app.get('/api/todos'");
    expect(server).toContain("app.get('/api/todos/:id'");
    expect(server).toContain("app.post('/api/todos'");
    expect(server).toContain("app.put('/api/todos/:id'");
    expect(server).toContain("app.delete('/api/todos/:id'");
    expect(result.transpiledRoutes).toBe(analysis.routes.length);
    expect(result.stubbedRoutes).toBe(0);
  });

  it('rewrites Express request access into Hono context calls', () => {
    expect(server).toContain('c.req.param("id")');
    expect(server).toContain('const __body = await c.req.json()');
    expect(server).not.toContain('req.params');
    expect(server).not.toContain('req.body');
    expect(server).not.toContain('res.json');
  });

  it('rewrites Express response calls into Hono responses', () => {
    expect(server).toContain('return c.json(todos)');
    expect(server).toContain('return c.json(todo, 201)');
    expect(server).toContain("error: 'Todo not found'");
    expect(server).toContain('return c.body(null, 204)');
  });

  it('points every ORM call at the embedded SQLite client', () => {
    expect(server).toContain('db.todo.findMany');
    expect(server).toContain('db.todo.findUnique');
    expect(server).toContain('db.todo.create');
    expect(server).toContain('db.todo.update');
    expect(server).toContain('db.todo.delete');
    expect(server).not.toContain('prisma.');
  });

  it('embeds the schema, model metadata and a fallback-capable driver loader', () => {
    expect(server).toContain('"Todo"');
    expect(server).toContain('CREATE TABLE IF NOT EXISTS');
    expect(server).toContain("foundRequire('better-sqlite3')");
    expect(server).toContain("foundRequire('node:sqlite')");
    expect(server).toContain("journal_mode = WAL");
  });

  it('mounts the packed static frontend under its original prefix', () => {
    expect(server).toContain('app.use("/assets/*", serveStatic({');
    expect(server).toContain("const PUBLIC_ROOT = path.join(SERVICE_DIR, 'public')");
  });

  it('produces a minimal dependency manifest', async () => {
    const manifest = JSON.parse(await fs.readFile(result.packageFile, 'utf8'));
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@hono/node-server',
      'better-sqlite3',
      'hono',
    ]);
  });

  it('copies static assets into the output directory', async () => {
    const index = await fs.readFile(path.join(outDir, 'public', 'index.html'), 'utf8');
    expect(index).toContain('Sample Todo App');
  });
});

describe('transpiler: response bodies', () => {
  it('rewrites request access nested inside a response body', async () => {
    const ast = parseSource(
      "router.get('/:id', (req, res) => { res.json({ id: Number(req.params.id) }); });",
    );

    let handler: any = null;
    walk(ast, (node) => {
      if (!handler && node.type === 'ArrowFunctionExpression') handler = node;
    });
    expect(handler).not.toBeNull();

    const inlineDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-shrink-inline-'));
    try {
      const inline = await transpile({
        analysis: {
          targetDir: inlineDir,
          routes: [
            {
              method: 'GET',
              path: '/api/items/:id',
              sourceFile: 'routes/items.js',
              framework: 'express',
              rawPath: '/:id',
              params: ['id'],
              usesBody: false,
              usesQuery: false,
              handler,
            },
          ],
          models: [],
          schemaSql: '',
          schema: null,
          staticAssets: [],
          sourceDatabase: null,
          routeFiles: [],
          scannedFiles: 1,
        },
        outDir: inlineDir,
        port: 4321,
        version: '0.0.0-test',
        staticMounts: [],
        hasPublic: false,
      });

      const emitted = await fs.readFile(inline.serverFile, 'utf8');
      expect(inline.stubbedRoutes).toBe(0);
      expect(emitted).toContain('c.req.param("id")');
      expect(emitted).not.toContain('req.params');
    } finally {
      await fs.rm(inlineDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Imported controllers (cross-file resolution, model fallback, job handoff)
// ---------------------------------------------------------------------------

/** Runs the pipeline against examples/sample-controller-app into a temp dir. */
async function transpileControllerSample(
  imported: Parameters<typeof transpile>[0]['imported'],
): Promise<{ result: TranspileResult; server: string; outDir: string }> {
  const analysis = await analyze(CONTROLLER_SAMPLE);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'app-shrink-controller-'));
  const packed = await pack(analysis, out);
  const transpiled = await transpile({
    analysis,
    outDir: out,
    port: 4321,
    version: '0.0.0-test',
    staticMounts: packed.mounts,
    hasPublic: packed.hasPublic,
    imported,
  });
  return { result: transpiled, server: await fs.readFile(transpiled.serverFile, 'utf8'), outDir: out };
}

describe('transpiler: imported controllers without a model', () => {
  it('inlines every referenced controller instead of emitting 501 stubs', async () => {
    const { result, server, outDir } = await transpileControllerSample({
      rootDir: CONTROLLER_SAMPLE,
      llmRoute: null,
    });

    try {
      expect(result.stubbedRoutes).toBe(0);
      expect(server).not.toContain('Not implemented');
      expect(result.transpiledRoutes).toBe(result.routeCount);
      expect(result.llmRoutes).toBe(0);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it('gives each route its own controller body', async () => {
    const { server, outDir } = await transpileControllerSample({
      rootDir: CONTROLLER_SAMPLE,
      llmRoute: null,
    });

    try {
      // `GET /api/todos/:id` resolves getTodo, not the surrounding listTodos.
      expect(server).toContain('db.todo.findUnique');
      expect(server).toContain('db.todo.count()');
      expect(server).toContain('db.todo.create');
      expect(server).toContain('db.todo.update');
      expect(server).toContain('db.todo.delete');
      expect(server).toContain('db.user.findMany');
      expect(server).toContain('db.user.delete');
      expect(server).not.toContain('req.params');
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it('resolves a namespace-import handler (`todoController.countTodos`)', async () => {
    const { server, outDir } = await transpileControllerSample({
      rootDir: CONTROLLER_SAMPLE,
      llmRoute: null,
    });

    try {
      expect(server).toContain("app.get('/api/todos/count'");
      expect(server).toContain('db.todo.count()');
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});

describe('transpiler: host-agent job handoff', () => {
  it('writes one job per imported handler and consumes the answers', async () => {
    const jobsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-shrink-jobs-'));

    try {
      const emitted = await transpileControllerSample({
        rootDir: CONTROLLER_SAMPLE,
        llmRoute: null,
        emitJobsDir: jobsDir,
      });

      try {
        // 11 routes, one of which (/healthz) is inline.
        expect(emitted.result.jobFiles.length).toBe(10);
        for (const jobFile of emitted.result.jobFiles) {
          const job = JSON.parse(await fs.readFile(jobFile, 'utf8'));
          expect(job.prompt).toContain('OUTPUT RULES');
          expect(job.handlerSource.length).toBeGreaterThan(0);
          expect(job.instructions).toContain('.out.ts');
        }

        // Simulate the IDE agent filling every job in.
        for (const jobFile of emitted.result.jobFiles) {
          const id = path.basename(jobFile, '.json');
          await fs.writeFile(
            path.join(jobsDir, jobOutputName(id)),
            'async (c) => c.json({ fromAgent: true })',
            'utf8',
          );
        }
      } finally {
        await fs.rm(emitted.outDir, { recursive: true, force: true });
      }

      const consumed = await transpileControllerSample({
        rootDir: CONTROLLER_SAMPLE,
        llmRoute: null,
        useJobsDir: jobsDir,
      });

      try {
        expect(consumed.result.llmRoutes).toBe(10);
        expect(consumed.result.stubbedRoutes).toBe(0);
        expect(consumed.server).toContain('{ fromAgent: true }');
        expect(consumed.server).not.toContain('db.todo.findMany');
      } finally {
        await fs.rm(consumed.outDir, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(jobsDir, { recursive: true, force: true });
    }
  });
});

/** Minimal OpenAI-compatible endpoint, so the provider path is exercised for real. */
async function startMockProvider(reply: string): Promise<{
  baseUrl: string;
  requests: string[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      requests.push(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('transpiler: model-first rewriting of imported handlers', () => {
  it('prefers the model output and sends it the real controller source', async () => {
    const provider = await startMockProvider('```js\nasync (c) => c.json({ rewritten: true })\n```');

    try {
      const llmRoute = await detectLlmRoute({
        apiKey: 'test-key',
        baseUrl: provider.baseUrl,
        model: 'mock-model',
      });
      expect(llmRoute?.kind).toBe('openai');

      const { result, server, outDir } = await transpileControllerSample({
        rootDir: CONTROLLER_SAMPLE,
        llmRoute,
      });

      try {
        expect(result.llmRoutes).toBe(10);
        expect(result.stubbedRoutes).toBe(0);
        // Markdown fences in the reply must be stripped, not emitted.
        expect(server).toContain('{ rewritten: true }');
        expect(server).not.toContain('```');

        expect(provider.requests.length).toBe(10);
        const asked = provider.requests.join('\n');
        expect(asked).toContain('listTodos');
        expect(asked).toContain('createTodo');
        expect(asked).toContain('prisma.todo.findMany');
        expect(asked).toContain('CREATE TABLE');
      } finally {
        await fs.rm(outDir, { recursive: true, force: true });
      }
    } finally {
      await provider.close();
    }
  });

  it('falls back to AST transpilation when the reply is unusable', async () => {
    const provider = await startMockProvider('I cannot help with that.');

    try {
      const llmRoute = await detectLlmRoute({
        apiKey: 'test-key',
        baseUrl: provider.baseUrl,
        model: 'mock-model',
      });

      const { result, server, outDir } = await transpileControllerSample({
        rootDir: CONTROLLER_SAMPLE,
        llmRoute,
      });

      try {
        expect(result.llmRoutes).toBe(0);
        expect(result.stubbedRoutes).toBe(0);
        expect(server).toContain('db.todo.findUnique');
      } finally {
        await fs.rm(outDir, { recursive: true, force: true });
      }
    } finally {
      await provider.close();
    }
  });

  it('stops calling a provider that fails outright after the first handler', async () => {
    let calls = 0;
    const server = http.createServer((_request, response) => {
      calls += 1;
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const llmRoute = await detectLlmRoute({
        apiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mock-model',
      });

      const { result, outDir } = await transpileControllerSample({
        rootDir: CONTROLLER_SAMPLE,
        llmRoute,
      });

      try {
        expect(calls).toBe(1);
        expect(result.stubbedRoutes).toBe(0);
        expect(result.warnings.some((warning) => warning.includes('could not be reached'))).toBe(true);
      } finally {
        await fs.rm(outDir, { recursive: true, force: true });
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
