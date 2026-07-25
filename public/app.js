/* Syncopier - browser client. Talks to the local server over WebSocket;
   all copying is done by robocopy.exe on the server side. */

const $ = (id) => document.getElementById(id);
const el = {
  source: $('source'), dest: $('dest'),
  sourceMsg: $('sourceMsg'), destMsg: $('destMsg'),
  patterns: $('patterns'), rangeFrom: $('rangeFrom'), rangeTo: $('rangeTo'), rangeMsg: $('rangeMsg'),
  resource: $('resource'), resourceHint: $('resourceHint'),
  conflict: $('conflict'), conflictHint: $('conflictHint'), retryRounds: $('retryRounds'),
  subdirs: $('subdirs'), restartable: $('restartable'), mirror: $('mirror'), dehydrate: $('dehydrate'),
  cmdPreview: $('cmdPreview'), statusChip: $('statusChip'),
  startBtn: $('startBtn'), scanBtn: $('scanBtn'), pauseBtn: $('pauseBtn'), cancelBtn: $('cancelBtn'),
  progressCard: $('progressCard'), overallFill: $('overallFill'), overallPct: $('overallPct'),
  fileBarWrap: $('fileBarWrap'), fileFill: $('fileFill'), filePct: $('filePct'), currentFile: $('currentFile'),
  stCopied: $('stCopied'), stFiles: $('stFiles'), stSpeed: $('stSpeed'),
  stEta: $('stEta'), stElapsed: $('stElapsed'), stDeferred: $('stDeferred'),
  odCard: $('odCard'), odBody: $('odBody'), odCopyAll: $('odCopyAll'), odSkip: $('odSkip'),
  previewCard: $('previewCard'), previewBody: $('previewBody'),
  failCard: $('failCard'), failList: $('failList'), failCount: $('failCount'),
  exportCsv: $('exportCsv'), retryFailed: $('retryFailed'),
  resultCard: $('resultCard'), resultBody: $('resultBody'),
  log: $('log'), copyLog: $('copyLog'),
};

let mode = 'all';
let ws = null;
let jobId = null;
let running = false;
let pausedState = false;
let skipOnlineOnly = false;

/* ── formatting ─────────────────────────────────────────── */
const fmtBytes = (b) => {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtTime = (s) => {
  if (s == null || !isFinite(s)) return '—';
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/* ── config ─────────────────────────────────────────────── */
function selection() {
  if (mode === 'wildcard') {
    return { mode, patterns: el.patterns.value.split(/\s+/).filter(Boolean) };
  }
  if (mode === 'range') {
    return { mode, from: el.rangeFrom.value.trim(), to: el.rangeTo.value.trim() };
  }
  return { mode: 'all' };
}

function config() {
  return {
    source: el.source.value.trim(),
    dest: el.dest.value.trim(),
    selection: selection(),
    resourceLevel: Number(el.resource.value),
    conflict: el.conflict.value,
    retryRounds: Number(el.retryRounds.value),
    subdirs: el.subdirs.checked,
    restartable: el.restartable.checked,
    mirror: el.mirror.checked,
    skipOnlineOnly,
    dehydrateAfter: el.dehydrate.checked,
  };
}

/* ── slider + hints ─────────────────────────────────────── */
const RESOURCE_TEXT = {
  1: 'Gentlest — single threaded with a 75ms gap between packets. The machine stays fully responsive, and this is the only setting that shows a per-file progress bar.',
  2: 'Very light — single threaded with a small inter-packet gap.',
  3: 'Light background copy — 4 threads.',
  4: 'Balanced — robocopy’s own default of 8 threads.',
  5: 'Balanced — robocopy’s own default of 8 threads.',
  6: 'Balanced — robocopy’s own default of 8 threads.',
  7: 'Fast — 16 threads with unbuffered I/O, good for large files.',
  8: 'Fast — 20 threads with unbuffered I/O.',
  9: 'Very fast — 24 threads. Disk and CPU will be busy.',
  10: 'Maximum — 32 threads. Expect the machine to feel loaded.',
};

const CONFLICT_TEXT = {
  overwrite: 'Existing destination files are replaced.',
  skip: 'Existing files are left exactly as they are.',
  keepboth: 'Keeps the original and adds a numbered copy. Robocopy has no such mode, so these files are copied one at a time — slower when there are many conflicts.',
};

function refreshHints() {
  el.resourceHint.textContent = RESOURCE_TEXT[el.resource.value];
  el.conflictHint.textContent = CONFLICT_TEXT[el.conflict.value];
  // Per-file percentages are only attributable when robocopy runs single
  // threaded; with /MT the lines interleave across files.
  el.fileBarWrap.style.display = Number(el.resource.value) <= 2 ? '' : 'none';
  updateCmd();
}

let cmdTimer = null;
function updateCmd() {
  clearTimeout(cmdTimer);
  cmdTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/flags', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config()),
      });
      const j = await r.json();
      if (j.preview) el.cmdPreview.textContent = j.preview;
    } catch { /* preview only */ }
  }, 150);
}

