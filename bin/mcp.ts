#!/usr/bin/env node
/**
 * app-shrink MCP server (stdio, dependency-free).
 *
 * Speaks the Model Context Protocol over stdin/stdout so any MCP-capable IDE
 * or agent (Trae, Claude Code, Cursor, Codex, ...) can drive app-shrink without
 * the tool ever needing its own credentials.
 *
 * stdout carries protocol frames only; every human-readable line goes to stderr.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { VERSION, buildShrunkApp, inspectTarget } from '../src/index';
import { jobOutputName, normalizeHandlerCode } from '../src/core/llm-transpiler';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'app-shrink';

function logToStderr(message: string): void {
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'shrink_inspect',
    description:
      'Analyse a Node.js/Next.js project and report the API routes, ORM models and static assets ' +
      'app-shrink would extract. Use this first to decide whether a project is worth shrinking.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Path to the source repository.' },
      },
      required: ['target'],
    },
  },
  {
    name: 'shrink_build',
    description:
      'Run the full pipeline and emit a single-file Hono + SQLite micro-service. ' +
      'Handlers that live in imported controller files are resolved across files; ' +
      'pass emitJobs to write them out for this agent to rewrite, then call ' +
      'shrink_write_handler for each job and re-run with useJobs.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Path to the source repository.' },
        out: { type: 'string', description: 'Output directory. Default ./dist-shrunk.' },
        port: { type: 'number', description: 'Default port baked into the generated service.' },
        verify: {
          type: 'boolean',
          description: 'Boot both apps and differentially verify every probe.',
        },
        noLlm: {
          type: 'boolean',
          description: 'Never call a model; use AST transpilation and job files only.',
        },
        emitJobs: {
          type: 'string',
          description: 'Write imported handlers here as job files for this agent to complete.',
        },
        useJobs: {
          type: 'string',
          description: 'Read handler implementations this agent already wrote for emitJobs.',
        },
        apiKey: { type: 'string', description: 'Optional model API key.' },
        model: { type: 'string', description: 'Optional model name.' },
        baseUrl: { type: 'string', description: 'Optional OpenAI-compatible base URL.' },
      },
      required: ['target'],
    },
  },
  {
    name: 'shrink_list_handler_jobs',
    description:
      'List the handler rewrites a build is still waiting for after emitJobs. ' +
      'Each id can be inspected with shrink_get_handler_job and answered with shrink_write_handler.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'The directory passed as emitJobs.' },
      },
      required: ['dir'],
    },
  },
  {
    name: 'shrink_get_handler_job',
    description:
      'Return the full prompt and original controller source for one handler job, ' +
      'including the runtime API the replacement handler may use.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'The directory passed as emitJobs.' },
        id: { type: 'string', description: 'Job id, as returned by shrink_list_handler_jobs.' },
      },
      required: ['dir', 'id'],
    },
  },
  {
    name: 'shrink_write_handler',
    description:
      'Write the rewritten Hono handler for one job. The code must be a bare ' +
      '`async (c) => { ... }` expression: no fences, no imports, no exports, no prose. ' +
      'Re-run shrink_build with useJobs pointing at the same directory once every job is answered.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'The directory passed as emitJobs.' },
        id: { type: 'string', description: 'Job id to answer.' },
        code: { type: 'string', description: 'The replacement handler expression.' },
      },
      required: ['dir', 'id', 'code'],
    },
  },
];

const JOB_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`"${name}" is required and must be a non-empty string`);
  }
  return value;
}

/** Rejects ids that would escape the jobs directory. */
function safeJobId(id: unknown): string {
  const value = requireString(id, 'id');
  if (!JOB_ID_PATTERN.test(value)) {
    throw new Error(`Invalid job id "${value}"`);
  }
  return value;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Prefers a short relative path, falling back to the absolute one outside cwd. */
function displayPath(target: string): string {
  const relative = path.relative(process.cwd(), target);
  return relative && !relative.startsWith('..') ? relative : target;
}

async function inspect(args: Record<string, unknown>): Promise<string> {
  const target = requireString(args.target, 'target');
  const analysis = await inspectTarget(target);

  const lines = [
    `${analysis.routes.length} API endpoint(s) across ${analysis.routeFiles.length} file(s)`,
    `${analysis.scannedFiles} file(s) scanned`,
  ];

  for (const route of analysis.routes) {
    lines.push(`  ${route.method} ${route.path}  [${route.framework}]`);
  }

  lines.push('', `Models: ${analysis.models.map((model) => model.name).join(', ') || '(none detected)'}`);
  lines.push(
    `Static assets: ${
      analysis.staticAssets.map((asset) => `${path.relative(analysis.targetDir, asset.dir)} -> ${asset.mount}`).join(', ') ||
      '(none)'
    }`,
  );

  return lines.join('\n');
}

async function build(args: Record<string, unknown>): Promise<string> {
  const target = requireString(args.target, 'target');
  const out = typeof args.out === 'string' ? args.out : './dist-shrunk';

  const result = await buildShrunkApp({
    target,
    out,
    port: typeof args.port === 'number' ? args.port : 3000,
    db: 'sqlite',
    verify: args.verify === true,
    apiKey: typeof args.apiKey === 'string' ? args.apiKey : undefined,
    baseUrl: typeof args.baseUrl === 'string' ? args.baseUrl : undefined,
    model: typeof args.model === 'string' ? args.model : undefined,
    noLlm: args.noLlm === true,
    emitJobs: typeof args.emitJobs === 'string' ? args.emitJobs : undefined,
    useJobs: typeof args.useJobs === 'string' ? args.useJobs : undefined,
    log: logToStderr,
  });

  const { analysis, transpile, verification } = result;
  const lines = [
    `Output: ${displayPath(path.join(result.outDir, 'server.ts'))}`,
    `Routes: ${analysis.routes.length} detected, ${transpile.transpiledRoutes} transpiled, ${transpile.stubbedRoutes} stubbed`,
    `Imported handlers rewritten by a model or agent: ${transpile.llmRoutes}`,
  ];

  if (transpile.jobFiles.length > 0) {
    lines.push(`Handler jobs written: ${transpile.jobFiles.length} into ${path.dirname(transpile.jobFiles[0])}`);
  }

  if (verification?.ran) {
    lines.push(
      `Verification: ${verification.parityScore}% parity across ${verification.probes.length} probe(s)`,
    );
    for (const probe of verification.probes) {
      lines.push(`  ${probe.method} ${probe.path}: ${probe.shrunk.status ?? 'ERR'} (parity ${probe.parity}%)`);
    }
  } else if (args.verify === true) {
    lines.push(`Verification did not run: ${verification?.reason ?? 'no report'}`);
  }

  for (const warning of transpile.warnings) lines.push(`Warning: ${warning}`);

  return lines.join('\n');
}

async function listHandlerJobs(args: Record<string, unknown>): Promise<string> {
  const dir = requireString(args.dir, 'dir');

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return `No job directory at ${dir}. Run shrink_build with emitJobs set.`;
  }

  const jobFiles = entries.filter((entry) => entry.endsWith('.json')).sort();
  if (jobFiles.length === 0) return `No jobs in ${dir}.`;

  const lines: string[] = [];
  for (const file of jobFiles) {
    const id = file.slice(0, -'.json'.length);
    const answered = await pathExists(path.join(dir, jobOutputName(id)));
    let job: any = {};
    try {
      job = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
    } catch {
      /* reported through the missing fields below */
    }
    lines.push(
      `${answered ? '[done]' : '[open]'} ${id} — ${job.method ?? '?'} ${job.path ?? '?'} ` +
        `(${job.handlerName ?? '?'} in ${job.sourceFile ?? '?'})`,
    );
  }

  const open = lines.filter((line) => line.startsWith('[open]')).length;
  return [`${jobFiles.length} job(s), ${open} awaiting a handler:`, ...lines].join('\n');
}

