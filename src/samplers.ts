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

export interface WorkspaceSizeMetrics {
    path?: string;
    bytes?: number;
}

const DEFAULT_DISK_METRICS: DiskMetrics = { free: 0, total: 0, usagePercent: 0 };

/**
 * How many filesystem requests the workspace walk may have in flight at once.
 * The walk waits on the filesystem rather than on this process, so a handful of
 * overlapping requests finishes a large tree much sooner. The cap matters as
 * much as the overlap: an on-access virus scanner sees every request, and
 * thousands at once is what turns a walk into a burst of scanner activity.
 */
const WALK_CONCURRENCY = 8;

/**
 * How long a workspace measurement is reused. A folder's size is a number
 * people glance at, not one they watch, so it is measured on the order of
 * minutes — the walk is by far the most expensive thing this extension does.
 */
const WORKSPACE_SAMPLE_INTERVAL_MS = 300_000;

/**
 * How often the whole tree is measured again from scratch, whatever the file
 * watcher did or did not report. Watchers miss things — VS Code excludes
 * `node_modules` from watching by default, and another process can write
 * anywhere — so the remembered totals are never trusted for longer than this.
 */
const WORKSPACE_FULL_SCAN_INTERVAL_MS = 1_800_000;

/**
 * How many directories a subtree must cost to walk before its total is worth
 * remembering. Remembering a cheap subtree saves a few requests and costs an
 * entry forever; remembering an expensive one is what makes an update after a
 * one-file edit cost nothing.
 */
const MEMO_COST_THRESHOLD = 64;

/**
 * The most subtree totals kept at once, so what is remembered stays bounded by
 * this number rather than by the size of the workspace.
 */
const MEMO_BUDGET = 512;

/**
 * How many changed paths are collected before it becomes cheaper to measure the
 * whole tree again than to work out what each of them invalidates. A build or a
 * branch switch reports far more than this, and past that point the answer is
 * the same either way.
 */
const MAX_PENDING_CHANGES = 4096;

/**
 * Lets a bounded number of operations run at once. Used to keep the number of
 * filesystem requests in flight fixed no matter how the walk fans out.
 */
class ConcurrencyGate {
    private active = 0;
    private readonly waiting: (() => void)[] = [];

    constructor(private readonly limit: number) {}

    async run<T>(operation: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) {
            await new Promise<void>((resolve) => this.waiting.push(resolve));
        }
        this.active++;
        try {
            return await operation();
        } finally {
            this.active--;
            this.waiting.shift()?.();
        }
    }
}

export class CpuSampler {
    private previousCPUTime: CPUTime | null = null;

    constructor(private readonly cpuProvider: () => os.CpuInfo[] = os.cpus) {}

    /**
     * Drop the baseline. Usage is the difference between two readings, so a
     * baseline left over from before a pause would spread that whole pause into
     * the next reading.
     */
    reset(): void {
        this.previousCPUTime = null;
    }

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

interface SubtreeSize {
    bytes: number;
    /** How many directories had to be read to arrive at `bytes`. */
    cost: number;
}

/**
 * Measures the size of the open folder, re-measuring as little of it as it can.
 *
 * A full walk of a real workspace is tens of thousands of filesystem requests,
 * so doing one on a timer is the wrong shape: almost nothing changes between
 * two of them. Instead the sampler remembers the total under the subtrees that
 * were expensive to walk, and a file change only invalidates the subtrees that
 * contain it — everything else is answered from memory, without touching the
 * filesystem at all.
 *
 * Which subtrees are remembered is decided by what they cost rather than by
 * their depth, so it adapts to the shape of the workspace: a repository with a
 * huge `node_modules` next to a small `src` remembers `node_modules`, and one
 * where everything sits under `packages/*` remembers each package. What is
 * remembered is capped, so the memory it costs does not grow with the tree.
 *
 * Correctness never depends on the change notifications: they only say what to
 * measure again sooner. Whatever they miss is caught by the periodic full scan.
 */
export class WorkspaceSizeSampler {
    private cachedMetrics: WorkspaceSizeMetrics = {};
    private lastSampleAt = 0;
    private inFlight: Promise<WorkspaceSizeMetrics> | undefined;

