import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LEASE_MS, LeaderLock, lockIsStale } from '../coordination/leaderLock';
import { lockPathFor, samePath, snapshotPathFor, workspaceScope } from '../coordination/paths';
import { SNAPSHOT_VERSION, isMachineSnapshot, isWorkspaceSnapshot } from '../coordination/sharedMetrics';
import { MachineMetrics, MetricsCollector } from '../metrics';
import { MonitorCoordinator } from '../monitorCoordinator';
import {
    CpuSampler,
    DiskSampler,
    MemorySampler,
    MonitorPathResolver,
    WorkspaceSizeSampler
} from '../samplers';

/** Counts what actually gets sampled, which is the whole point of electing a leader. */
class CountingCollector extends MetricsCollector {
    public machineSamples = 0;
    public workspaceSamples = 0;

    public collectMachine(forceRefreshDisk: boolean = false): MachineMetrics {
        this.machineSamples++;
        return super.collectMachine(forceRefreshDisk);
    }

    public collectWorkspace(forceRefresh: boolean = false) {
        this.workspaceSamples++;
        return super.collectWorkspace(forceRefresh);
    }

    public peekWorkspace() {
        this.workspaceSamples++;
        return super.peekWorkspace();
    }
}

function createCollector(workspaceDir: string | undefined): CountingCollector {
    let readings = 0;
    const cpuProvider = (): os.CpuInfo[] => {
        readings++;
        return [{
            model: 'test',
            speed: 3000,
            times: { user: readings * 25, nice: 0, sys: 0, idle: readings * 75, irq: 0 }
        }];
    };
    const statfs = (): fs.StatsFs => ({
        bavail: 25,
        bfree: 25,
        blocks: 100,
        bsize: 1024 ** 3,
        ffree: 0,
        files: 0,
        type: 0
    });

    return new CountingCollector(
        new CpuSampler(cpuProvider),
        new MemorySampler(() => 8 * 1024 ** 2, () => 4 * 1024 ** 2),
        // Sampling intervals of zero keep the samplers out of the way: this
        // suite is about who samples, not about their own caching.
        new DiskSampler(new MonitorPathResolver(() => 'darwin'), statfs, Date.now, 0),
        new WorkspaceSizeSampler(() => workspaceDir, Date.now, 0)
    );
}