async function getHandlerJob(args: Record<string, unknown>): Promise<string> {
  const dir = requireString(args.dir, 'dir');
  const id = safeJobId(args.id);

  let job: any;
  try {
    job = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8'));
  } catch {
    throw new Error(`No job "${id}" in ${dir}`);
  }

  return [
    `# Job ${id}`,
    `Route: ${job.method} ${job.path}`,
    `Handler: ${job.handlerName} in ${job.sourceFile}`,
    `Write the answer to: ${job.outputFile}`,
    '',
    '## Prompt',
    job.prompt,
    '',
    '## Original controller source',
    job.handlerSource,
  ].join('\n');
}

async function writeHandler(args: Record<string, unknown>): Promise<string> {
  const dir = requireString(args.dir, 'dir');
  const id = safeJobId(args.id);
  const raw = requireString(args.code, 'code');

  const jobFile = path.join(dir, `${id}.json`);
  if (!(await pathExists(jobFile))) {
    throw new Error(`No job "${id}" in ${dir}. Call shrink_list_handler_jobs first.`);
  }

  const code = normalizeHandlerCode(raw);
  if (!code) {
    throw new Error(
      'The code is not a usable handler expression. Reply with a bare ' +
        '`async (c) => { ... }` function, without fences, imports, exports or prose.',
    );
  }

  const outputFile = path.join(dir, jobOutputName(id));
  await fs.writeFile(outputFile, `${code}\n`, 'utf8');
  return `Wrote ${outputFile}`;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'shrink_inspect':
      return inspect(args);
    case 'shrink_build':
      return build(args);
    case 'shrink_list_handler_jobs':
      return listHandlerJobs(args);
    case 'shrink_get_handler_job':
      return getHandlerJob(args);
    case 'shrink_write_handler':
      return writeHandler(args);
    default:
      throw new Error(`Unknown tool "${name}"`);
  }
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: unknown, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message: any): Promise<void> {
  const { id, method, params } = message ?? {};

  // Notifications carry no id and must not be answered.
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize':
        sendResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: VERSION },
        });
        return;

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;

      case 'ping':
        sendResult(id, {});
        return;

      case 'tools/list':
        sendResult(id, { tools: TOOLS });
        return;

      case 'tools/call': {
        const name = String(params?.name ?? '');
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const text = await callTool(name, args);
          sendResult(id, { content: [{ type: 'text', text }] });
        } catch (error: any) {
          sendResult(id, {
            content: [{ type: 'text', text: `Error: ${error?.message ?? String(error)}` }],
            isError: true,
          });
        }
        return;
      }

      default:
        if (!isNotification) sendError(id, -32601, `Method not found: ${method}`);
        return;
    }
  } catch (error: any) {
    if (!isNotification) sendError(id, -32603, error?.message ?? String(error));
  }
}

let buffer = '';
let queue: Promise<void> = Promise.resolve();
let inFlight = 0;
let stdinEnded = false;

/**
 * Tool calls are async, so the process must stay alive until the last one has
 * replied - otherwise a piped client that closes stdin early loses responses.
 */
function enqueue(work: () => Promise<void>): void {
  inFlight += 1;
  queue = queue
    .then(work)
    .catch((error) => logToStderr(`app-shrink-mcp: ${error?.message ?? String(error)}`))
    .then(() => {
      inFlight -= 1;
      if (stdinEnded && inFlight === 0) process.exit(0);
    });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        logToStderr('app-shrink-mcp: ignoring malformed frame');
      }
      if (parsed) enqueue(() => handle(parsed));
    }
    index = buffer.indexOf('\n');
  }
});

process.stdin.on('end', () => {
  stdinEnded = true;
  if (inFlight === 0) process.exit(0);
});

logToStderr(`app-shrink-mcp v${VERSION} ready (stdio)`);
