// Syncopier - local HTTP + WebSocket server.
//
// Binds to 127.0.0.1 only: this process can spawn robocopy against any path on
// the machine, so it must never be reachable from the network.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { Job } from './lib/job.js';
import { createQueue } from './lib/retry.js';
import { resourceFlags, buildArgs, normalizeDir } from './lib/robocopy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 5173;
const HOST = '127.0.0.1';
const CONFIG_DIR = path.join(os.homedir(), '.syncopier');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      try {
        resolve(JSON.parse(b || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

/**
 * Native Windows folder picker.
 *
 * Browsers deliberately hide real filesystem paths from <input type=file>, so
 * the only way to get a genuine path is to ask the OS.
 */
function pickFolder(initial) {
  const script = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Select a folder'
$d.ShowNewFolderButton = $true
${initial ? `try { $d.SelectedPath = '${initial.replace(/'/g, "''")}' } catch {}` : ''}
$top = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}
if ($d.ShowDialog($top) -eq 'OK') { Write-Output $d.SelectedPath }
`;
  return new Promise((resolve) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
    );
    let out = '';
    ps.stdout.on('data', (d) => (out += d));
    ps.on('error', () => resolve(null));
    ps.on('close', () => resolve(out.trim() || null));
  });
}

async function validatePath(p) {
  const norm = normalizeDir(p);
  if (!norm) return { ok: false, message: 'Enter a folder path.' };
  try {
    const st = await fs.stat(norm);
    if (!st.isDirectory()) return { ok: false, message: 'That path is a file, not a folder.' };
    return { ok: true, path: norm };
  } catch {
    return { ok: false, message: 'Folder not found.' };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/browse' && req.method === 'POST') {
    const { initial } = await readBody(req);
    const picked = await pickFolder(initial);
    return json(res, 200, { path: picked });
  }

  if (url.pathname === '/api/validate' && req.method === 'POST') {
    const { path: p } = await readBody(req);
    return json(res, 200, await validatePath(p));
  }

  if (url.pathname === '/api/flags' && req.method === 'POST') {
    const cfg = await readBody(req);
    try {
      const { threads, flags } = resourceFlags(cfg.resourceLevel, {
        oneDriveMode: cfg.oneDriveMode,
      });
      return json(res, 200, {
        threads,
        flags,
        preview: ['robocopy', ...buildArgs(cfg)].join(' '),
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (url.pathname === '/api/lastjob') {
    if (req.method === 'GET') {
      try {
        const raw = await fs.readFile(path.join(CONFIG_DIR, 'lastjob.json'), 'utf8');
        return json(res, 200, JSON.parse(raw));
      } catch {
        return json(res, 200, {});
      }
    }
    if (req.method === 'POST') {
      const cfg = await readBody(req);
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      await fs.writeFile(path.join(CONFIG_DIR, 'lastjob.json'), JSON.stringify(cfg, null, 2));
      return json(res, 200, { ok: true });
    }
  }

  // Export the deferred-failure list so nothing is trapped in the UI.
  if (url.pathname === '/api/failed.csv') {
    const id = url.searchParams.get('job');
    const q = createQueue(id);
    await q.load();
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="failed-${id}.csv"`,
    });
    return res.end(q.toCSV());
  }

  if (url.pathname === '/api/failed' && req.method === 'GET') {
    const id = url.searchParams.get('job');
    const q = createQueue(id);
    await q.load();
    return json(res, 200, { items: q.list() });
  }

  // Static files
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const target = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await fs.readFile(target);
    res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });
const jobs = new Map();

wss.on('connection', (ws) => {
  const send = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  let current = null;

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.action === 'start' || msg.action === 'scan') {
      if (current && ['copying', 'scanning', 'retrying'].includes(current.state)) {
        return send({ type: 'error', message: 'A job is already running.' });
      }
      const cfg = { ...msg.config, dryRun: msg.action === 'scan' || msg.config?.dryRun };
      current = new Job(cfg, send);
      jobs.set(current.id, current);
      send({ type: 'started', jobId: current.id });

      try {
        await fs.mkdir(CONFIG_DIR, { recursive: true });
        await fs.writeFile(path.join(CONFIG_DIR, 'lastjob.json'), JSON.stringify(msg.config, null, 2));
      } catch {
        /* non-fatal */
      }

      current.run();
      return;
    }

    if (!current) return;
    if (msg.action === 'pause') current.pause();
    if (msg.action === 'resume') current.resume();
    if (msg.action === 'cancel') current.cancel();
  });

  ws.on('close', () => {
    // Deliberately does NOT cancel a running job - closing a browser tab should
    // not destroy an in-flight copy.
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Syncopier - a GUI for Windows robocopy`);
  console.log(`  Running at http://${HOST}:${PORT}\n`);
});
