import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HEARTBEAT_MS, LEASE_MS, LeaderLock, lockIsStale } from '../coordination/leaderLock';
import { MACHINE_SCOPE, lockPathFor, samePath, snapshotPathFor, workspaceScope } from '../coordination/paths';
import {
    SNAPSHOT_VERSION,
    WorkspaceSnapshot,
    isMachineSnapshot,
    isWorkspaceSnapshot,
    readMachineSnapshot,
    readWorkspaceSnapshot
} from '../coordination/sharedMetrics';
import { MetricsFormatter } from '../formatter';
import { MachineMetrics, MetricsCollector, MetricsSnapshot } from '../metrics';
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

function createCollector(
    workspaceDir: string | undefined,
    workspaceSampleIntervalMs: number = 0,
    memoCostThreshold?: number
): CountingCollector {
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
        // suite is about who samples, not about their own caching — except
        // where a test needs the folder size cached, or its subtotals
        // remembered, the way they are in use.
        new DiskSampler(new MonitorPathResolver(() => 'darwin'), statfs, Date.now, 0),
        new WorkspaceSizeSampler(() => workspaceDir, Date.now, workspaceSampleIntervalMs, undefined, memoCostThreshold)
    );
}

/** The folder size a window shows: in the update itself, the tooltip and Copy Summary alike. */
function assertFolderSizeShown(metrics: MetricsSnapshot, bytes: number | undefined): void {
    assert.strictEqual(metrics.workspace.bytes, bytes);
    const shown = MetricsFormatter.formatBytes(bytes);
    assert.ok(MetricsFormatter.createTooltipText(metrics).includes(`Current Directory Size: ${shown}\n`));
    assert.ok(MetricsFormatter.createClipboardText(metrics).split('\n').includes(`- **Current Directory Size:** ${shown}`));
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
    const sharedFolderSize = async () =>
        (await readWorkspaceSnapshot(snapshotPathFor(storageDir, workspaceScope(workspaceDir))))?.bytes;

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

    test('a window that is showing nobody the folder size neither walks it nor holds its lease', async () => {
        const backgroundCollector = createCollector(workspaceDir);
        const focusedCollector = createCollector(workspaceDir);
        const wanted = { folderSize: true };
        const background = new MonitorCoordinator(backgroundCollector, storageDir, () => workspaceDir, {
            ...coordinatorOptions(),
            wantsWorkspaceMeasurement: () => wanted.folderSize
        });
        const focused = new MonitorCoordinator(focusedCollector, storageDir, () => workspaceDir, coordinatorOptions());

        await background.refresh();
        assert.strictEqual(background.isWorkspaceLeader, true);

        // The window went to the background, where its tooltip cannot be
        // hovered. Every request the walk would have made is one an on-access
        // virus scanner would have inspected for a number nobody can see.
        wanted.folderSize = false;
        const walksSoFar = backgroundCollector.workspaceSamples;
        const metrics = await background.refresh();
        assert.strictEqual(backgroundCollector.workspaceSamples, walksSoFar);
        assert.deepStrictEqual(metrics.workspace, {});

        // Handing the lease back is what lets a window that *is* in front pick
        // the measurement up, rather than leaving it unmeasured everywhere.
        await focused.refresh();
        assert.strictEqual(background.isWorkspaceLeader, false);
        assert.strictEqual(focused.isWorkspaceLeader, true);
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

    test('a reading left behind by a window that has closed is not shown', async () => {
        // Yesterday's session published this, and no window maintains it now.
        const leftBehind = {
            version: SNAPSHOT_VERSION,
            updatedAtMs: clock.ms - 24 * 60 * 60 * 1000,
            leader: 'yesterday',
            cpu: { usage: 99, speed: 3000 },
            memory: { used: 1, total: 2, usagePercent: 99 },
            disk: { free: 1, total: 2, usagePercent: 99 },
            averages: { cpuAvg: 99, memoryAvg: 99, diskAvg: 99 }
        };
        await fs.promises.writeFile(snapshotPathFor(storageDir, MACHINE_SCOPE), JSON.stringify(leftBehind));

        const collector = createCollector(workspaceDir);
        const coordinator = new MonitorCoordinator(collector, storageDir, () => workspaceDir, coordinatorOptions());

        // The first update renders before the window knows its role, and the
        // second is the one a newly elected leader spends re-basing its CPU
        // reading — both used to show yesterday's 99%.
        for (let update = 0; update < 2; update++) {
            const metrics = await coordinator.refresh();
            assert.strictEqual(metrics.cpu.usage, 25);
            assert.strictEqual(metrics.averages.cpuAvg, 25);
            assert.notStrictEqual(metrics.memory.usagePercent, 99);
            clock.ms += 1000;
        }
    });

    test('a follower goes on trusting a leader whose readings have not changed', async () => {
        const leaderCollector = createCollector(workspaceDir);
        const followerCollector = createCollector(workspaceDir);
        const leader = new MonitorCoordinator(leaderCollector, storageDir, () => workspaceDir, coordinatorOptions());
        const follower = new MonitorCoordinator(followerCollector, storageDir, () => workspaceDir, coordinatorOptions());

        await leader.refresh();
        await leader.refresh();
        await follower.refresh();
        assert.strictEqual(follower.isMachineLeader, false);

        // An idle machine: the readings do not move for longer than a lease,
        // while the leader goes on updating every five seconds.
        for (let elapsed = 0; elapsed <= LEASE_MS; elapsed += 5000) {
            clock.ms += 5000;
            await leader.refresh();
        }
        await follower.refresh();

        // The snapshot's age is how a follower tells a live leader from one
        // that is gone, so unchanged readings still have to be rewritten.
        const snapshot = await readMachineSnapshot(snapshotPathFor(storageDir, MACHINE_SCOPE));
        assert.ok(snapshot);
        assert.ok(clock.ms - snapshot.updatedAtMs < HEARTBEAT_MS);
        assert.strictEqual(follower.isMachineLeader, false);
        assert.strictEqual(followerCollector.machineSamples, 0);
    });

    test('a window taking the folder measurement back shows the newer size, not its own older one', async () => {
        const inFront = { first: true, second: false };
        // In use the size is cached for minutes, which is what leaves the
        // first window's own measurement out of date when it comes back.
        const firstCollector = createCollector(workspaceDir, 5 * 60_000);
        const secondCollector = createCollector(workspaceDir, 5 * 60_000);
        const first = new MonitorCoordinator(firstCollector, storageDir, () => workspaceDir, {
            ...coordinatorOptions(),
            wantsWorkspaceMeasurement: () => inFront.first
        });
        const second = new MonitorCoordinator(secondCollector, storageDir, () => workspaceDir, {
            ...coordinatorOptions(),
            wantsWorkspaceMeasurement: () => inFront.second
        });

        await first.refresh();
        await firstCollector.pendingWorkspaceWalk;
        assert.strictEqual((await first.refresh()).workspace.bytes, 4);
        assert.strictEqual(await sharedFolderSize(), 4);

        // The folder grows while the second window is in front and measuring.
        await fs.promises.writeFile(path.join(workspaceDir, 'grown.txt'), '123456');
        inFront.first = false;
        inFront.second = true;
        await first.refresh();
        await second.refresh();
        await secondCollector.pendingWorkspaceWalk;
        assert.strictEqual((await second.refresh()).workspace.bytes, 10);
        assert.strictEqual(await sharedFolderSize(), 10);

        // Back to the first window, whose own measurement predates the growth:
        // it neither shows that nor publishes it over the newer one.
        inFront.first = true;
        inFront.second = false;
        await second.refresh();
        const back = await first.refresh();
        assert.strictEqual(first.isWorkspaceLeader, true);
        assert.strictEqual(back.workspace.bytes, 10);
        assert.strictEqual(await sharedFolderSize(), 10);

        // From then on it shows what it measured itself.
        await firstCollector.pendingWorkspaceWalk;
        assert.strictEqual((await first.refresh()).workspace.bytes, 10);
        assert.strictEqual(await sharedFolderSize(), 10);
    });

    test('a window coming to the front takes the folder measurement up at once', async () => {
        const inFront = { first: true, second: false };
        const options = { now: () => clock.ms, roleCheckIntervalMs: HEARTBEAT_MS, settleMs: 0 };
        const first = new MonitorCoordinator(createCollector(workspaceDir), storageDir, () => workspaceDir, {
            ...options,
            wantsWorkspaceMeasurement: () => inFront.first
        });
        const second = new MonitorCoordinator(createCollector(workspaceDir), storageDir, () => workspaceDir, {
            ...options,
            wantsWorkspaceMeasurement: () => inFront.second
        });
        await first.refresh();
        await second.refresh();
        assert.strictEqual(first.isWorkspaceLeader, true);

        // Well inside one role-check interval, the windows swap places.
        clock.ms += 1000;
        inFront.first = false;
        inFront.second = true;
        await first.refresh();
        await second.refresh();
        assert.strictEqual(first.isWorkspaceLeader, false);
        assert.strictEqual(second.isWorkspaceLeader, true);
    });

    test('a folder size left behind by a window that has closed is not shown', async () => {
        // Closing the last window leaves its snapshot behind, and a window
        // opened on the folder the next day must not show that size as current.
        const leftBehind: WorkspaceSnapshot = {
            version: SNAPSHOT_VERSION,
            updatedAtMs: clock.ms - 24 * 60 * 60_000,
            leader: 'yesterday',
            path: workspaceDir,
            bytes: 999_999
        };
        await fs.promises.writeFile(snapshotPathFor(storageDir, workspaceScope(workspaceDir)), JSON.stringify(leftBehind));
        const collector = createCollector(workspaceDir);
        const coordinator = new MonitorCoordinator(collector, storageDir, () => workspaceDir, coordinatorOptions());

        const first = await coordinator.refresh();
        assert.strictEqual(coordinator.isWorkspaceLeader, true);
        assertFolderSizeShown(first, undefined);

        await collector.pendingWorkspaceWalk;
        assertFolderSizeShown(await coordinator.refresh(), 4);
        assert.strictEqual(await sharedFolderSize(), 4);
    });

    test('a window back in front after a long while shows the folder size it measured itself', async () => {
        const inFront = { value: true };
        const collector = createCollector(workspaceDir);
        const coordinator = new MonitorCoordinator(collector, storageDir, () => workspaceDir, {
            ...coordinatorOptions(),
            wantsWorkspaceMeasurement: () => inFront.value
        });
        await coordinator.refresh();
        await collector.pendingWorkspaceWalk;
        assertFolderSizeShown(await coordinator.refresh(), 4);

        // Away at another application for longer than a lease, the window
        // hands the measurement back and nobody takes it up.
        inFront.value = false;
        await coordinator.refresh();
        assert.strictEqual(coordinator.isWorkspaceLeader, false);
        clock.ms += LEASE_MS + HEARTBEAT_MS;

        // Its snapshot is old by then, but nobody has measured the folder
        // since it wrote it, so its size still stands rather than going blank.
        inFront.value = true;
        const back = await coordinator.refresh();
        assert.strictEqual(coordinator.isWorkspaceLeader, true);
        assertFolderSizeShown(back, 4);
        await collector.pendingWorkspaceWalk;
    });

    test('a window taking over from a leader whose folder size has not changed shows that size at once', async () => {
        const inFront = { first: true, second: false };
        const firstCollector = createCollector(workspaceDir);
        const secondCollector = createCollector(workspaceDir);
        const first = new MonitorCoordinator(firstCollector, storageDir, () => workspaceDir, {
            ...coordinatorOptions(),
            wantsWorkspaceMeasurement: () => inFront.first
        });
        const second = new MonitorCoordinator(secondCollector, storageDir, () => workspaceDir, {
            ...coordinatorOptions(),
            wantsWorkspaceMeasurement: () => inFront.second
        });
        await first.refresh();
        await firstCollector.pendingWorkspaceWalk;
        assertFolderSizeShown(await first.refresh(), 4);

        // The size stays the same for longer than a lease. A snapshot's age is
        // how a window taking over tells a live leader's size from one left
        // behind, so it is rewritten all the same.
        for (let elapsed = 0; elapsed <= LEASE_MS; elapsed += 5000) {
            clock.ms += 5000;
            await first.refresh();
            await firstCollector.pendingWorkspaceWalk;
        }
        const snapshot = await readWorkspaceSnapshot(snapshotPathFor(storageDir, workspaceScope(workspaceDir)));
        assert.ok(snapshot);
        assert.ok(clock.ms - snapshot.updatedAtMs < HEARTBEAT_MS);

        inFront.first = false;
        inFront.second = true;
        await first.refresh();
        const taken = await second.refresh();
        assert.strictEqual(second.isWorkspaceLeader, true);
        assertFolderSizeShown(taken, 4);
        await secondCollector.pendingWorkspaceWalk;
    });

    test('a window taking the folder measurement back measures what its own watcher never reported', async () => {
        const inFront = { first: true, second: false };
        // Remembering every directory's total, however cheap it was to walk,
        // stands in for a folder large enough for that to pay.
        const firstCollector = createCollector(workspaceDir, 0, 1);
        const secondCollector = createCollector(workspaceDir, 0, 1);
        const first = new MonitorCoordinator(firstCollector, storageDir, () => workspaceDir, {
            ...coordinatorOptions(),
            wantsWorkspaceMeasurement: () => inFront.first
        });
        const second = new MonitorCoordinator(secondCollector, storageDir, () => workspaceDir, {
            ...coordinatorOptions(),
            wantsWorkspaceMeasurement: () => inFront.second
        });
        await first.refresh();
        await firstCollector.pendingWorkspaceWalk;
        assertFolderSizeShown(await first.refresh(), 4);
        await firstCollector.pendingWorkspaceWalk;

        // The folder grows where no watcher reports it — VS Code does not
        // watch node_modules — while the second window is in front.
        await fs.promises.writeFile(path.join(workspaceDir, 'unwatched.txt'), '123456');
        inFront.first = false;
        inFront.second = true;
        await first.refresh();
        await second.refresh();
        await secondCollector.pendingWorkspaceWalk;
        assertFolderSizeShown(await second.refresh(), 10);
        assert.strictEqual(await sharedFolderSize(), 10);

        // Back to the first window, whose remembered total predates the
        // growth: its walk disagrees with the size it took over, so it
        // measures the whole folder rather than publishing the older total.
        inFront.first = true;
        inFront.second = false;
        await second.refresh();
        assertFolderSizeShown(await first.refresh(), 10);
        await firstCollector.pendingWorkspaceWalk;
        assertFolderSizeShown(await first.refresh(), 10);
        assert.strictEqual(await sharedFolderSize(), 10);
        await firstCollector.pendingWorkspaceWalk;
    });

    test('a window back in front after a long while shows the newer size another window measured meanwhile', async () => {
        const inFront = { first: true, second: false };
        const firstCollector = createCollector(workspaceDir);
        const secondCollector = createCollector(workspaceDir);
        const first = new MonitorCoordinator(firstCollector, storageDir, () => workspaceDir, {
            ...coordinatorOptions(),
            wantsWorkspaceMeasurement: () => inFront.first
        });
        const second = new MonitorCoordinator(secondCollector, storageDir, () => workspaceDir, {
            ...coordinatorOptions(),
            wantsWorkspaceMeasurement: () => inFront.second
        });
        await first.refresh();
        await firstCollector.pendingWorkspaceWalk;
        assertFolderSizeShown(await first.refresh(), 4);

        await fs.promises.writeFile(path.join(workspaceDir, 'grown.txt'), '123456');
        inFront.first = false;
        inFront.second = true;
        await first.refresh();
        await second.refresh();
        await secondCollector.pendingWorkspaceWalk;
        assertFolderSizeShown(await second.refresh(), 10);

        // The user leaves for another application for longer than a lease,
        // so the second window stops measuring, then comes back to the first.
        inFront.second = false;
        await second.refresh();
        clock.ms += LEASE_MS + HEARTBEAT_MS;
        inFront.first = true;

        // The second window's size is no longer fresh, but it is newer than
        // the one the first window knew, so it is what the first one shows.
        const back = await first.refresh();
        assert.strictEqual(first.isWorkspaceLeader, true);
        assertFolderSizeShown(back, 10);
        await firstCollector.pendingWorkspaceWalk;
        assertFolderSizeShown(await first.refresh(), 10);
        assert.strictEqual(await sharedFolderSize(), 10);
        await firstCollector.pendingWorkspaceWalk;
    });

    test('a window that loses the folder lease to one still on its first walk does not show a size left behind', async () => {
        const leftBehind: WorkspaceSnapshot = {
            version: SNAPSHOT_VERSION,
            updatedAtMs: clock.ms - 24 * 60 * 60_000,
            leader: 'yesterday',
            path: workspaceDir,
            bytes: 999_999
        };
        await fs.promises.writeFile(snapshotPathFor(storageDir, workspaceScope(workspaceDir)), JSON.stringify(leftBehind));
        const firstCollector = createCollector(workspaceDir);
        const first = new MonitorCoordinator(firstCollector, storageDir, () => workspaceDir, coordinatorOptions());
        const second = new MonitorCoordinator(createCollector(workspaceDir), storageDir, () => workspaceDir, coordinatorOptions());

        // Both windows want the size for a moment, as they do while the focus
        // passes from one to the other. The first takes the lease and starts
        // walking; the second follows before anything current is published.
        assertFolderSizeShown(await first.refresh(), undefined);
        assert.strictEqual(first.isWorkspaceLeader, true);
        const following = await second.refresh();
        assert.strictEqual(second.isWorkspaceLeader, false);
        assertFolderSizeShown(following, undefined);

        await firstCollector.pendingWorkspaceWalk;
        assertFolderSizeShown(await first.refresh(), 4);
        assertFolderSizeShown(await second.refresh(), 4);
    });

    test('a window that loses the folder lease goes on showing the size it measured itself', async () => {
        const inFront = { first: false, second: true };
        const firstCollector = createCollector(workspaceDir);
        const secondCollector = createCollector(workspaceDir);
        const first = new MonitorCoordinator(firstCollector, storageDir, () => workspaceDir, {
            ...coordinatorOptions(),
            wantsWorkspaceMeasurement: () => inFront.first
        });
        const second = new MonitorCoordinator(secondCollector, storageDir, () => workspaceDir, {
            ...coordinatorOptions(),
            wantsWorkspaceMeasurement: () => inFront.second
        });
        await second.refresh();
        await secondCollector.pendingWorkspaceWalk;
        assertFolderSizeShown(await second.refresh(), 4);

        // The second window is in the background for longer than a lease,
        // then the first comes to the front and starts walking the folder.
        inFront.second = false;
        await second.refresh();
        clock.ms += LEASE_MS + HEARTBEAT_MS;
        inFront.first = true;
        assertFolderSizeShown(await first.refresh(), undefined);
        assert.strictEqual(first.isWorkspaceLeader, true);

        // The second window wants the size again before the first has
        // published. Its own snapshot is old, but nobody has measured the
        // folder since it wrote it, so it is no reason to go blank.
        inFront.second = true;
        const following = await second.refresh();
        assert.strictEqual(second.isWorkspaceLeader, false);
        assertFolderSizeShown(following, 4);
        await firstCollector.pendingWorkspaceWalk;
    });

    test('a window that opened the folder under another spelling takes over the size it followed', async () => {
        const otherSpelling = workspaceDir + path.sep;
        assert.strictEqual(samePath(otherSpelling, workspaceDir), true);
        const inFront = { first: true, second: false };
        const firstCollector = createCollector(workspaceDir);
        const secondCollector = createCollector(otherSpelling);
        const first = new MonitorCoordinator(firstCollector, storageDir, () => workspaceDir, {
            ...coordinatorOptions(),
            wantsWorkspaceMeasurement: () => inFront.first
        });
        const second = new MonitorCoordinator(secondCollector, storageDir, () => otherSpelling, {
            ...coordinatorOptions(),
            wantsWorkspaceMeasurement: () => inFront.second
        });
        await first.refresh();
        await firstCollector.pendingWorkspaceWalk;
        assertFolderSizeShown(await first.refresh(), 4);

        // The second window follows the first for a moment.
        inFront.second = true;
        const following = await second.refresh();
        assert.strictEqual(second.isWorkspaceLeader, false);
        assertFolderSizeShown(following, 4);
        inFront.second = false;
        await second.refresh();

        // Nobody measures the folder for longer than a lease, then the second
        // window comes to the front: the size it followed is the one it knew,
        // however the publishing window spelled the folder.
        inFront.first = false;
        await first.refresh();
        clock.ms += LEASE_MS + HEARTBEAT_MS;
        inFront.second = true;
        const taken = await second.refresh();
        assert.strictEqual(second.isWorkspaceLeader, true);
        assertFolderSizeShown(taken, 4);
        await secondCollector.pendingWorkspaceWalk;
        assertFolderSizeShown(await second.refresh(), 4);
    });
});
