import { randomUUID } from 'crypto';
import { HEARTBEAT_MS, LEASE_MS, LeaderLock } from './coordination/leaderLock';
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
    private lastMachinePublishedAtMs = Number.NEGATIVE_INFINITY;
    /** Whether the previous update sampled here, which is what the CPU baseline is relative to. */
    private sampledLocally = false;

    private workspaceLock: LeaderLock | undefined;
    private workspaceLeader = false;
    private workspaceScopeKey = '';
    private workspaceSnapshotPath = '';
    private lastWorkspace: WorkspaceSizeMetrics = {};
    private lastWorkspacePublished = '';
    private lastWorkspacePublishedAtMs = Number.NEGATIVE_INFINITY;

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
        if (this.standalone) {
            return;
        }
        // A window that has just come to the front, or just left it, takes up
        // or hands back the folder measurement now rather than at the next
        // check: until then the folder would be measured by nobody in front.
        const scope = this.wantedWorkspaceScope();
        if (nowMs - this.roleCheckedAtMs < this.roleCheckIntervalMs && scope === this.workspaceScopeKey) {
            return;
        }
        this.roleCheckedAtMs = nowMs;

        try {
            await this.ensureMachineRole(nowMs);
            await this.ensureWorkspaceRole(nowMs, scope);
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

    /** The folder lease this window should hold right now, or '' for none. */
    private wantedWorkspaceScope(): string {
        const workspacePath = this.workspacePathProvider();
        return this.wantsWorkspaceMeasurement() && workspacePath ? workspaceScope(workspacePath) : '';
    }

    private async ensureWorkspaceRole(nowMs: number, scope: string): Promise<void> {
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
        const wasLeader = this.workspaceLeader;
        this.workspaceLeader = wasLeader
            ? await this.workspaceLock.renew(nowMs)
            : await this.workspaceLock.acquire(nowMs);
        if (this.workspaceLeader && !wasLeader) {
            await this.takeOverWorkspace(nowMs);
        }
    }

    /**
     * Start measuring a folder that another window may have been measuring
     * since this one last did. This window's own total can be older than what
     * that window published, so it neither shows nor publishes it: it shows
     * the published size until a walk of its own — one that only measures what
     * changed, unless it disagrees with that size — has finished.
     *
     * The published size is no older than what this window last knew, so it
     * replaces that however old it is. It does not stand in for knowing
     * nothing, though, unless it is fresh: a live leader rewrites its snapshot
     * every heartbeat, so one older than a lease was left by a window that has
     * stopped measuring — at a cold start, possibly in a session that ended
     * days ago — and a window that has not known this folder's size shows none
     * until it has measured it, as it would with no snapshot at all.
     */
    private async takeOverWorkspace(nowMs: number): Promise<void> {
        const workspacePath = this.workspacePathProvider();
        const snapshot = await readWorkspaceSnapshot(this.workspaceSnapshotPath);
        const published = workspacePath && snapshot && samePath(snapshot.path, workspacePath) ? snapshot : undefined;
        // A size this window published itself is what its own walk started
        // from, so only another window's is worth checking that walk against.
        this.collector.expireWorkspace(published?.leader === this.instanceId ? undefined : published?.bytes);
        if (!workspacePath || !published) {
            return;
        }

        // A timestamp ahead of this clock means the clocks disagree, not that
        // the leader has stopped.
        const fresh = nowMs - published.updatedAtMs < LEASE_MS;
        if (fresh || this.lastWorkspace.path === workspacePath) {
            this.lastWorkspace = { path: workspacePath, bytes: published.bytes };
        }
    }

    private createLock(scope: string): LeaderLock {
        return new LeaderLock(lockPathFor(this.storageDir, scope), this.instanceId, this.settleMs);
    }

    private async updateMachine(nowMs: number, forceRefreshDisk: boolean): Promise<MachineMetrics> {
        if (this.standalone || this.machineLeader) {
            const { machine, sampled } = this.sampleMachine(forceRefreshDisk);
            if (sampled) {
                await this.publishMachine(nowMs, machine);
            }
            return machine;
        }

        const snapshot = await readMachineSnapshot(this.machineSnapshotPath);
        // A live leader rewrites its snapshot every heartbeat, so one older
        // than a lease was left by a window that is gone — at a cold start,
        // possibly in a session that ended days ago. A timestamp ahead of this
        // clock means the clocks disagree, not that the leader is gone.
        if (!snapshot || nowMs - snapshot.updatedAtMs >= LEASE_MS) {
            // No leader has published yet (the common case for a few seconds
            // after a cold start), or its snapshot is unreadable or left
            // behind. Showing an empty status bar would be worse than paying
            // for one sample.
            return this.sampleMachine(forceRefreshDisk).machine;
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
     *
     * `sampled` is false for that carried-over reading: it is shown, but not
     * published, since publishing would stamp an old reading as current.
     */
    private sampleMachine(forceRefreshDisk: boolean): { machine: MachineMetrics; sampled: boolean } {
        if (!this.sampledLocally) {
            this.sampledLocally = true;
            this.collector.resetCpuBaseline();
            if (this.lastMachine) {
                return { machine: this.lastMachine, sampled: false };
            }
        }
        this.lastMachine = this.collector.collectMachine(forceRefreshDisk);
        return { machine: this.lastMachine, sampled: true };
    }

    private async publishMachine(nowMs: number, machine: MachineMetrics): Promise<void> {
        if (this.standalone || !this.machineLeader) {
            return;
        }
        // An idle machine reports the same numbers update after update, and
        // those writes are skipped — but not for longer than a heartbeat, as
        // the snapshot's age is how a follower tells this window's readings
        // from ones a closed window left behind.
        const payload = JSON.stringify(machine);
        if (payload === this.lastMachinePublished && nowMs - this.lastMachinePublishedAtMs < HEARTBEAT_MS) {
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
            this.lastMachinePublishedAtMs = nowMs;
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
            const measured = forceRefresh
                ? await this.collector.collectWorkspace(true)
                : this.collector.peekWorkspace();
            if (measured.path === workspacePath) {
                this.lastWorkspace = measured;
                await this.publishWorkspace(nowMs, measured);
            } else if (this.lastWorkspace.path !== workspacePath) {
                this.lastWorkspace = {};
            }
            // Otherwise nothing has been measured since this window took the
            // lease, and the size it took over from the last leader stands.
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

    private async publishWorkspace(nowMs: number, measured: WorkspaceSizeMetrics): Promise<void> {
        const { path: measuredPath, bytes } = measured;
        if (this.standalone || !this.workspaceLeader || this.workspaceSnapshotPath === '') {
            return;
        }
        if (measuredPath === undefined || bytes === undefined) {
            return;
        }
        // A folder's size rarely changes between two updates, and those writes
        // are skipped — but not for longer than a heartbeat, as the snapshot's
        // age is how a window taking over tells this window's size from one a
        // closed window left behind.
        const payload = `${measuredPath} ${bytes}`;
        if (payload === this.lastWorkspacePublished && nowMs - this.lastWorkspacePublishedAtMs < HEARTBEAT_MS) {
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
            this.lastWorkspacePublishedAtMs = nowMs;
        } catch (error) {
            console.error('otak-monitor: publishing the workspace snapshot failed', error);
        }
    }
}
