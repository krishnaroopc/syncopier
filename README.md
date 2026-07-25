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
- **Output detail** — silent, normal, or verbose robocopy logging
- **Live error counter** that falls back to zero as failures are recovered

## What's new in 1.2

**Fixed: the OneDrive hydration warning described the whole source folder,
not the job.** Resuming an interrupted 7,001-file range copy (4,428 files
already done) warned that 68,361 files / 33.40 GB would be downloaded — the
true remaining work was 2,573 files / 1.26 GB, a 26× overstatement. The
warning now reports the files the job will actually copy, and a resume reads
as "Resuming: 4,428 of 7,001 selected files are already at the destination;
2,573 online-only files (1.26 GB) will be downloaded." `mode: 'all'` keeps
whole-folder numbers, since they're correct there. The disk-space guard
(`willExceedDisk`) now uses the same corrected figure, so it can no longer
refuse a job that actually fits.

Destination state for this check is read from the destination's own file
metadata, not from robocopy scan output — robocopy prints no line for a file
already identical at the destination, the same behaviour behind the v1.1
"missing files" bug, so scan output alone can't tell "copied" from "absent."

Also fixed in the same pass: two PowerShell calls used a placeholder test
looser than the rest of the app (missing the reparse-point requirement, the
exact looseness a v1.1 fix had already closed elsewhere) and a chunking
routine that repeated the full source path per filename — safe on short
paths, but it silently overflowed the Windows command-line limit on a deeply
nested library path and (before a stricter error mode was added) reported
"0 online-only" instead of failing visibly.

## What's new in 1.1

**Fixed: files reported as missing when they were already copied.**
Robocopy prints a per-file line only for files it would *act* on. A file already
present identically at the destination is counted under `Skipped` and produces
no output line at all. v1.0 inferred existence from those lines, so a
fully-copied range was indistinguishable from one whose files never existed —
and it warned that thousands of present files were missing. Source enumeration
now runs against a scratch directory, so existence never depends on what the
destination already holds.

**Fixed: SharePoint and Teams libraries were not recognised as cloud storage.**
Detection matched the `%OneDrive%` path prefix only. A synced tenant library
lives outside it — `C:\Users\you\CONTOSO\...`, not `C:\Users\you\OneDrive - CONTOSO\...` —
so on a real library of 72,789 files (68,361 online-only, 33 GB) OneDrive mode
never engaged: no thread cap, no pacing, no hydration warning, no disk-space
guard. Detection now checks placeholder attributes, which the sync engine sets
wherever the library is mounted. Note that the `Offline` bit *alone* is not a
placeholder — ordinary local files can carry it — so a reparse point is required
too.

**Fixed: conflict detection only examined the first batch.** In a range of
several thousand files, everything past the first ~200 names was invisible.

**Restarting is now blocked while a copy is running**, via a PID-checked lock
file. *Stop Syncopier* asks for confirmation instead of killing a copy silently.

Also: larger UI text, an OneDrive load indicator on the resource slider, and the
"just outside your range" list is collapsed by default.

## Requirements

- Windows (robocopy is a Windows utility)
- [Node.js](https://nodejs.org) 18 or newer — the launcher will point you at it if it's missing

## Install

Download or clone the folder, then **double-click `Syncopier.vbs`**.

That's it. It starts the background server and opens your browser — no console window, no typing. The first run offers to fetch one small dependency automatically.

To stop it, double-click **`Stop Syncopier.vbs`**. (Closing the browser tab deliberately leaves it running, so closing a window can never kill a copy in progress.)

<details>
<summary>Command line, if you prefer</summary>

```bash
git clone https://github.com/krishnaroopc/syncopier.git
cd syncopier
npm install
npm start
```

Then open <http://localhost:5173>.
</details>

### Why isn't it just an HTML file?

Because a web page can't run `robocopy.exe` — browsers sandbox that away, deliberately. Something has to sit between the page and the copy engine, so Syncopier ships a tiny local server and the launcher hides it completely.

The server binds to `127.0.0.1` only. It can run robocopy against any path your account can reach, so it is intentionally not reachable from the network.

### Optional: desktop shortcut

Right-click `Syncopier.vbs` → **Send to** → **Desktop (create shortcut)**, or run:

```bat
powershell -c "$s=(New-Object -COM WScript.Shell).CreateShortcut(\"$env:USERPROFILE\Desktop\Syncopier.lnk\");$s.TargetPath='wscript.exe';$s.Arguments='\"%CD%\Syncopier.vbs\"';$s.WorkingDirectory='%CD%';$s.IconLocation=\"$env:SystemRoot\System32\imageres.dll,27\";$s.Save()"
```

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

One non-robocopy gotcha, in the launcher: in VBScript, reading `http.Status` after a failed `Send` raises its own error, so `If Err.Number = 0 And http.Status = 200` evaluates both sides and returns a **false positive**. That made the launcher think a dead port was live and open a browser at nothing. Status is now read only after `Send` has definitely succeeded.

## Licence

MIT — see [LICENSE](LICENSE).

Robocopy is a Microsoft utility included with Windows and is not affiliated with this project.
