// File selection: plain wildcards and numeric ranges.
//
// Robocopy has no numeric-range concept (finding 13). It accepts globs and
// explicit names, but cannot express "file000234.ext through file001234.ext".
//
// The tempting implementation - decompose the range into globs and hand them to
// robocopy - is WRONG, and provably so. Covering 000234..001234 with globs also
// matches 000230-000233 and 001235-001239: nine files outside the requested
// range (finding 14). Silently copying files the user did not ask for is the
// worst failure this tool could have.
//
// So globs are used only to enumerate candidates cheaply via /L, the exact
// bounds are enforced here in JS, and only verified names are copied
// (finding 15: 110 candidates -> 101 kept, range exactly 234..1234, zero
// overshoot).

// Windows CreateProcess caps the command line at 32,767 characters. Passing
// 1001 short names measured ~15,014 chars - fine - but the SAME range with
// 40-char names would be ~40,000 and fail outright (finding 16). Batching is
// mandatory. 8000 is a deliberately conservative budget that also leaves room
// for the flags and both directory paths.
export const ARG_BUDGET = 8000;

/**
 * Split a filename into prefix + digit-run + suffix.
 *
 * The digit run is taken as the LAST one in the name, so paths like
 * "scan2024/file000234.ext" key off the file number rather than the year.
 * Padding width is preserved verbatim: file1.ext and file000001.ext are
 * different files and must never be conflated.
 */
export function parseNumbered(name) {
  const m = /^(.*?)(\d+)(\D*)$/.exec(String(name ?? '').trim());
  if (!m) return null;
  return {
    prefix: m[1],
    digits: m[2],
    suffix: m[3],
    width: m[2].length,
    value: Number(m[2]),
  };
}

/**
 * Validate a from/to pair and return the range descriptor.
 * Throws with a user-facing message - the UI shows these inline.
 */
export function parseRange(fromName, toName) {
  const a = parseNumbered(fromName);
  const b = parseNumbered(toName);

  if (!a) throw new Error(`"${fromName}" has no number in it to count from.`);
  if (!b) throw new Error(`"${toName}" has no number in it to count from.`);

  if (a.prefix !== b.prefix) {
    throw new Error(`Names must share a prefix - got "${a.prefix}" and "${b.prefix}".`);
  }
  if (a.suffix !== b.suffix) {
    throw new Error(`Names must share an extension - got "${a.suffix}" and "${b.suffix}".`);
  }
  if (a.width !== b.width) {
    throw new Error(
      `Zero-padding differs (${a.width} vs ${b.width} digits). ` +
        `"${fromName}" and "${toName}" would refer to differently named files.`,
    );
  }
  if (b.value < a.value) {
    throw new Error(`Range runs backwards: ${a.value} is greater than ${b.value}.`);
  }

  return {
    prefix: a.prefix,
    suffix: a.suffix,
    width: a.width,
    from: a.value,
    to: b.value,
    count: b.value - a.value + 1,
  };
}

export function formatName(range, n) {
  return `${range.prefix}${String(n).padStart(range.width, '0')}${range.suffix}`;
}

/**
 * Build a small set of globs that is guaranteed to COVER the range.
 *
 * Coverage is what matters here, not precision - overshoot is expected and is
 * removed later by filterExact(). Collapsing each shared numeric prefix into
 * one `?`-padded pattern keeps the /L scan cheap: `file0002*.ext` matched 66
 * files as a single short argument (finding 17).
 */
export function globCover(range) {
  const { prefix, suffix, width, from, to } = range;
  const globs = new Set();
  const fromS = String(from).padStart(width, '0');
  const toS = String(to).padStart(width, '0');

  // Walk the shared leading digits; for the rest emit one pattern per distinct
  // prefix at the first differing position.
  let shared = 0;
  while (shared < width && fromS[shared] === toS[shared]) shared++;

  if (shared === width) {
    globs.add(`${prefix}${fromS}${suffix}`);
  } else {
    const head = fromS.slice(0, shared);
    const lo = Number(fromS[shared]);
    const hi = Number(toS[shared]);
    const restLen = width - shared - 1;
    for (let d = lo; d <= hi; d++) {
      globs.add(`${prefix}${head}${d}${'?'.repeat(restLen)}${suffix}`);
    }
  }
  return [...globs];
}

