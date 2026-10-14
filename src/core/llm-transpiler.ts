import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseSource } from '../utils/ast';
import type { ModelDef } from '../utils/schema-converter';

const execFileAsync = promisify(execFile);

export type LlmProviderKind = 'openai' | 'anthropic' | 'ollama' | 'agent-cli';

export interface LlmSettings {
  /** Explicit key; beats every environment variable. */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Skip every model call and rely on job files instead. */
  disabled?: boolean;
}

export interface LlmRoute {
  kind: LlmProviderKind;
  /** Label used in logs, e.g. `openai (gpt-4o-mini)`. */
  label: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** Executable name for `agent-cli`. */
  command?: string;
}

export interface HandlerRewriteRequest {
  method: string;
  path: string;
  framework: string;
  params: string[];
  usesBody: boolean;
  usesQuery: boolean;
  /** Path relative to the project root, for the prompt only. */
  sourceFile: string;
  handlerName: string;
  handlerSource: string;
  schemaSql: string;
  models: ModelDef[];
}

export interface HandlerPrompt {
  system: string;
  user: string;
}

export type RewriteOutcome =
  | { ok: true; code: string; provider: string }
  /** `transport` is true when the provider itself failed (unreachable, not
   *  logged in, HTTP error) rather than replying with unusable output. */
  | { ok: false; error: string; transport: boolean };

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

async function hasCommand(name: string): Promise<boolean> {
  try {
    await execFileAsync('which', [name]);
    return true;
  } catch {
    return false;
  }
}

