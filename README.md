<div align="center">

# otak-monitor

**Watch CPU, memory, and disk usage without leaving VS Code.**

otak-monitor keeps a lightweight system indicator in your status bar, shows current system metrics on hover, and copies a Markdown snapshot in one click.

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/odangoo.otak-monitor?label=Marketplace&color=1d4ed8)](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-monitor)
[![VS Code engine](https://img.shields.io/badge/VS%20Code-%5E1.90.0-007acc)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-otak--monitor-24292f)](https://github.com/tsuyoshi-otake/otak-monitor)

![Local system metrics](https://img.shields.io/badge/metrics-local%20only-0f766e)
![Status bar monitor](https://img.shields.io/badge/status%20bar-CPU%20usage-2563eb)
![Markdown clipboard](https://img.shields.io/badge/clipboard-Markdown-7c3aed)
![Codespaces aware](https://img.shields.io/badge/Codespaces-aware-334155)
![No telemetry](https://img.shields.io/badge/telemetry-none-64748b)

[**Install**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-monitor) ·
[**GitHub**](https://github.com/tsuyoshi-otake/otak-monitor) ·
[**Report an issue**](https://github.com/tsuyoshi-otake/otak-monitor/issues)

</div>

---

Development often means checking whether your editor, build, tests, containers, or browser are consuming the machine. **otak-monitor keeps the essential CPU, memory, and disk numbers inside VS Code** so you can glance at the status bar, inspect details on hover, and paste a formatted snapshot into notes or issues.

## Quick Start

1. **Install** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-monitor).
2. Reload or start VS Code.
3. Find the CPU indicator on the right side of the status bar.
4. Hover to inspect CPU clock and usage, temperature, memory, and disk usage.
5. Click the status bar item to switch it to the next reading.
6. Use **Copy Summary** in the tooltip to copy a Markdown metrics snapshot.

![otak-monitor status bar and tooltip](images/otak-monitor.png)

## Capabilities

- **Status bar CPU monitor**: shows current CPU usage in a stable-width `CPU: 05%` format.
- **Switchable status bar reading**: click to move through CPU usage, temperature, memory, disk, and folder size; the choice is remembered between sessions.
- **Live processor clock**: reports the clock the processor is actually running at, not the nominal one printed on the box — the same number the operating system's task manager shows.
- **CPU temperature**: shown wherever the machine exposes a readable sensor, and left out entirely where it does not.
- **Current system tooltip**: hover for the processor's name, CPU usage and clock speed, temperature, memory usage, disk usage, and the size of the open folder.
- **Markdown clipboard snapshot**: one link in the tooltip copies current metrics and 1-minute averages.
- **Rolling averages**: keeps a fixed-size history of 24 samples for CPU, memory, and disk averages.
- **Efficient refresh cadence**: updates every 2.5 seconds while the VS Code window is focused, every 5 seconds while unfocused, and every 10 seconds while unfocused and following another window.
- **One sample per machine**: with several windows open, one of them is elected to do the sampling and the others render what it publishes, so the cost does not grow with the number of windows.
- **Incremental folder measurement**: remembers the total under each expensive subtree and re-measures only the part that changed, so editing one file costs a few filesystem requests instead of a full walk.
- **Non-blocking folder measurement**: the folder size is measured in the background, so a large workspace never delays a status bar update.
- **Scanner-friendly walking**: measures with directory listings and file attributes only, never opening a file, keeps a fixed cap on requests in flight, skips the folders you exclude, and does not walk at all in a window whose tooltip nobody can hover.
- **Cached disk sampling**: avoids repeated synchronous disk checks by caching disk stats between samples.
- **Quiet redraws**: the status bar and tooltip are only reassigned when the text they would show has actually changed.
- **Cross-platform paths**: monitors the right root path on Windows, macOS, Linux, and GitHub Codespaces.
- **Local-only operation**: no accounts, API keys, telemetry, or network calls are required for monitoring.

## How It Works

When VS Code finishes startup, otak-monitor:

1. Creates a right-aligned status bar item.
2. Samples aggregate CPU usage from OS CPU time deltas.
3. Reads the running clock and, where the machine exposes one, the CPU temperature.
4. Reads memory usage from the operating system.
5. Samples disk usage with a platform-aware monitor path.
6. Measures the size of the open folder in the background.
7. Adds each sample to a fixed-size rolling history.
8. Updates the status bar text and hover tooltip.

Clicking the status bar item switches it to the next reading. **Copy Summary** in the tooltip refreshes disk usage, writes a Markdown report to the clipboard, and shows a short confirmation message.

### Reading the Processor

`os.cpus()` reports the nominal clock and never moves off it, which is why the tooltip used to sit at the base frequency while the machine ran half a gigahertz above or below it. Where a platform knows better, otak-monitor asks it — and only in the window that samples for the machine, so the cost does not grow with the number of windows open.

| Platform | Running clock | Temperature |
| --- | --- | --- |
| Windows | base clock × `% Processor Performance`, read from WMI by class name rather than by localised counter path | ACPI thermal zone where the machine exposes one; most desktops do not, and the row is then left out |
| Linux | `scaling_cur_freq` per frequency policy, falling back to `/proc/cpuinfo` on machines with no `cpufreq` driver | the hottest `thermal_zone` that names the processor |
| macOS | `sysctl hw.cpufrequency`, sampled sparingly | not available — the sensors sit behind the SMC, which nothing reads without root |

On Windows this runs as a single long-lived PowerShell process rather than one per sample: starting PowerShell costs more processor time than every reading this extension takes put together. It stops when the window that started it is gone, and gives up rather than restarting forever if it cannot run at all.

Both readings can be turned off, and neither is ever reported as a zero — a reading the machine cannot take is left out of the tooltip and skipped when clicking through the status bar readings.

### Several Windows Open

CPU, memory, and disk usage read the same in every window, and measuring the size of a folder gives the same answer to every window that opened it — so otak-monitor only pays for them once.

The windows share a small lease file in the extension's storage directory. One window holds it, does the sampling, and publishes the result; the others read that result instead of sampling. The lease is renewed on a heartbeat, so closing or killing the sampling window lets another one take over within about half a minute. Windows that opened different folders keep separate leases for the folder size, since that measurement is not shared between them.

A window that is following another one reads CPU, memory, and disk usage from the published result and never walks the folder itself; the size simply appears once the measuring window publishes it. So opening a second window on the same folder adds no filesystem work at all.

If the storage directory cannot be written to, each window simply samples for itself.

### Measuring the Folder Size

Walking a real workspace is tens of thousands of filesystem requests, and almost nothing changes between two updates — so otak-monitor measures the difference rather than the whole folder.

While walking, it remembers the total under each subtree that was expensive to reach. When a file changes, only the subtrees containing that file are measured again; every other total is answered from memory without touching the disk. Which subtrees are remembered is decided by what they cost to walk rather than by how deep they are, so it fits the shape of the project on its own: a repository with a large `node_modules` beside a small `src` remembers `node_modules`, while a monorepo with everything under `packages/` remembers each package. The number of remembered totals is capped, so this costs a fixed amount of memory rather than one that grows with the tree.

Measured on this repository (5.4 GB, 9,171 directories, 51,305 files):

| | Time |
|---|---|
| First measurement | 860 ms |
| After editing one file under `src/` | 1 ms |
| With nothing changed | 0 ms |

Reported changes are collected as they arrive and worked out into re-measurements once, when the next measurement starts. A build reports the same directories thousands of times over, and answering each notification separately is string work for a conclusion that was already reached; collecting them costs one set insertion per notification instead, which takes 10,000 notifications from 63.8 ms to 0.2 ms. Past the point where tracking them costs more than measuring the folder again, the folder is simply measured again.

File change notifications are only a hint about what to measure again — they are never what makes the number correct. VS Code excludes folders such as `node_modules` from watching, and other processes write to the folder without telling anyone, so the whole folder is measured again from scratch every 30 minutes regardless, and clicking the status bar item measures it immediately.

**Virus scanners.** On-access scanners such as Sophos and Microsoft Defender scan when a file's contents are read, not when its metadata is queried. Measuring never opens a file: it lists directories and asks for file attributes with `lstat`, which also means symbolic links and junctions are counted as links instead of being followed out of the workspace. Requests in flight are capped at 8, so the walk never arrives as a burst, and after the first measurement there is usually nothing to walk at all.

Three further levers keep the request count down on machines where a scanner still makes it expensive:

- A window that is not in front does not measure. The size is only ever read from the tooltip or the folder reading, and neither can be seen in a background window — so it hands the folder's lease back instead, and a window that *is* in front picks the measurement up.
- `otakMonitor.folderSize.excludeNames` names directories that are never walked, wherever they appear in the tree. `node_modules` and other build output are usually both the largest and the least interesting part of the total.
- `otakMonitor.folderSize.enabled` turns the walk off outright.

## Status Bar & Clipboard

The status bar starts on CPU usage, and each click moves to the next reading:

```text
CPU: 05%  →  TEMP: 62°C  →  MEM: 50%  →  DISK: 30%  →  DIR: 42.50 MB  →  CPU: 05%
```

Readings the machine cannot take are skipped, and the one you stop on is remembered between sessions. **Switch Status Bar Reading** is also available from the Command Palette and from the tooltip.

Hover over the status bar item to see current metrics:

```text
Current

---

AMD Ryzen 9 7950X 16-Core Processor

CPU Usage: 77% @ 5.24 GHz (base 3.80 GHz)

CPU Temperature: 62 °C

Memory Usage: 1024 MB / 2048 MB (50%)

Disk Usage (C:): 150 GB / 500 GB (30%)

Current Directory Size: 42.50 MB

---

Copy Summary · Switch Reading · Settings
```

**Copy Summary** copies Markdown:

```markdown
# System Metrics (2026/06/28 14:00:00)

## Current Status
- **Processor:** AMD Ryzen 9 7950X 16-Core Processor
- **CPU Usage: 77% @ 5.24 GHz (base 3.80 GHz)**
- **CPU Temperature:** 62 °C
- **Memory Usage:** 1024 MB / 2048 MB (50%)
- **Disk Usage (C:):** 150 GB / 500 GB (30%)
- **Current Directory Size:** 42.50 MB

## 1-Minute Average
- **CPU:** 04%
- **Memory:** 49%
- **Disk:** 30%
```

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `otakMonitor.cpu.showRunningClock` | `true` | Report the clock the processor is actually running at rather than its nominal clock. Windows and Linux. |
| `otakMonitor.cpu.showTemperature` | `true` | Report the CPU temperature where the machine exposes a readable sensor. |
| `otakMonitor.folderSize.enabled` | `true` | Measure the size of the open folder. Off, the directory walk never runs. |
| `otakMonitor.folderSize.excludeNames` | `[]` | Directory names left out of the folder size wherever they appear — for example `node_modules` or `.git`. Excluded directories are never walked. |

## Disk Targets

| Environment | Monitored path |
| --- | --- |
| Windows | `C:\` |
| Windows Codespaces | home directory |
| macOS | `/` |
| Linux | `/` |
| Linux Codespaces | workspace folder from `CODESPACE_VSCODE_FOLDER`, falling back to `/` |

Disk values are shown in GB. If a platform cannot provide disk statistics, otak-monitor keeps the last known values and avoids repeated error spam.

## Security & Privacy

otak-monitor is designed for local development environments where system metrics should stay on the machine.

- **100% local sampling**: CPU, memory, and disk data are collected through local OS APIs.
- **Zero network access**: metrics are never uploaded or transmitted.
- **Local coordination only**: windows share readings through a lease and a small snapshot file inside the extension's own storage directory.
- **No telemetry**: no analytics, usage tracking, or external calls.
- **No account or API key**: nothing to sign in to, nothing to provision.
- **Settings-safe**: it does not change your VS Code configuration.
- **Open source, MIT-licensed**: the implementation is auditable on [GitHub](https://github.com/tsuyoshi-otake/otak-monitor).

## Language Support

VS Code package metadata — the extension description, the command titles, and the setting descriptions — follows your VS Code display language:

**English** · 日本語 · 简体中文 · 繁體中文 · 한국어 · Tiếng Việt · Español · Português (BR) · Français · Deutsch · हिन्दी · Bahasa Indonesia · Italiano · Русский · العربية · Türkçe

The README is maintained in English only.

## Requirements

- VS Code **1.90.0** or newer
- Windows, macOS, Linux, or GitHub Codespaces
- A VS Code window with the status bar visible

## Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-monitor), or run:

```text
ext install odangoo.otak-monitor
```

<details>
<summary><strong>Build from source (VSIX)</strong></summary>

```bash
npm install
npm run package
code --install-extension otak-monitor-1.2.5.vsix
```

Reload VS Code afterwards to activate the extension.

</details>

## Troubleshooting

- **CPU shows `00%` immediately after startup**: the first sample establishes the CPU baseline; wait for the next update.
- **No temperature is shown**: the machine exposes no readable sensor. Most Windows desktops publish no ACPI thermal zone, and macOS keeps its sensors behind the SMC, which needs root — so the row is left out rather than filled with a guess.
- **The clock still reads the base frequency**: check `otakMonitor.cpu.showRunningClock`, and note that macOS reports a fixed clock and virtual machines often report only what `/proc/cpuinfo` says.
- **Disk usage shows `0 GB` or stale values**: the current environment may not expose filesystem stats for the monitored path.
- **Clicking no longer copies**: clicking now switches the reading. Use **Copy Summary** in the tooltip, or **Otak Monitor: Copy System Metrics** from the Command Palette.
- **The copy command fails**: confirm VS Code clipboard access is available, then try **Copy Summary** again.
- **The folder size stays empty**: it is not measured while the window is in the background, and not at all when `otakMonitor.folderSize.enabled` is off.
- **The status bar item is hidden**: confirm the VS Code status bar is visible and no layout customization is hiding right-aligned items.

## Related Extensions

More VS Code extensions by [odangoo](https://marketplace.visualstudio.com/publishers/odangoo):

| Extension | Description |
| --- | --- |
| [**otak-paste**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-paste) | Paste optimized screenshots into Markdown and keep repositories lighter |
| [**otak-proxy**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-proxy) | One-click proxy switching for VS Code, Git, npm, and integrated terminals |
| [**otak-committer**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-committer) | AI-assisted commit messages, pull requests, and issues |
| [**otak-clipboard**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-clipboard) | Copy a folder or the current tab to your clipboard in two clicks |
| [**otak-clock**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-clock) | Dual time-zone clock for the status bar |
| [**otak-pomodoro**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-pomodoro) | A Pomodoro focus timer built into VS Code |
| [**otak-restart**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-restart) | Quick Extension Host and window restart from the status bar |
| [**otak-zen**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-zen) | A calm, distraction-free Zen mode for VS Code |
| [**otak-lsp**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-lsp) | Japanese morphological analysis with grammar checks, semantic highlights, and hovers |
| [**otak-usage**](https://marketplace.visualstudio.com/items?itemName=odangoo.otak-usage) | At-a-glance usage statistics for VS Code |

## License

Released under the [MIT License](LICENSE).

<div align="center">
<br>
<sub>Built by <a href="https://github.com/tsuyoshi-otake">tsuyoshi-otake</a> · <a href="https://marketplace.visualstudio.com/items?itemName=odangoo.otak-monitor">Marketplace</a> · <a href="https://github.com/tsuyoshi-otake/otak-monitor">GitHub</a> · <a href="https://github.com/tsuyoshi-otake/otak-monitor/issues">Issues</a></sub>
</div>
