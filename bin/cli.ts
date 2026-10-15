#!/usr/bin/env node
import path from 'node:path';
import pc from 'picocolors';
import { Command } from 'commander';
import { VERSION, BuildResult, buildShrunkApp, inspectTarget } from '../src/index';
import { logger, formatBytes, formatFootprint, formatMb, percentDelta, BenchmarkRow } from '../src/utils/logger';

const program = new Command();

program
  .name('app-shrink')
  .description('Clean-room micro-app compiler for bloated full-stack Node.js projects')
  .version(VERSION);

program
  .command('inspect')
  .description('Inspect a target repository and print detected routes and database models')
  .argument('<target>', 'path to the source repository')
  .action(async (target: string) => {
    try {
      logger.banner(VERSION);
      logger.step(1, 1, `🔍 Inspecting: ${pc.cyan(target)}`);
      const analysis = await inspectTarget(target);

      logger.blank();
      logger.info(
        `${pc.bold(String(analysis.routes.length))} API endpoint(s) across ${pc.bold(
          String(analysis.routeFiles.length),
        )} file(s)`,
      );
      if (analysis.routes.length > 0) {
        logger.table(
          ['METHOD', 'PATH'],
          analysis.routes
            .slice()
            .sort((a, b) => `${a.path}${a.method}`.localeCompare(`${b.path}${b.method}`))
            .map((route) => [route.method, route.path]),
        );
      }

      logger.blank();
      if (analysis.models.length > 0) {
        logger.info(
          `Database models (${pc.bold(String(analysis.models.length))}): ${analysis.models
            .map((model) => `${model.name} (${model.fields.length} fields)`)
            .join(', ')}`,
        );
      } else {
        logger.warn('No supported ORM schema (Prisma/Drizzle) detected.');
      }

      if (analysis.staticAssets.length > 0) {
        logger.info(
          `Static frontend: ${analysis.staticAssets
            .map((asset) => `${path.relative(analysis.targetDir, asset.dir) || '.'} -> ${asset.mount}`)
            .join(', ')}`,
        );
      }

      if (analysis.sourceDatabase) {
        logger.info(`Source database: ${path.relative(process.cwd(), analysis.sourceDatabase)}`);
      }
      logger.blank();
    } catch (error: any) {
      logger.error(error?.message ?? String(error));
      process.exitCode = 1;
    }
  });

program
  .command('build')
  .description('Run the full shrink pipeline and emit a standalone micro-service')
  .argument('<target>', 'path to the source repository')
  .option('--out <dir>', 'output directory', './dist-shrunk')
  .option('--db <driver>', 'database driver: sqlite | memory', 'sqlite')
  .option('--port <number>', 'default port for the generated service', (value) => Number(value), 3000)
  .option('--verify', 'run the differential runtime verifier (phase 4)', false)
  .option('--api-key <key>', 'model API key (else OPENAI_API_KEY / ANTHROPIC_API_KEY)')
  .option('--base-url <url>', 'override the model provider base URL')
  .option('--model <name>', 'override the model name')
  .option('--no-llm', 'never call a model; use AST transpilation and job files only')
  .option('--emit-jobs <dir>', 'write imported handlers as jobs for your IDE agent to complete')
  .option('--use-jobs <dir>', 'read handler jobs your IDE agent completed after --emit-jobs')
  .action(async (
    target: string,
    options: {
      out: string;
      db: string;
      port: number;
      verify: boolean;
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      llm: boolean;
      emitJobs?: string;
      useJobs?: string;
    },
  ) => {
    if (options.db !== 'sqlite' && options.db !== 'memory') {
      logger.error(`Unsupported --db value "${options.db}". Use "sqlite" or "memory".`);
      process.exitCode = 1;
      return;
    }

    try {
      logger.banner(VERSION);

      logger.step(1, 4, `🔍 Inspecting: ${pc.cyan(target)}...`);
      const startedAt = Date.now();

      const result: BuildResult = await buildShrunkApp({
        target,
        out: options.out,
        port: options.port,
        db: options.db,
        verify: options.verify,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        model: options.model,
        noLlm: options.llm === false,
        emitJobs: options.emitJobs,
        useJobs: options.useJobs,
        log: (message) => logger.info(message.trimStart()),
      });

      const { analysis, transpile: transpiled, pack: packed } = result;

      logger.sub(
        `Detected ${pc.bold(String(analysis.routes.length))} API endpoint(s) across ${analysis.routeFiles.length} file(s)`,
      );
      if (analysis.models.length > 0) {
        logger.sub(
          `Found schema (${pc.bold(String(analysis.models.length))} models: ${analysis.models
            .map((model) => model.name)
            .join(', ')})`,
        );
      } else {
        logger.sub(pc.yellow('No ORM schema detected - emitting an empty SQLite database.'));
      }

      logger.step(2, 4, `💾 Compiling Schema -> SQLite DDL... ${pc.green('Done.')}`);
      logger.sub(
        `${analysis.models.length} table(s), ${analysis.models.reduce((sum, model) => sum + model.fields.length, 0)} column(s) written to schema.sql`,
      );

      logger.step(3, 4, `⚡ Transpiling handlers -> Hono micro-server... ${pc.green('Done.')}`);
      logger.sub(
        `${transpiled.transpiledRoutes} handler(s) transpiled${transpiled.stubbedRoutes > 0 ? `, ${pc.yellow(`${transpiled.stubbedRoutes} stubbed`)}` : ''}`,
      );
      if (transpiled.llmRoutes > 0) {
        logger.sub(`${transpiled.llmRoutes} imported handler(s) rewritten by a model or your IDE agent`);
      }
      if (transpiled.jobFiles.length > 0) {
        logger.sub(
          `${transpiled.jobFiles.length} job file(s) written to ${pc.cyan(
            path.relative(process.cwd(), path.dirname(transpiled.jobFiles[0])) || '.',
          )} for your IDE agent to complete`,
        );
      }
      if (packed.hasPublic) {
        logger.sub(
          `Packed ${packed.copiedFiles} static asset(s) (${formatBytes(packed.copiedBytes)}) -> public/`,
        );
      }

      let verification = result.verification;
      if (options.verify) {
        logger.step(4, 4, '🧪 Running differential runtime verifier...');
        if (!verification || !verification.ran) {
          logger.warn(verification?.reason ?? 'verification did not run');
        } else {
          logger.sub(
            `Boot time: ${pc.green(`${verification.shrunkBootMs ?? 0}ms`)} (vs ${verification.originalBootMs ?? 0}ms original)`,
          );
          for (const probe of verification.probes) {
            const status = probe.shrunk.status ?? 'ERR';
            const ok = probe.statusMatched && probe.parity >= 90;
            const mark = ok ? pc.green(`${status}`) : pc.yellow(`${status}`);
            const parityText = `${probe.parity}%`;
            logger.sub(
              `${probe.method} ${probe.path}: ${mark} (Parity ${ok ? pc.green(parityText) : pc.yellow(parityText)})`,
            );
          }
          for (const warning of verification.warnings) logger.warn(warning);
        }
      } else {
        logger.step(4, 4, `🧪 Verifier skipped (pass ${pc.cyan('--verify')} to enable)`);
      }

      printResults(result, Date.now() - startedAt);
    } catch (error: any) {
      logger.error(error?.message ?? String(error));
      process.exitCode = 1;
    }
  });

