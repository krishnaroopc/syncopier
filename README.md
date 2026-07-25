# Syncopier

A friendly local web GUI for **[robocopy](https://learn.microsoft.com/windows-server/administration/windows-commands/robocopy)** — Microsoft's *Robust File Copy* utility that ships with every copy of Windows.

> **Robocopy does all the work.** Syncopier writes no copy logic of its own. It builds robocopy's arguments, runs it, parses its output, and shows you what's happening. Every byte is moved by `robocopy.exe`. This project exists because robocopy is excellent and its command line is not.

```
┌─ your browser ──────────────┐
│  progress bars, options     │
└──────────┬──────────────────┘
           │ WebSocket (localhost only)
┌──────────▼──────────────────┐
│  Node server                │
└──────────┬──────────────────┘
           │ spawn()
      robocopy.exe  ← does the copying
```

## Why

Robocopy is the fastest and most reliable way to copy files on Windows, but:

- flags like `/MT`, `/Z`, `/XO`, `/XA:O` are hard to remember and easy to get wrong
- it shows a *per-file* percentage but **no overall progress bar and no ETA**
- it has no notion of "copy files 234 through 1234"
- copying from OneDrive can quietly download tens of gigabytes, and a throttled sync engine produces failures that are easy to miss in a wall of console text

Syncopier fixes the interface without replacing the engine.

## Features

- **Real progress** — an overall bar and ETA, made possible by measuring the job with a `/L` dry run first
- **Browse or type** paths, with live validation
- **One resource slider**, from gentle background copy to maximum throughput, showing the exact flags it will use
- **Conflict resolution** — overwrite, skip, or *keep both* (`name (1).ext`)
- **Numeric range selection** — copy `file000234.ext` through `file001234.ext`, with exact boundaries
- **OneDrive-aware** — reports how much will be downloaded *before* starting, paces requests so the sync engine isn't overloaded, and retries what fails
- **Nothing is silently lost** — files that fail are queued, retried after the main pass, and saved to disk so a crash can't lose the list
- **Dry run** for every mode
- **Pause, resume, cancel**

## Requirements

- Windows (robocopy is a Windows utility)
- [Node.js](https://nodejs.org) 18 or newer

## Install

```bash
git clone https://github.com/krishnaroopc/syncopier.git
cd syncopier
npm install
npm start
```

Then open <http://localhost:5173>.

The server binds to `127.0.0.1` only. It can run robocopy against any path your user account can reach, so it is deliberately not reachable from the network.

## The resource slider

| Slider | Robocopy flags | What it means |
|-------:|----------------|---------------|
| 1 | `/IPG:75` | Gentlest — single threaded, throttled |
| 2 | `/IPG:20` | Very light background copy |
| 3 | `/MT:4` | Light |
| 4–6 | `/MT:8` | Balanced (robocopy's own default) |
| 7–9 | `/MT:16`–`/MT:24` `/J` | Fast, unbuffered I/O |
| 10 | `/MT:32` `/J` | Maximum |

Levels 1–2 run single threaded, which is the only way robocopy's per-file percentages can be attributed to a specific file — so that's when the per-file progress bar appears.

## Copying from OneDrive

If either folder is inside OneDrive, Syncopier shows a pre-flight summary before anything is copied:

```
OneDrive detected
  245,570 files in source
   22,300 online-only  (49.72 GB will be downloaded)
  Free space  243.69 GB → 193.97 GB after
  [ Copy everything ]  [ Skip online-only ]
```

Things worth knowing:

- **Online-only files must be downloaded to be copied, and they stay on your disk afterwards.** This is how Windows' Files-On-Demand works, not something Syncopier chooses. There's an opt-in checkbox to set them back to online-only when the copy finishes.
- **Thread counts are capped in OneDrive mode.** Hydration is network-bound; more threads don't make cloud files arrive faster, they mostly produce `ERROR 392` and `ERROR 395` throttling. An adaptive governor backs off further if errors appear.
- **Scanning is free.** The pre-flight measurement reads only metadata, so it never triggers a download.
- **"Skip online-only"** uses `/XA:O`, so robocopy never opens a placeholder.

## Numeric ranges

Pick "Numbered range" and give a first and last filename:

```
file000234.ext  →  file001234.ext
```

Robocopy has no numeric-range concept — it only understands wildcards. The obvious approach, turning the range into globs like `file0002??.ext`, is subtly wrong: those globs also match `file000230`–`file000233` and `file001235`–`file001239`.

So Syncopier uses globs only to *find candidates* cheaply, then filters to your exact bounds and copies only verified filenames. The preview shows what matched, and explicitly lists near misses that were **not** copied:

```
1,001 files matched · file000234.ext → file001234.ext · 4.2 GB
Just outside your range — not copied:
  file000233.ext   file001235.ext
```

Zero padding is significant: `file1.ext` and `file000001.ext` are different files, and a mismatch is rejected rather than guessed at.

Long filenames are handled by batching. A 1,001-file range with 40-character names is about 40,000 characters of command line — past the Windows 32,767-character limit — so Syncopier splits it into several robocopy calls that report as one job.

## When files fail

Failures don't stop the copy. Each one is recorded and classified:

- **transient** — the sync engine is throttling or stalling (`392`, `395`, `21`, network errors). Retried automatically.
- **permanent** — access denied, path too long, file missing. Reported, not retried, so no time is wasted.

The main pass always finishes first. Then transient failures are retried in rounds with increasing backoff (30s → 2m → 5m), single threaded and paced to let OneDrive recover.

The queue is written to `~/.syncopier/jobs/<id>.json` as it changes, so a crash, reboot, or cancel can't lose the list. **A job is only reported successful when that queue is empty** — otherwise you get a count of what didn't make it and why, exportable as CSV.

## A note on `/MIR`

Mirror mode makes the destination match the source, which means **it deletes destination files that aren't in the source**. That's robocopy working as documented, but it can remove data permanently, so it's behind a confirmation prompt.

## Development

```bash
npm test
```

The test suite covers argument construction, output parsing, and range selection. Two tests are worth keeping honest:

- **boundary exactness** — asserts the nine files just outside `file000234`–`file001234` are excluded. If it fails, Syncopier is copying files the user didn't ask for.
- **`/IPG` with `/MT`** — robocopy rejects this combination and exits 16 without copying anything, so no slider level may emit both.

### Verified robocopy behaviour

Syncopier's design rests on behaviour checked against the real `robocopy.exe` rather than assumed:

| Behaviour | Why it matters |
|---|---|
| Exit codes are a **bitmask**; `1` means "files copied", `>= 8` is failure | Treating `1` as an error is the classic robocopy-wrapper bug |
| `/L` reports byte sizes without copying — including for OneDrive placeholders, without hydrating them | Makes an accurate overall bar, ETA, and hydration estimate possible for free |
| `/MT` prints absolute paths and interleaves threads | Per-file percentages can't be attributed, so the overall bar counts bytes instead |
| `/IPG` cannot be combined with `/MT` | Robocopy exits 16 and copies nothing |
| Robocopy accepts a single named file | Makes "keep both" and per-file retries possible |
| `/XJ` does **not** exclude OneDrive folders | They're reparse points but not junctions — measured identical file counts on a 245,570-file tree. A guard here would have been cargo-cult safety |
| Conflict flags must not be applied to a `/L` scan | They'd hide the very files the scan needs to report as conflicts |

## Licence

MIT — see [LICENSE](LICENSE).

Robocopy is a Microsoft utility included with Windows and is not affiliated with this project.