suite('Coordination Test Suite', () => {
    let storageDir: string;
    let workspaceDir: string;
    let otherWorkspaceDir: string;
    const clock = { ms: 1_000_000 };

    setup(async () => {
        storageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otak-monitor-storage-'));
        workspaceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otak-monitor-ws-'));
        otherWorkspaceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otak-monitor-ws-'));
        await fs.promises.writeFile(path.join(workspaceDir, 'file.txt'), '1234');
        await fs.promises.writeFile(path.join(otherWorkspaceDir, 'file.txt'), '123456789');
        clock.ms = 1_000_000;
    });

    teardown(async () => {
        for (const directory of [storageDir, workspaceDir, otherWorkspaceDir]) {
            await fs.promises.rm(directory, { recursive: true, force: true });
        }
    });

    const coordinatorOptions = () => ({
        now: () => clock.ms,
        roleCheckIntervalMs: 0,
        settleMs: 0
    });

    test('only one window holds a lease at a time', async () => {
        const lockPath = lockPathFor(storageDir, 'test');
        const first = new LeaderLock(lockPath, 'first', 0);
        const second = new LeaderLock(lockPath, 'second', 0);

        assert.strictEqual(await first.acquire(1000), true);
        assert.strictEqual(await second.acquire(1000), false);
        assert.strictEqual(await first.renew(2000), true);

        // The holder stopped renewing, so the lease expires and moves on.
        assert.strictEqual(await second.acquire(2000 + LEASE_MS), true);
        assert.strictEqual(await first.renew(2000 + LEASE_MS), false);

        await second.release();
        assert.strictEqual(await first.acquire(2000 + LEASE_MS), true);
    });

    test('a heartbeat from the future counts as fresh rather than stale', () => {
        const record = { version: 1, holder: 'first', pid: 1, host: 'host', heartbeatMs: 5000 };

        assert.strictEqual(lockIsStale(record, 1000), false);
        assert.strictEqual(lockIsStale(record, 5000 + LEASE_MS), true);
    });

    test('the workspace scope ignores spellings that reach the same folder', () => {
        assert.strictEqual(samePath(workspaceDir, path.join(workspaceDir, 'nested', '..')), true);
        assert.strictEqual(samePath(workspaceDir, otherWorkspaceDir), false);
        assert.notStrictEqual(workspaceScope(workspaceDir), workspaceScope(otherWorkspaceDir));
    });

    test('malformed snapshots are rejected before they reach the formatter', () => {
        const machine = {
            version: SNAPSHOT_VERSION,
            updatedAtMs: 1,
            leader: 'first',
            cpu: { usage: 10, speed: 3000 },
            memory: { used: 1, total: 2, usagePercent: 50 },
            disk: { free: 1, total: 2, usagePercent: 50 },
            averages: { cpuAvg: 10, memoryAvg: 50, diskAvg: 50 }
        };

        assert.strictEqual(isMachineSnapshot(machine), true);
        assert.strictEqual(isMachineSnapshot({ ...machine, averages: undefined }), false);
        assert.strictEqual(isMachineSnapshot({ ...machine, cpu: { usage: Number.NaN, speed: 3000 } }), false);
        assert.strictEqual(isMachineSnapshot({ ...machine, version: SNAPSHOT_VERSION + 1 }), false);

        const workspace = { version: SNAPSHOT_VERSION, updatedAtMs: 1, leader: 'first', path: '/tmp', bytes: 4 };
        assert.strictEqual(isWorkspaceSnapshot(workspace), true);
        assert.strictEqual(isWorkspaceSnapshot({ ...workspace, bytes: '4' }), false);
        assert.strictEqual(isWorkspaceSnapshot({ ...workspace, path: '' }), false);
    });

    test('a status bar update never waits for the directory walk', async () => {
        const collector = createCollector(workspaceDir);
        const solo = new MonitorCoordinator(collector, storageDir, () => workspaceDir, coordinatorOptions());

        // The first update starts the walk and reports without it, so a large
        // workspace cannot hold up the CPU reading beside it.
        assert.deepStrictEqual((await solo.refresh()).workspace, {});

        await collector.pendingWorkspaceWalk;
        assert.deepStrictEqual((await solo.refresh()).workspace, { path: workspaceDir, bytes: 4 });
    });

    test('a following window renders the leader snapshot without sampling', async () => {
        const leaderCollector = createCollector(workspaceDir);
        const followerCollector = createCollector(workspaceDir);
        const leader = new MonitorCoordinator(leaderCollector, storageDir, () => workspaceDir, coordinatorOptions());
        const follower = new MonitorCoordinator(followerCollector, storageDir, () => workspaceDir, coordinatorOptions());

        await leader.refresh();
        await leaderCollector.pendingWorkspaceWalk;
        const leaderMetrics = await leader.refresh();
        assert.strictEqual(leader.isMachineLeader, true);
        assert.strictEqual(leader.isWorkspaceLeader, true);
        assert.ok(leaderCollector.machineSamples > 0);
        assert.deepStrictEqual(leaderMetrics.workspace, { path: workspaceDir, bytes: 4 });

        const followerMetrics = await follower.refresh();
        assert.strictEqual(follower.isMachineLeader, false);
        assert.strictEqual(follower.isWorkspaceLeader, false);
        assert.strictEqual(followerCollector.machineSamples, 0);
        assert.strictEqual(followerCollector.workspaceSamples, 0);
        assert.deepStrictEqual(followerMetrics.cpu, leaderMetrics.cpu);
        assert.deepStrictEqual(followerMetrics.memory, leaderMetrics.memory);
        assert.deepStrictEqual(followerMetrics.disk, leaderMetrics.disk);
        assert.deepStrictEqual(followerMetrics.workspace, { path: workspaceDir, bytes: 4 });

        assert.ok(fs.existsSync(snapshotPathFor(storageDir, 'machine')));
    });

    test('a window on another folder still measures that folder itself', async () => {
        const leaderCollector = createCollector(workspaceDir);
        const otherCollector = createCollector(otherWorkspaceDir);
        const leader = new MonitorCoordinator(leaderCollector, storageDir, () => workspaceDir, coordinatorOptions());
        const other = new MonitorCoordinator(otherCollector, storageDir, () => otherWorkspaceDir, coordinatorOptions());

        await leader.refresh();
        await leaderCollector.pendingWorkspaceWalk;
        await leader.refresh();

        await other.refresh();
        await otherCollector.pendingWorkspaceWalk;
        const otherMetrics = await other.refresh();

        // Machine readings are shared; the directory walk is not, because the
        // two windows would not get the same answer from it.
        assert.strictEqual(other.isMachineLeader, false);
        assert.strictEqual(other.isWorkspaceLeader, true);
        assert.strictEqual(otherCollector.machineSamples, 0);
        assert.ok(otherCollector.workspaceSamples > 0);
        assert.deepStrictEqual(otherMetrics.workspace, { path: otherWorkspaceDir, bytes: 9 });
    });

    test('an expired lease is taken over, and the new leader re-bases its CPU reading', async () => {
        const leaderCollector = createCollector(workspaceDir);
        const followerCollector = createCollector(workspaceDir);
        const leader = new MonitorCoordinator(leaderCollector, storageDir, () => workspaceDir, coordinatorOptions());
        const follower = new MonitorCoordinator(followerCollector, storageDir, () => workspaceDir, coordinatorOptions());

        // The first update is where a window learns its role; the second is the
        // first one it publishes a snapshot from.
        await leader.refresh();
        await leader.refresh();
        const followed = await follower.refresh();
        assert.strictEqual(follower.isMachineLeader, false);
        assert.strictEqual(followerCollector.machineSamples, 0);

        // The leader window is gone: nothing renews its lease.
        clock.ms += LEASE_MS + 1;
        const promoted = await follower.refresh();
        assert.strictEqual(follower.isMachineLeader, true);
        // CPU usage is a difference between two readings, so the first update
        // after promotion re-bases instead of reporting the whole gap.
        assert.strictEqual(followerCollector.machineSamples, 0);
        assert.deepStrictEqual(promoted.cpu, followed.cpu);

        clock.ms += 1000;
        await follower.refresh();
        assert.strictEqual(followerCollector.machineSamples, 1);
    });

    test('releasing the lease hands leadership over without waiting it out', async () => {
        const leaderCollector = createCollector(workspaceDir);
        const nextCollector = createCollector(workspaceDir);
        const leader = new MonitorCoordinator(leaderCollector, storageDir, () => workspaceDir, coordinatorOptions());
        const next = new MonitorCoordinator(nextCollector, storageDir, () => workspaceDir, coordinatorOptions());

        await leader.refresh();
        await next.refresh();
        assert.strictEqual(next.isMachineLeader, false);

        leader.releaseSync();
        await next.refresh();
        assert.strictEqual(next.isMachineLeader, true);
        assert.strictEqual(next.isWorkspaceLeader, true);
    });

    test('a window without a shared storage directory samples for itself', async () => {
        const collector = createCollector(workspaceDir);
        const solo = new MonitorCoordinator(collector, '', () => workspaceDir, coordinatorOptions());

        await solo.refresh();
        await collector.pendingWorkspaceWalk;
        const metrics = await solo.refresh();

        assert.strictEqual(solo.isMachineLeader, true);
        assert.ok(collector.machineSamples > 0);
        assert.ok(collector.workspaceSamples > 0);
        assert.deepStrictEqual(metrics.workspace, { path: workspaceDir, bytes: 4 });
        assert.deepStrictEqual(await fs.promises.readdir(storageDir), []);
    });

    test('a follower takes the cheap readings but never walks the folder', async () => {
        const collector = createCollector(workspaceDir);
        const follower = new MonitorCoordinator(collector, storageDir, () => workspaceDir, coordinatorOptions());
        // Somebody else holds both leases but has not published a snapshot.
        const machineLock = new LeaderLock(lockPathFor(storageDir, 'machine'), 'someone-else', 0);
        const workspaceLock = new LeaderLock(lockPathFor(storageDir, workspaceScope(workspaceDir)), 'someone-else', 0);
        assert.strictEqual(await machineLock.acquire(clock.ms), true);
        assert.strictEqual(await workspaceLock.acquire(clock.ms), true);

        const metrics = await follower.refresh();

        assert.strictEqual(follower.isMachineLeader, false);
        // An empty status bar is worse than one cheap machine sample, but the
        // folder walk is exactly what following another window is meant to
        // avoid, so this window shows no size until the leader publishes one.
        assert.strictEqual(collector.machineSamples, 1);
        assert.strictEqual(collector.workspaceSamples, 0);
        assert.deepStrictEqual(metrics.workspace, {});
    });
});
