import * as vscode from 'vscode';
import { MetricsCollector, MetricsSnapshot } from './metrics';
import { MetricsFormatter } from './formatter';

const UPDATE_INTERVAL = 2500;

export function activate(context: vscode.ExtensionContext) {
    const controller = new MonitorController();
    context.subscriptions.push(controller);
    controller.start(context);
}

export function deactivate() {}

class MonitorController implements vscode.Disposable {
    private readonly metricsCollector = new MetricsCollector();
    private readonly statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    private timer: NodeJS.Timeout | undefined;
    private latestMetrics: MetricsSnapshot | undefined;

    start(context: vscode.ExtensionContext): void {
        this.statusBarItem.command = 'otak-monitor.copyMetrics';
        context.subscriptions.push(this.statusBarItem);

        context.subscriptions.push(
            vscode.commands.registerCommand('otak-monitor.copyMetrics', () => {
                return this.copyMetrics();
            })
        );

        vscode.window.onDidChangeWindowState(() => {
            this.startTimer();
        }, null, context.subscriptions);

        this.updateStatus();
        this.startTimer();
    }

    dispose(): void {
        this.stopTimer();
        this.statusBarItem.dispose();
    }

    private async copyMetrics(): Promise<void> {
        try {
            const metrics = this.metricsCollector.getAllMetrics({ refreshDisk: true });
            this.latestMetrics = metrics;
            this.statusBarItem.tooltip = MetricsFormatter.createTooltip(metrics);
            await vscode.env.clipboard.writeText(MetricsFormatter.createClipboardText(metrics));
            vscode.window.showInformationMessage('System metrics copied to clipboard (Markdown format)');
        } catch (error) {
            console.error('Failed to copy system metrics:', error);
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to copy system metrics: ${message}`);
        }
    }

    private startTimer(): void {
        this.stopTimer();
        this.timer = setInterval(() => {
            this.updateStatus();
        }, this.getEffectiveInterval()) as NodeJS.Timeout;
    }

    private stopTimer(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private getEffectiveInterval(): number {
        return vscode.window.state.focused ? UPDATE_INTERVAL : UPDATE_INTERVAL * 2;
    }

    private updateStatus(): void {
        this.latestMetrics = this.metricsCollector.getAllMetrics();
        this.statusBarItem.text = MetricsFormatter.getStatusBarText(this.latestMetrics.cpu.usage);
        this.statusBarItem.tooltip = MetricsFormatter.createTooltip(this.latestMetrics);
        this.statusBarItem.show();
    }
}
