import * as assert from 'assert';
import { MetricsFormatter } from '../formatter';
import { RollingMetricsHistory } from '../rollingAverage';

suite('Extension Test Suite', () => {
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
});
