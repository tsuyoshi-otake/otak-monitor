import * as assert from 'assert';
import * as vscode from 'vscode';
import { MetricsFormatter, nextStatusBarView } from '../formatter';
import { MetricsSnapshot } from '../metrics';
import { RollingMetricsHistory } from '../rollingAverage';
import { CpuMetrics, CpuSampler, WorkspaceSizeSampler, cleanCpuModel } from '../samplers';
import { NullCpuSensor, createCpuSensor, plausibleTemperature, scaledClock, windowsSensorScript } from '../cpuSensor';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function snapshotWith(cpu: Partial<CpuMetrics> = {}): MetricsSnapshot {
    return {
        cpu: { usage: 5, speed: 3800, ...cpu },
        memory: { used: 8000, total: 16000, usagePercent: 50 },
        disk: { free: 400, total: 1000, usagePercent: 60 },
        averages: { cpuAvg: 4, memoryAvg: 50, diskAvg: 60 },
        workspace: { path: '/workspace', bytes: 1536 }
    };
}

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
        assert.strictEqual(MetricsFormatter.getStatusBarText(snapshotWith({ usage: 5 })), 'CPU: 05%');
        assert.strictEqual(MetricsFormatter.getStatusBarText(snapshotWith({ usage: 100 })), 'CPU: 100%');
    });

    test('the status bar shows whichever reading was chosen', () => {
        const metrics = snapshotWith({ usage: 7, temperatureC: 62 });

        assert.strictEqual(MetricsFormatter.getStatusBarText(metrics, 'temperature'), 'TEMP: 62°C');
        assert.strictEqual(MetricsFormatter.getStatusBarText(metrics, 'memory'), 'MEM: 50%');
        assert.strictEqual(MetricsFormatter.getStatusBarText(metrics, 'disk'), 'DISK: 60%');
        assert.strictEqual(MetricsFormatter.getStatusBarText(metrics, 'folder'), 'DIR: 1.50 KB');
    });

    test('cycling skips a reading this machine cannot take', () => {
        const withSensor = snapshotWith({ temperatureC: 62 });
        const withoutSensor = snapshotWith();

        assert.strictEqual(nextStatusBarView('cpu', withSensor), 'temperature');
        // No thermal sensor: clicking past CPU lands on the next reading that
        // has something to show rather than on a permanently empty one.
        assert.strictEqual(nextStatusBarView('cpu', withoutSensor), 'memory');
        assert.strictEqual(nextStatusBarView('folder', withoutSensor), 'cpu');
    });

    test('the CPU line leads with the running clock and names the base only when it differs', () => {
        assert.strictEqual(
            MetricsFormatter.formatCpuLine(snapshotWith({ usage: 77, speed: 3800, currentSpeed: 5244 })),
            'CPU Usage: 77% @ 5.24 GHz (base 3.80 GHz)'
        );
        // Idle machine at its nominal clock: repeating the same number twice
        // says nothing.
        assert.strictEqual(
            MetricsFormatter.formatCpuLine(snapshotWith({ usage: 3, speed: 3800, currentSpeed: 3800 })),
            'CPU Usage: 03% @ 3.80 GHz'
        );
        assert.strictEqual(
            MetricsFormatter.formatCpuLine(snapshotWith({ usage: 3, speed: 3800 })),
            'CPU Usage: 03% @ 3.80 GHz'
        );
    });

    test('the processor names itself in the tooltip and the clipboard', () => {
        const named = snapshotWith({ model: 'AMD Ryzen 9 7950X 16-Core Processor' });

        assert.ok(MetricsFormatter.createTooltipText(named).includes('AMD Ryzen 9 7950X 16-Core Processor'));
        assert.ok(MetricsFormatter.createClipboardText(named).includes('- **Processor:** AMD Ryzen 9 7950X 16-Core Processor'));
        // A machine that reports no usable name gets no line rather than a blank one.
        assert.ok(!MetricsFormatter.createClipboardText(snapshotWith()).includes('Processor:'));
    });

    test('a processor name is tidied, and a placeholder is treated as none', () => {
        assert.strictEqual(
            cleanCpuModel('  Intel(R) Core(TM) i7-8700K CPU @  3.70GHz '),
            'Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz'
        );
        assert.strictEqual(cleanCpuModel('unknown'), undefined);
        assert.strictEqual(cleanCpuModel('   '), undefined);
        assert.strictEqual(cleanCpuModel(undefined), undefined);
    });

    test('the tooltip offers the actions and is trusted enough to run them', () => {
        const tooltip = MetricsFormatter.createTooltip(snapshotWith({ temperatureC: 62 }));

        assert.strictEqual(tooltip.isTrusted, true);
        assert.ok(tooltip.value.includes('command:otak-monitor.copyMetrics'));
        assert.ok(tooltip.value.includes('command:otak-monitor.cycleStatusBarView'));
        assert.ok(tooltip.value.includes('CPU Temperature: 62 °C'));
        // A machine with no sensor gets no row at all rather than an empty one.
        assert.ok(!MetricsFormatter.createTooltipText(snapshotWith()).includes('CPU Temperature'));
    });

    test('a clock is only reported when both the base and the counter are known', () => {
        assert.strictEqual(scaledClock(3800, 138), 5244);
        assert.strictEqual(scaledClock(3800, undefined), undefined);
        assert.strictEqual(scaledClock(0, 138), undefined);
        assert.strictEqual(scaledClock(3800, 0), undefined);
    });

    test('a temperature that cannot describe a processor is dropped', () => {
        assert.strictEqual(plausibleTemperature(62.4), 62);
        assert.strictEqual(plausibleTemperature(0), undefined);
        assert.strictEqual(plausibleTemperature(200), undefined);
        assert.strictEqual(plausibleTemperature(undefined), undefined);
    });

    test('the Windows sensor script stops with the window that started it', () => {
        const script = windowsSensorScript({ clock: true, temperature: false }, 3000, 4242);

        assert.ok(script.includes('$parentPid = 4242'));
        assert.ok(script.includes('if (-not (Get-Process -Id $parentPid)) { break }'));
        assert.ok(script.includes('Start-Sleep -Milliseconds 3000'));
        assert.ok(script.includes('Win32_PerfFormattedData_Counters_ProcessorInformation'));
        // Temperature was not asked for, so the loop never queries it.
        assert.ok(script.includes('$wantsTemperature = $false'));
    });

    test('a platform with nothing to read costs nothing to run', () => {
        assert.ok(createCpuSensor({ clock: true, temperature: true }, 'aix') instanceof NullCpuSensor);
        assert.ok(createCpuSensor({ clock: false, temperature: false }, 'win32') instanceof NullCpuSensor);
        // macOS publishes no temperature without root, so asking only for one
        // leaves nothing to start.
        assert.ok(createCpuSensor({ clock: false, temperature: true }, 'darwin') instanceof NullCpuSensor);
    });

    test('sensor readings travel with the CPU sample, and their absence with it too', () => {
        const cpus = () => os.cpus();
        const withSensor = new CpuSampler(cpus, () => ({ currentSpeed: 5244, temperatureC: 62 }));
        assert.strictEqual(withSensor.getCPUInfo().currentSpeed, 5244);
        assert.strictEqual(withSensor.getCPUInfo().temperatureC, 62);

        const withoutSensor = new CpuSampler(cpus);
        assert.strictEqual(withoutSensor.getCPUInfo().currentSpeed, undefined);
        const reading = withoutSensor.getCPUInfo();
        assert.strictEqual(reading.temperatureC, undefined);
        // A reading that was not taken leaves no key behind. Publishing goes
        // through JSON, which drops an undefined value, so anything else would
        // leave a sampling window holding a different object from a following
        // one — identical to look at and not equal.
        assert.deepStrictEqual(JSON.parse(JSON.stringify(reading)), reading);
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

    test('excluded directories are left out of the total, and changing them re-measures', async () => {
        const workspacePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otak-monitor-'));
        try {
            await fs.promises.mkdir(path.join(workspacePath, 'src'));
            await fs.promises.mkdir(path.join(workspacePath, 'node_modules'));
            await fs.promises.mkdir(path.join(workspacePath, 'src', 'node_modules'));
            await fs.promises.writeFile(path.join(workspacePath, 'src', 'file.txt'), '1234');
            await fs.promises.writeFile(path.join(workspacePath, 'node_modules', 'big.bin'), '1'.repeat(100));
            await fs.promises.writeFile(path.join(workspacePath, 'src', 'node_modules', 'nested.bin'), '1'.repeat(50));

            let excluded: string[] = [];
            const currentTime = 100;
            const sampler = new WorkspaceSizeSampler(
                () => workspacePath, () => currentTime, 0, 60_000, 1, () => excluded
            );
            assert.strictEqual((await sampler.getWorkspaceSize()).bytes, 154);

            // The name is excluded wherever it turns up, not only at the root.
            excluded = ['node_modules'];
            assert.strictEqual((await sampler.getWorkspaceSize()).bytes, 4);

            // Everything remembered was measured under the old exclusions, so
            // taking one away has to walk the tree again rather than answer
            // from a total that no longer means what it did.
            excluded = [];
            assert.strictEqual((await sampler.getWorkspaceSize()).bytes, 154);
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
