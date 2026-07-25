import { randomUUID } from 'crypto';
import { HEARTBEAT_MS, LeaderLock } from './coordination/leaderLock';
import { MACHINE_SCOPE, lockPathFor, samePath, snapshotPathFor, workspaceScope } from './coordination/paths';
import {
    MachineSnapshot,
    SNAPSHOT_VERSION,
    WorkspaceSnapshot,
    readMachineSnapshot,
    readWorkspaceSnapshot,
    writeSnapshot
} from './coordination/sharedMetrics';
import { MachineMetrics, MetricsCollector, MetricsSnapshot } from './metrics';
import { WorkspaceSizeMetrics } from './samplers';

export interface RefreshOptions {
    refreshDisk?: boolean;
    refreshWorkspace?: boolean;
}

export interface CoordinatorOptions {
    now?: () => number;
    /** How often the leases are claimed or renewed. */
    roleCheckIntervalMs?: number;
    /** Read-back delay when claiming a lease; only tests need to change it. */
    settleMs?: number;
    /**
     * Whether the folder size is worth measuring at all right now. It is only
     * ever read from the tooltip, and the tooltip cannot be hovered in a window
     * that is not in front — so a window that says no here neither walks the
     * folder nor holds the lease that would oblige it to.
     */
    wantsWorkspaceMeasurement?: () => boolean;
}

/**
 * Splits the work of a metrics update between the window that samples and the
 * windows that follow it.
 *
 * Every VS Code window used to run the whole update for itself, so a machine
 * with N windows open walked the workspace directory N times, called
 * `statfs` N times and read `/proc`-equivalent CPU counters N times — for
 * numbers that are identical in all of them. Here a file lease elects one
 * window per scope; it samples and publishes a snapshot, and the others just
 * read that snapshot.
 *
 * There are two scopes because the metrics have two different shapes:
 * CPU, memory and disk describe the machine, so all windows share one leader;
 * the directory size describes one folder, so only windows that opened the same
 * folder share a leader for it.
 *
 * Every failure path falls back to sampling locally, so the worst case is the
 * behaviour this class replaced.
 */
export class MonitorCoordinator {
    private readonly instanceId = randomUUID();
    private readonly tag: string;
    private readonly now: () => number;
    private readonly roleCheckIntervalMs: number;
    private readonly settleMs: number | undefined;
    private readonly wantsWorkspaceMeasurement: () => boolean;

    /** No shared directory, or coordination failed: this window samples for itself. */
    private standalone: boolean;
    private roleCheckedAtMs = Number.NEGATIVE_INFINITY;
    /** Whether this window has learned its role at least once. */
    private rolesSettled = false;

    private machineLock: LeaderLock | undefined;
    private machineLeader = false;
    private readonly machineSnapshotPath: string;
    private lastMachine: MachineMetrics | undefined;
    private lastMachinePublished = '';
    /** Whether the previous update sampled here, which is what the CPU baseline is relative to. */
    private sampledLocally = false;

    private workspaceLock: LeaderLock | undefined;
    private workspaceLeader = false;
    private workspaceScopeKey = '';
    private workspaceSnapshotPath = '';
    private lastWorkspace: WorkspaceSizeMetrics = {};
    private lastWorkspacePublished = '';

    constructor(
        private readonly collector: MetricsCollector,
        private readonly storageDir: string,
        private readonly workspacePathProvider: () => string | undefined,
        options: CoordinatorOptions = {}
    ) {
        this.standalone = storageDir === '';
        this.tag = `${process.pid}-${this.instanceId.slice(0, 8)}`;
        this.now = options.now ?? Date.now;
        this.roleCheckIntervalMs = options.roleCheckIntervalMs ?? HEARTBEAT_MS;
        this.settleMs = options.settleMs;
        this.wantsWorkspaceMeasurement = options.wantsWorkspaceMeasurement ?? (() => true);
        this.machineSnapshotPath = this.standalone ? '' : snapshotPathFor(storageDir, MACHINE_SCOPE);
    }

    get isMachineLeader(): boolean {
        return this.standalone || this.machineLeader;
    }

    get isWorkspaceLeader(): boolean {
        return this.standalone || this.workspaceLeader;
    }

