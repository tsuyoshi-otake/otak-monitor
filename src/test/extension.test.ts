import * as assert from 'assert';
import * as vscode from 'vscode';
import { MetricsFormatter } from '../formatter';
import { RollingMetricsHistory } from '../rollingAverage';
import { WorkspaceSizeSampler } from '../samplers';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

suite('Extension Test Suite', () => {
    test('the extension activates', async () => {
        const extension = vscode.extensions.getExtension('odangoo.otak-monitor');

        assert.ok(extension, 'the extension is not installed in the test host');
        await extension.activate();
        assert.strictEqual(extension.isActive, true);
    });

    test('rolling history keeps O(1) totals while evicting old samples', () => {
        const history = new RollingMetricsHistory(2);

        history.add({ cpuUsage: 10, memoryUsage: 20, diskUsage: 30 });
        history.add({ cpuUsage: 30, memoryUsage: 40, diskUsage: 50 });
        history.add({ cpuUsage: 50, memoryUsage: 60, diskUsage: 70 });

        assert.deepStrictEqual(history.getAverages(), {
            cpuAvg: 40,
            memoryAvg: 50,
            diskAvg: 60
        });
    });

    test('status bar text keeps a stable width for CPU usage', () => {
        assert.strictEqual(MetricsFormatter.getStatusBarText(5), 'CPU: 05%');
        assert.strictEqual(MetricsFormatter.getStatusBarText(100), 'CPU: 100%');
    });

    test('formats directory sizes with readable binary units', () => {
        assert.strictEqual(MetricsFormatter.formatBytes(undefined), 'N/A');
        assert.strictEqual(MetricsFormatter.formatBytes(512), '512 B');
        assert.strictEqual(MetricsFormatter.formatBytes(1536), '1.50 KB');
        assert.strictEqual(MetricsFormatter.formatBytes(2 * 1024 * 1024), '2.00 MB');
    });

    test('workspace size includes nested files and reuses the cached result', async () => {
        const workspacePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otak-monitor-'));
        try {
            await fs.promises.mkdir(path.join(workspacePath, 'nested'));
            await fs.promises.writeFile(path.join(workspacePath, 'first.txt'), '1234');
            await fs.promises.writeFile(path.join(workspacePath, 'nested', 'second.txt'), '123456');

            let currentTime = 100;
            const sampler = new WorkspaceSizeSampler(() => workspacePath, () => currentTime, 1000);
            assert.deepStrictEqual(await sampler.getWorkspaceSize(), { path: workspacePath, bytes: 10 });

            await fs.promises.writeFile(path.join(workspacePath, 'third.txt'), '12345');
            assert.strictEqual((await sampler.getWorkspaceSize()).bytes, 10);

            currentTime = 1101;
            assert.strictEqual((await sampler.getWorkspaceSize()).bytes, 15);
        } finally {
            await fs.promises.rm(workspacePath, { recursive: true, force: true });
        }
    });

    test('only the part of the workspace that changed is measured again', async () => {
        const workspacePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otak-monitor-'));
        const fileIn = (branch: string) => path.join(workspacePath, branch, 'file.txt');
        try {
            await fs.promises.mkdir(path.join(workspacePath, 'a'));
            await fs.promises.mkdir(path.join(workspacePath, 'b'));
            await fs.promises.writeFile(fileIn('a'), '1234');
            await fs.promises.writeFile(fileIn('b'), '123456');

            let currentTime = 100;
            // Remember every subtree rather than only the expensive ones, so
            // the test can see which of them get walked again.
            const sampler = new WorkspaceSizeSampler(() => workspacePath, () => currentTime, 0, 60_000, 1);
            assert.strictEqual((await sampler.getWorkspaceSize()).bytes, 10);

            // Both branches grow, but only one of them is reported.
            await fs.promises.appendFile(fileIn('a'), '5');
            await fs.promises.appendFile(fileIn('b'), '78');
            sampler.markChanged(fileIn('a'));
            // b keeps the total it was measured with, which it could only do by
            // not being walked.
            assert.strictEqual((await sampler.getWorkspaceSize()).bytes, 11);

            // Nothing is reported this time, so nothing is walked at all.
            await fs.promises.appendFile(fileIn('a'), '6');
            assert.strictEqual((await sampler.getWorkspaceSize()).bytes, 11);

            // The periodic full measurement is what catches everything that was
            // never reported.
            currentTime += 60_000;
            assert.strictEqual((await sampler.getWorkspaceSize()).bytes, 14);
        } finally {
            await fs.promises.rm(workspacePath, { recursive: true, force: true });
        }
    });

    test('more changes than are worth tracking measure the whole folder again', async () => {
        const workspacePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otak-monitor-'));
        const fileIn = (branch: string) => path.join(workspacePath, branch, 'file.txt');
        try {
            await fs.promises.mkdir(path.join(workspacePath, 'a'));
            await fs.promises.mkdir(path.join(workspacePath, 'b'));
            await fs.promises.writeFile(fileIn('a'), '1234');
            await fs.promises.writeFile(fileIn('b'), '123456');

            const currentTime = 100;
            const sampler = new WorkspaceSizeSampler(() => workspacePath, () => currentTime, 0, 60_000, 1);
            assert.strictEqual((await sampler.getWorkspaceSize()).bytes, 10);

            // A build reports far more paths than it is worth tracking, and
            // never names the branch that actually grew.
            await fs.promises.appendFile(fileIn('b'), '78');
            for (let index = 0; index < 5000; index++) {
                sampler.markChanged(path.join(workspacePath, 'a', `generated-${index}.txt`));
            }

            // Measuring everything again is what makes that safe.
            assert.strictEqual((await sampler.getWorkspaceSize()).bytes, 12);
        } finally {
            await fs.promises.rm(workspacePath, { recursive: true, force: true });
        }
    });
});
