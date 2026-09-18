import pc from 'picocolors';

export interface BenchmarkRow {
  label: string;
  before: string;
  after: string;
  delta?: string;
}

const BOX_WIDTH = 56;

function center(text: string, width: number): string {
  const visible = text.replace(/\u001b\[[0-9;]*m/g, '');
  const pad = Math.max(0, width - visible.length);
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + text + ' '.repeat(pad - left);
}

/**
 * Terminal output helper. Everything user-facing goes through here so the
 * pipeline stages stay uniform and testable.
 */
export const logger = {
  banner(version: string): void {
    const inner = BOX_WIDTH - 2;
    const top = pc.gray('┌' + '─'.repeat(inner) + '┐');
    const bottom = pc.gray('└' + '─'.repeat(inner) + '┘');
    const side = pc.gray('│');
    console.log('');
    console.log(top);
    console.log(side + pc.bold(pc.cyan(center(`app-shrink v${version}`, inner))) + side);
    console.log(side + pc.gray(center('Clean-room micro-app compiler for bloated stacks', inner)) + side);
    console.log(bottom);
    console.log('');
  },

  step(index: number, total: number, message: string): void {
    console.log(`${pc.bold(pc.blue(`[${index}/${total}]`))} ${message}`);
  },

  sub(message: string): void {
    console.log(`      ${pc.gray('↳')} ${message}`);
  },

  ok(message: string): void {
    console.log(`      ${pc.green('✔')} ${message}`);
  },

  warn(message: string): void {
    console.log(`      ${pc.yellow('⚠')} ${pc.yellow(message)}`);
  },

  info(message: string): void {
    console.log(`      ${message}`);
  },

  blank(): void {
    console.log('');
  },

  error(message: string): void {
    console.error(`${pc.red('✖')} ${pc.red(message)}`);
  },

  success(message: string): void {
    console.log(`${pc.green('✔')} ${message}`);
  },

  results(rows: BenchmarkRow[]): void {
    const line = '='.repeat(BOX_WIDTH);
    const labelWidth = Math.max(...rows.map((r) => r.label.length), 20);
    console.log('');
    console.log(pc.bold(pc.cyan(line)));
    console.log(pc.bold(pc.cyan(center('RESULTS', BOX_WIDTH))));
    console.log(pc.bold(pc.cyan(line)));
    for (const row of rows) {
      const label = pc.gray(row.label.padEnd(labelWidth));
      const after = row.delta ? `${row.after} ${pc.green(row.delta)}` : row.after;
      console.log(`${label}  ${pc.bold(after)}`);
    }
    console.log(pc.bold(pc.cyan(line)));
  },

  /**
   * Renders a simple aligned two/three column comparison table used by the
   * verifier's parity report.
   */
  table(headers: string[], rows: string[][]): void {
    const widths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] ?? '').replace(/\u001b\[[0-9;]*m/g, '').length)),
    );
    const render = (cells: string[], colour: (s: string) => string) =>
      cells.map((c, i) => colour(c.padEnd(widths[i]))).join('  ');
    console.log(pc.gray(render(headers, (s) => pc.bold(s))));
    console.log(pc.gray('─'.repeat(widths.reduce((a, b) => a + b + 2, 0))));
    for (const row of rows) console.log(render(row, (s) => s));
  },
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value >= 10 || exp === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exp]}`;
}

export function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Prefers bytes/KB for sub-megabyte footprints so small outputs stay readable. */
export function formatFootprint(bytes: number): string {
  return bytes < 1024 * 1024 ? formatBytes(bytes) : formatMb(bytes);
}

export function percentDelta(before: number, after: number): string {
  if (before <= 0) return '';
  const pct = ((after - before) / before) * 100;
  const sign = pct > 0 ? '+' : '';
  return `(${sign}${pct.toFixed(0)}%)`;
}