    /** Total bytes under a directory, kept only for subtrees worth remembering. */
    private readonly subtotals = new Map<string, number>();
    /** Remembered subtrees that a change has invalidated. */
    private readonly invalidated = new Set<string>();
    /** Paths reported as changed, not yet worked out into invalidations. */
    private readonly pendingChanges = new Set<string>();
    /** Whether more changes were reported than were worth keeping track of. */
    private pendingOverflow = false;
    /** The workspace the remembered totals belong to. */
    private memoizedPath = '';
    private lastFullScanAt = 0;
    private readonly gate = new ConcurrencyGate(WALK_CONCURRENCY);

    constructor(
        private readonly workspacePathProvider: () => string | undefined = () => process.cwd(),
        private readonly now: () => number = Date.now,
        private readonly sampleIntervalMs: number = WORKSPACE_SAMPLE_INTERVAL_MS,
        private readonly fullScanIntervalMs: number = WORKSPACE_FULL_SCAN_INTERVAL_MS,
        private readonly memoCostThreshold: number = MEMO_COST_THRESHOLD
    ) {}

    /** The measurement in progress, if any. */
    get pendingMeasurement(): Promise<WorkspaceSizeMetrics> | undefined {
        return this.inFlight;
    }

    /**
     * Note that `changedPath` changed, so the remembered totals covering it are
     * measured again on the next update. This is a hint and nothing more: a
     * change that is never reported is still picked up by the full scan, and a
     * path that is not remembered is measured every time anyway.
     */
    markChanged(changedPath: string): void {
        if (this.pendingOverflow) {
            return;
        }

        // Only the path is kept. Working out which remembered totals a change
        // invalidates costs a handful of string operations per level of the
        // path, and a build reports the same directories thousands of times
        // over — so it is left until the next measurement, by which point the
        // set has collapsed the repeats and the work happens once.
        this.pendingChanges.add(changedPath);
        if (this.pendingChanges.size > MAX_PENDING_CHANGES) {
            this.pendingChanges.clear();
            this.pendingOverflow = true;
        }
    }

    /** Works out what the reported changes invalidate, once, before a walk. */
    private applyPendingChanges(): void {
        if (this.subtotals.size > 0) {
            for (const changedPath of this.pendingChanges) {
                this.invalidateContaining(changedPath);
            }
        }

        this.pendingChanges.clear();
    }

    private invalidateContaining(changedPath: string): void {
        const resolved = path.resolve(changedPath);
        const relative = path.relative(this.memoizedPath, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return; // outside the folder being measured
        }

        // The change is inside every ancestor, so every remembered ancestor has
        // to be measured again; walking down from the root costs one lookup per
        // level rather than a search through what is remembered.
        this.invalidate(this.memoizedPath);
        let directory = this.memoizedPath;
        for (const segment of path.dirname(relative).split(path.sep)) {
            if (segment === '' || segment === '.') {
                break;
            }
            directory = path.join(directory, segment);
            this.invalidate(directory);
        }
        // The change may be the directory itself, created or removed or renamed.
        this.invalidate(resolved);
    }

    /**
     * The size measured so far, starting a new measurement when the cached one
     * has aged out but never waiting for it. Walking a large workspace takes
     * seconds, and blocking a status bar update on it delays every other
     * reading in that update for the sake of a number that changes slowly.
     */
    peekWorkspaceSize(): WorkspaceSizeMetrics {
        const workspacePath = this.workspacePathProvider();
        void this.getWorkspaceSize().catch(() => undefined);

        return this.cachedMetrics.path === workspacePath ? this.cachedMetrics : {};
    }

    async getWorkspaceSize(forceRefresh: boolean = false): Promise<WorkspaceSizeMetrics> {
        const workspacePath = this.workspacePathProvider();
        if (!workspacePath) {
            this.cachedMetrics = {};
            return this.cachedMetrics;
        }

        const currentTime = this.now();
        if (!forceRefresh && this.cachedMetrics.path === workspacePath &&
            this.lastSampleAt > 0 && currentTime - this.lastSampleAt < this.sampleIntervalMs) {
            return this.cachedMetrics;
        }

        if (this.inFlight) {
            return this.inFlight;
        }

        this.inFlight = this.measure(workspacePath, currentTime, forceRefresh);
        try {
            return await this.inFlight;
        } finally {
            this.inFlight = undefined;
        }
    }

    private invalidate(directoryPath: string): void {
        if (this.subtotals.has(directoryPath)) {
            this.invalidated.add(directoryPath);
        }
    }

