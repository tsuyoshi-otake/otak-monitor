<p align="center">
  <h1 align="center">otak-monitor</h1>
  <p align="center">A real-time system monitor for VS Code - Track CPU and memory usage with current values and 1-minute averages.</p>
</p>

---

## Usage

1. Find the system monitor in your VS Code status bar
2. View real-time CPU usage percentage
3. Hover to see detailed current and average metrics

## Features

otak-monitor is a lightweight VS Code extension that helps you monitor system resources without leaving your editor.

### Key Features

- **Real-time CPU Monitoring**:
  - Status bar display of CPU usage percentage
  - Updates every second
  - Aggregated across all CPU cores
  - Precise to one decimal place
  - Current CPU clock speed (MHz)
  - 1-minute moving average

- **Memory Usage Tracking**:
  - Detailed memory information
  - Shows used and total memory in MB
  - Memory usage percentage
  - 1-minute moving average
  - Real-time updates

- **Visual Integration**:
  - Clean status bar integration
  - Right-aligned placement
  - Non-intrusive display
  - Detailed hover tooltip showing:
    - Current CPU and memory metrics
    - 1-minute average values
    - Real-time updates

## Requirements

- Visual Studio Code ^1.97.0

## Installation

1. Install the extension from VS Code Marketplace
2. Look for the CPU usage display in your status bar
3. Hover over it to see detailed system information

## Status Bar Display

The extension shows the following information in your status bar:

```
CPU: 45.3%  // Real-time CPU usage
```

With a detailed tooltip showing:
```
Current:
CPU Usage: 45.3% (2400 MHz)
Memory Usage: 1024 MB / 2048 MB (50.0%)

1-Minute Average:
CPU: 42.8%
Memory: 48.5%
```

## Implementation Details

- CPU usage is calculated by comparing idle and total CPU time differences
- Memory values are shown in MB and percentage
- Moving averages are calculated over the last 60 seconds
- Updates occur every second for real-time monitoring
- Minimal performance impact on the system

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

For more information, visit the [GitHub repository](https://github.com/tsuyoshi-otake-system-exe-jp/otak-monitor).

Part of the [otak-series](https://marketplace.visualstudio.com/search?term=otak&target=VSCode) VS Code extensions.
