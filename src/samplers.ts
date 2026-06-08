import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

export interface CPUTime {
    idle: number;
    total: number;
}

export interface CpuMetrics {
    usage: number;
    speed: number;
}

export interface MemoryMetrics {
    used: number;
    total: number;
    usagePercent: number;
}

export interface DiskMetrics {
    free: number;
    total: number;
    usagePercent: number;
}

const DEFAULT_DISK_METRICS: DiskMetrics = { free: 0, total: 0, usagePercent: 0 };

export class CpuSampler {
    private previousCPUTime: CPUTime | null = null;

    constructor(private readonly cpuProvider: () => os.CpuInfo[] = os.cpus) {}

    getCPUInfo(): CpuMetrics {
        const cpus = this.cpuProvider();
        let totalIdle = 0;
        let totalTick = 0;

        for (const cpu of cpus) {
            const times = cpu.times;
            totalIdle += times.idle;
            totalTick += times.user + times.nice + times.sys + times.idle + times.irq;
        }

        const speed = cpus[0]?.speed ?? 0;
        if (this.previousCPUTime === null) {
            this.previousCPUTime = { idle: totalIdle, total: totalTick };
            return { usage: 0, speed };
        }

        const idleDiff = totalIdle - this.previousCPUTime.idle;
        const totalDiff = totalTick - this.previousCPUTime.total;
        const cpuUsage = totalDiff > 0 ? 100 - (idleDiff / totalDiff) * 100 : 0;

        this.previousCPUTime = { idle: totalIdle, total: totalTick };

        return {
            usage: Math.round(cpuUsage),
            speed
        };
    }
}

export class MemorySampler {
    constructor(
        private readonly totalMemoryProvider: () => number = os.totalmem,
        private readonly freeMemoryProvider: () => number = os.freemem
    ) {}

    getMemoryUsage(): MemoryMetrics {
        const totalMemory = Math.round(this.totalMemoryProvider() / (1024 * 1024));
        const freeMemory = Math.round(this.freeMemoryProvider() / (1024 * 1024));
        const usedMemory = totalMemory - freeMemory;
        const usagePercent = totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0;

        return {
            used: usedMemory,
            total: totalMemory,
            usagePercent: Math.round(usagePercent)
        };
    }
}

export class MonitorPathResolver {
    constructor(
        private readonly platformProvider: () => NodeJS.Platform = os.platform,
        private readonly homeProvider: () => string = os.homedir,
        private readonly environment: NodeJS.ProcessEnv = process.env
    ) {}

    getMonitorPath(): string {
        switch (this.platformProvider()) {
            case 'win32':
                return this.environment.CODESPACES ?
                    path.resolve(this.homeProvider()) :
                    'C:\\';
            case 'darwin':
                return '/';
            case 'linux':
                return this.environment.CODESPACES ?
                    path.resolve(this.environment.CODESPACE_VSCODE_FOLDER || '/') : '/';
            default:
                console.warn('Unsupported platform for disk monitoring');
                return '';
        }
    }
}

export class DiskSampler {
    private cachedMetrics: DiskMetrics = DEFAULT_DISK_METRICS;
    private lastSampleAt = 0;
    private lastErrorPath = '';

    constructor(
        private readonly pathResolver: MonitorPathResolver = new MonitorPathResolver(),
        private readonly statfs: (path: string) => fs.StatsFs = fs.statfsSync,
        private readonly now: () => number = Date.now,
        private readonly sampleIntervalMs: number = 10000
    ) {}

    getDiskUsage(forceRefresh: boolean = false): DiskMetrics {
        const currentTime = this.now();
        if (!forceRefresh && this.lastSampleAt > 0 && currentTime - this.lastSampleAt < this.sampleIntervalMs) {
            return this.cachedMetrics;
        }

        const monitorPath = this.pathResolver.getMonitorPath();
        if (!monitorPath) {
            this.cachedMetrics = DEFAULT_DISK_METRICS;
            this.lastSampleAt = currentTime;
            return this.cachedMetrics;
        }

        try {
            const stats = this.statfs(monitorPath);
            const total = Math.round((stats.blocks * stats.bsize) / (1024 * 1024 * 1024));
            const free = Math.round((stats.bfree * stats.bsize) / (1024 * 1024 * 1024));
            const used = total - free;
            const usagePercent = total > 0 ? Math.round((used / total) * 100) : 0;

            this.cachedMetrics = { free, total, usagePercent };
            this.lastSampleAt = currentTime;
            this.lastErrorPath = '';
        } catch (error) {
            if (this.lastErrorPath !== monitorPath) {
                console.error(`Failed to get disk stats for ${monitorPath}:`, error);
                this.lastErrorPath = monitorPath;
            }
            this.lastSampleAt = currentTime;
        }

        return this.cachedMetrics;
    }
}