/**
 * Keep only the candidates whose number is genuinely inside [from, to].
 * This is the step that eliminates the boundary overshoot from finding 14.
 */
export function filterExact(candidates, range) {
  const kept = [];
  const excluded = [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Anchored to the basename so a directory component can't satisfy the match.
  const re = new RegExp(`^${esc(range.prefix)}(\\d{${range.width}})${esc(range.suffix)}$`, 'i');

  for (const c of candidates) {
    const name = String(c.path ?? c).split(/[\\/]/).pop();
    const m = re.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    const entry = typeof c === 'object' ? { ...c, name, n } : { path: c, name, n };
    if (n >= range.from && n <= range.to) kept.push(entry);
    else excluded.push(entry);
  }

  kept.sort((x, y) => x.n - y.n);
  excluded.sort((x, y) => x.n - y.n);
  return { kept, excluded };
}

/**
 * Chunk names so no single robocopy invocation approaches the command-line
 * limit. Batches accumulate into one overall progress bar in the UI.
 */
export function batchNames(names, budget = ARG_BUDGET) {
  const batches = [];
  let cur = [];
  let len = 0;
  for (const name of names) {
    const cost = name.length + 3; // separator + quoting headroom
    if (cur.length && len + cost > budget) {
      batches.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(name);
    len += cost;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * Resolve a selection into concrete robocopy file arguments.
 *
 * mode 'all'      -> ['*.*']
 * mode 'wildcard' -> patterns passed straight through (robocopy handles these)
 * mode 'range'    -> glob-cover, /L enumerate, exact filter, then batch
 *
 * `scanFn` is injected so this module stays unit-testable without spawning.
 */
export async function resolveSelection(job, scanFn) {
  const mode = job.selection?.mode ?? 'all';

  if (mode === 'all') {
    return { mode, batches: [['*.*']], names: null, preview: null };
  }

  if (mode === 'wildcard') {
    const patterns = (job.selection.patterns ?? [])
      .map((p) => String(p).trim())
      .filter(Boolean);
    if (!patterns.length) throw new Error('Enter at least one wildcard pattern, e.g. *.jpg');
    return { mode, batches: batchNames(patterns), names: null, preview: null };
  }

  if (mode === 'range') {
    const range = parseRange(job.selection.from, job.selection.to);
    const globs = globCover(range);

    // Enumerate with /L only. Safe on OneDrive: reports real sizes without
    // hydrating placeholders (finding 8).
    const scanned = await scanFn(globs);
    const { kept, excluded } = filterExact(scanned.files ?? [], range);

    const bytes = kept.reduce((a, f) => a + (f.bytes ?? 0), 0);
    const found = new Set(kept.map((f) => f.n));
    const missing = [];
    for (let n = range.from; n <= range.to && missing.length < 100; n++) {
      if (!found.has(n)) missing.push(formatName(range, n));
    }

    return {
      mode,
      range,
      globs,
      names: kept.map((f) => f.name),
      batches: batchNames(kept.map((f) => f.name)),
      preview: {
        matched: kept.length,
        requested: range.count,
        bytes,
        first: kept[0]?.name ?? null,
        last: kept[kept.length - 1]?.name ?? null,
        // Surfaced in the UI so off-by-one range errors are visible BEFORE any
        // data moves - these are exactly the files a glob-only build would have
        // wrongly copied.
        nearMisses: excluded.slice(0, 20).map((f) => f.name),
        missing,
      },
    };
  }

  throw new Error(`Unknown selection mode: ${mode}`);
}
