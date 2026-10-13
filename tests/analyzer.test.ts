import { describe, expect, it, beforeAll } from 'vitest';
import path from 'node:path';
import { AnalysisResult, analyze } from '../src/core/analyzer';

const SAMPLE = path.resolve(__dirname, '..', 'examples', 'sample-todo-app');

let result: AnalysisResult;

beforeAll(async () => {
  result = await analyze(SAMPLE);
});

describe('analyzer: route extraction', () => {
  it('detects every CRUD endpoint and resolves router mount prefixes', () => {
    const signatures = result.routes.map((route) => `${route.method} ${route.path}`).sort();

    expect(signatures).toEqual(
      [
        'DELETE /api/todos/:id',
        'DELETE /api/users/:id',
        'GET /api/todos',
        'GET /api/todos/:id',
        'GET /api/users',
        'GET /api/users/:id',
        'GET /healthz',
        'POST /api/todos',
        'POST /api/users',
        'PUT /api/todos/:id',
      ].sort(),
    );
  });

  it('treats the Express router as the source framework', () => {
    expect(result.routes.every((route) => route.framework === 'express')).toBe(true);
  });

  it('normalizes dynamic segments into Hono-style params', () => {
    const detail = result.routes.find((route) => route.method === 'GET' && route.path.endsWith('/:id'));
    expect(detail?.params).toEqual(['id']);
  });

  it('flags handlers that read the request body or query string', () => {
    const create = result.routes.find((route) => route.method === 'POST' && route.path === '/api/todos');
    expect(create?.usesBody).toBe(true);

    const list = result.routes.find((route) => route.method === 'GET' && route.path === '/api/todos');
    expect(list?.usesQuery).toBe(true);
  });

  it('attaches the primary handler AST to each route', () => {
    for (const route of result.routes) {
      expect(route.handler).not.toBeNull();
    }
  });
});

describe('analyzer: schema extraction', () => {
  it('reads both Prisma models', () => {
    expect(result.models.map((model) => model.name).sort()).toEqual(['Todo', 'User']);
  });

  it('flags the primary key and autoincrement default', () => {
    const todo = result.models.find((model) => model.name === 'Todo')!;
    const id = todo.fields.find((field) => field.name === 'id')!;

    expect(id.isId).toBe(true);
    expect(id.prismaDefault?.fn).toBe('autoincrement');
    expect(id.columnType).toBe('INTEGER');
  });

  it('maps dialect types onto SQLite storage classes', () => {
    const todo = result.models.find((model) => model.name === 'Todo')!;
    const byName = Object.fromEntries(todo.fields.map((field) => [field.name, field]));

    expect(byName.title.columnType).toBe('TEXT');
    expect(byName.completed.columnType).toBe('INTEGER');
    expect(byName.createdAt.columnType).toBe('DATETIME');
    expect(byName.priority.columnType).toBe('INTEGER');
  });

  it('resolves the foreign key from the relation attribute', () => {
    const todo = result.models.find((model) => model.name === 'Todo')!;
    const relation = todo.fields.find((field) => field.name === 'user')!;

    expect(relation.relation?.model).toBe('User');
    expect(relation.relation?.fields).toEqual(['userId']);
    expect(relation.relation?.references).toEqual(['id']);
  });

  it('emits valid SQLite DDL', () => {
    expect(result.schemaSql).toContain('CREATE TABLE IF NOT EXISTS Todo (');
    expect(result.schemaSql).toContain('INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(result.schemaSql).toContain('FOREIGN KEY (userId) REFERENCES User (id)');
    expect(result.schemaSql).toContain('DEFAULT 0');
  });

  it('does not materialise Prisma relation fields as columns', () => {
    expect(result.schemaSql).not.toContain('user TEXT');
    expect(result.schemaSql).toContain('userId INTEGER NOT NULL');
  });

  it('locates the source SQLite database from the datasource url', () => {
    expect(result.sourceDatabase).toBe(path.join(SAMPLE, 'prisma', 'dev.db'));
  });
});

describe('analyzer: static assets', () => {
  it('detects the public directory and its Express mount', () => {
    const publicAsset = result.staticAssets.find((asset) => asset.kind === 'public');
    expect(publicAsset).toBeDefined();
    expect(publicAsset?.dir).toBe(path.join(SAMPLE, 'public'));
    expect(publicAsset?.mount).toBe('/assets');
  });
});
