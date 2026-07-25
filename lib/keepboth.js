// "Keep both" conflict resolution.
//
// Robocopy has no such mode - it either overwrites or skips. This implements it
// with a second pass, using two verified behaviours: /L tags pre-existing files
// by class (Older/Newer/Changed, finding 3), and robocopy will copy a single
// named file (finding 5).
//
// The main pass runs with /XC /XN /XO so existing files are untouched; then each
// conflicting file is copied individually into a temp dir and renamed into place
// as "name (1).ext".

import fs from 'node:fs/promises';
import path from 'node:path';
import { runRobocopy, buildArgs, isFailure } from './robocopy.js';

/** Find a free "name (n).ext" next to an existing file. */
export async function uniqueName(destDir, fileName) {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    try {
      await fs.access(path.join(destDir, candidate));
    } catch {
      return candidate; // access() threw => the name is free
    }
  }
  return `${stem} (${Date.now()})${ext}`;
}

/**
 * Copy each conflicting file alongside the original.
 *
 * Per-file and single-threaded by necessity, so this is slower than a plain
 * copy on large conflict sets - the UI says so up front.
 */
export async function keepBothPass(conflicts, job, { onEvent, shouldStop, tracker } = {}) {
  const results = { copied: [], failed: [] };
  if (!conflicts.length) return results;

  const tmpRoot = path.join(job.dest, `.robocopy-gui-tmp-${Date.now()}`);
  await fs.mkdir(tmpRoot, { recursive: true });

  try {
    for (const conflict of conflicts) {
      if (shouldStop?.()) break;

      const srcPath = conflict.path;
      const srcDir = path.dirname(srcPath);
      const name = path.basename(srcPath);

      const rel = path.relative(job.source, srcDir);
      const destDir = rel && !rel.startsWith('..') ? path.join(job.dest, rel) : job.dest;
      await fs.mkdir(destDir, { recursive: true });

      const stage = path.join(tmpRoot, rel || '.');
      await fs.mkdir(stage, { recursive: true });

      // Copy just this one file into the staging dir.
      const args = buildArgs(
        {
          ...job,
          source: srcDir,
          dest: stage,
          conflict: 'overwrite',
          mirror: false,
          subdirs: false,
          emptyDirs: false,
          // Level 3 = plain /MT:4 with no /IPG. Levels 1-2 throttle with /IPG,
          // which robocopy refuses to combine with /MT.
          resourceLevel: 3,
        },
        { files: [name] },
      );

      let sawError = false;
      const code = await runRobocopy(args, {
        onEvent: (ev) => {
          if (ev.type === 'error') {
            sawError = true;
            tracker?.observe(ev);
          }
          onEvent?.(ev);
        },
      }).catch(() => 16);

      if (isFailure(code) || sawError) {
        results.failed.push(srcPath);
        continue;
      }

      try {
        const target = await uniqueName(destDir, name);
        await fs.rename(path.join(stage, name), path.join(destDir, target));
        results.copied.push({ source: srcPath, saved: path.join(destDir, target) });
        onEvent?.({ type: 'keepboth', source: srcPath, saved: target });
      } catch (err) {
        results.failed.push(srcPath);
        onEvent?.({ type: 'raw', text: `keep-both rename failed for ${name}: ${err.message}` });
      }
    }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  return results;
}
