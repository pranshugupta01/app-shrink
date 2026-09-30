#!/usr/bin/env node
import path from 'node:path';
import pc from 'picocolors';
import { Command } from 'commander';
import { VERSION, BuildResult, buildShrunkApp, inspectTarget } from '../src/index';
import { logger, formatBytes, formatFootprint, formatMb, percentDelta, BenchmarkRow } from '../src/utils/logger';

const program = new Command();
program.name('app-shrink').description('Clean-room micro-app compiler for bloated full-stack Node.js projects').version(VERSION);

program.command('inspect').description('Inspect a target repository').argument('<target>').action(async (target: string) => {
  try {
    logger.banner(VERSION);
    logger.step(1, 1, `🔍 Inspecting: ${pc.cyan(target)}`);
    const analysis = await inspectTarget(target);
    logger.blank();
    logger.info(`${pc.bold(String(analysis.routes.length))} API endpoint(s) across ${analysis.routeFiles.length} file(s)`);
    if (analysis.routes.length > 0) {
      logger.table(['METHOD', 'PATH'], analysis.routes.slice().sort((a, b) => `${a.path}${a.method}`.localeCompare(`${b.path}${b.method}`)).map((route) => [route.method, route.path]));
    }
    logger.blank();
    if (analysis.models.length > 0) logger.info(`Database models (${analysis.models.length}): ${analysis.models.map((m) => `${m.name} (${m.fields.length} fields)`).join(', ')}`);
    else logger.warn('No supported ORM schema (Prisma/Drizzle) detected.');
    logger.blank();
  } catch (error: any) { logger.error(error?.message ?? String(error)); process.exitCode = 1; }
});

program.command('build').description('Run the full shrink pipeline').argument('<target>')
  .option('--out <dir>', 'output directory', './dist-shrunk')
  .option('--db <driver>', 'database driver: sqlite | memory', 'sqlite')
  .option('--port <number>', 'default port for the generated service', (v) => Number(v), 3000)
  .option('--verify', 'run the differential runtime verifier', false)
  .action(async (target, options) => {
    try {
      logger.banner(VERSION);
      logger.step(1, 4, `🔍 Inspecting: ${pc.cyan(target)}...`);
      const startedAt = Date.now();
      const result: BuildResult = await buildShrunkApp({ target, out: options.out, port: options.port, db: options.db, verify: options.verify, log: (m) => logger.info(m.trimStart()) });
      const { analysis, transpile: transpiled, pack: packed } = result;
      logger.sub(`Detected ${analysis.routes.length} API endpoint(s) across ${analysis.routeFiles.length} file(s)`);
      if (analysis.models.length > 0) logger.sub(`Found schema (${analysis.models.length} models: ${analysis.models.map((m) => m.name).join(', ')})`);
      logger.step(2, 4, `💾 Compiling Schema -> SQLite DDL... ${pc.green('Done.')}`);
      logger.sub(`${analysis.models.length} table(s), ${analysis.models.reduce((s, m) => s + m.fields.length, 0)} column(s) written to schema.sql`);
      logger.step(3, 4, `⚡ Transpiling handlers -> Hono micro-server... ${pc.green('Done.')}`);
      logger.sub(`${transpiled.transpiledRoutes} handler(s) transpiled${transpiled.stubbedRoutes > 0 ? `, ${transpiled.stubbedRoutes} stubbed` : ''}`);
      if (packed.hasPublic) logger.sub(`Packed ${packed.copiedFiles} static asset(s) (${formatBytes(packed.copiedBytes)}) -> public/`);
      let verification = result.verification;
      if (options.verify) {
        logger.step(4, 4, '🧪 Running differential runtime verifier...');
        if (!verification || !verification.ran) logger.warn(verification?.reason ?? 'verification did not run');
        else { logger.sub(`Boot time: ${verification.shrunkBootMs}ms (vs ${verification.originalBootMs}ms original)`); for (const probe of verification.probes) logger.sub(`${probe.method} ${probe.path}: ${probe.shrunk.status} (Parity ${probe.parity}%)`); }
      } else logger.step(4, 4, `🧪 Verifier skipped (pass --verify)`);
      printResults(result, Date.now() - startedAt);
    } catch (error: any) { logger.error(error?.message ?? String(error)); process.exitCode = 1; }
  });

function memoryRow(label: string, after: number | null, before: number | null, unit: string): BenchmarkRow {
  return { label, before: '', after: after != null ? `~${formatMb(after)} ${unit}${before != null ? ` (vs ${formatMb(before)} original)` : ''}` : 'n/a', delta: after != null && before != null ? percentDelta(before, after) : undefined };
}

function printResults(result: BuildResult, elapsedMs: number): void {
  const { outDir, verification } = result;
  const rows = [
    { label: 'Shrunk App Footprint:', after: verification ? `~${formatFootprint(verification.shrunkDiskBytes)}` : 'n/a' },
    memoryRow('Idle Memory (RSS): *', verification?.shrunkRssBytes ?? null, verification?.originalRssBytes ?? null, 'RAM'),
    memoryRow('Idle Heap (V8): *', verification?.shrunkHeapUsedBytes ?? null, verification?.originalHeapUsedBytes ?? null, 'heap'),
    { label: 'Cold Start:', after: verification?.shrunkBootMs != null ? `${verification.shrunkBootMs}ms${verification.originalBootMs != null ? ` (vs ${verification.originalBootMs}ms)` : ''}` : 'n/a' },
    { label: 'Response Parity:', after: verification?.ran ? `${verification.parityScore}%` : 'not verified' },
    { label: 'Output Generated:', after: `${path.relative(process.cwd(), outDir) || '.'}/server.ts` },
  ];
  logger.results(rows);
}

program.parseAsync(process.argv).catch((error) => { logger.error(error?.message ?? String(error)); process.exitCode = 1; });
