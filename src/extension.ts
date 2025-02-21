import * as vscode from 'vscode';
import * as os from 'os';

interface CPUTime {
    idle: number;
    total: number;
}

interface SystemMetrics {
    timestamp: number;
    cpuUsage: number;
    memoryUsage: number;
}

let previousCPUTime: CPUTime | null = null;
// 過去1分間のメトリクスを保持する配列
const metricsHistory: SystemMetrics[] = [];
const HISTORY_LENGTH = 60; // 1分間（60秒）

function getCPUInfo(): { usage: number; speed: number } {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    // 全CPUコアの時間を合計
    cpus.forEach(cpu => {
        const times = cpu.times;
        totalIdle += times.idle;
        totalTick += times.user + times.nice + times.sys + times.idle + times.irq;
    });

    // 初回実行時
    if (previousCPUTime === null) {
        previousCPUTime = { idle: totalIdle, total: totalTick };
        return { usage: 0, speed: cpus[0].speed };
    }

    // CPU使用率を計算
    const idleDiff = totalIdle - previousCPUTime.idle;
    const totalDiff = totalTick - previousCPUTime.total;
    const cpuUsage = 100 - (idleDiff / totalDiff) * 100;

    // 現在の値を保存
    previousCPUTime = { idle: totalIdle, total: totalTick };

    return {
        usage: Math.round(cpuUsage * 10) / 10, // 小数点1桁まで
        speed: cpus[0].speed
    };
}

function getMemoryUsage(): { used: number; total: number; usagePercent: number } {
    const totalMemory = Math.round(os.totalmem() / (1024 * 1024)); // MB単位
    const freeMemory = Math.round(os.freemem() / (1024 * 1024));
    const usedMemory = totalMemory - freeMemory;
    const usagePercent = (usedMemory / totalMemory) * 100;
    
    return {
        used: usedMemory,
        total: totalMemory,
        usagePercent: Math.round(usagePercent * 10) / 10
    };
}

function updateMetricsHistory(cpuUsage: number, memoryUsage: number) {
    const now = Date.now();
    metricsHistory.push({
        timestamp: now,
        cpuUsage,
        memoryUsage
    });

    // 1分以上前のデータを削除
    const oneMinuteAgo = now - 60000;
    while (metricsHistory.length > 0 && metricsHistory[0].timestamp < oneMinuteAgo) {
        metricsHistory.shift();
    }
}

function getAverageMetrics(): { cpuAvg: number; memoryAvg: number } {
    if (metricsHistory.length === 0) {
        return { cpuAvg: 0, memoryAvg: 0 };
    }

    const sum = metricsHistory.reduce((acc, metric) => ({
        cpuUsage: acc.cpuUsage + metric.cpuUsage,
        memoryUsage: acc.memoryUsage + metric.memoryUsage
    }), { cpuUsage: 0, memoryUsage: 0 });

    return {
        cpuAvg: Math.round((sum.cpuUsage / metricsHistory.length) * 10) / 10,
        memoryAvg: Math.round((sum.memoryUsage / metricsHistory.length) * 10) / 10
    };
}

export function activate(context: vscode.ExtensionContext) {
    console.log('otak-monitor is now active!');

    // ステータスバーアイテムを作成
    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );

    // 1秒ごとに更新
    setInterval(() => {
        const cpuInfo = getCPUInfo();
        const memoryInfo = getMemoryUsage();

        // メトリクス履歴を更新
        updateMetricsHistory(cpuInfo.usage, memoryInfo.usagePercent);
        
        // 1分間の平均を計算
        const averages = getAverageMetrics();

        // ステータスバーのテキストを更新
        statusBarItem.text = `CPU: ${cpuInfo.usage}%`;
        
        // ツールチップを更新
        statusBarItem.tooltip = 
            `Current:\n` +
            `CPU Usage: ${cpuInfo.usage}% (${cpuInfo.speed} MHz)\n` +
            `Memory Usage: ${memoryInfo.used} MB / ${memoryInfo.total} MB (${memoryInfo.usagePercent}%)\n\n` +
            `1-Minute Average:\n` +
            `CPU: ${averages.cpuAvg}%\n` +
            `Memory: ${averages.memoryAvg}%`;
        
        statusBarItem.show();
    }, 1000);

    // 拡張機能が非アクティブになったときのクリーンアップ
    context.subscriptions.push(statusBarItem);
}

export function deactivate() {
    // クリーンアップが必要な場合はここに実装
}
