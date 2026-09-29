import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AnalysisResult, StaticAssetSource } from './analyzer';
import { StaticMount } from '../templates/hono-boilerplate';

export interface PackResult {
  publicDir: string | null;
  copiedFiles: number;
  copiedBytes: number;
  mounts: StaticMount[];
  hasPublic: boolean;
  sources: string[];
}

const COPY_ORDER: StaticAssetSource['kind'][] = ['public', 'out', 'build', 'dist'];

async function copyDirectory(source: string, destination: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const entries = await fs.readdir(source, { withFileTypes: true });
  await fs.mkdir(destination, { recursive: true });

  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      const nested = await copyDirectory(from, to);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
      files += 1;
      bytes += (await fs.stat(from)).size;
    }
  }

  return { files, bytes };
}

/**
 * Phase 3: copies every detected frontend directory into `<out>/public` and
 * returns the URL mounts Hono should register.
 */
export async function pack(analysis: AnalysisResult, outDir: string): Promise<PackResult> {
  const candidates = [...analysis.staticAssets].sort(
    (a, b) => COPY_ORDER.indexOf(a.kind) - COPY_ORDER.indexOf(b.kind),
  );

  if (candidates.length === 0) {
    return {
      publicDir: null,
      copiedFiles: 0,
      copiedBytes: 0,
      mounts: [],
      hasPublic: false,
      sources: [],
    };
  }

  const publicDir = path.join(outDir, 'public');
  await fs.mkdir(publicDir, { recursive: true });

  const mounts: StaticMount[] = [];
  const sources: string[] = [];
  let copiedFiles = 0;
  let copiedBytes = 0;

  for (const asset of candidates) {
    const result = await copyDirectory(asset.dir, publicDir);
    copiedFiles += result.files;
    copiedBytes += result.bytes;
    sources.push(asset.dir);

    if (asset.kind === 'public') {
      if (!mounts.some((entry) => entry.mount === asset.mount)) {
        mounts.push({ mount: asset.mount, folder: 'public' });
      }
    } else if (!mounts.some((entry) => entry.mount === '/')) {
      mounts.push({ mount: '/', folder: 'public' });
    }
  }

  return {
    publicDir,
    copiedFiles,
    copiedBytes,
    mounts,
    hasPublic: copiedFiles > 0,
    sources,
  };
}
