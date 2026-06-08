import { AverageMetrics, RollingMetricsHistory } from './rollingAverage';
import { CpuMetrics, CpuSampler, DiskMetrics, DiskSampler, MemoryMetrics, MemorySampler } from './samplers';

export interface MetricsSnapshot {
    cpu: CpuMetrics;
    memory: MemoryMetrics;
    disk: DiskMetrics;
    averages: AverageMetrics;
}

export class MetricsCollector {
    private readonly metricsHistory: RollingMetricsHistory;

    constructor(
        private readonly cpuSampler: CpuSampler = new CpuSampler(),
        private readonly memorySampler: MemorySampler = new MemorySampler(),
        private readonly diskSampler: DiskSampler = new DiskSampler(),
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

    public getAllMetrics(options: { refreshDisk?: boolean } = {}): MetricsSnapshot {
        const cpu = this.getCPUInfo();
        const memory = this.getMemoryUsage();
        const disk = this.getDiskUsage(options.refreshDisk ?? false);

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
}
