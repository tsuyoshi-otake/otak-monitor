import * as os from 'os';
import * as vscode from 'vscode';
import { MetricsSnapshot } from './metrics';

/** Which single reading the status bar shows. */
export type StatusBarView = 'cpu' | 'temperature' | 'memory' | 'disk' | 'folder';

/** The order a click moves through the readings. */
export const STATUS_BAR_VIEWS: readonly StatusBarView[] = ['cpu', 'temperature', 'memory', 'disk', 'folder'];

export function isStatusBarView(raw: unknown): raw is StatusBarView {
    return typeof raw === 'string' && (STATUS_BAR_VIEWS as readonly string[]).includes(raw);
}

/**
 * Whether a reading has anything to say on this machine. Only the temperature
 * can be missing outright, and a machine with no sensor should not have to
 * click past a permanently empty reading to get back to the ones it has.
 */
export function canShowStatusBarView(view: StatusBarView, metrics: MetricsSnapshot | undefined): boolean {
    return view !== 'temperature' || metrics === undefined || metrics.cpu.temperatureC !== undefined;
}

/** The next reading a click should show, skipping any this machine cannot take. */
export function nextStatusBarView(current: StatusBarView, metrics?: MetricsSnapshot): StatusBarView {
    const from = Math.max(0, STATUS_BAR_VIEWS.indexOf(current));
    for (let step = 1; step <= STATUS_BAR_VIEWS.length; step++) {
        const candidate = STATUS_BAR_VIEWS[(from + step) % STATUS_BAR_VIEWS.length];
        if (canShowStatusBarView(candidate, metrics)) {
            return candidate;
        }
    }
    return current;
}

export class MetricsFormatter {
    public static formatBytes(bytes: number | undefined): string {
        if (bytes === undefined) {
            return 'N/A';
        }

        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = bytes;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex++;
        }

