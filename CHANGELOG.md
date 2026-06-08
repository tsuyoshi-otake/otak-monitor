# Change Log

All notable changes to the "otak-monitor" extension will be documented in this file.

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