async function ollamaIsUp(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Picks the first usable way to reach a model.
 *
 * Ordered from most explicit to least: an API key you supplied, then a
 * provider environment variable, then a local Ollama daemon, and finally an
 * already-installed agent CLI (`claude`, `codex`) whose logged-in session is
 * reused - that last one is what makes the feature work with no API key at all.
 *
 * Returns null when nothing is available, which is not an error: the caller
 * falls back to emitting job files for a host agent to fill in.
 */
export async function detectLlmRoute(settings: LlmSettings = {}): Promise<LlmRoute | null> {
  if (settings.disabled) return null;

  const env = process.env;
  const apiKey = settings.apiKey ?? env.OPENAI_API_KEY;
  if (apiKey) {
    const model = settings.model ?? env.OPENAI_MODEL ?? 'gpt-4o-mini';
    return {
      kind: 'openai',
      label: `openai (${model})`,
      model,
      baseUrl: (settings.baseUrl ?? env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
      apiKey,
    };
  }

  if (env.ANTHROPIC_API_KEY) {
    const model = settings.model ?? env.ANTHROPIC_MODEL ?? 'claude-3-5-sonnet-latest';
    return {
      kind: 'anthropic',
      label: `anthropic (${model})`,
      model,
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: env.ANTHROPIC_API_KEY,
    };
  }

  const ollamaHost = env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  if (await ollamaIsUp(ollamaHost)) {
    const model = settings.model ?? env.OLLAMA_MODEL ?? 'llama3.1';
    return { kind: 'ollama', label: `ollama (${model})`, model, baseUrl: ollamaHost.replace(/\/$/, '') };
  }

  for (const command of ['claude', 'codex']) {
    if (await hasCommand(command)) {
      return {
        kind: 'agent-cli',
        label: `${command} cli (reuses your existing login)`,
        model: command,
        command,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You convert exactly one Express or Next.js route handler into exactly one Hono handler.

OUTPUT RULES - absolute, no exceptions:
- Reply with a single JavaScript arrow function expression and nothing else.
- Shape: async (c) => { ... }
- Do NOT wrap the reply in markdown code fences.
- Do NOT add prose, explanation, headings, or trailing notes.
- Do NOT emit import or export statements.
- The function must be self-contained. It may only reference \`c\`, \`db\`, \`sqlite\` and its own local variables.

RUNTIME API - this is everything available; nothing is imported on your behalf:
- c.req.param('id')            -> string | undefined
- c.req.query('name')          -> string | undefined
- await c.req.json()           -> parsed JSON body; may throw when the body is absent, so guard it
- c.req.header('x-name')       -> string | undefined
- c.req.method                 -> string
- c.json(value, status?)       -> JSON response, status defaults to 200
- c.body(text, status?)        -> plain-text response
- c.body(null, 204)            -> empty response
- db                           -> Prisma-shaped client over SQLite, SYNCHRONOUS (never await it)
                                  db.<Model>.findMany|findFirst|findUnique|create|update|delete|upsert|count
                                  Model names are available in PascalCase and camelCase.
                                  Arguments use Prisma syntax: where / data / orderBy / select / take.
- db.$queryRaw(sql, params)    -> rows
- db.$executeRaw(sql, params)  -> write result
- sqlite                       -> raw better-sqlite3 handle
                                  sqlite.prepare(sql).all(...params) | .get(...params) | .run(...params)

BEHAVIOUR RULES:
- Preserve the original status codes, JSON key names and key order exactly.
- res.status(404).json({ error: 'x' }) becomes c.json({ error: 'x' }, 404).
- res.status(204).end() becomes c.body(null, 204).
- Keep every validation and error branch from the original.
- Wrap request-derived integers in Number(...) exactly where the original did.
- Prefer \`db\` over raw SQL unless the original used raw SQL.
- The handler must always return a response, even when a branch falls through.`;

function renderModels(models: ModelDef[]): string {
  if (models.length === 0) return '(none detected)';
  return models
    .map((model) => {
      const fields = model.fields
        .map((field) => `${field.name}${field.isOptional ? '?' : ''} ${field.prismaType}`)
        .join(', ');
      return `${model.name} [table ${model.tableName}] { ${fields} }`;
    })
    .join('\n');
}

export function buildHandlerPrompt(request: HandlerRewriteRequest): HandlerPrompt {
  const schema = request.schemaSql.trim() || '-- no schema was detected in the source project';

  const user = [
    `TARGET ROUTE`,
    `Method: ${request.method}`,
    `Path: ${request.path}`,
    `Framework: ${request.framework}`,
    `Path parameters: ${request.params.length ? request.params.join(', ') : '(none)'}`,
    `Reads request body: ${request.usesBody ? 'yes' : 'unknown'}`,
    `Reads query string: ${request.usesQuery ? 'yes' : 'unknown'}`,
    '',
    `SOURCE FILE: ${request.sourceFile}`,
    `HANDLER NAME: ${request.handlerName}`,
    '',
    `SQLITE SCHEMA (the tables that exist at runtime)`,
    '-----',
    schema,
    '-----',
    '',
    `MODELS (as exposed on \`db\`)`,
    '-----',
    renderModels(request.models),
    '-----',
    '',
    `CONTROLLER SOURCE TO CONVERT`,
    '-----',
    request.handlerSource,
    '-----',
    '',
    'Reply with only the Hono handler for TARGET ROUTE.',
  ].join('\n');

  return { system: SYSTEM_PROMPT, user };
}

/** Flattens system + user into one string, for CLI providers and job files. */
export function renderPrompt(prompt: HandlerPrompt): string {
  return `${prompt.system}\n\n=====\n\n${prompt.user}`;
}

// ---------------------------------------------------------------------------
// Provider calls
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 120_000;

async function callOpenAiCompatible(route: LlmRoute, prompt: HandlerPrompt): Promise<string> {
  const response = await fetch(`${route.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${route.apiKey}`,
    },
    body: JSON.stringify({
      model: route.model,
      temperature: 0,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const payload: any = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('response contained no message content');
  }
  return content;
}

async function callAnthropic(route: LlmRoute, prompt: HandlerPrompt): Promise<string> {
  const response = await fetch(`${route.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': route.apiKey ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: route.model,
      max_tokens: 4096,
      temperature: 0,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const payload: any = await response.json();
  const text = (payload?.content ?? [])
    .filter((block: any) => block?.type === 'text')
    .map((block: any) => block.text)
    .join('');
  if (!text.trim()) throw new Error('response contained no text blocks');
  return text;
}

async function callOllama(route: LlmRoute, prompt: HandlerPrompt): Promise<string> {
  const response = await fetch(`${route.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: route.model,
      stream: false,
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const payload: any = await response.json();
  const content = payload?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('response contained no message content');
  }
  return content;
}

/** Runs `claude -p` / `codex exec`, reusing whatever login already exists. */
function callAgentCli(route: LlmRoute, prompt: HandlerPrompt): Promise<string> {
  const text = renderPrompt(prompt);
  const args = route.command === 'codex' ? ['exec', text] : ['-p', text, '--output-format', 'text'];

  return new Promise((resolve, reject) => {
    const child = spawn(route.command as string, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${route.command} timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${route.command} exited with code ${code}: ${stderr.trim().slice(0, 300)}`));
        return;
      }
      if (!stdout.trim()) {
        reject(new Error(`${route.command} produced no output`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function callProvider(route: LlmRoute, prompt: HandlerPrompt): Promise<string> {
  switch (route.kind) {
    case 'openai':
      return callOpenAiCompatible(route, prompt);
    case 'anthropic':
      return callAnthropic(route, prompt);
    case 'ollama':
      return callOllama(route, prompt);
    case 'agent-cli':
      return callAgentCli(route, prompt);
  }
}

// ---------------------------------------------------------------------------
// Response normalisation
// ---------------------------------------------------------------------------

/** Drops markdown fence lines; surrounding prose is handled by the carving step. */
function stripFences(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !/^\s*```/.test(line))
    .join('\n')
    .trim();
}

/** True when `code` parses as a bare function expression. */
function parsesAsFunction(code: string): boolean {
  try {
    const file = parseSource(`const __candidate = ${code};`);
    const statement: any = file.program.body[0];
    const init = statement?.declarations?.[0]?.init;
    return (
      init?.type === 'ArrowFunctionExpression' ||
      init?.type === 'FunctionExpression' ||
      init?.type === 'FunctionDeclaration'
    );
  } catch {
    return false;
  }
}

/** Walks a balanced `{...}` / `(...)` block starting at `open`. */
function matchBalanced(text: string, open: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Last-resort recovery: carve the arrow function out of surrounding prose. */
function carveArrowFunction(text: string): string | null {
  const arrow = text.indexOf('=>');
  if (arrow === -1) return null;

  let paramsStart = arrow - 1;
  while (paramsStart >= 0 && /\s/.test(text[paramsStart])) paramsStart -= 1;
  if (text[paramsStart] !== ')') return null;
  const paramsOpen = text.lastIndexOf('(', paramsStart);
  if (paramsOpen === -1) return null;

  // Keep a leading `async` keyword when the reply has one.
  let start = paramsOpen;
  const asyncKeyword = text.slice(0, paramsOpen).match(/async\s*$/);
  if (asyncKeyword) start = paramsOpen - asyncKeyword[0].length;

  let cursor = arrow + 2;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;

  if (text[cursor] === '{') {
    const end = matchBalanced(text, cursor, '{', '}');
    if (end === -1) return null;
    return text.slice(start, end + 1);
  }

  // Concise body: take the rest of the line/statement.
  let end = cursor;
  while (end < text.length && text[end] !== '\n' && text[end] !== ';') end += 1;
  return text.slice(start, end);
}

/**
 * Turns a raw model reply into a bare `async (c) => { ... }` expression.
 * Returns null when nothing function-shaped survives, which the caller treats
 * as a failed rewrite rather than emitting broken code.
 */
export function normalizeHandlerCode(raw: string): string | null {
  const stripped = stripFences(raw);
  if (parsesAsFunction(stripped)) return stripped;

  // The reply may be `const handler = async (c) => {...}` or similar.
  const declaration = stripped.match(
    /(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*([\s\S]+?);?\s*$/,
  );
  if (declaration && parsesAsFunction(declaration[1].trim())) {
    return declaration[1].trim();
  }

  const carved = carveArrowFunction(stripped);
  if (carved && parsesAsFunction(carved)) return carved;

  return null;
}

/**
 * Asks the route's provider for a Hono rewrite of one extracted handler.
 * Never throws: a failure is returned as `{ ok: false }` so the caller can
 * fall back to the AST path or a job file.
 */
export async function rewriteHandler(
  request: HandlerRewriteRequest,
  route: LlmRoute,
): Promise<RewriteOutcome> {
  const prompt = buildHandlerPrompt(request);
  let raw: string;
  try {
    raw = await callProvider(route, prompt);
  } catch (error: any) {
    return { ok: false, error: error?.message ?? String(error), transport: true };
  }

  const code = normalizeHandlerCode(raw);
  if (!code) {
    return {
      ok: false,
      error: 'model reply did not contain a usable function expression',
      transport: false,
    };
  }
  return { ok: true, code, provider: route.label };
}

// ---------------------------------------------------------------------------
// Job files - the host-agent handoff
// ---------------------------------------------------------------------------

export interface HandlerJob {
  id: string;
  method: string;
  path: string;
  framework: string;
  sourceFile: string;
  handlerName: string;
  schemaSql: string;
  handlerSource: string;
  /** The full prompt, system and user combined. */
  prompt: string;
}

export interface WrittenJob extends HandlerJob {
  /** Absolute path of the JSON the agent reads. */
  jsonFile: string;
  /** Absolute path the agent must write the handler to. */
  outputFile: string;
}

export function jobOutputName(id: string): string {
  return `${id}.out.ts`;
}

export async function writeHandlerJobs(dir: string, jobs: HandlerJob[]): Promise<WrittenJob[]> {
  await fs.mkdir(dir, { recursive: true });
  const written: WrittenJob[] = [];

  for (const job of jobs) {
    const jsonFile = path.join(dir, `${job.id}.json`);
    const outputFile = path.join(dir, jobOutputName(job.id));
    const payload = {
      ...job,
      instructions:
        `Rewrite the handler in "handlerSource" as a single Hono arrow function ` +
        `"async (c) => { ... }" using only the runtime API described in "prompt". ` +
        `Write ONLY that expression to ${path.relative(process.cwd(), outputFile)} - ` +
        `no markdown fences, no imports, no exports, no prose.`,
      outputFile: path.relative(process.cwd(), outputFile),
    };
    await fs.writeFile(jsonFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    written.push({ ...job, jsonFile, outputFile });
  }

  return written;
}

/** Reads a filled-in job. Returns null when the agent has not written it yet. */
export async function readHandlerJobOutput(dir: string, id: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(dir, jobOutputName(id)), 'utf8');
    return normalizeHandlerCode(raw);
  } catch {
    return null;
  }
}
