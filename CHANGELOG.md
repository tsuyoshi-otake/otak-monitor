# Change Log

All notable changes to the "otak-monitor" extension will be documented in this file.

## [1.3.0] - 2026-07-26

### Added
- Report the clock the processor is actually running at instead of the nominal clock `os.cpus()` reports and never moves off: base clock × `% Processor Performance` from WMI on Windows, `scaling_cur_freq` (falling back to `/proc/cpuinfo`) on Linux, and `sysctl hw.cpufrequency` on macOS. The nominal clock is named beside it only when the two differ (#8).
- Report the CPU temperature where the machine exposes a readable sensor — an ACPI thermal zone on Windows, the hottest processor `thermal_zone` on Linux. Machines without one, macOS included, get no row and no status bar reading rather than a zero (#9).
- Switch the status bar reading by clicking it: CPU usage, temperature, memory, disk, and folder size. Readings the machine cannot take are skipped, and the chosen one is remembered between sessions (#10).
- Name the processor in the tooltip and in the Markdown summary, tidying what the OS reports and leaving the line out where the machine reports a placeholder rather than a name (#13).
- Add **Copy Summary**, **Switch Reading**, and **Settings** links to the tooltip, matching otak-usage (#11).
- Add `otakMonitor.cpu.showRunningClock`, `otakMonitor.cpu.showTemperature`, `otakMonitor.folderSize.enabled`, and `otakMonitor.folderSize.excludeNames`, with descriptions in all 16 display languages.

### Changed
- Take the platform readings in one long-lived process rather than one per sample, run it only in the window that samples for the machine, and stop it when that window is gone (#8, #9).
- Stop measuring the folder size in a window that is not in front, and hand that folder's lease back so a window that is picks the measurement up. Every request the walk does not make is one an on-access virus scanner does not inspect, and the size is only ever read from a tooltip a background window cannot show (#12).
- Skip the directory names listed in `otakMonitor.folderSize.excludeNames` entirely — they are neither measured nor walked — and measure the folder again from scratch when that list changes (#12).

### Fixed
- Leave a reading the machine could not take out of the CPU metrics entirely instead of carrying it as an undefined value. Readings are published to the other windows as JSON, which drops an undefined value, so a window that sampled held a different object from one that read the published copy (#8).

## [1.2.8] - 2026-07-26

### Changed
- Collect reported file changes and work out what they invalidate once, at the next measurement, instead of on every notification, which takes 10,000 notifications from 63.8 ms to 0.2 ms and closes a window where a change reported during a walk could be missed until the next full scan (#6).
- Measure the whole folder again rather than track more changed paths than are worth listing, so a build or a branch switch costs a fixed amount of memory (#6).

## [1.2.7] - 2026-07-26

### Changed
- Elect one window to sample CPU, memory, and disk usage and publish the readings to the others, so the sampling cost stays flat as more VS Code windows are opened (#4).
- Share the workspace directory-size measurement between windows that opened the same folder, and hand sampling over to another window within the lease window when the sampling one closes (#4).
- Measure the workspace directory in the background instead of holding up the status bar update, and reuse each measurement for five minutes (#4).
- Remember the total under each expensive subtree and re-measure only the subtrees a file change touched, which takes an update after a one-file edit from 860 ms to 1 ms on a 5.4 GB workspace, and to nothing at all when the workspace has not changed (#4).
- Choose the remembered subtrees by what they cost to walk rather than by their depth, and cap how many are kept, so the memory this costs does not grow with the workspace (#4).
- Measure the whole workspace again every 30 minutes, and whenever the status bar item is clicked, so a change no file watcher reported is still picked up (#4).
- Measure with directory listings and `lstat` only, never opening a file and never following symbolic links or junctions, so an on-access virus scanner has nothing to scan; keep filesystem requests in flight capped at 8 so the walk cannot arrive as a burst (#4).
- Skip status bar and tooltip assignments that would not change what is displayed, and leave the tooltip alone entirely while the window is in the background (#4).
- Update less often while a window is in the background, and less often still when it is following another window's readings (#4).

## [1.2.6] - 2026-07-11

### Added
- Display the current workspace directory size below disk usage in tooltips and copied metrics.
- Publish tagged releases to the Open VSX Registry in addition to Visual Studio Marketplace.

## [1.2.5] - 2026-06-28

### Changed
- Replaced the Marketplace icon with the new otak-monitor icon asset.
- Updated the README using the current otak-paste documentation structure.
- Localized VS Code package metadata for the extension description and copy command title.

## [1.2.4] - 2026-06-10

### Changed
- Maintenance release with no functional changes.
- Verified operation on Windows, macOS, and Linux (including GitHub Codespaces) with the full test suite on each platform.

## [1.2.3] - 2026-06-08

### Changed
- Split CPU, memory, disk, path resolution, and rolling average responsibilities out of the metrics service.
- Replaced history `shift()` and per-sample `reduce()` averaging with fixed-size O(1) rolling totals.
- Cached disk usage sampling to reduce synchronous filesystem work on the extension host.
- Updated packaging/test dependencies and regenerated the lockfile for vulnerability remediation.

### Fixed
- Registered timer cleanup through a disposable controller and returned the copy command promise to VS Code.
- Added command error handling for clipboard copy failures.

## [1.2.2] - 2024-03-01

### Changed
- CPU usage display format
  - Changed to two-digit format (e.g., "005%" instead of "05%")
- Reduced clipboard copy notification duration from 5 to 2 seconds

## [1.2.1] - 2024-02-28

### Changed
- CPU usage display format
  - Changed to two-digit format (e.g., "05%" instead of "005%")
- Reduced clipboard copy notification duration from 5 to 2 seconds

## [1.2.0] - 2024-02-24

### Added
- Clipboard integration
  - Copy system metrics in Markdown format
  - Automatic notification with 5-second timeout
  - Well-formatted output with headers and styling

### Enhanced
- Performance optimization
  - Split code into modular components
  - Separate metrics collection and formatting logic
  - Improved code maintainability

### Changed
- Status bar behavior
  - Status bar now shows CPU usage only
  - Regular tooltip updates without requiring click
  - More efficient update cycle

## [1.1.1] - 2024-02-22

### Enhanced
- Improved disk label display for different operating systems
  - Windows: Shows "Disk Usage (C:)" or "Disk Usage (Home)" for Codespaces
  - Linux/macOS: Shows "Disk Usage (/)" or "Disk Usage (Workspace)" for Codespaces

## [1.1.0] - 2024-02-22

### Added
- Disk usage monitoring
  - Shows used and total space in GB
  - Disk usage percentage display
  - One-minute moving average
  - Integration with tooltip display

### Enhanced
- Cross-platform support
  - Windows: C: drive monitoring
  - macOS: Root volume (/) monitoring
  - Linux: Root filesystem (/) monitoring

### Added
- GitHub Codespaces support
  - Automatic environment detection
  - Workspace-aware disk monitoring
  - Adaptive path resolution for containers
  - Consistent monitoring experience in remote development

## [1.0.0] - 2024-02-22

### Added
- Real-time CPU usage monitoring
  - Display in status bar
  - Updates every 5 seconds
  - Shows usage with one decimal precision
  - Current CPU clock speed display

- Memory usage monitoring
  - Used/Total memory in MB
  - Memory usage percentage display

- One-minute moving averages
  - CPU usage average
  - Memory usage average
  - Uses 12 data points at 5-second intervals

- Markdown-formatted tooltip
  - Updates only on hover
  - Clear presentation of current stats and moving averages
  - Structured display with current values and historical data