        const precision = unitIndex === 0 ? 0 : 2;
        return `${value.toFixed(precision)} ${units[unitIndex]}`;
    }

    /**
     * A clock in the unit people quote it in. Anything at or above a gigahertz
     * reads as gigahertz — which is what the operating system's own task
     * manager shows, and what makes a running clock comparable to the number
     * printed on the box the machine came in.
     */
    public static formatClock(megahertz: number | undefined): string {
        if (megahertz === undefined || megahertz <= 0) {
            return 'N/A';
        }
        return megahertz >= 1000 ? `${(megahertz / 1000).toFixed(2)} GHz` : `${Math.round(megahertz)} MHz`;
    }

    public static getDiskLabel(): string {
        switch (os.platform()) {
            case 'win32':
                return process.env.CODESPACES ?
                    'Disk Usage (Home)' :
                    'Disk Usage (C:)';
            case 'darwin':
                return 'Disk Usage (/)';
            case 'linux':
                return process.env.CODESPACES ?
                    'Disk Usage (Workspace)' :
                    'Disk Usage (/)';
            default:
                return 'Disk Usage';
        }
    }

    /**
     * The CPU line. The clock the processor is running at is the one worth
     * leading with; the nominal clock follows it only when the two differ,
     * where it says whether the machine is boosting or being held back.
     */
    public static formatCpuLine(metrics: MetricsSnapshot): string {
        const usage = `CPU Usage: ${metrics.cpu.usage.toString().padStart(2, '0')}%`;
        const { speed, currentSpeed } = metrics.cpu;
        if (currentSpeed === undefined) {
            return speed > 0 ? `${usage} @ ${this.formatClock(speed)}` : usage;
        }
        const base = speed > 0 && Math.abs(currentSpeed - speed) >= 50
            ? ` (base ${this.formatClock(speed)})`
            : '';
        return `${usage} @ ${this.formatClock(currentSpeed)}${base}`;
    }

    /**
     * The tooltip body. Kept separate from the `MarkdownString` so a caller can
     * compare it against what it last displayed: rendering the tooltip pushes
     * it across to the UI process, which is worth skipping when nothing moved.
     */
    public static createTooltipText(metrics: MetricsSnapshot): string {
        const { model, temperatureC } = metrics.cpu;

        return [
            'Current\n\n---\n\n',
            model === undefined ? '' : `${model}\n\n`,
            `${this.formatCpuLine(metrics)}\n\n`,
            temperatureC === undefined ? '' : `CPU Temperature: ${temperatureC} °C\n\n`,
            `Memory Usage: ${metrics.memory.used} MB / ${metrics.memory.total} MB (${metrics.memory.usagePercent}%)\n\n`,
            `${this.getDiskLabel()}: ${metrics.disk.total - metrics.disk.free} GB / ${metrics.disk.total} GB (${metrics.disk.usagePercent}%)\n\n`,
            `Current Directory Size: ${this.formatBytes(metrics.workspace.bytes)}\n\n`,
            '---\n\n',
            '[$(copy) Copy Summary](command:otak-monitor.copyMetrics "Copy these metrics to the clipboard as Markdown")',
            ' · [$(list-selection) Switch Reading](command:otak-monitor.cycleStatusBarView "Show the next reading in the status bar")',
            ' · [$(gear) Settings](command:workbench.action.openSettings?%5B%22otakMonitor%22%5D "Open the otak-monitor settings")'
        ].join('');
    }

    public static createTooltip(metrics: MetricsSnapshot): vscode.MarkdownString {
        const mdTooltip = new vscode.MarkdownString();
        // The footer runs commands, and a command link does nothing at all in a
        // tooltip that is not trusted.
        mdTooltip.isTrusted = true;
        mdTooltip.supportThemeIcons = true;
        mdTooltip.appendMarkdown(this.createTooltipText(metrics));

        return mdTooltip;
    }

    public static createClipboardText(metrics: MetricsSnapshot): string {
        const timestamp = new Date().toLocaleString();
        const { model, temperatureC } = metrics.cpu;

        return [
            `# System Metrics (${timestamp})`,
            '',
            '## Current Status',
            ...(model === undefined ? [] : [`- **Processor:** ${model}`]),
            `- **${this.formatCpuLine(metrics)}**`,
            ...(temperatureC === undefined ? [] : [`- **CPU Temperature:** ${temperatureC} °C`]),
            `- **Memory Usage:** ${metrics.memory.used} MB / ${metrics.memory.total} MB (${metrics.memory.usagePercent}%)`,
            `- **${this.getDiskLabel()}:** ${metrics.disk.total - metrics.disk.free} GB / ${metrics.disk.total} GB (${metrics.disk.usagePercent}%)`,
            `- **Current Directory Size:** ${this.formatBytes(metrics.workspace.bytes)}`,
            '',
            '## 1-Minute Average',
            `- **CPU:** ${metrics.averages.cpuAvg.toString().padStart(2, '0')}%`,
            `- **Memory:** ${metrics.averages.memoryAvg}%`,
            `- **Disk:** ${metrics.averages.diskAvg}%`
        ].join('\n');
    }

    /**
     * One reading, in a width that does not move as the number changes: a
     * status bar item that resizes drags everything to its left along with it.
     */
    public static getStatusBarText(metrics: MetricsSnapshot, view: StatusBarView = 'cpu'): string {
        switch (view) {
            case 'temperature':
                return metrics.cpu.temperatureC === undefined
                    ? 'TEMP: N/A'
                    : `TEMP: ${metrics.cpu.temperatureC.toString().padStart(2, '0')}°C`;
            case 'memory':
                return `MEM: ${this.formatPercent(metrics.memory.usagePercent)}`;
            case 'disk':
                return `DISK: ${this.formatPercent(metrics.disk.usagePercent)}`;
            case 'folder':
                return `DIR: ${this.formatBytes(metrics.workspace.bytes)}`;
            default:
                return `CPU: ${this.formatPercent(metrics.cpu.usage)}`;
        }
    }

    private static formatPercent(value: number): string {
        return `${value === 100 ? '100' : value.toString().padStart(2, '0')}%`;
    }
}