    async refresh(options: RefreshOptions = {}): Promise<MetricsSnapshot> {
        const nowMs = this.now();
        const roles = this.ensureRoles(nowMs);
        // Claiming a lease costs a read-back pause, which the very first update
        // would otherwise spend with an empty status bar. The machine readings
        // are cheap enough to take without knowing the role yet: a window that
        // turns out to be a follower simply stops taking them from the next
        // update on.
        if (this.rolesSettled) {
            await roles;
        }
        const machine = await this.updateMachine(nowMs, options.refreshDisk ?? false);

        // The directory walk is the expensive one, so it waits until the role
        // is known and only the leader ever starts it.
        await roles;
        this.rolesSettled = true;
        const workspace = await this.updateWorkspace(nowMs, options.refreshWorkspace ?? false);

        return { ...machine, workspace };
    }

    /**
     * Give up the leases without waiting, so the next window takes over at once
     * instead of waiting out the lease. `dispose()` cannot await, and a window
     * that is killed outright never gets here — the lease covers that case.
     */
    releaseSync(): void {
        this.machineLock?.releaseSync();
        this.workspaceLock?.releaseSync();
        this.machineLeader = false;
        this.workspaceLeader = false;
    }

    private async ensureRoles(nowMs: number): Promise<void> {
        if (this.standalone || nowMs - this.roleCheckedAtMs < this.roleCheckIntervalMs) {
            return;
        }
        this.roleCheckedAtMs = nowMs;

        try {
            await this.ensureMachineRole(nowMs);
            await this.ensureWorkspaceRole(nowMs);
        } catch (error) {
            // The lock file itself is unwritable — a read-only or full storage
            // directory. Coordinating is impossible, so fall back to what every
            // window did before: sample for itself.
            console.error('otak-monitor: leader election unavailable; sampling in this window', error);
            this.standalone = true;
            this.machineLock = undefined;
            this.workspaceLock = undefined;
            this.machineLeader = false;
            this.workspaceLeader = false;
        }
    }

    private async ensureMachineRole(nowMs: number): Promise<void> {
        const lock = this.machineLock ??= this.createLock(MACHINE_SCOPE);
        this.machineLeader = this.machineLeader ? await lock.renew(nowMs) : await lock.acquire(nowMs);
    }

    private async ensureWorkspaceRole(nowMs: number): Promise<void> {
        const workspacePath = this.workspacePathProvider();
        const scope = this.wantsWorkspaceMeasurement() && workspacePath ? workspaceScope(workspacePath) : '';
        if (scope !== this.workspaceScopeKey) {
            // The window moved to another folder, so its lease no longer covers
            // what it measures. Hand the old one back before taking the new one.
            await this.workspaceLock?.release().catch(() => undefined);
            this.workspaceScopeKey = scope;
            this.workspaceLock = scope === '' ? undefined : this.createLock(scope);
            this.workspaceSnapshotPath = scope === '' ? '' : snapshotPathFor(this.storageDir, scope);
            this.workspaceLeader = false;
            this.lastWorkspacePublished = '';
        }
        if (!this.workspaceLock) {
            return;
        }
        this.workspaceLeader = this.workspaceLeader
            ? await this.workspaceLock.renew(nowMs)
            : await this.workspaceLock.acquire(nowMs);
    }

    private createLock(scope: string): LeaderLock {
        return new LeaderLock(lockPathFor(this.storageDir, scope), this.instanceId, this.settleMs);
    }

    private async updateMachine(nowMs: number, forceRefreshDisk: boolean): Promise<MachineMetrics> {
        if (this.standalone || this.machineLeader) {
            const machine = this.sampleMachine(forceRefreshDisk);
            await this.publishMachine(nowMs, machine);
            return machine;
        }

        const snapshot = await readMachineSnapshot(this.machineSnapshotPath);
        if (!snapshot) {
            // No leader has published yet (the common case for a few seconds
            // after a cold start), or its snapshot is unreadable. Showing an
            // empty status bar would be worse than paying for one sample.
            return this.sampleMachine(forceRefreshDisk);
        }

        const machine: MachineMetrics = {
            cpu: snapshot.cpu,
            memory: snapshot.memory,
            disk: snapshot.disk,
            averages: snapshot.averages
        };
        // Feed the shared reading into this window's own history too, so its
        // averages are already warm if it is promoted later.
        this.collector.recordSharedSample(machine);
        this.sampledLocally = false;
        this.lastMachine = machine;
        return machine;
    }

