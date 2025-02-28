import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

export interface CPUTime {
    idle: number;
    total: number;
}

export interface SystemMetrics {
    timestamp: number;
    cpuUsage: number;
    memoryUsage: number;
    diskUsage: number;
}

export class MetricsCollector {
    private previousCPUTime: CPUTime | null = null;
    private metricsHistory: SystemMetrics[] = [];
    private readonly HISTORY_LENGTH = 24; // 1分間（24データポイント）

    public getCPUInfo(): { usage: number; speed: number } {
        const cpus = os.cpus();
        let totalIdle = 0;
        let totalTick = 0;

        cpus.forEach(cpu => {
            const times = cpu.times;
            totalIdle += times.idle;
            totalTick += times.user + times.nice + times.sys + times.idle + times.irq;
        });

        if (this.previousCPUTime === null) {
            this.previousCPUTime = { idle: totalIdle, total: totalTick };
            return { usage: 0, speed: cpus[0].speed };
        }

        const idleDiff = totalIdle - this.previousCPUTime.idle;
        const totalDiff = totalTick - this.previousCPUTime.total;
        const cpuUsage = totalDiff > 0 ? 100 - (idleDiff / totalDiff) * 100 : 0;

        this.previousCPUTime = { idle: totalIdle, total: totalTick };

        return {
            usage: Math.round(cpuUsage),
            speed: cpus[0].speed
        };
    }

    public getMemoryUsage(): { used: number; total: number; usagePercent: number } {
        const totalMemory = Math.round(os.totalmem() / (1024 * 1024));
        const freeMemory = Math.round(os.freemem() / (1024 * 1024));
        const usedMemory = totalMemory - freeMemory;
        const usagePercent = totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0;
        
        return {
            used: usedMemory,
            total: totalMemory,
            usagePercent: Math.round(usagePercent)
        };
    }

    public getDiskUsage(): { free: number; total: number; usagePercent: number } {
        const defaultResult = { free: 0, total: 0, usagePercent: 0 };
    
        try {
            const monitorPath = this.getMonitorPath();
            if (!monitorPath) {
                return defaultResult;
            }
            
            try {
                const stats = fs.statfsSync(monitorPath);
                const total = Math.round((stats.blocks * stats.bsize) / (1024 * 1024 * 1024));
                const free = Math.round((stats.bfree * stats.bsize) / (1024 * 1024 * 1024));
                const used = total - free;
                const usagePercent = total > 0 ? Math.round((used / total) * 100) : 0;

                return { free, total, usagePercent };
            } catch (statError) {
                console.error(`Failed to get disk stats for ${monitorPath}:`, statError);
                return defaultResult;
            }
        } catch (error) {
            console.error('Error in disk usage monitoring:', error instanceof Error ? error.message : error);
            return defaultResult;
        }
    }

    private getMonitorPath(): string {
        switch (os.platform()) {
            case 'win32':
                return process.env.CODESPACES ? 
                    path.resolve(os.homedir()) :
                    'C:\\';
            case 'darwin':
                return '/';
            case 'linux':
                return process.env.CODESPACES ? 
                    path.resolve(process.env.CODESPACE_VSCODE_FOLDER || '/') : '/';
            default:
                console.warn('Unsupported platform for disk monitoring');
                return '';
        }
    }

    public updateMetricsHistory(metrics: Omit<SystemMetrics, 'timestamp'>): void {
        this.metricsHistory.push({
            timestamp: Date.now(),
            ...metrics
        });
        if (this.metricsHistory.length > this.HISTORY_LENGTH) {
            this.metricsHistory.shift();
        }
    }

    public getAverageMetrics(): { cpuAvg: number; memoryAvg: number; diskAvg: number } {
        if (this.metricsHistory.length === 0) {
            return { cpuAvg: 0, memoryAvg: 0, diskAvg: 0 };
        }

        const { cpuUsage, memoryUsage, diskUsage } = this.metricsHistory.reduce(
            (acc, val) => ({
                cpuUsage: acc.cpuUsage + val.cpuUsage,
                memoryUsage: acc.memoryUsage + val.memoryUsage,
                diskUsage: acc.diskUsage + val.diskUsage
            }),
            { cpuUsage: 0, memoryUsage: 0, diskUsage: 0 }
        );

        return {
            cpuAvg: Math.round(cpuUsage / this.metricsHistory.length),
            memoryAvg: Math.round(memoryUsage / this.metricsHistory.length),
            diskAvg: Math.round(diskUsage / this.metricsHistory.length)
        };
    }

    public getAllMetrics(): {
        cpu: { usage: number; speed: number };
        memory: { used: number; total: number; usagePercent: number };
        disk: { free: number; total: number; usagePercent: number };
        averages: { cpuAvg: number; memoryAvg: number; diskAvg: number };
    } {
        const cpu = this.getCPUInfo();
        const memory = this.getMemoryUsage();
        const disk = this.getDiskUsage();

        this.updateMetricsHistory({
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