/* ── path validation ────────────────────────────────────── */
async function validate(which) {
  const input = el[which];
  const msg = el[`${which}Msg`];
  const v = input.value.trim();
  if (!v) { input.className = ''; msg.textContent = ''; msg.className = 'field-msg'; return; }

  const r = await fetch('/api/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: v }),
  });
  const j = await r.json();
  input.className = j.ok ? 'good' : 'bad';
  msg.className = `field-msg ${j.ok ? 'ok' : 'bad'}`;
  msg.textContent = j.ok ? '' : j.message;

  if (j.ok && which === 'dest' && el.source.value.trim().toLowerCase() === v.toLowerCase()) {
    input.className = 'bad';
    msg.className = 'field-msg bad';
    msg.textContent = 'Source and destination are the same folder.';
  }
  updateCmd();
}

/* ── websocket ──────────────────────────────────────────── */
function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    setStatus('disconnected', 'bad');
    setTimeout(connect, 1500);
  };
  ws.onopen = () => setStatus('idle');
}

function send(action, extra = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action, ...extra }));
}

function setStatus(text, cls = '') {
  el.statusChip.textContent = text;
  el.statusChip.className = `status-chip ${cls}`;
}

function log(line) {
  el.log.textContent += line + '\n';
  el.log.scrollTop = el.log.scrollHeight;
}

/* ── incoming messages ──────────────────────────────────── */
function handle(m) {
  switch (m.type) {
    case 'started':
      jobId = m.jobId;
      el.log.textContent = '';
      el.failCard.classList.add('hidden');
      el.resultCard.classList.add('hidden');
      el.failList.innerHTML = '';
      break;

    case 'state':
      setStatus(m.state, ['copying', 'scanning', 'retrying'].includes(m.state) ? 'busy' : '');
      break;

    case 'scan':
      renderScan(m);
      break;

    case 'blocked':
      setStatus('blocked', 'bad');
      showResult(`<div class="notice bad"><strong>Stopped before copying.</strong><br>${m.reason}</div>`);
      setRunning(false);
      break;

    case 'command':
      log(`> ${m.args}`);
      break;

    case 'batch':
      if (m.of > 1) log(`— batch ${m.index} of ${m.of} —`);
      break;

    case 'progress':
      renderProgress(m);
      break;

    case 'failure':
      addFailure(m);
      break;

    case 'governor':
      log(`⚠ OneDrive throttling detected — thread count ${m.direction === 'down' ? 'reduced' : 'raised'} to ${m.threads}`);
      break;

    case 'retry':
      renderRetry(m);
      break;

    case 'retry-summary':
      log(`Retry finished: ${m.recovered} recovered, ${m.remaining} still failing.`);
      break;

    case 'keepboth':
      log(`kept both: ${m.saved}`);
      break;

    case 'dehydrate':
      setStatus(`freeing space ${m.done}/${m.total}`, 'busy');
      break;

    case 'done':
      renderDone(m);
      break;

    case 'log':
      if (m.text?.trim()) log(m.text);
      break;

    case 'error':
      setStatus('error', 'bad');
      showResult(`<div class="notice bad">${m.message}</div>`);
      setRunning(false);
      break;
  }
}

/* ── rendering ──────────────────────────────────────────── */
function renderScan(m) {
  el.previewCard.classList.remove('hidden');
  const s = m.selection ?? {};
  let html = `<dl class="kv">
    <dt>Files to copy</dt><dd>${(m.totalFiles ?? 0).toLocaleString()}</dd>
    <dt>Total size</dt><dd>${fmtBytes(m.totalBytes)}</dd>
    <dt>Already at destination</dt><dd>${(m.conflicts ?? 0).toLocaleString()}</dd>
  </dl>`;

  if (s.mode === 'range') {
    html += `<dl class="kv">
      <dt>Range matched</dt><dd>${s.matched?.toLocaleString()} of ${s.requested?.toLocaleString()} requested</dd>
      <dt>First → last</dt><dd>${s.first ?? '—'} → ${s.last ?? '—'}</dd>
    </dl>`;
    // Show what a glob-only implementation would have wrongly included.
    if (s.nearMisses?.length) {
      html += `<div class="notice info"><strong>Just outside your range — not copied:</strong>
        <div class="chips">${s.nearMisses.map((n) => `<span class="chip">${n}</span>`).join('')}</div></div>`;
    }
    if (s.missing?.length) {
      html += `<div class="notice warn"><strong>${s.missing.length} file(s) in the range don’t exist in the source:</strong>
        <div class="chips">${s.missing.slice(0, 12).map((n) => `<span class="chip">${n}</span>`).join('')}
        ${s.missing.length > 12 ? `<span class="chip">+${s.missing.length - 12} more</span>` : ''}</div></div>`;
    }
  }

  el.previewBody.innerHTML = html;

  if (m.onedrive?.oneDrive) renderOneDrive(m.onedrive);
}

