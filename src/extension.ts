import * as vscode from 'vscode';
import { CpuSensor, CpuSensorOptions, createCpuSensor } from './cpuSensor';
import { MetricsCollector, MetricsSnapshot } from './metrics';
import { MetricsFormatter, StatusBarView, canShowStatusBarView, isStatusBarView, nextStatusBarView } from './formatter';
import { MonitorCoordinator } from './monitorCoordinator';
import { CpuSampler, WorkspaceSizeSampler } from './samplers';

const UPDATE_INTERVAL = 2500;

/** Where the reading the status bar shows is remembered between sessions. */
const STATUS_BAR_VIEW_KEY = 'otak-monitor.statusBarView';

export function activate(context: vscode.ExtensionContext) {
    const controller = new MonitorController();
    context.subscriptions.push(controller);
    controller.start(context);
}

export function deactivate() {}

function workspacePath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function configuration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('otakMonitor');
}

function sensorOptions(): CpuSensorOptions {
    const config = configuration();
    return {
        clock: config.get<boolean>('cpu.showRunningClock', true),
        temperature: config.get<boolean>('cpu.showTemperature', true)
    };
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
    private readonly workspaceSizeSampler = new WorkspaceSizeSampler(
        workspacePath,
        undefined,
        undefined,
        undefined,
        undefined,
        () => configuration().get<string[]>('folderSize.excludeNames', [])
    );
    /**
     * Reads the clock and the temperature, which no cross-platform API exposes.
     * It is replaced rather than reconfigured when the settings change, so the
     * platform-specific machinery has one shape and no way to be half-running.
     */
    private cpuSensor: CpuSensor = createCpuSensor(sensorOptions());
    private readonly metricsCollector = new MetricsCollector(
        new CpuSampler(undefined, () => this.cpuSensor.read()),
        undefined,
        undefined,
        this.workspaceSizeSampler
    );
    private readonly statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    private coordinator: MonitorCoordinator | undefined;
    private context: vscode.ExtensionContext | undefined;
    private timer: NodeJS.Timeout | undefined;
    private timerIntervalMs = 0;
    private latestMetrics: MetricsSnapshot | undefined;
    private updateInFlight = false;
    private renderedText = '';
    private renderedTooltip = '';
    private view: StatusBarView = 'cpu';
    private sensorRunning = false;

    start(context: vscode.ExtensionContext): void {
        this.context = context;
        this.coordinator = new MonitorCoordinator(
            this.metricsCollector,
            sharedStorageDir(context),
            workspacePath,
            { wantsWorkspaceMeasurement: () => this.wantsFolderSize() }
        );

        const remembered = context.globalState.get(STATUS_BAR_VIEW_KEY);
        this.view = isStatusBarView(remembered) ? remembered : 'cpu';
        this.statusBarItem.command = 'otak-monitor.cycleStatusBarView';
        context.subscriptions.push(this.statusBarItem);

        context.subscriptions.push(
            vscode.commands.registerCommand('otak-monitor.copyMetrics', () => {
                return this.copyMetrics();
            }),
            vscode.commands.registerCommand('otak-monitor.cycleStatusBarView', () => {
                return this.cycleStatusBarView();
            })
        );

        this.watchWorkspace(context);

        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('otakMonitor.cpu')) {
                this.replaceSensor();
            }
            if (event.affectsConfiguration('otakMonitor')) {
                void this.updateStatus();
            }
        }, null, context.subscriptions);

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
        this.cpuSensor.stop();
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

    /** Show the next reading, and go on showing it in later sessions. */
    private async cycleStatusBarView(): Promise<void> {
        this.view = nextStatusBarView(this.view, this.latestMetrics);
        await this.context?.globalState.update(STATUS_BAR_VIEW_KEY, this.view);
        if (this.latestMetrics) {
            this.render(this.latestMetrics);
        }
    }

    /**
     * Whether the folder size is worth measuring right now. It is only ever read
     * from the tooltip or the folder view, neither of which a window that is not
     * in front can show — so a background window walking the folder would be
     * making thousands of filesystem requests nobody can see the result of, and
     * on a machine with an on-access virus scanner, every one of those requests
     * is one the scanner inspects.
     */
    private wantsFolderSize(): boolean {
        return vscode.window.state.focused && configuration().get<boolean>('folderSize.enabled', true);
    }

    private replaceSensor(): void {
        this.cpuSensor.stop();
        this.sensorRunning = false;
        this.cpuSensor = createCpuSensor(sensorOptions());
        this.syncSensor();
    }

    /**
     * Run the sensor in the window that samples for the machine, and only there.
     * Its readings are the same in every window, and they travel to the others
     * in the shared snapshot along with the rest of the machine's numbers.
     */
    private syncSensor(): void {
        const wanted = this.coordinator?.isMachineLeader ?? true;
        if (wanted === this.sensorRunning) {
            return;
        }
        this.sensorRunning = wanted;
        if (wanted) {
            this.cpuSensor.start();
        } else {
            this.cpuSensor.stop();
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
            this.syncSensor();
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
        // A reading this machine has stopped being able to take — a sensor
        // switched off, or a snapshot from a window with no thermal sensor —
        // shows CPU usage instead of nothing at all, while the choice itself is
        // kept in case the reading comes back.
        const view = canShowStatusBarView(this.view, metrics) ? this.view : 'cpu';
        const text = MetricsFormatter.getStatusBarText(metrics, view);
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
