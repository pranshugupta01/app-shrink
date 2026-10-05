import { promises as fs, existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ChildProcess, execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { AnalysisResult, RouteDef } from './analyzer';

/** The full set of files we have to copy to faithfully snapshot a SQLite db.
 *  better-sqlite3 leaves -wal / -shm sidecars next to the main file when WAL
 *  mode is on; without them the snapshot is not crash-consistent. */
const SQLITE_SIDECARS = ['', '-wal', '-shm', '-journal'] as const;

const execFileAsync = promisify(execFile);

export interface ProbeSpec {
  label: string;
  method: string;
  path: string;
  body?: unknown;
}

export interface ProbeOutcome {
  status: number | null;
  body: unknown;
  raw: string | null;
  error: string | null;
  ms: number;
}

export interface ProbeResult {
  label: string;
  method: string;
  path: string;
  original: ProbeOutcome;
  shrunk: ProbeOutcome;
  parity: number;
  statusMatched: boolean;
  notes: string[];
}

export interface VerificationReport {
  ran: boolean;
  reason?: string;
  probes: ProbeResult[];
  originalBootMs: number | null;
  shrunkBootMs: number | null;
  originalRssBytes: number | null;
  shrunkRssBytes: number | null;
  originalHeapUsedBytes: number | null;
  shrunkHeapUsedBytes: number | null;
  originalDiskBytes: number;
  shrunkDiskBytes: number;
  parityScore: number;
  warnings: string[];
}

export interface VerifyOptions {
  analysis: AnalysisResult;
  outDir: string;
  shrunkEntry: string;
  /** Absolute path to the SQLite file the generated service should use. */
  databaseFile: string;
  timeoutMs?: number;
  log: (message: string) => void;
}

const VOLATILE_KEYS = /^(createdAt|updatedAt|deletedAt|timestamp)$/i;

// ---------------------------------------------------------------------------
// Child process tracking - guarantees no orphaned servers on any exit path.
// ---------------------------------------------------------------------------

const liveChildren = new Set<ChildProcess>();

function trackChild(child: ChildProcess): ChildProcess {
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  return child;
}

async function killAllChildren(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  const pending = [...liveChildren];
  for (const child of pending) {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
  if (pending.length === 0) return;
  await delay(400);
  for (const child of pending) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

let cleanupRegistered = false;
function registerProcessCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const emergencyKill = () => {
    for (const child of liveChildren) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };
  process.on('exit', emergencyKill);
  process.on('uncaughtException', (error) => {
    emergencyKill();
    throw error;
  });
  process.on('unhandledRejection', (reason) => {
    emergencyKill();
    throw reason;
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Source database snapshotting
//
// Differential verification replays POST/PUT/DELETE probes, which mutate the
// source database. We snapshot it up-front and restore it afterwards so runs
// are repeatable and the target repo is left untouched.
// ---------------------------------------------------------------------------

const DB_SIDECARS = ['', '-wal', '-shm'] as const;

interface DatabaseSnapshot {
  dir: string;
  files: { original: string; backup: string }[];
}

async function snapshotDatabase(file: string | null): Promise<DatabaseSnapshot | null> {
  if (!file || !(await pathExists(file))) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-shrink-db-'));
  const files: DatabaseSnapshot['files'] = [];
  for (const suffix of DB_SIDECARS) {
    const original = `${file}${suffix}`;
    if (!(await pathExists(original))) continue;
    const backup = path.join(dir, `${path.basename(file)}${suffix}`);
    await fs.copyFile(original, backup);
    files.push({ original, backup });
  }
  return { dir, files };
}

async function restoreDatabase(snapshot: DatabaseSnapshot | null): Promise<void> {
  if (!snapshot) return;
  for (const entry of snapshot.files) {
    try {
      await fs.copyFile(entry.backup, entry.original);
    } catch {
      /* the target may have been removed while we ran */
    }
  }
  await fs.rm(snapshot.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Environment discovery
// ---------------------------------------------------------------------------

/** Walks up from this file until the app-shrink package root is found. */
function findPackageRoot(): string {
  let current = __dirname;
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(current, 'package.json')) && existsSync(path.join(current, 'bin'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

/**
 * `tsx` is our TypeScript launcher. Preferring the local bin shim keeps the
 * verifier working on every supported Node version.
 */
function resolveTsxLauncher(): { command: string; prefixArgs: string[] } {
  const shim = path.join(findPackageRoot(), 'node_modules', '.bin', 'tsx');
  if (existsSync(shim)) return { command: shim, prefixArgs: [] };

  const [major, minor] = process.versions.node.split('.').map(Number);
  const supportsImport = major > 20 || (major === 20 && minor >= 6);
  return { command: process.execPath, prefixArgs: supportsImport ? ['--import', 'tsx'] : ['--loader', 'tsx'] };
}

/**
 * Node >= 22.18 / >= 23.6 strips TypeScript types natively. The generated
 * service is ESM, so it can boot without any transpiler - which is what makes
 * the small-footprint and cold-start numbers measurable instead of being
 * dominated by a toolchain.
 */
function supportsNativeTypeScript(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major >= 24) return true;
  if (major === 23) return minor >= 6;
  if (major === 22) return minor >= 18;
  return false;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function directorySize(target: string, seen = new Set<string>()): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (seen.has(full)) continue;
    seen.add(full);
    if (entry.isDirectory()) {
      total += await directorySize(full, seen);
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(full)).size;
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return total;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not allocate a free port')));
      }
    });
  });
}

/**
 * Launchers such as `tsx` re-spawn the app, so memory has to be attributed to
 * the whole process tree rather than to the PID we spawned. The OS could tell
 * us that, but `top -l 1 -stats pid,mem` disagrees with itself across runs and
 * `ps -o rss=` reports 0 on macOS, so the numbers below come from
 * `process.memoryUsage()` inside each instrumented process instead - the same
 * API the benchmark spec names. See "Memory instrumentation".
 */

// ---------------------------------------------------------------------------
// Memory instrumentation
//
// Two numbers, both read with `process.memoryUsage()` from *inside* the app
// process rather than observed from the outside:
//
//   RSS   - what the OS has resident for the app. Node's own baseline dominates
//           it and shared pages are included, so it is far less flattering than
//           an application-only measure.
//   heap  - what the application itself allocated. This is the number that
//           shows the real reduction in application overhead.
//
// The probe is injected with `NODE_OPTIONS`, which reaches the app no matter
// which launcher starts it (plain `node`, or `tsx`, which re-spawns). It stays
// silent until it is asked for a reading, so it cannot perturb the apps.
//
// The two readings are taken separately on purpose. RSS is read untouched,
// because forcing a collection hands pages back to the OS and the next resident
// reading then reports a fraction of the app's steady-state footprint. Heap is
// read only after a collection, so it reflects retained memory instead of
// whatever garbage happened to be uncollected at that instant.
// ---------------------------------------------------------------------------

const MEMORY_MARKER = '__APP_SHRINK_MEM__';
const MEMORY_SAMPLE_ROUNDS = 3;

/** `rss` is a plain reading; `heap` is taken after a forced collection. */
type MemoryEvent = 'ready' | 'rss' | 'heap';

interface MemoryMarker {
  event: MemoryEvent;
  pid: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
}

const MEMORY_PROBE_SOURCE = [
  `const MARKER = ${JSON.stringify(MEMORY_MARKER)};`,
  'const emit = (event) => {',
  '  try {',
  '    const usage = process.memoryUsage();',
  "    process.stdout.write('\\n' + MARKER + JSON.stringify({ event, pid: process.pid, rss: usage.rss, heapUsed: usage.heapUsed, heapTotal: usage.heapTotal }) + '\\n');",
  '  } catch {',
  '    /* never let diagnostics break the app */',
  '  }',
  '};',
  'emit("ready");',
  'process.on("SIGUSR2", () => emit("rss"));',
  'process.on("SIGUSR1", () => {',
  '  if (typeof globalThis.gc === "function") globalThis.gc();',
  '  emit("heap");',
  '});',
  '',
].join('\n');

/** `--import` (and therefore the NODE_OPTIONS form of it) needs Node >= 18.18. */
function nodeSupportsImportFlag(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major >= 21) return true;
  if (major === 20) return minor >= 6;
  if (major === 18) return minor >= 18;
  return false;
}

let memoryProbePath: string | null = null;

async function installMemoryProbe(): Promise<string | null> {
  if (memoryProbePath) return memoryProbePath;
  if (!nodeSupportsImportFlag()) return null;
  try {
    const file = path.join(os.tmpdir(), `app-shrink-mem-probe-${process.pid}.mjs`);
    await fs.writeFile(file, MEMORY_PROBE_SOURCE, 'utf8');
    memoryProbePath = file;
    return file;
  } catch {
    return null;
  }
}

async function removeMemoryProbe(): Promise<void> {
  if (!memoryProbePath) return;
  const file = memoryProbePath;
  memoryProbePath = null;
  try {
    await fs.rm(file, { force: true });
  } catch {
    /* best effort */
  }
}

function parseMemoryMarker(line: string): MemoryMarker | null {
  const index = line.indexOf(MEMORY_MARKER);
  if (index === -1) return null;
  try {
    const payload = JSON.parse(line.slice(index + MEMORY_MARKER.length));
    if (typeof payload?.pid !== 'number' || typeof payload?.heapUsed !== 'number') return null;
    return payload as MemoryMarker;
  } catch {
    return null;
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function readingsFor(server: RunningServer, event: MemoryEvent): MemoryMarker[] {
  return server.logs
    .map(parseMemoryMarker)
    .filter((entry): entry is MemoryMarker => entry !== null && entry.event === event);
}

/**
 * Signals every instrumented process and returns the markers that arrived.
 *
 * Targets come from the probe's own startup markers rather than from the
 * process tree: SIGUSR1/SIGUSR2 terminate a process that has no handler, so we
 * must never signal a process we have not instrumented.
 */
async function requestReading(
  server: RunningServer,
  signal: NodeJS.Signals,
  event: MemoryEvent,
): Promise<MemoryMarker[]> {
  const seen = readingsFor(server, event).length;
  for (const pid of server.probePids) {
    try {
      process.kill(pid, signal);
    } catch {
      /* the process exited between the marker and now */
    }
  }
  await delay(250);
  return readingsFor(server, event).slice(seen);
}

/**
 * Asks the OS which process owns the listening socket for `port`.
 *
 * Memory cannot be attributed by heap size alone. When the source app is booted
 * through a TypeScript toolchain, that toolchain runs its own Node process whose
 * transformer keeps a *larger* V8 heap than the app itself, while the app's
 * resident footprint is mostly native (the Prisma query engine, for instance).
 * Ranking by heap therefore charges the toolchain and reports the wrong app.
 * The listener is unambiguous.
 *
 * Returns null on hosts without `lsof`, where the caller falls back to ranking.
 */
async function findListeningPid(port: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('lsof', [
      '-nP',
      `-iTCP:${port}`,
      '-sTCP:LISTEN',
      '-t',
    ]);
    const pids = stdout
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    return pids.length > 0 ? pids[0] : null;
  } catch {
    return null;
  }
}

/**
 * Selects the reading that belongs to the application itself.
 *
 * A launcher such as `tsx` re-spawns the app, so more than one instrumented
 * process answers. The listener wins; failing that, the app is the process
 * holding the resident memory, since a toolchain process is a build-time
 * artifact and charging the shrunk service for it would flatter the comparison.
 */
function pickApplication(
  readings: MemoryMarker[],
  listeningPid: number | null,
): MemoryMarker | null {
  if (readings.length === 0) return null;
  if (listeningPid !== null) {
    const owner = readings.find((entry) => entry.pid === listeningPid);
    if (owner) return owner;
  }
  return readings.reduce((largest, entry) =>
    entry.rss > largest.rss ? entry : largest,
  );
}

/**
 * Takes both readings and returns the medians.
 *
 * Every RSS round happens before the first heap round, never interleaved. A
 * forced collection returns pages to the OS, so any resident reading taken
 * afterwards reports a fraction of the app's steady-state footprint - measuring
 * both in the same loop would silently compare a warm RSS against a collected
 * one and understate the app by two thirds.
 */
async function sampleMemoryUsage(
  server: RunningServer,
): Promise<{ rssBytes: number | null; heapUsedBytes: number | null }> {
  if (server.probePids.size === 0) return { rssBytes: null, heapUsedBytes: null };

  const listeningPid = await findListeningPid(server.port);

  const rssRounds: number[] = [];
  for (let round = 0; round < MEMORY_SAMPLE_ROUNDS; round += 1) {
    const entry = pickApplication(await requestReading(server, 'SIGUSR2', 'rss'), listeningPid);
    if (entry) rssRounds.push(entry.rss);
  }

  const heapRounds: number[] = [];
  for (let round = 0; round < MEMORY_SAMPLE_ROUNDS; round += 1) {
    const entry = pickApplication(await requestReading(server, 'SIGUSR1', 'heap'), listeningPid);
    if (entry) heapRounds.push(entry.heapUsed);
  }

  return { rssBytes: median(rssRounds), heapUsedBytes: median(heapRounds) };
}

// ---------------------------------------------------------------------------
// Source app provisioning
// ---------------------------------------------------------------------------

interface SourceApp {
  entry: string;
  cwd: string;
  packageManager: 'npm';
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  log: (message: string) => void,
): Promise<void> {
  log(`      running: ${path.basename(command)} ${args.join(' ')}`);
  try {
    await execFileAsync(command, args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  } catch (error: any) {
    const detail = [error?.stdout, error?.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`\`${args.join(' ')}\` failed in ${cwd}\n${detail || error?.message || error}`);
  }
}

/**
 * Makes sure the target repository can actually boot: dependencies installed,
 * Prisma client generated, schema pushed and seeded.
 */
async function provisionSourceApp(
  analysis: AnalysisResult,
  log: (message: string) => void,
): Promise<{ app: SourceApp; databaseFile: string | null }> {
  const cwd = analysis.targetDir;
  const packageJsonPath = path.join(cwd, 'package.json');
  if (!(await pathExists(packageJsonPath))) {
    throw new Error(`No package.json found in ${cwd}`);
  }
  const manifest = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

  if (!(await pathExists(path.join(cwd, 'node_modules')))) {
    log('installing source dependencies (this happens once)');
    await runCommand('npm', ['install', '--no-audit', '--no-fund'], cwd, log);
  }

  const hasPrisma = analysis.schema !== null && (await pathExists(path.join(cwd, 'prisma', 'schema.prisma')));
  if (hasPrisma) {
    const prismaBin = path.join(cwd, 'node_modules', '.bin', 'prisma');
    const generatedClient = path.join(cwd, 'node_modules', '.prisma', 'client');

    if (!(await pathExists(generatedClient)) && (await pathExists(prismaBin))) {
      log('generating Prisma client');
      await runCommand(prismaBin, ['generate'], cwd, log);
    }

    const databaseFile = analysis.sourceDatabase;
    if (databaseFile && !(await pathExists(databaseFile)) && (await pathExists(prismaBin))) {
      log('creating and seeding the source database');
      await runCommand(prismaBin, ['db', 'push', '--skip-generate', '--accept-data-loss'], cwd, log);
      const seedScript = manifest?.prisma?.seed as string | undefined;
      if (seedScript) {
        const launcher = resolveTsxLauncher();
        const seedArgs = seedScript.replace(/^tsx\s+/, '').split(/\s+/);
        await runCommand(launcher.command, [...launcher.prefixArgs, ...seedArgs], cwd, log);
      }
    }

    if (databaseFile && (await pathExists(databaseFile))) {
      return { app: await resolveSourceApp(cwd, manifest), databaseFile };
    }
  }

  return { app: await resolveSourceApp(cwd, manifest), databaseFile: analysis.sourceDatabase };
}

async function resolveSourceApp(cwd: string, manifest: any): Promise<SourceApp> {
  const startScript: string | undefined = manifest?.scripts?.start;
  if (startScript) {
    const match = startScript.match(/(?:tsx|ts-node|node)\s+(\S+)/);
    if (match) {
      const entry = match[1];
      if (await pathExists(path.join(cwd, entry))) {
        return { entry, cwd, packageManager: 'npm' };
      }
    }
  }

  for (const candidate of [
    'server.ts',
    'server.js',
    'index.ts',
    'index.js',
    'src/server.ts',
    'src/index.ts',
    'src/app.ts',
    'app.ts',
  ]) {
    if (await pathExists(path.join(cwd, candidate))) {
      return { entry: candidate, cwd, packageManager: 'npm' };
    }
  }

  throw new Error(
    `Could not find a runnable entrypoint in ${cwd}. Add a "start" script to package.json to enable verification.`,
  );
}

// ---------------------------------------------------------------------------
// Generated service provisioning
// ---------------------------------------------------------------------------

/** True when Node can resolve `specifier` starting from `cwd`. */
function resolvesFrom(cwd: string, specifier: string): boolean {
  try {
    createRequire(path.join(cwd, 'noop.js')).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes sure the generated service can actually boot.
 *
 * The emitted `server.ts` imports `hono` and `@hono/node-server`, so it needs
 * those on its own resolution path. Building into a directory *inside* the
 * app-shrink checkout hides the problem - Node then walks up and finds the
 * CLI's own `node_modules` - and the service only fails once it is built
 * somewhere real. Installing here closes that gap; failure is not fatal,
 * because the health check reports the concrete resolution error anyway.
 */
async function ensureShrunkDependencies(
  outDir: string,
  log: (message: string) => void,
): Promise<void> {
  if (!(await pathExists(path.join(outDir, 'package.json')))) return;
  if (resolvesFrom(outDir, 'hono') && resolvesFrom(outDir, '@hono/node-server')) return;

  log('installing generated service dependencies (this happens once)');
  try {
    await runCommand('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], outDir, log);
  } catch {
    /* reported by the health check as a resolution error */
  }
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

interface RunningServer {
  child: ChildProcess;
  port: number;
  baseUrl: string;
  bootMs: number;
  logs: string[];
  /** PIDs that announced the memory probe at startup (launchers spawn several). */
  probePids: Set<number>;
}

function spawnServer(
  command: string,
  args: string[],
  cwd: string,
  port: number,
  extraEnv: Record<string, string>,
  label: string,
): RunningServer {
  const child = trackChild(
    spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
        PORT: String(port),
        NODE_ENV: 'production',
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );

  const logs: string[] = [];
  const probePids = new Set<number>();
  const capture = (chunk: Buffer) => {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      logs.push(`[${label}] ${trimmed}`);
      const marker = parseMemoryMarker(trimmed);
      if (marker && marker.event === 'ready') probePids.add(marker.pid);
    }
    if (logs.length > 200) logs.splice(0, logs.length - 200);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  return { child, port, baseUrl: `http://127.0.0.1:${port}`, bootMs: 0, logs, probePids };
}

/**
 * Injects the memory probe without discarding an existing NODE_OPTIONS.
 * `--expose-gc` is what lets the probe collect before sampling.
 */
function probeEnv(probePath: string | null): Record<string, string> {
  if (!probePath) return {};
  const existing = process.env.NODE_OPTIONS?.trim();
  const injected = `--expose-gc --import ${probePath}`;
  return { NODE_OPTIONS: [existing, injected].filter(Boolean).join(' ') };
}

async function waitForHealth(server: RunningServer, timeoutMs: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (server.child.exitCode !== null) {
      throw new Error(
        `Server exited early (code ${server.child.exitCode}).\n${server.logs.slice(-12).join('\n')}`,
      );
    }
    try {
      const response = await fetch(`${server.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.status === 200) return Date.now() - started;
    } catch {
      /* not listening yet */
    }
    await delay(60);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${server.baseUrl}/healthz.\n${server.logs.slice(-12).join('\n')}`,
  );
}

// ---------------------------------------------------------------------------
// Probe synthesis
// ---------------------------------------------------------------------------

function singularize(word: string): string {
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
}

function findModelForRoute(analysis: AnalysisResult, routePath: string) {
  const segments = routePath.split('/').filter((part) => part && !part.startsWith(':'));
  for (let i = segments.length - 1; i >= 0; i--) {
    const candidate = singularize(segments[i]);
    const direct = analysis.models.find((model) => model.name.toLowerCase() === candidate.toLowerCase());
    if (direct) return direct;
  }
  return null;
}

function sampleValueFor(fieldType: string, fieldName: string): unknown {
  switch (fieldType) {
    case 'Int':
    case 'BigInt':
      return 1;
    case 'Float':
    case 'Decimal':
      return 1.5;
    case 'Boolean':
      return false;
    case 'DateTime':
      return new Date().toISOString();
    case 'Json':
      return { sample: true };
    default:
      return `${fieldName}-sample`.slice(0, 40);
  }
}

/**
 * Derives a plausible request body straight from the extracted schema: required
 * scalar columns become fields, optional/defaulted ones are skipped.
 */
function synthesizeCreateBody(analysis: AnalysisResult, routePath: string): unknown {
  const model = findModelForRoute(analysis, routePath);
  if (!model) return {};
  const body: Record<string, unknown> = {};
  for (const field of model.fields) {
    if (field.isArray || field.isId || field.isUpdatedAt) continue;
    if (field.relation && field.relation.fields.length === 0) continue;
    if (field.relation && field.relation.fields.length > 0) {
      body[field.name] = 1;
      continue;
    }
    if (field.isOptional || field.defaultExpr || field.prismaDefault) continue;
    body[field.name] = sampleValueFor(field.prismaType, field.name);
  }
  return body;
}

function synthesizeUpdateBody(analysis: AnalysisResult, routePath: string): unknown {
  const model = findModelForRoute(analysis, routePath);
  if (!model) return { updated: true };
  for (const field of model.fields) {
    if (field.isId || field.isUpdatedAt || field.isArray || field.relation) continue;
    const value =
      field.prismaType === 'Boolean'
        ? true
        : sampleValueFor(field.prismaType, `${field.name}-updated`);
    return { [field.name]: value };
  }
  return { updated: true };
}

function buildProbePlan(analysis: AnalysisResult): ProbeSpec[] {
  const probes: ProbeSpec[] = [{ label: 'healthcheck', method: 'GET', path: '/healthz' }];
  const routes = [...analysis.routes].sort((a, b) => a.path.localeCompare(b.path));

  const readRoutes = routes.filter((route) => route.method === 'GET' && route.path !== '/healthz');
  const writes = routes.filter((route) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method));

  for (const route of readRoutes) {
    const resolved = route.params.length > 0 ? route.path.replace(/:[A-Za-z0-9_]+\*?/g, '1') : route.path;
    probes.push({
      label: `${route.method} ${route.path}`,
      method: 'GET',
      path: resolved,
    });
  }

  for (const route of writes.filter((entry) => entry.method === 'POST')) {
    probes.push({
      label: `${route.method} ${route.path}`,
      method: 'POST',
      path: route.path,
      body: synthesizeCreateBody(analysis, route.path),
    });
  }

  for (const route of writes.filter((entry) => entry.method === 'PUT' || entry.method === 'PATCH')) {
    probes.push({
      label: `${route.method} ${route.path}`,
      method: route.method,
      path: route.path.replace(/:[A-Za-z0-9_]+\*?/g, '1'),
      body: synthesizeUpdateBody(analysis, route.path),
    });
  }

  for (const route of writes.filter((entry) => entry.method === 'DELETE')) {
    probes.push({
      label: `${route.method} ${route.path}`,
      method: 'DELETE',
      path: route.path.replace(/:[A-Za-z0-9_]+\*?/g, '1'),
    });
  }

  return probes;
}

// ---------------------------------------------------------------------------
// Differential comparison
// ---------------------------------------------------------------------------

async function sendProbe(baseUrl: string, probe: ProbeSpec): Promise<ProbeOutcome> {
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}${probe.path}`, {
      method: probe.method,
      headers: probe.body === undefined ? {} : { 'content-type': 'application/json' },
      body: probe.body === undefined ? undefined : JSON.stringify(probe.body),
      signal: AbortSignal.timeout(5000),
    });
    const raw = await response.text();
    let parsed: unknown = null;
    const contentType = response.headers.get('content-type') ?? '';
    if (raw && contentType.includes('json')) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    } else {
      parsed = raw || null;
    }
    return {
      status: response.status,
      body: parsed,
      raw: raw.slice(0, 4000),
      error: null,
      ms: Date.now() - started,
    };
  } catch (error: any) {
    return {
      status: null,
      body: null,
      raw: null,
      error: error?.message ?? String(error),
      ms: Date.now() - started,
    };
  }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function shapePaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix || 'root'}:array<empty>`];
    return shapePaths(value[0], `${prefix}[]`);
  }
  if (value !== null && typeof value === 'object') {
    const out: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.test(key)) continue;
      const next = prefix ? `${prefix}.${key}` : key;
      out.push(...shapePaths(child, next));
    }
    if (out.length === 0) out.push(`${prefix || 'root'}:object`);
    return out;
  }
  return [`${prefix || 'root'}:${typeOf(value)}`];
}

function compareProbe(probe: ProbeSpec, original: ProbeOutcome, shrunk: ProbeOutcome): ProbeResult {
  const notes: string[] = [];
  const statusMatched = original.status === shrunk.status;

  if (original.error && !shrunk.error) notes.push(`source failed: ${original.error}`);
  if (shrunk.error && !original.error) notes.push(`shrunk failed: ${shrunk.error}`);
  if (!statusMatched) notes.push(`status ${original.status ?? 'ERR'} vs ${shrunk.status ?? 'ERR'}`);

  const originalShape = new Set(shapePaths(original.body));
  const shrunkShape = new Set(shapePaths(shrunk.body));
  const union = new Set([...originalShape, ...shrunkShape]);
  let overlap = 0;
  for (const entry of union) {
    if (originalShape.has(entry) && shrunkShape.has(entry)) overlap += 1;
  }
  let parity = union.size === 0 ? 100 : Math.round((overlap / union.size) * 100);

  const originalArray = Array.isArray(original.body) ? original.body.length : null;
  const shrunkArray = Array.isArray(shrunk.body) ? shrunk.body.length : null;
  if (originalArray !== null && shrunkArray !== null && originalArray !== shrunkArray) {
    notes.push(`row count ${originalArray} vs ${shrunkArray}`);
    parity = Math.min(parity, 50);
  }

  const missing = [...originalShape].filter((entry) => !shrunkShape.has(entry));
  const extra = [...shrunkShape].filter((entry) => !originalShape.has(entry));
  if (missing.length > 0) notes.push(`missing in shrunk: ${missing.slice(0, 6).join(', ')}`);
  if (extra.length > 0) notes.push(`extra in shrunk: ${extra.slice(0, 6).join(', ')}`);

  if (!statusMatched) parity = 0;

  return {
    label: probe.label,
    method: probe.method,
    path: probe.path,
    original,
    shrunk,
    parity,
    statusMatched,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function verify(options: VerifyOptions): Promise<VerificationReport> {
  const { analysis, outDir, shrunkEntry, log } = options;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const warnings: string[] = [];
  registerProcessCleanup();

  const originalDiskBytes = await directorySize(analysis.targetDir);
  const shrunkDiskBytes = await directorySize(outDir);

  const report: VerificationReport = {
    ran: false,
    probes: [],
    originalBootMs: null,
    shrunkBootMs: null,
    originalRssBytes: null,
    shrunkRssBytes: null,
    originalHeapUsedBytes: null,
    shrunkHeapUsedBytes: null,
    originalDiskBytes,
    shrunkDiskBytes,
    parityScore: 0,
    warnings,
  };

  let sourceApp: SourceApp;
  let databaseFile: string | null;
  try {
    const provisioned = await provisionSourceApp(analysis, log);
    sourceApp = provisioned.app;
    databaseFile = provisioned.databaseFile;
  } catch (error: any) {
    report.reason = `source app could not be provisioned: ${error?.message ?? error}`;
    return report;
  }

  // Probing replays write requests, so protect the target repo by snapshotting
  // its database and restoring it once the two servers are torn down.
  const snapshot = await snapshotDatabase(databaseFile);

  // Give the generated service its own snapshot of the source data so both
  // sides start from byte-identical state.
  if (databaseFile && (await pathExists(databaseFile))) {
    await fs.mkdir(path.dirname(options.databaseFile), { recursive: true });
    await fs.copyFile(databaseFile, options.databaseFile);
    // WAL sidecars carry data that has not been checkpointed into the main file.
    for (const suffix of ['-wal', '-shm']) {
      if (await pathExists(`${databaseFile}${suffix}`)) {
        await fs.copyFile(`${databaseFile}${suffix}`, `${options.databaseFile}${suffix}`);
      }
    }
    log(`      seeded shrunk database from ${path.relative(process.cwd(), databaseFile)}`);
  } else {
    warnings.push('no source SQLite database detected; the shrunk service starts empty');
  }

  const launcher = resolveTsxLauncher();
  // The generated service is ESM TypeScript, so newer Node runtimes can boot it
  // directly; only the (Prisma/Express) source app needs a transpiler.
  const shrunkLauncher = supportsNativeTypeScript()
    ? { command: process.execPath, prefixArgs: [] as string[] }
    : launcher;
  const [originalPort, shrunkPort] = await Promise.all([getFreePort(), getFreePort()]);

  const memoryProbe = await installMemoryProbe();
  if (!memoryProbe) {
    warnings.push('memory instrumentation needs Node >= 18.18; RSS and heap will read "n/a"');
  }

  let original: RunningServer | null = null;
  let shrunk: RunningServer | null = null;

  try {
    original = spawnServer(
      launcher.command,
      [...launcher.prefixArgs, sourceApp.entry],
      sourceApp.cwd,
      originalPort,
      probeEnv(memoryProbe),
      'source',
    );

    try {
      report.originalBootMs = await waitForHealth(original, timeoutMs);
    } catch (error: any) {
      report.reason = `the source app did not become healthy: ${error?.message ?? error}`;
      return report;
    }

    await ensureShrunkDependencies(outDir, log);

    shrunk = spawnServer(
      shrunkLauncher.command,
      [...shrunkLauncher.prefixArgs, shrunkEntry],
      outDir,
      shrunkPort,
      { DB_PATH: options.databaseFile, ...probeEnv(memoryProbe) },
      'shrunk',
    );

    try {
      report.shrunkBootMs = await waitForHealth(shrunk, timeoutMs);
    } catch (error: any) {
      report.reason = `the generated service did not become healthy: ${error?.message ?? error}`;
      return report;
    }

    for (const probe of buildProbePlan(analysis)) {
      const [originalOutcome, shrunkOutcome] = [
        await sendProbe(original.baseUrl, probe),
        await sendProbe(shrunk.baseUrl, probe),
      ];
      report.probes.push(compareProbe(probe, originalOutcome, shrunkOutcome));
    }

    // Both apps have been up since boot and have served the same probes, so
    // their memory is now comparable.
    const [originalMemory, shrunkMemory] = await Promise.all([
      sampleMemoryUsage(original),
      sampleMemoryUsage(shrunk),
    ]);
    report.originalRssBytes = originalMemory.rssBytes;
    report.shrunkRssBytes = shrunkMemory.rssBytes;
    report.originalHeapUsedBytes = originalMemory.heapUsedBytes;
    report.shrunkHeapUsedBytes = shrunkMemory.heapUsedBytes;

    report.ran = true;
    report.parityScore =
      report.probes.length === 0
        ? 0
        : Math.round(report.probes.reduce((sum, probe) => sum + probe.parity, 0) / report.probes.length);

    return report;
  } finally {
    const servers = [original, shrunk].filter((entry): entry is RunningServer => entry !== null);
    for (const server of servers) {
      try {
        server.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    await killAllChildren('SIGTERM');
    await restoreDatabase(snapshot);
    await removeMemoryProbe();
  }
}