function renderOneDrive(od) {
  el.odCard.classList.remove('hidden');
  const gb = (b) => `${(b / 1024 ** 3).toFixed(2)} GB`;
  let html = '';

  for (const w of od.warnings ?? []) {
    html += `<div class="notice ${w.level === 'blocked' ? 'bad' : 'info'}">${w.message}</div>`;
  }

  html += `<dl class="kv">
    <dt>Files in source</dt><dd>${(od.totalFiles ?? 0).toLocaleString()}</dd>
    <dt>Online-only</dt><dd>${(od.onlineOnly ?? 0).toLocaleString()} (${gb(od.onlineBytes ?? 0)})</dd>
    <dt>Free space</dt><dd>${gb(od.freeBytes ?? 0)} → ${gb(od.freeAfterBytes ?? 0)} after</dd>
  </dl>
  <p class="hint">Online-only files must be downloaded from the cloud before they can be
  copied, and they stay on your disk afterwards. Syncopier paces these downloads so the
  OneDrive sync engine isn’t overloaded, and retries anything that fails.</p>`;

  el.odBody.innerHTML = html;
}

function renderProgress(s) {
  el.progressCard.classList.remove('hidden');
  el.overallFill.style.width = `${s.percent.toFixed(1)}%`;
  el.overallPct.textContent = `${s.percent.toFixed(1)}%`;
  el.currentFile.textContent = s.currentFile?.path ?? '—';
  el.currentFile.title = s.currentFile?.path ?? '';
  el.fileFill.style.width = `${s.currentPercent ?? 0}%`;
  el.filePct.textContent = s.currentPercent ? `${s.currentPercent}%` : '';
  el.stCopied.textContent = `${fmtBytes(s.copiedBytes)} / ${fmtBytes(s.totalBytes)}`;
  el.stFiles.textContent = `${s.copiedFiles.toLocaleString()} / ${s.totalFiles.toLocaleString()}`;
  el.stSpeed.textContent = s.bytesPerSec ? `${fmtBytes(s.bytesPerSec)}/s` : '—';
  el.stEta.textContent = fmtTime(s.etaSec);
  el.stElapsed.textContent = fmtTime(s.elapsedSec);
  el.stDeferred.textContent = s.deferred ?? 0;
}

function addFailure(m) {
  el.failCard.classList.remove('hidden');
  el.failCount.textContent = m.deferred;
  const row = document.createElement('div');
  row.className = 'fail-item';
  row.innerHTML = `<span class="ellipsis" title="${m.path ?? ''}">${m.path ?? '(unknown)'}</span>
    <span class="why ${m.kind}">${m.kind === 'permanent' ? 'will not retry' : 'will retry'} · ${m.code}</span>`;
  el.failList.appendChild(row);
}

function renderRetry(m) {
  if (m.type === 'retry-wait') {
    log(`Waiting ${Math.round(m.waitMs / 1000)}s before retry round ${m.round} (${m.pending} files)…`);
  } else if (m.type === 'retry-round') {
    setStatus(`retry round ${m.round}`, 'busy');
  } else if (m.type === 'retry-ok') {
    log(`✓ recovered ${m.path}`);
  } else if (m.type === 'retry-fail') {
    log(`✗ still failing ${m.path}`);
  }
}

function renderDone(m) {
  setRunning(false);
  const failed = m.failed ?? [];

  if (m.dryRun) {
    setStatus('dry run complete', 'ok');
    showResult(`<div class="notice ok"><strong>Dry run complete.</strong> Nothing was copied.</div>`);
    return;
  }

  if (m.cancelled) {
    setStatus('cancelled', 'bad');
  } else if (failed.length) {
    setStatus('finished with errors', 'bad');
  } else {
    setStatus('complete', 'ok');
  }

  let html = '';
  if (!failed.length && !m.cancelled) {
    html += `<div class="notice ok"><strong>All files copied.</strong>
      ${m.copiedFiles.toLocaleString()} files · ${fmtBytes(m.copiedBytes)} in ${fmtTime(m.elapsedSec)}.</div>`;
  } else if (failed.length) {
    // Never claim success while files are unaccounted for.
    html += `<div class="notice bad"><strong>${failed.length} file(s) did not copy.</strong>
      They are listed above and saved to <code>${m.queueFile ?? ''}</code> so you can retry them later.</div>`;
  }
  if (m.cancelled) html += `<div class="notice warn">Job cancelled. Re-running will skip files already copied.</div>`;

  if (m.keepBoth?.copied?.length) {
    html += `<div class="notice info">Kept both versions of ${m.keepBoth.copied.length} file(s).</div>`;
  }

  showResult(html);
}

