import { AverageMetrics, RollingMetricsHistory } from './rollingAverage';
import {
    CpuMetrics,
    CpuSampler,
    DiskMetrics,
    DiskSampler,
    MemoryMetrics,
    MemorySampler,
    WorkspaceSizeMetrics,
    WorkspaceSizeSampler
} from './samplers';

/**
 * The readings that describe the machine rather than the window. They are the
 * same in every VS Code window, which is what makes them worth sampling once
 * and sharing.
 */
export interface MachineMetrics {
    cpu: CpuMetrics;
    memory: MemoryMetrics;
    disk: DiskMetrics;
    averages: AverageMetrics;
}

export interface MetricsSnapshot extends MachineMetrics {
    workspace: WorkspaceSizeMetrics;
}

export class MetricsCollector {
    private readonly metricsHistory: RollingMetricsHistory;

    constructor(
        private readonly cpuSampler: CpuSampler = new CpuSampler(),
        private readonly memorySampler: MemorySampler = new MemorySampler(),
        private readonly diskSampler: DiskSampler = new DiskSampler(),
        private readonly workspaceSizeSampler: WorkspaceSizeSampler = new WorkspaceSizeSampler(),
        historyLength: number = 24
    ) {
        this.metricsHistory = new RollingMetricsHistory(historyLength);
    }

    public getCPUInfo(): CpuMetrics {
        return this.cpuSampler.getCPUInfo();
    }

    public getMemoryUsage(): MemoryMetrics {
        return this.memorySampler.getMemoryUsage();
    }

    public getDiskUsage(forceRefresh: boolean = false): DiskMetrics {
        return this.diskSampler.getDiskUsage(forceRefresh);
    }

    public getAverageMetrics(): AverageMetrics {
        return this.metricsHistory.getAverages();
    }

    /**
     * Forget the CPU baseline so the next reading is measured from now on. A
     * window that has been following another one's readings holds a baseline
     * from whenever it last sampled, and the difference against that would be
     * reported as "current" CPU usage.
     */
    public resetCpuBaseline(): void {
        this.cpuSampler.reset();
        this.cpuSampler.getCPUInfo();
    }

    public collectMachine(forceRefreshDisk: boolean = false): MachineMetrics {
        const cpu = this.getCPUInfo();
        const memory = this.getMemoryUsage();
        const disk = this.getDiskUsage(forceRefreshDisk);

        this.metricsHistory.add({
            cpuUsage: cpu.usage,
            memoryUsage: memory.usagePercent,
            diskUsage: disk.usagePercent
        });

        return {
            cpu,
            memory,
            disk,
            averages: this.getAverageMetrics()
        };
    }

    public collectWorkspace(forceRefresh: boolean = false): Promise<WorkspaceSizeMetrics> {
        return this.workspaceSizeSampler.getWorkspaceSize(forceRefresh);
    }

    /** The workspace size known right now; a stale one is refreshed in the background. */
    public peekWorkspace(): WorkspaceSizeMetrics {
        return this.workspaceSizeSampler.peekWorkspaceSize();
    }

    /** The background measurement started by `peekWorkspace`, if one is running. */
    public get pendingWorkspaceWalk(): Promise<WorkspaceSizeMetrics> | undefined {
        return this.workspaceSizeSampler.pendingMeasurement;
    }

    /** Record a machine reading that another window sampled, so the averages stay continuous. */
    public recordSharedSample(machine: MachineMetrics): void {
        this.metricsHistory.add({
            cpuUsage: machine.cpu.usage,
            memoryUsage: machine.memory.usagePercent,
            diskUsage: machine.disk.usagePercent
        });
    }

    public async getAllMetrics(options: { refreshDisk?: boolean; refreshWorkspace?: boolean } = {}): Promise<MetricsSnapshot> {
        const machine = this.collectMachine(options.refreshDisk ?? false);
        const workspace = await this.collectWorkspace(options.refreshWorkspace ?? false);

        return { ...machine, workspace };
    }
}
