import * as crypto from 'crypto';
import * as path from 'path';

/**
 * CPU, memory and disk readings describe the machine, not the window, so every
 * window of one installation shares a single lease for them.
 */
export const MACHINE_SCOPE = 'machine';

/**
 * The directory-size walk only produces the same answer for windows that opened
 * the same folder, so its lease is keyed by that folder. Windows paths are
 * case-insensitive and a folder can be reached by more than one spelling, so
 * normalize before hashing — otherwise two windows on the same directory split
 * into separate scopes and walk it twice, which is exactly what the lease
 * exists to prevent.
 */
export function workspaceScope(workspacePath: string): string {
    const resolved = path.resolve(workspacePath);
    const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    return `ws-${crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16)}`;
}

/** True when two paths point at the same folder under the platform's rules. */
export function samePath(left: string, right: string): boolean {
    return workspaceScope(left) === workspaceScope(right);
}

export function lockPathFor(storageDir: string, scope: string): string {
    return path.join(storageDir, `leader-${scope}.lock`);
}

export function snapshotPathFor(storageDir: string, scope: string): string {
    return path.join(storageDir, `snapshot-${scope}.json`);
}