    /**
     * Sample here. CPU usage is the difference between two readings, so the
     * first sample after a spell of following another window would otherwise
     * report everything that happened since this window last looked. Re-base it
     * instead and keep showing the reading we already had for one update.
     */
    private sampleMachine(forceRefreshDisk: boolean): MachineMetrics {
        if (!this.sampledLocally) {
            this.sampledLocally = true;
            this.collector.resetCpuBaseline();
            if (this.lastMachine) {
                return this.lastMachine;
            }
        }
        this.lastMachine = this.collector.collectMachine(forceRefreshDisk);
        return this.lastMachine;
    }

    private async publishMachine(nowMs: number, machine: MachineMetrics): Promise<void> {
        if (this.standalone || !this.machineLeader) {
            return;
        }
        // An idle machine reports the same numbers update after update; skipping
        // those writes also stops the followers from re-rendering.
        const payload = JSON.stringify(machine);
        if (payload === this.lastMachinePublished) {
            return;
        }

        const snapshot: MachineSnapshot = {
            version: SNAPSHOT_VERSION,
            updatedAtMs: nowMs,
            leader: this.instanceId,
            ...machine
        };
        try {
            await writeSnapshot(this.machineSnapshotPath, this.tag, snapshot);
            this.lastMachinePublished = payload;
        } catch (error) {
            console.error('otak-monitor: publishing the machine snapshot failed', error);
        }
    }

    private async updateWorkspace(nowMs: number, forceRefresh: boolean): Promise<WorkspaceSizeMetrics> {
        if (!this.wantsWorkspaceMeasurement()) {
            // Nothing is displaying it: neither walk the folder nor go looking
            // for what another window measured. What was last known stands.
            return this.lastWorkspace;
        }

        const workspacePath = this.workspacePathProvider();
        if (!workspacePath) {
            this.lastWorkspace = {};
            return this.lastWorkspace;
        }

        if (this.standalone || this.workspaceLeader) {
            // An explicit refresh is worth waiting for; a status bar update is
            // not, so it takes whatever the last walk produced and lets the
            // next one land in a later update.
            this.lastWorkspace = forceRefresh
                ? await this.collector.collectWorkspace(true)
                : this.collector.peekWorkspace();
            await this.publishWorkspace(nowMs);
            return this.lastWorkspace;
        }

        const snapshot = await readWorkspaceSnapshot(this.workspaceSnapshotPath);
        if (snapshot && samePath(snapshot.path, workspacePath)) {
            this.lastWorkspace = { path: snapshot.path, bytes: snapshot.bytes };
        } else if (this.lastWorkspace.path !== workspacePath) {
            // The leader for this folder has not published yet. Unlike the
            // machine readings, walking the folder to fill the gap would cost
            // exactly what the shared measurement exists to avoid, so this
            // window shows no size until the measurement arrives.
            this.lastWorkspace = {};
        }
        return this.lastWorkspace;
    }

    private async publishWorkspace(nowMs: number): Promise<void> {
        const { path: measuredPath, bytes } = this.lastWorkspace;
        if (this.standalone || !this.workspaceLeader || this.workspaceSnapshotPath === '') {
            return;
        }
        if (measuredPath === undefined || bytes === undefined) {
            return;
        }
        const payload = `${measuredPath} ${bytes}`;
        if (payload === this.lastWorkspacePublished) {
            return;
        }

        const snapshot: WorkspaceSnapshot = {
            version: SNAPSHOT_VERSION,
            updatedAtMs: nowMs,
            leader: this.instanceId,
            path: measuredPath,
            bytes
        };
        try {
            await writeSnapshot(this.workspaceSnapshotPath, this.tag, snapshot);
            this.lastWorkspacePublished = payload;
        } catch (error) {
            console.error('otak-monitor: publishing the workspace snapshot failed', error);
        }
    }
}
