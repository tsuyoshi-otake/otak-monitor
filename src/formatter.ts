import * as os from 'os';
import * as vscode from 'vscode';

export class MetricsFormatter {
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

    public static createTooltip(metrics: {
        cpu: { usage: number; speed: number };
        memory: { used: number; total: number; usagePercent: number };
        disk: { free: number; total: number; usagePercent: number };
        averages: { cpuAvg: number; memoryAvg: number; diskAvg: number };
    }): vscode.MarkdownString {
        const mdTooltip = new vscode.MarkdownString();
        const cpuDisplay = metrics.cpu.usage.toString().padStart(2, '0');

        // Current metrics section
        mdTooltip.appendMarkdown("Current\n\n---\n\n");
        mdTooltip.appendMarkdown(
            `CPU Usage: ${cpuDisplay}% @ ${metrics.cpu.speed} MHz\n\n`
        );
        mdTooltip.appendMarkdown(
            `Memory Usage: ${metrics.memory.used} MB / ${metrics.memory.total} MB (${metrics.memory.usagePercent}%)\n\n`
        );
        mdTooltip.appendMarkdown(
            `${this.getDiskLabel()}: ${metrics.disk.total - metrics.disk.free} GB / ${metrics.disk.total} GB (${metrics.disk.usagePercent}%)`
        );

        return mdTooltip;
    }

    public static createClipboardText(metrics: {
        cpu: { usage: number; speed: number };
        memory: { used: number; total: number; usagePercent: number };
        disk: { free: number; total: number; usagePercent: number };
        averages: { cpuAvg: number; memoryAvg: number; diskAvg: number };
    }): string {
        const timestamp = new Date().toLocaleString();
        const cpuDisplay = metrics.cpu.usage.toString().padStart(2, '0');
        
        return [
            `# System Metrics (${timestamp})`,
            '',
            '## Current Status',
            `- **CPU Usage:** ${cpuDisplay}% @ ${metrics.cpu.speed} MHz`,
            `- **Memory Usage:** ${metrics.memory.used} MB / ${metrics.memory.total} MB (${metrics.memory.usagePercent}%)`,
            `- **${this.getDiskLabel()}:** ${metrics.disk.total - metrics.disk.free} GB / ${metrics.disk.total} GB (${metrics.disk.usagePercent}%)`,
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