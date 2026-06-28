<div align="center">

# otak-monitor

**Watch CPU, memory, and disk usage without leaving VS Code.**

otak-monitor keeps a lightweight CPU indicator in your status bar, shows current system metrics on hover, and copies a Markdown snapshot when you click it.

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
4. Hover to inspect CPU, memory, and disk usage.
5. Click the status bar item to copy a Markdown metrics snapshot.

![otak-monitor status bar and tooltip](images/otak-monitor.png)

## Capabilities

- **Status bar CPU monitor**: shows current CPU usage in a stable-width `CPU: 05%` format.
- **Current system tooltip**: hover for CPU usage and clock speed, memory usage, and disk usage.
- **Markdown clipboard snapshot**: click once to copy current metrics and 1-minute averages.
- **Rolling averages**: keeps a fixed-size history of 24 samples for CPU, memory, and disk averages.
- **Efficient refresh cadence**: updates every 2.5 seconds while the VS Code window is focused and every 5 seconds while unfocused.
- **Cached disk sampling**: avoids repeated synchronous disk checks by caching disk stats between samples.
- **Cross-platform paths**: monitors the right root path on Windows, macOS, Linux, and GitHub Codespaces.
- **Local-only operation**: no accounts, API keys, telemetry, or network calls are required for monitoring.

## How It Works

When VS Code finishes startup, otak-monitor:

1. Creates a right-aligned status bar item.
2. Samples aggregate CPU usage from OS CPU time deltas.
3. Reads memory usage from the operating system.
4. Samples disk usage with a platform-aware monitor path.
5. Adds each sample to a fixed-size rolling history.
6. Updates the status bar text and hover tooltip.

Clicking the status bar item refreshes disk usage, writes a Markdown report to the clipboard, and shows a short confirmation message.

## Status Bar & Clipboard

The status bar displays CPU usage:

```text
CPU: 05%
```

Hover over the status bar item to see current metrics:

```text
Current

---

CPU Usage: 05% @ 2400 MHz

Memory Usage: 1024 MB / 2048 MB (50%)

Disk Usage (C:): 150 GB / 500 GB (30%)
```

Click the status bar item to copy Markdown:

```markdown
# System Metrics (2026/06/28 14:00:00)

## Current Status
- **CPU Usage:** 05% @ 2400 MHz
- **Memory Usage:** 1024 MB / 2048 MB (50%)
- **Disk Usage (C:):** 150 GB / 500 GB (30%)

## 1-Minute Average
- **CPU:** 04%
- **Memory:** 49%
- **Disk:** 30%
```

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
- **No telemetry**: no analytics, usage tracking, or external calls.
- **No account or API key**: nothing to sign in to, nothing to provision.
- **Settings-safe**: it does not change your VS Code configuration.
- **Open source, MIT-licensed**: the implementation is auditable on [GitHub](https://github.com/tsuyoshi-otake/otak-monitor).

## Language Support

VS Code package metadata, including the extension description and copy command title, follows your VS Code display language:

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
- **Disk usage shows `0 GB` or stale values**: the current environment may not expose filesystem stats for the monitored path.
- **The copy command fails**: confirm VS Code clipboard access is available, then try clicking the status bar item again.
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
