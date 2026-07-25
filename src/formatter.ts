import * as os from 'os';
import * as vscode from 'vscode';
import { MetricsSnapshot } from './metrics';

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
     * The tooltip body. Kept separate from the `MarkdownString` so a caller can
     * compare it against what it last displayed: rendering the tooltip pushes
     * it across to the UI process, which is worth skipping when nothing moved.
     */
    public static createTooltipText(metrics: MetricsSnapshot): string {
        const cpuDisplay = metrics.cpu.usage.toString().padStart(2, '0');

        return [
            'Current\n\n---\n\n',
            `CPU Usage: ${cpuDisplay}% @ ${metrics.cpu.speed} MHz\n\n`,
            `Memory Usage: ${metrics.memory.used} MB / ${metrics.memory.total} MB (${metrics.memory.usagePercent}%)\n\n`,
            `${this.getDiskLabel()}: ${metrics.disk.total - metrics.disk.free} GB / ${metrics.disk.total} GB (${metrics.disk.usagePercent}%)\n\n`,
            `Current Directory Size: ${this.formatBytes(metrics.workspace.bytes)}`
        ].join('');
    }

    public static createTooltip(metrics: MetricsSnapshot): vscode.MarkdownString {
        const mdTooltip = new vscode.MarkdownString();
        mdTooltip.appendMarkdown(this.createTooltipText(metrics));

        return mdTooltip;
    }

    public static createClipboardText(metrics: MetricsSnapshot): string {
        const timestamp = new Date().toLocaleString();
        const cpuDisplay = metrics.cpu.usage.toString().padStart(2, '0');
        
        return [
            `# System Metrics (${timestamp})`,
            '',
            '## Current Status',
            `- **CPU Usage:** ${cpuDisplay}% @ ${metrics.cpu.speed} MHz`,
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

    public static getStatusBarText(cpuUsage: number): string {
        return `CPU: ${cpuUsage === 100 ? 
            "100" : 
            cpuUsage.toString().padStart(2, '0')}%`;
    }
}
