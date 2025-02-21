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
// 過去1分間のメトリクスを保持する配列（5秒間隔で12データポイント）
const metricsHistory: SystemMetrics[] = [];
const UPDATE_INTERVAL = 5000; // 基本は5秒ごと
const HISTORY_LENGTH = 12; // 1分間（12データポイント）

// VS Code ウィンドウがアクティブなときだけ頻繁に更新するための処理
function getEffectiveInterval(): number {
    return vscode.window.state.focused ? UPDATE_INTERVAL : UPDATE_INTERVAL * 2;
}

function getCPUInfo(): { usage: number; speed: number } {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
        const times = cpu.times;
        totalIdle += times.idle;
        totalTick += times.user + times.nice + times.sys + times.idle + times.irq;
    });

    // 初回実行時は前回値がないため、計測できない
    if (previousCPUTime === null) {
        previousCPUTime = { idle: totalIdle, total: totalTick };
        return { usage: 0, speed: cpus[0].speed };
    }

    const idleDiff = totalIdle - previousCPUTime.idle;
    const totalDiff = totalTick - previousCPUTime.total;
    // totalDiff が0の場合を考慮
    const cpuUsage = totalDiff > 0 ? 100 - (idleDiff / totalDiff) * 100 : 0;

    // 現在の値を保存
    previousCPUTime = { idle: totalIdle, total: totalTick };

    return {
        // 小数点以下は不要なため Math.round で整数にする
        usage: Math.round(cpuUsage),
        speed: cpus[0].speed
    };
}

function getMemoryUsage(): { used: number; total: number; usagePercent: number } {
    const totalMemory = Math.round(os.totalmem() / (1024 * 1024)); // MB単位
    const freeMemory = Math.round(os.freemem() / (1024 * 1024));
    const usedMemory = totalMemory - freeMemory;
    const usagePercent = totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0;
    
    return {
        used: usedMemory,
        total: totalMemory,
        usagePercent: Math.round(usagePercent)
    };
}

function updateMetricsHistory(cpuUsage: number, memoryUsage: number) {
    metricsHistory.push({
        timestamp: Date.now(),
        cpuUsage,
        memoryUsage
    });
    if (metricsHistory.length > HISTORY_LENGTH) {
        metricsHistory.shift();
    }
}

function getAverageMetrics(): { cpuAvg: number; memoryAvg: number } {
    if (metricsHistory.length === 0) {
        return { cpuAvg: 0, memoryAvg: 0 };
    }
    const { cpuUsage, memoryUsage } = metricsHistory.reduce(
        (acc, val) => ({
            cpuUsage: acc.cpuUsage + val.cpuUsage,
            memoryUsage: acc.memoryUsage + val.memoryUsage,
        }),
        { cpuUsage: 0, memoryUsage: 0 }
    );

    return {
        cpuAvg: Math.round(cpuUsage / metricsHistory.length),
        memoryAvg: Math.round(memoryUsage / metricsHistory.length),
    };
}

// timerの型をNodeJS.Timeoutにして型エラーを防ぐ
let timer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('otak-monitor is now active!');

    // ステータスバーアイテムを作成
    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    context.subscriptions.push(statusBarItem);

    // タイマーの再設定処理
    function startTimer() {
        // 前回のタイマーがあればクリア
        if (timer) {
            clearInterval(timer);
        }
        // 有効な更新間隔を算出し、新しいタイマーを開始（型アサーションにより NodeJS.Timeout と明示）
        timer = setInterval(updateStatus, getEffectiveInterval()) as NodeJS.Timeout;
    }

    function updateStatus() {
        const cpuInfo = getCPUInfo();
        const memoryInfo = getMemoryUsage();

        updateMetricsHistory(cpuInfo.usage, memoryInfo.usagePercent);
        const averages = getAverageMetrics();

        // CPU使用率は整数値で、常に2桁表示になるようにパディング
        const cpuDisplay = cpuInfo.usage.toString().padStart(2, '0');
        statusBarItem.text = `CPU: ${cpuDisplay}%`;

        // ツールチップは基本的にプレーンテキストで表示し、必要な部分だけ Markdown 書式を利用する
        const mdTooltip = new vscode.MarkdownString();

        // プレーンテキスト部分
        mdTooltip.appendText("Current\n\n");
        mdTooltip.appendText(`CPU Usage: ${cpuDisplay}% @ ${cpuInfo.speed} MHz\n\n`);
        mdTooltip.appendText(`Memory Usage: ${memoryInfo.used} MB / ${memoryInfo.total} MB (${memoryInfo.usagePercent}%)\n\n`);

        // Markdown を利用して罫線を挿入
        mdTooltip.appendMarkdown("---\n\n");

        // 「1-Minute Average」のタイトル行（プレーンテキスト）
        mdTooltip.appendText("1-Minute Average\n\n");

        // CPU と Memory の平均値を同じ行に、HTML の&nbsp;&nbsp;を間に入れて表示
        mdTooltip.appendMarkdown(
        `CPU: ${averages.cpuAvg.toString().padStart(2, '0')} %&nbsp;&nbsp; Memory: ${averages.memoryAvg}%`
        );

        statusBarItem.tooltip = mdTooltip;
        statusBarItem.show();
    }

    // VS Code のウィンドウのフォーカス状態に応じて更新間隔を変更するためのイベントリスナー
    vscode.window.onDidChangeWindowState(() => {
        startTimer();
    }, null, context.subscriptions);

    startTimer();
}

export function deactivate() {
    // 必要なクリーンアップ処理
    if (timer) {
        clearInterval(timer);
    }
}