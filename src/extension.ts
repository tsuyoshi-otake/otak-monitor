import * as vscode from 'vscode';
import { MetricsCollector } from './metrics';
import { MetricsFormatter } from './formatter';

let timer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('otak-monitor is now active!');

    const metricsCollector = new MetricsCollector();

    // ステータスバーアイテムを作成
    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = 'otak-monitor.copyMetrics';
    context.subscriptions.push(statusBarItem);

    // 初期ツールチップを設定
    const initialMetrics = metricsCollector.getAllMetrics();
    statusBarItem.tooltip = MetricsFormatter.createTooltip(initialMetrics);

    // クリック時のコマンドを登録
    let disposable = vscode.commands.registerCommand('otak-monitor.copyMetrics', () => {
        const metrics = metricsCollector.getAllMetrics();
        
        // ツールチップを更新
        statusBarItem.tooltip = MetricsFormatter.createTooltip(metrics);
        
        // クリップボードにコピー
        const clipboardText = MetricsFormatter.createClipboardText(metrics);
        vscode.env.clipboard.writeText(clipboardText).then(() => {
            // 一時的な通知を表示（5秒後に自動で消える）
            vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'System metrics copied to clipboard (Markdown format)',
                    cancellable: false
                },
                async (progress) => {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            );
        });
    });
    context.subscriptions.push(disposable);

    // タイマーの再設定処理
    function startTimer() {
        if (timer) {
            clearInterval(timer);
        }
        timer = setInterval(updateStatus, getEffectiveInterval()) as NodeJS.Timeout;
    }

    // VS Code ウィンドウのフォーカス状態に応じて更新間隔を決定
    function getEffectiveInterval(): number {
        const UPDATE_INTERVAL = 5000; // 基本は5秒ごと
        return vscode.window.state.focused ? UPDATE_INTERVAL : UPDATE_INTERVAL * 2;
    }

    // ステータスバーの更新
    function updateStatus() {
        const metrics = metricsCollector.getAllMetrics();
        statusBarItem.text = MetricsFormatter.getStatusBarText(metrics.cpu.usage);
        
        // ツールチップも定期的に更新
        statusBarItem.tooltip = MetricsFormatter.createTooltip(metrics);
        
        statusBarItem.show();
    }

    // フォーカス状態変更時にタイマーを再設定
    vscode.window.onDidChangeWindowState(() => {
        startTimer();
    }, null, context.subscriptions);

    // 初期タイマー開始
    startTimer();
}

export function deactivate() {
    if (timer) {
        clearInterval(timer);
    }
}