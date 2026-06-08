export interface MetricSample {
    cpuUsage: number;
    memoryUsage: number;
    diskUsage: number;
}

export interface AverageMetrics {
    cpuAvg: number;
    memoryAvg: number;
    diskAvg: number;
}

export class RollingMetricsHistory {
    private readonly samples: MetricSample[];
    private nextIndex = 0;
    private sampleCount = 0;
    private cpuTotal = 0;
    private memoryTotal = 0;
    private diskTotal = 0;

    constructor(private readonly capacity: number) {
        if (capacity < 1) {
            throw new Error('Rolling metrics capacity must be greater than zero.');
        }

        this.samples = new Array<MetricSample>(capacity);
    }

    add(sample: MetricSample): void {
        if (this.sampleCount === this.capacity) {
            const previous = this.samples[this.nextIndex];
            this.cpuTotal -= previous.cpuUsage;
            this.memoryTotal -= previous.memoryUsage;
            this.diskTotal -= previous.diskUsage;
        } else {
            this.sampleCount++;
        }

        this.samples[this.nextIndex] = sample;
        this.cpuTotal += sample.cpuUsage;
        this.memoryTotal += sample.memoryUsage;
        this.diskTotal += sample.diskUsage;
        this.nextIndex = (this.nextIndex + 1) % this.capacity;
    }

    getAverages(): AverageMetrics {
        if (this.sampleCount === 0) {
            return { cpuAvg: 0, memoryAvg: 0, diskAvg: 0 };
        }

        return {
            cpuAvg: Math.round(this.cpuTotal / this.sampleCount),
            memoryAvg: Math.round(this.memoryTotal / this.sampleCount),
            diskAvg: Math.round(this.diskTotal / this.sampleCount)
        };
    }
}