    private async measure(workspacePath: string, sampledAt: number, forceFullScan: boolean): Promise<WorkspaceSizeMetrics> {
        const staleMemo = sampledAt - this.lastFullScanAt >= this.fullScanIntervalMs;
        if (forceFullScan || staleMemo || this.pendingOverflow || workspacePath !== this.memoizedPath) {
            // Forget everything and walk it all: this is what catches changes no
            // watcher reported, and drops entries for folders that are gone.
            this.subtotals.clear();
            this.invalidated.clear();
            this.pendingChanges.clear();
            this.pendingOverflow = false;
            this.memoizedPath = workspacePath;
            this.lastFullScanAt = sampledAt;
        } else {
            this.applyPendingChanges();
        }

        const { bytes } = await this.subtreeSize(workspacePath);
        this.cachedMetrics = { path: workspacePath, bytes };
        this.lastSampleAt = sampledAt;
        return this.cachedMetrics;
    }

    /**
     * The total under one directory, walking only what is not already known.
     * A remembered subtree that nothing has invalidated answers immediately and
     * costs no filesystem request at all, which is what makes an update after a
     * one-file edit proportional to the edit rather than to the workspace.
     */
    private async subtreeSize(directoryPath: string): Promise<SubtreeSize> {
        const remembered = this.subtotals.get(directoryPath);
        if (remembered !== undefined && !this.invalidated.has(directoryPath)) {
            return { bytes: remembered, cost: 0 };
        }

        const here = await this.readDirectory(directoryPath);
        let bytes = here.bytes;
        let cost = 1;
        for (const child of await this.eachChild(here.directories, (entry) => this.subtreeSize(entry))) {
            bytes += child.bytes;
            cost += child.cost;
        }

        this.invalidated.delete(directoryPath);
        if (remembered !== undefined || this.worthRemembering(cost)) {
            this.subtotals.set(directoryPath, bytes);
        }

        return { bytes, cost };
    }

    private worthRemembering(cost: number): boolean {
        return cost >= this.memoCostThreshold && this.subtotals.size < MEMO_BUDGET;
    }

    /**
     * The bytes held directly in one directory, and the directories below it.
     *
     * Nothing here opens a file. Directory entries and file attributes are
     * metadata, which an on-access virus scanner has no reason to look inside;
     * reading file contents is what makes it scan, and this never does.
     */
    private async readDirectory(directoryPath: string): Promise<{ bytes: number; directories: string[] }> {
        const directories: string[] = [];
        const files: string[] = [];

        let entries: fs.Dirent[];
        try {
            entries = await this.gate.run(() => fs.promises.readdir(directoryPath, { withFileTypes: true }));
        } catch {
            // Report the readable portion instead of failing the whole update.
            return { bytes: 0, directories };
        }

        for (const entry of entries) {
            const entryPath = path.join(directoryPath, entry.name);
            // Symbolic links and junctions are neither: descending through one
            // would leave the workspace, count a tree twice, or loop forever.
            if (entry.isDirectory()) {
                directories.push(entryPath);
            } else if (entry.isFile()) {
                files.push(entryPath);
            }
        }

        let bytes = 0;
        for (const size of await this.eachChild(files, (file) => this.fileSize(file))) {
            bytes += size;
        }

        return { bytes, directories };
    }

    private async fileSize(filePath: string): Promise<number> {
        try {
            // lstat asks for attributes without opening the file and without
            // resolving links, so nothing here can pull in a scan or a target
            // outside the workspace.
            return (await this.gate.run(() => fs.promises.lstat(filePath))).size;
        } catch {
            // Files disappear and permissions bite while a workspace is walked.
            return 0;
        }
    }

    /**
     * Apply `task` to every item, a fixed number at a time. The gate already
     * caps the filesystem requests; this caps how much of the tree is part-way
     * measured at once, which is what the walk holds in memory.
     */
    private async eachChild<T, R>(items: T[], task: (item: T) => Promise<R>): Promise<R[]> {
        const results: R[] = [];

        for (let start = 0; start < items.length; start += WALK_CONCURRENCY) {
            const batch: Promise<R>[] = [];
            for (let index = start; index < items.length && index < start + WALK_CONCURRENCY; index++) {
                batch.push(task(items[index]));
            }
            for (const result of await Promise.all(batch)) {
                results.push(result);
            }
        }

        return results;
    }
}
