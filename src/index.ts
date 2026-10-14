import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AnalysisResult, RouteDef, analyze } from './core/analyzer';
import { DEFAULT_DB_FILE, TranspileResult, transpile } from './core/transpiler';
import { LlmRoute, detectLlmRoute } from './core/llm-transpiler';
import { PackResult, pack } from './core/packer';
import { VerificationReport, verify } from './core/verifier';

export const VERSION = '0.1.0';

export type { AnalysisResult, RouteDef, StaticAssetSource } from './core/analyzer';
export type { TranspileResult } from './core/transpiler';
export type { PackResult } from './core/packer';
export type { VerificationReport, ProbeResult } from './core/verifier';
export type { ModelDef, FieldDef } from './utils/schema-converter';
export type { LlmRoute, LlmProviderKind } from './core/llm-transpiler';

export interface BuildOptions {
  /** Path to the bloated source repository. */
  target: string;
  /** Output directory (default `./dist-shrunk`). */
  out: string;
  /** Default port baked into the generated service. */
  port: number;
  /** `sqlite` writes a file, `memory` keeps everything in RAM. */
  db: 'sqlite' | 'memory';
  /** Run phase 4 differential verification. */
  verify: boolean;
  /** Explicit model key; beats every environment variable. */
  apiKey?: string;
  /** Provider base URL override. */
  baseUrl?: string;
  /** Model name override. */
  model?: string;
  /** Never call a model; rely on AST transpilation and job files. */
  noLlm?: boolean;
  /** Write unfilled handler jobs here for a host agent to complete. */
  emitJobs?: string;
  /** Read the host agent's finished handler jobs from here. */
  useJobs?: string;
  log: (message: string) => void;
}

export interface BuildResult {
  analysis: AnalysisResult;
  pack: PackResult;
  transpile: TranspileResult;
  verification: VerificationReport | null;
  outDir: string;
  databaseFile: string;
  /** The provider that was selected, or null when none was reachable. */
  llmRoute: LlmRoute | null;
}

/** True when the route's handler is written inline rather than imported. */
function isInlineHandler(route: RouteDef): boolean {
  const handler = route.handler;
  return (
    !!handler &&
    (handler.type === 'ArrowFunctionExpression' ||
      handler.type === 'FunctionExpression' ||
      handler.type === 'FunctionDeclaration')
  );
}

export async function inspectTarget(target: string): Promise<AnalysisResult> {
  return analyze(target);
}

/**
 * Refuses to wipe a directory that is clearly not a previous build output.
 */
function assertSafeOutputDir(outDir: string, target: string): void {
  const resolvedOut = path.resolve(outDir);
  const resolvedTarget = path.resolve(target);
  const cwd = process.cwd();
  const root = path.parse(resolvedOut).root;

  if (resolvedOut === root || resolvedOut === cwd) {
    throw new Error(`Refusing to clean unsafe output directory: ${resolvedOut}`);
  }
  if (resolvedOut === resolvedTarget || resolvedTarget.startsWith(resolvedOut + path.sep)) {
    throw new Error(`Output directory must not contain the source project: ${resolvedTarget}`);
  }
}

/**
 * Runs phases 1-4 and returns everything the CLI needs to print a report.
 */
export async function buildShrunkApp(options: BuildOptions): Promise<BuildResult> {
  const log = options.log;
  const outDir = path.resolve(options.out);
  assertSafeOutputDir(outDir, options.target);

  // ---- Phase 1: analysis ---------------------------------------------------
  const analysis = await analyze(options.target);

  // ---- Phase 2: schema + handlers -----------------------------------------
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  // ---- Phase 3: static assets (packed before transpiling so mounts are known)
  const packed = await pack(analysis, outDir);

  // Imported controllers need a model (or a host agent) to be inlined; a
  // project whose handlers are all inline never pays the detection cost.
  const emitJobs = options.emitJobs ? path.resolve(options.emitJobs) : undefined;
  const useJobs = options.useJobs ? path.resolve(options.useJobs) : undefined;

  let llmRoute: LlmRoute | null = null;
  if (analysis.routes.some((route) => !isInlineHandler(route))) {
    llmRoute = await detectLlmRoute({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      model: options.model,
      disabled: options.noLlm,
    });

    if (llmRoute) {
      log(`Using ${llmRoute.label} to rewrite imported handlers`);
    } else if (useJobs) {
      log('No model provider found - using handlers from --use-jobs');
    } else if (emitJobs) {
      log('No model provider found - falling back to AST transpilation and job files');
    } else {
      log(
        'No model provider found and no job directory set - imported handlers ' +
          'fall back to AST transpilation (pass --emit-jobs to hand them to your IDE agent)',
      );
    }
  }

  const transpiled = await transpile({
    analysis,
    outDir,
    port: options.port,
    version: VERSION,
    staticMounts: packed.mounts,
    hasPublic: packed.hasPublic,
    imported: {
      rootDir: analysis.targetDir,
      llmRoute,
      emitJobsDir: emitJobs,
      useJobsDir: useJobs,
    },
  });

  // Declare the runtime dependency set so the folder is portable on its own.
  await fs.writeFile(
    path.join(outDir, '.gitignore'),
    ['node_modules/', '*.db', '*.db-wal', '*.db-shm'].join('\n') + '\n',
    'utf8',
  );

  const databaseFile =
    options.db === 'memory' ? ':memory:' : path.join(outDir, DEFAULT_DB_FILE);

  // ---- Phase 4: differential verification ---------------------------------
  let verification: VerificationReport | null = null;
  if (options.verify) {
    verification = await verify({
      analysis,
      outDir,
      shrunkEntry: transpiled.serverFile,
      databaseFile,
      log,
    });
  }

  return {
    analysis,
    pack: packed,
    transpile: transpiled,
    verification,
    outDir,
    databaseFile,
    llmRoute,
  };
}
