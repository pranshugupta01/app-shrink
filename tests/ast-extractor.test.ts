import { describe, expect, it } from 'vitest';
import { extractHandler, isFunctionNode } from '../src/utils/ast-extractor';

describe('extractHandler', () => {
  it('extracts an exported function declaration verbatim', () => {
    const source = [
      'export async function listTodos(req, res) {',
      '  const todos = await prisma.todo.findMany();',
      '  res.json(todos);',
      '}',
      '',
      'export async function getTodo(req, res) {',
      '  res.json({ id: req.params.id });',
      '}',
    ].join('\n');

    const handler = extractHandler(source, 'getTodo');
    expect(handler?.exportName).toBe('getTodo');
    expect(handler?.code).toContain('res.json({ id: req.params.id })');
    expect(handler?.code).not.toContain('findMany');
  });

  it('extracts an exported const arrow function', () => {
    const source = 'export const countTodos = async (req, res) => {\n  res.json({ count: 0 });\n};';
    const handler = extractHandler(source, 'countTodos');
    expect(handler?.code).toContain('async (req, res) =>');
    expect(handler?.code).toContain('count: 0');
  });

  it('follows a bare declaration plus `export { x }`', () => {
    const source = 'function list(req, res) {\n  res.json([]);\n}\n\nexport { list };';
    expect(extractHandler(source, 'list')?.code).toContain('res.json([])');
  });

  it('follows a renamed re-export `export { local as api }`', () => {
    const source = 'const local = (req, res) => { res.json(1); };\nexport { local as api };';
    expect(extractHandler(source, 'api')?.code).toContain('res.json(1)');
  });

  it('reads `module.exports = { x }`', () => {
    const source = 'const list = (req, res) => { res.json([]); };\nmodule.exports = { list };';
    expect(extractHandler(source, 'list')?.code).toContain('res.json([])');
  });

  it('reads `module.exports = { x: fn }`', () => {
    const source = 'module.exports = {\n  list: async (req, res) => {\n    res.json([]);\n  },\n};';
    expect(extractHandler(source, 'list')?.code).toContain('res.json([])');
  });

  it('reads `exports.x = function () {}`', () => {
    const source = 'exports.getTodo = function (req, res) {\n  res.json(1);\n};';
    expect(extractHandler(source, 'getTodo')?.code).toContain('res.json(1)');
  });

  it('reads `export default { x }`', () => {
    const source = 'export default {\n  list: (req, res) => {\n    res.json(2);\n  },\n};';
    expect(extractHandler(source, 'list')?.code).toContain('res.json(2)');
  });

  it('prefers the namespace property over the local binding name', () => {
    const source = 'export async function listTodos(req, res) { res.json(3); }';
    const handler = extractHandler(source, 'todoController', 'listTodos');
    expect(handler?.property).toBe('listTodos');
    expect(handler?.code).toContain('res.json(3)');
  });

  it('returns the requested handler even when several are exported', () => {
    const source = [
      'export async function first(req, res) { res.json("first"); }',
      'export async function second(req, res) { res.json("second"); }',
      'export async function third(req, res) { res.json("third"); }',
    ].join('\n');

    expect(extractHandler(source, 'first')?.code).toContain('"first"');
    expect(extractHandler(source, 'second')?.code).toContain('"second"');
    expect(extractHandler(source, 'third')?.code).toContain('"third"');
  });

  it('returns null for a name that is not exported', () => {
    const source = 'export async function list(req, res) { res.json([]); }';
    expect(extractHandler(source, 'missing')).toBeNull();
  });

  it('refuses object and class methods, whose slice is not a function expression', () => {
    const source = 'export default {\n  list(req, res) {\n    res.json([]);\n  },\n};';
    expect(extractHandler(source, 'list')).toBeNull();
  });

  it('returns null for a value that is not a function', () => {
    const source = 'export const list = [1, 2, 3];';
    expect(extractHandler(source, 'list')).toBeNull();
  });

  it('resolves a property on a separately exported object literal', () => {
    const source = [
      'export const todoController = {',
      '  countTodos: async (_req, res) => {',
      '    const count = await prisma.todo.count();',
      '    res.json({ count });',
      '  },',
      '};',
    ].join('\n');

    const handler = extractHandler(source, 'todoController', 'countTodos');
    expect(handler).not.toBeNull();
    expect(handler!.property).toBe('countTodos');
    expect(handler!.code).toContain('prisma.todo.count');
    expect(handler!.code).toContain('res.json({ count })');
  });
});

describe('isFunctionNode', () => {
  it('accepts the three re-hostable function shapes', () => {
    expect(isFunctionNode({ type: 'ArrowFunctionExpression' } as any)).toBe(true);
    expect(isFunctionNode({ type: 'FunctionExpression' } as any)).toBe(true);
    expect(isFunctionNode({ type: 'FunctionDeclaration' } as any)).toBe(true);
  });

  it('rejects object methods, class methods, identifiers and null', () => {
    expect(isFunctionNode({ type: 'ObjectMethod' } as any)).toBe(false);
    expect(isFunctionNode({ type: 'ClassMethod' } as any)).toBe(false);
    expect(isFunctionNode({ type: 'Identifier' } as any)).toBe(false);
    expect(isFunctionNode(null)).toBe(false);
  });
});
