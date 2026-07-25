import * as vscode from 'vscode';
import { MetricsCollector, MetricsSnapshot } from './metrics';
import { MetricsFormatter } from './formatter';
import { MonitorCoordinator } from './monitorCoordinator';
import { WorkspaceSizeSampler } from './samplers';

const UPDATE_INTERVAL = 2500;

export function activate(context: vscode.ExtensionContext) {
    const controller = new MonitorController();
    context.subscriptions.push(controller);
    controller.start(context);
}

export function deactivate() {}

function workspacePath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * The directory every window of this installation shares, which is where the
 * leases and snapshots live. A non-`file` storage location (a web host) leaves
 * the windows unable to coordinate, so each one samples for itself.
 */
function sharedStorageDir(context: vscode.ExtensionContext): string {
    const storage = context.globalStorageUri;
    return storage?.scheme === 'file' ? storage.fsPath : '';
}

class MonitorController implements vscode.Disposable {
    private readonly workspaceSizeSampler = new WorkspaceSizeSampler(workspacePath);
    private readonly metricsCollector = new MetricsCollector(
        undefined,
        undefined,
        undefined,
        this.workspaceSizeSampler
    );
    private readonly statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    private coordinator: MonitorCoordinator | undefined;
    private timer: NodeJS.Timeout | undefined;
    private timerIntervalMs = 0;
    private latestMetrics: MetricsSnapshot | undefined;
    private updateInFlight = false;
    private renderedText = '';
    private renderedTooltip = '';

    start(context: vscode.ExtensionContext): void {
        this.coordinator = new MonitorCoordinator(
            this.metricsCollector,
            sharedStorageDir(context),
            workspacePath
        );
        this.statusBarItem.command = 'otak-monitor.copyMetrics';
        context.subscriptions.push(this.statusBarItem);

        context.subscriptions.push(
            vscode.commands.registerCommand('otak-monitor.copyMetrics', () => {
                return this.copyMetrics();
            })
        );

        this.watchWorkspace(context);

        vscode.window.onDidChangeWindowState(() => {
            // A window that just came back to the front has been updating
            // slowly, and its tooltip has not been maintained at all.
            void this.updateStatus();
            this.startTimer();
        }, null, context.subscriptions);

        void this.updateStatus();
        this.startTimer();
    }

    dispose(): void {
        this.stopTimer();
        this.coordinator?.releaseSync();
        this.statusBarItem.dispose();
    }

    /**
     * Tell the sampler which part of the folder changed, so its next update
     * measures that part instead of the whole tree. This is an optimisation and
     * not a source of truth: VS Code excludes folders such as `node_modules`
     * from watching, and the sampler measures everything again periodically for
     * exactly that reason.
     */
    private watchWorkspace(context: vscode.ExtensionContext): void {
        if (!workspacePath()) {
            return;
        }

        const watcher = vscode.workspace.createFileSystemWatcher('**/*');
        const changed = (uri: vscode.Uri): void => this.workspaceSizeSampler.markChanged(uri.fsPath);
        watcher.onDidCreate(changed, null, context.subscriptions);
        watcher.onDidChange(changed, null, context.subscriptions);
        watcher.onDidDelete(changed, null, context.subscriptions);
        context.subscriptions.push(watcher);
    }

    private async copyMetrics(): Promise<void> {
        try {
            const metrics = await this.refresh({ refreshDisk: true, refreshWorkspace: true });
            this.latestMetrics = metrics;
            this.render(metrics);
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
        this.timerIntervalMs = this.getEffectiveInterval();
        this.timer = setInterval(() => {
            void this.updateStatus();
        }, this.timerIntervalMs) as NodeJS.Timeout;
    }

    private stopTimer(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private getEffectiveInterval(): number {
        if (vscode.window.state.focused) {
            return UPDATE_INTERVAL;
        }
        // A window in the background is only keeping its status bar roughly
        // current. One that is also following another window's readings has
        // nothing to sample either, so it can wake up far less often.
        return this.coordinator?.isMachineLeader === false ? UPDATE_INTERVAL * 4 : UPDATE_INTERVAL * 2;
    }

    /**
     * Ask for the current metrics. Whether that means sampling the machine or
     * reading what another window sampled is the coordinator's decision, so the
     * refresh flags are a request rather than a promise of fresh values.
     */
    private refresh(options: { refreshDisk?: boolean; refreshWorkspace?: boolean } = {}): Promise<MetricsSnapshot> {
        return this.coordinator
            ? this.coordinator.refresh(options)
            : this.metricsCollector.getAllMetrics(options);
    }

    private async updateStatus(): Promise<void> {
        if (this.updateInFlight) {
            return;
        }

        this.updateInFlight = true;
        try {
            this.latestMetrics = await this.refresh();
            this.render(this.latestMetrics);
            if (this.timerIntervalMs !== this.getEffectiveInterval()) {
                this.startTimer(); // this window took over the sampling, or handed it on
            }
        } catch (error) {
            console.error('Failed to update system metrics:', error);
        } finally {
            this.updateInFlight = false;
        }
    }

    /**
     * Every assignment here crosses over to the UI process, so the ones that
     * would change nothing are worth skipping — an idle machine reports the
     * same numbers for minutes at a time. The tooltip is skipped entirely while
     * the window is in the background, where it cannot be hovered.
     */
    private render(metrics: MetricsSnapshot): void {
        const text = MetricsFormatter.getStatusBarText(metrics.cpu.usage);
        if (text !== this.renderedText) {
            this.statusBarItem.text = text;
            this.renderedText = text;
            this.statusBarItem.show();
        }

        if (!vscode.window.state.focused) {
            return;
        }
        const tooltip = MetricsFormatter.createTooltipText(metrics);
        if (tooltip !== this.renderedTooltip) {
            this.statusBarItem.tooltip = MetricsFormatter.createTooltip(metrics);
            this.renderedTooltip = tooltip;
        }
    }
}
