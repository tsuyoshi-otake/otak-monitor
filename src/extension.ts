import * as vscode from 'vscode';
import { MetricsCollector } from './metrics';
import { MetricsFormatter } from './formatter';

let timer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('otak-monitor is now active!');

    const metricsCollector = new MetricsCollector();

    // Create a status bar item
    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = 'otak-monitor.copyMetrics';
    context.subscriptions.push(statusBarItem);

    // Register the command to be executed on click
    let disposable = vscode.commands.registerCommand('otak-monitor.copyMetrics', () => {
        const metrics = metricsCollector.getAllMetrics();
        
        // Update tooltip
        statusBarItem.tooltip = MetricsFormatter.createTooltip(metrics);
        
        // Copy to clipboard
        const clipboardText = MetricsFormatter.createClipboardText(metrics);
        vscode.env.clipboard.writeText(clipboardText).then(() => {
            vscode.window.showInformationMessage('System metrics copied to clipboard');
        });
    });
    context.subscriptions.push(disposable);

    // Timer reset procedure
    function startTimer() {
        if (timer) {
            clearInterval(timer);
        }
        timer = setInterval(updateStatus, getEffectiveInterval()) as NodeJS.Timeout;
    }

    // Determine update interval based on VS Code window focus state
    function getEffectiveInterval(): number {
        const UPDATE_INTERVAL = 5000; // Base update every 5 seconds
        return vscode.window.state.focused ? UPDATE_INTERVAL : UPDATE_INTERVAL * 2;
    }

    // Update the status bar (CPU usage only)
    function updateStatus() {
        const cpuInfo = metricsCollector.getCPUInfo();
        statusBarItem.text = MetricsFormatter.getStatusBarText(cpuInfo.usage);
        statusBarItem.show();
    }

    // Reset timer when focus state changes
    vscode.window.onDidChangeWindowState(() => {
        startTimer();
    }, null, context.subscriptions);

    // Start initial timer
    startTimer();
}

export function deactivate() {
    if (timer) {
        clearInterval(timer);
    }
}