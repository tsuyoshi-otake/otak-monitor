import { MachineMetrics } from '../metrics';
import { readJsonFile, writeFileAtomic } from './atomicFile';

export const SNAPSHOT_VERSION = 1;

/**
 * What the machine leader publishes for the other windows to render: the
 * readings every window would otherwise sample for itself, plus the rolling
 * averages, which a follower cannot compute because it takes no samples.
 */
export interface MachineSnapshot extends MachineMetrics {
    version: number;
    /** Epoch ms the leader produced this. */
    updatedAtMs: number;
    /** Instance id of the publishing leader; diagnostic only. */
    leader: string;
}

/**
 * What the leader of one workspace folder publishes. `path` travels with the
 * measurement so a follower can tell that the snapshot really describes the
 * folder it has open, rather than trusting the file name's hash alone.
 */
export interface WorkspaceSnapshot {
    version: number;
    updatedAtMs: number;
    leader: string;
    path: string;
    bytes: number;
}

export function isMachineSnapshot(raw: unknown): raw is MachineSnapshot {
    const snapshot = raw as MachineSnapshot | undefined;
    return isSnapshotEnvelope(snapshot) &&
        hasFiniteNumbers(snapshot.cpu, ['usage', 'speed']) &&
        hasFiniteNumbers(snapshot.memory, ['used', 'total', 'usagePercent']) &&
        hasFiniteNumbers(snapshot.disk, ['free', 'total', 'usagePercent']) &&
        hasFiniteNumbers(snapshot.averages, ['cpuAvg', 'memoryAvg', 'diskAvg']);
}

export function isWorkspaceSnapshot(raw: unknown): raw is WorkspaceSnapshot {
    const snapshot = raw as WorkspaceSnapshot | undefined;
    return isSnapshotEnvelope(snapshot) &&
        typeof snapshot.path === 'string' && snapshot.path !== '' &&
        typeof snapshot.bytes === 'number' && Number.isFinite(snapshot.bytes);
}

/**
 * Reject a malformed payload outright rather than letting a missing field reach
 * the formatter, where it would surface as `NaN` or `undefined` in the status
 * bar with no hint of where it came from.
 */
function isSnapshotEnvelope(raw: unknown): raw is { version: number; updatedAtMs: number; leader: string } {
    const snapshot = raw as { version?: unknown; updatedAtMs?: unknown } | undefined;
    return !!snapshot && typeof snapshot === 'object' &&
        snapshot.version === SNAPSHOT_VERSION &&
        typeof snapshot.updatedAtMs === 'number' && Number.isFinite(snapshot.updatedAtMs);
}

function hasFiniteNumbers(raw: unknown, keys: string[]): boolean {
    if (typeof raw !== 'object' || raw === null) {
        return false;
    }
    const record = raw as Record<string, unknown>;
    return keys.every((key) => typeof record[key] === 'number' && Number.isFinite(record[key]));
}

export async function readMachineSnapshot(filePath: string): Promise<MachineSnapshot | undefined> {
    const raw = await readJsonFile(filePath);
    return isMachineSnapshot(raw) ? raw : undefined;
}

export async function readWorkspaceSnapshot(filePath: string): Promise<WorkspaceSnapshot | undefined> {
    const raw = await readJsonFile(filePath);
    return isWorkspaceSnapshot(raw) ? raw : undefined;
}

export async function writeSnapshot(filePath: string, tag: string, snapshot: MachineSnapshot | WorkspaceSnapshot): Promise<void> {
    await writeFileAtomic(filePath, tag, JSON.stringify(snapshot));
}