/**
 * Renders a shrunk-vs-original memory comparison.
 *
 * Both metrics are reported on purpose. RSS is what the OS charges the process
 * and is dominated by Node's own runtime baseline (shared pages included),
 * while heap is what the application actually allocated. Showing only the
 * first understates the win; showing only the second overstates it.
 */
function memoryRow(
  label: string,
  after: number | null,
  before: number | null,
  unit: string,
): BenchmarkRow {
  return {
    label,
    before: '',
    after:
      after != null
        ? `~${formatMb(after)} ${unit}${before != null ? ` (vs ${formatMb(before)} original)` : ''}`
        : 'n/a',
    delta: after != null && before != null ? percentDelta(before, after) : undefined,
  };
}

function printResults(result: BuildResult, elapsedMs: number): void {
  const { analysis, outDir, verification } = result;
  const originalBytes = verification?.originalDiskBytes ?? 0;
  const shrunkBytes = verification?.shrunkDiskBytes ?? 0;

  const shrinkDelta =
    originalBytes > 0 && shrunkBytes > 0 ? percentDelta(originalBytes, shrunkBytes) : undefined;

  const rows = [
    {
      label: 'Original Footprint:',
      before: '',
      after: originalBytes > 0 ? `~${formatMb(originalBytes)}` : 'n/a',
    },
    {
      label: 'Shrunk App Footprint:',
      before: '',
      after: shrunkBytes > 0 ? `~${formatFootprint(shrunkBytes)}` : 'n/a',
      delta: shrinkDelta,
    },
    memoryRow(
      'Idle Memory (RSS): *',
      verification?.shrunkRssBytes ?? null,
      verification?.originalRssBytes ?? null,
      'RAM',
    ),
    memoryRow(
      'Idle Heap (V8): *',
      verification?.shrunkHeapUsedBytes ?? null,
      verification?.originalHeapUsedBytes ?? null,
      'heap',
    ),
    {
      label: 'Cold Start:',
      before: '',
      after:
        verification?.shrunkBootMs != null
          ? `${verification.shrunkBootMs}ms${verification.originalBootMs != null ? ` (vs ${verification.originalBootMs}ms original)` : ''}`
          : 'n/a',
    },
    {
      label: 'Response Parity:',
      before: '',
      after: verification?.ran ? `${verification.parityScore}%` : 'not verified',
    },
    {
      label: 'Output Generated:',
      before: '',
      after: `${path.relative(process.cwd(), outDir) || '.'}/server.ts`,
    },
    {
      label: 'Build Time:',
      before: '',
      after: `${(elapsedMs / 1000).toFixed(1)}s`,
    },
  ];

  logger.results(rows);
  logger.info('* RSS is what the OS charges the process and is dominated by the Node runtime,');
  logger.info('  ~170 MB before any app code loads; macOS reclaims those pages unpredictably.');
  logger.info('  V8 heap is what the app itself allocated. See "Reading the results" in README.md.');

  if (analysis.routes.length === 0) {
    logger.warn('No routes were extracted - the generated service only exposes /healthz.');
  }
}

program.parseAsync(process.argv).catch((error) => {
  logger.error(error?.message ?? String(error));
  process.exitCode = 1;
});