function showResult(html) {
  el.resultCard.classList.remove('hidden');
  el.resultBody.innerHTML = html;
}

function setRunning(on) {
  running = on;
  el.startBtn.disabled = on;
  el.scanBtn.disabled = on;
  el.pauseBtn.disabled = !on;
  el.cancelBtn.disabled = !on;
  if (!on) { el.pauseBtn.textContent = 'Pause'; pausedState = false; }
}

/* ── events ─────────────────────────────────────────────── */
document.querySelectorAll('.seg-btn').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    mode = b.dataset.mode;
    document.querySelectorAll('.mode-panel').forEach((p) => {
      p.classList.toggle('hidden', p.dataset.panel !== mode);
    });
    updateCmd();
  };
});

document.querySelectorAll('[data-browse]').forEach((b) => {
  b.onclick = async () => {
    const which = b.dataset.browse;
    b.disabled = true;
    b.textContent = 'Opening…';
    try {
      const r = await fetch('/api/browse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initial: el[which].value.trim() }),
      });
      const j = await r.json();
      if (j.path) { el[which].value = j.path; validate(which); }
    } finally {
      b.disabled = false;
      b.textContent = 'Browse…';
    }
  };
});

el.source.addEventListener('blur', () => validate('source'));
el.dest.addEventListener('blur', () => validate('dest'));
el.resource.addEventListener('input', refreshHints);
el.conflict.addEventListener('change', refreshHints);
[el.subdirs, el.restartable, el.mirror].forEach((c) => c.addEventListener('change', updateCmd));
[el.patterns, el.rangeFrom, el.rangeTo].forEach((i) => i.addEventListener('input', updateCmd));

el.mirror.addEventListener('change', () => {
  if (el.mirror.checked) {
    const ok = confirm(
      'Mirror mode (/MIR) DELETES files in the destination that do not exist in the source.\n\n' +
      'This is robocopy behaving exactly as documented, but it can remove data permanently.\n\n' +
      'Enable it?',
    );
    if (!ok) el.mirror.checked = false;
  }
  updateCmd();
});

el.startBtn.onclick = () => {
  if (!el.source.value.trim() || !el.dest.value.trim()) {
    alert('Choose a source and a destination folder first.');
    return;
  }
  setRunning(true);
  send('start', { config: config() });
};

el.scanBtn.onclick = () => {
  if (!el.source.value.trim() || !el.dest.value.trim()) {
    alert('Choose a source and a destination folder first.');
    return;
  }
  setRunning(true);
  send('scan', { config: config() });
};

el.pauseBtn.onclick = () => {
  pausedState = !pausedState;
  send(pausedState ? 'pause' : 'resume');
  el.pauseBtn.textContent = pausedState ? 'Resume' : 'Pause';
};

el.cancelBtn.onclick = () => {
  if (confirm('Cancel this copy? Files already copied are kept.')) send('cancel');
};

el.odCopyAll.onclick = () => { skipOnlineOnly = false; el.odCard.classList.add('hidden'); updateCmd(); };
el.odSkip.onclick = () => { skipOnlineOnly = true; el.odCard.classList.add('hidden'); updateCmd(); };

el.exportCsv.onclick = () => { if (jobId) location.href = `/api/failed.csv?job=${jobId}`; };
el.retryFailed.onclick = () => { setRunning(true); send('start', { config: { ...config(), retryOnly: true } }); };

el.copyLog.onclick = async () => {
  await navigator.clipboard.writeText(el.log.textContent);
  el.copyLog.textContent = 'Copied';
  setTimeout(() => (el.copyLog.textContent = 'Copy'), 1200);
};

/* ── restore last job ───────────────────────────────────── */
(async () => {
  try {
    const last = await (await fetch('/api/lastjob')).json();
    if (last.source) el.source.value = last.source;
    if (last.dest) el.dest.value = last.dest;
    if (last.resourceLevel) el.resource.value = last.resourceLevel;
    if (last.conflict) el.conflict.value = last.conflict;
    if (typeof last.subdirs === 'boolean') el.subdirs.checked = last.subdirs;
    if (typeof last.restartable === 'boolean') el.restartable.checked = last.restartable;
  } catch { /* first run */ }
  refreshHints();
  connect();
})();
