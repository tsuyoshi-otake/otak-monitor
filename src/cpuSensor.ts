import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * What a platform can tell us about the processor beyond what `os.cpus()` says.
 * Both fields are optional because both are genuinely unavailable on some
 * machines, and a missing reading is shown as nothing rather than as a zero.
 */
export interface CpuSensorReading {
    /** The clock the package is running at right now, in MHz. */
    currentSpeed?: number;
    /** Package temperature in degrees Celsius. */
    temperatureC?: number;
}

export interface CpuSensorOptions {
    /** Ask for the running clock. */
    clock: boolean;
    /** Ask for the package temperature. */
    temperature: boolean;
}

/**
 * A source of readings that cost more than a library call to take, so it is
 * started and stopped rather than polled: only the window that samples for the
 * machine runs one.
 */
export interface CpuSensor {
    /** The most recent reading. Empty until one arrives, and empty once stopped. */
    read(): CpuSensorReading;
    start(): void;
    stop(): void;
}

/** How often a sensor takes a reading. */
const SAMPLE_MS = 3000;

/**
 * How often the macOS sensor asks. Every reading there costs a process, and the
 * value it returns is one the machine rarely changes, so it is read on the
 * order of the minute rather than of the second.
 */
const DARWIN_SAMPLE_MS = 30_000;

/** How long a sensor that stopped on its own is left alone before restarting. */
const RESTART_DELAY_MS = 60_000;

/** How many restarts before the platform is written off as unable to answer. */
const MAX_RESTARTS = 2;

/** A sensor for the platforms that cannot answer, so callers need no branch. */
export class NullCpuSensor implements CpuSensor {
    read(): CpuSensorReading {
        return {};
    }

    start(): void {
        // Nothing to start: this platform exposes neither reading.
    }

    stop(): void {
        // Nothing to stop.
    }
}

/**
 * Reads the processor counters Windows only exposes through WMI.
 *
 * `os.cpus()` reports the nominal clock on Windows and never moves off it, so
 * the number in the tooltip stayed at the base frequency while the machine was
 * running half a gigahertz above or below it. What Task Manager shows is the
 * base clock scaled by the `% Processor Performance` counter, which is what
 * this reads.
 *
 * It reads it through one long-lived PowerShell process rather than one per
 * sample: starting PowerShell costs more processor time than every reading this
 * extension takes put together, and paying that every few seconds to report how
 * busy the processor is would be self-defeating. The counters are queried by
 * WMI class and property name rather than by performance-counter path, because
 * counter paths are localised and class names are not.
 */
class WindowsCpuSensor implements CpuSensor {
    private child: ChildProcess | undefined;
    private restartTimer: NodeJS.Timeout | undefined;
    private restarts = 0;
    private running = false;
    private pending = '';
    private latest: CpuSensorReading = {};

    constructor(
        private readonly options: CpuSensorOptions,
        private readonly baseSpeedProvider: () => number = () => os.cpus()[0]?.speed ?? 0
    ) {}

    read(): CpuSensorReading {
        return this.latest;
    }

    start(): void {
        if (this.running) {
            return;
        }
        this.running = true;
        this.restarts = 0;
        this.spawnSensor();
    }

    stop(): void {
        this.running = false;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = undefined;
        }
        this.child?.kill();
        this.child = undefined;
        this.pending = '';
        // The readings are only as good as the process that takes them; keeping
        // the last one would leave a frozen clock on display, which is the very
        // thing this sensor exists to fix.
        this.latest = {};
    }

    private spawnSensor(): void {
        const script = windowsSensorScript(this.options, SAMPLE_MS, process.pid);
        let child: ChildProcess;
        try {
            child = spawn('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                // Encoded rather than quoted: the script travels as one argument
                // whatever it contains, and an encoded command is not a script
                // file, so no execution policy applies to it.
                '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
            ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {
            this.running = false; // no PowerShell to run: the base clock stands
            return;
        }

        this.child = child;
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => this.consume(chunk));
        child.on('error', () => this.giveUp());
        child.on('exit', () => this.scheduleRestart(child));
    }

    private giveUp(): void {
        this.running = false;
        this.child = undefined;
        this.latest = {};
    }

    private scheduleRestart(exited: ChildProcess): void {
        if (this.child !== exited) {
            return; // already replaced, or stopped on purpose
        }
        this.child = undefined;
        this.latest = {};
        if (!this.running || this.restarts >= MAX_RESTARTS) {
            this.running = false;
            return;
        }
        this.restarts++;
        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            if (this.running) {
                this.spawnSensor();
            }
        }, RESTART_DELAY_MS);
        this.restartTimer.unref?.();
    }

    private consume(chunk: string): void {
        this.pending += chunk;
        let breakAt = this.pending.indexOf('\n');
        while (breakAt >= 0) {
            this.apply(this.pending.slice(0, breakAt));
            this.pending = this.pending.slice(breakAt + 1);
            breakAt = this.pending.indexOf('\n');
        }
        // A line that never arrives in full would grow without bound if the
        // process started writing something else entirely.
        if (this.pending.length > 1024) {
            this.pending = '';
        }
    }

    private apply(line: string): void {
        const [performance, celsius] = line.trim().split('|');
        this.latest = {
            currentSpeed: scaledClock(this.baseSpeedProvider(), toNumber(performance)),
            temperatureC: plausibleTemperature(toNumber(celsius))
        };
    }
}

/**
 * Reads what Linux publishes in `sysfs`, which is a handful of small files and
 * needs no process of its own. Which files hold the answer differs between
 * machines, so they are looked up once and then read on a timer.
 */
class LinuxCpuSensor implements CpuSensor {
    private timer: NodeJS.Timeout | undefined;
    private latest: CpuSensorReading = {};
    private clockPaths: string[] | undefined;
    private temperaturePaths: string[] | undefined;

    constructor(private readonly options: CpuSensorOptions) {}

    read(): CpuSensorReading {
        return this.latest;
    }

    start(): void {
        if (this.timer) {
            return;
        }
        void this.sample();
        this.timer = setInterval(() => void this.sample(), SAMPLE_MS);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.latest = {};
    }

    private async sample(): Promise<void> {
        const [currentSpeed, temperatureC] = await Promise.all([
            this.options.clock ? this.readClock() : Promise.resolve(undefined),
            this.options.temperature ? this.readTemperature() : Promise.resolve(undefined)
        ]);
        this.latest = { currentSpeed, temperatureC };
    }

    private async readClock(): Promise<number | undefined> {
        // Frequencies are published per policy, which is per cluster on a
        // machine whose cores differ, and the highest is the one the busy work
        // is running at. Machines without a `cpufreq` driver — most virtual
        // ones — publish nothing there, and `/proc/cpuinfo` is what is left.
        const paths = this.clockPaths ??= await listClockFiles();
        const kilohertz = await readMaximum(paths);
        if (kilohertz !== undefined) {
            return Math.round(kilohertz / 1000);
        }
        return await readProcCpuinfoMegahertz();
    }

    private async readTemperature(): Promise<number | undefined> {
        const paths = this.temperaturePaths ??= await listThermalZones();
        const millidegrees = await readMaximum(paths);
        return millidegrees === undefined ? undefined : plausibleTemperature(Math.round(millidegrees / 100) / 10);
    }
}

/**
 * Reads what macOS will answer without a password.
 *
 * That is less than the other two platforms give. The temperature sensors sit
 * behind the SMC, which `powermetrics` reads as root and nothing reads without
 * it; asking for a password to fill in a tooltip line is not a trade worth
 * making, so no temperature is reported at all. The clock is worth reading
 * because `os.cpus()` is unreliable here — on Apple silicon it reports the
 * timebase frequency rather than the processor's — and `sysctl` knows better on
 * the Intel machines that publish it.
 *
 * `sysctl` is a small static binary, but it is still a process, so it is asked
 * far less often than the counters that actually move.
 */
class DarwinCpuSensor implements CpuSensor {
    private timer: NodeJS.Timeout | undefined;
    private latest: CpuSensorReading = {};

    read(): CpuSensorReading {
        return this.latest;
    }

    start(): void {
        if (this.timer) {
            return;
        }
        void this.sample();
        this.timer = setInterval(() => void this.sample(), DARWIN_SAMPLE_MS);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.latest = {};
    }

    private async sample(): Promise<void> {
        const hertz = toNumber(await runSysctl('hw.cpufrequency'));
        this.latest = hertz === undefined || hertz <= 0
            ? {}
            : { currentSpeed: Math.round(hertz / 1_000_000) };
    }
}

export function createCpuSensor(
    options: CpuSensorOptions,
    platform: NodeJS.Platform = os.platform()
): CpuSensor {
    if (!options.clock && !options.temperature) {
        return new NullCpuSensor();
    }
    switch (platform) {
        case 'win32':
            return new WindowsCpuSensor(options);
        case 'linux':
            return new LinuxCpuSensor(options);
        case 'darwin':
            return options.clock ? new DarwinCpuSensor() : new NullCpuSensor();
        default:
            return new NullCpuSensor();
    }
}

/** The clock implied by a base frequency and a percentage of it, in MHz. */
export function scaledClock(baseSpeedMhz: number, performancePercent: number | undefined): number | undefined {
    if (performancePercent === undefined || performancePercent <= 0 || baseSpeedMhz <= 0) {
        return undefined;
    }
    return Math.round((baseSpeedMhz * performancePercent) / 100);
}

/**
 * Keep a temperature only if it could describe a processor. A machine with no
 * thermal zone reports zero rather than nothing, and a zone that names an
 * unrelated part of the chassis reports a room temperature; showing either as
 * the CPU temperature would be worse than showing no temperature at all.
 */
export function plausibleTemperature(celsius: number | undefined): number | undefined {
    if (celsius === undefined || celsius < 10 || celsius > 125) {
        return undefined;
    }
    return Math.round(celsius);
}

function toNumber(raw: string | undefined): number | undefined {
    if (raw === undefined || raw.trim() === '') {
        return undefined;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
}

async function listFiles(directory: string, prefix: string, leaf: string): Promise<string[]> {
    try {
        const entries = await fs.promises.readdir(directory);
        return entries
            .filter((entry) => entry.startsWith(prefix))
            .map((entry) => path.join(directory, entry, leaf));
    } catch {
        return [];
    }
}

/**
 * Where Linux publishes the current clock. One file per frequency policy where
 * the kernel groups the cores, one per core where it does not; the per-core
 * form is capped because reading it on a machine with a hundred cores would
 * cost more than the reading is worth.
 */
async function listClockFiles(): Promise<string[]> {
    const byPolicy = await listFiles('/sys/devices/system/cpu/cpufreq', 'policy', 'scaling_cur_freq');
    if (byPolicy.length > 0) {
        return byPolicy;
    }
    const byCore = await listFiles('/sys/devices/system/cpu', 'cpu', path.join('cpufreq', 'scaling_cur_freq'));
    return byCore.filter((each) => /cpu\d+/.test(each)).slice(0, 16);
}

/**
 * The highest clock `/proc/cpuinfo` reports, in MHz. This is the answer on a
 * machine with no `cpufreq` driver — a virtual one, most often — where the
 * kernel still knows what the processor told it.
 */
async function readProcCpuinfoMegahertz(): Promise<number | undefined> {
    const text = await readText('/proc/cpuinfo');
    if (text === undefined) {
        return undefined;
    }
    let highest: number | undefined;
    for (const line of text.split('\n')) {
        const match = /^cpu MHz\s*:\s*([\d.]+)/.exec(line);
        const value = match ? Number(match[1]) : undefined;
        if (value !== undefined && Number.isFinite(value) && (highest === undefined || value > highest)) {
            highest = value;
        }
    }
    return highest === undefined ? undefined : Math.round(highest);
}

/**
 * The thermal zones worth reading. A machine exposes zones for parts other than
 * the processor — the battery, the chassis, a wireless card — so the ones that
 * name the processor are preferred, and the rest are only read when none do.
 */
async function listThermalZones(): Promise<string[]> {
    const root = '/sys/class/thermal';
    let entries: string[];
    try {
        entries = (await fs.promises.readdir(root)).filter((entry) => entry.startsWith('thermal_zone'));
    } catch {
        return [];
    }

    const processorZones: string[] = [];
    const otherZones: string[] = [];
    for (const entry of entries) {
        const zone = path.join(root, entry);
        const type = await readText(path.join(zone, 'type'));
        const target = /pkg|x86|cpu|core|soc|k10temp|coretemp|tdie/i.test(type ?? '') ? processorZones : otherZones;
        target.push(path.join(zone, 'temp'));
    }
    return processorZones.length > 0 ? processorZones : otherZones;
}

async function readMaximum(paths: string[]): Promise<number | undefined> {
    let highest: number | undefined;
    for (const value of await Promise.all(paths.map((each) => readText(each)))) {
        const parsed = toNumber(value);
        if (parsed !== undefined && (highest === undefined || parsed > highest)) {
            highest = parsed;
        }
    }
    return highest;
}

/** One `sysctl` reading, or nothing at all if the name is not published. */
function runSysctl(name: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        let child: ChildProcess;
        try {
            child = spawn('/usr/sbin/sysctl', ['-n', name], { stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {
            resolve(undefined);
            return;
        }

        let output = '';
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            output += chunk;
        });
        child.on('error', () => resolve(undefined));
        child.on('close', (code) => resolve(code === 0 ? output.trim() : undefined));
    });
}

async function readText(filePath: string): Promise<string | undefined> {
    try {
        return await fs.promises.readFile(filePath, 'utf8');
    } catch {
        return undefined;
    }
}

/**
 * The loop the Windows sensor runs. It writes one `performance|celsius` line per
 * sample, leaving a field empty when that reading is unavailable, and stops
 * asking for a temperature the moment the machine turns out not to have one —
 * most desktops do not expose an ACPI thermal zone at all.
 *
 * It also stops when the window that started it is gone, so a host that dies
 * without running `deactivate` does not leave the sensor behind.
 */
export function windowsSensorScript(options: CpuSensorOptions, sampleMs: number, parentPid: number): string {
    return [
        '$ErrorActionPreference = \'SilentlyContinue\'',
        `$parentPid = ${parentPid}`,
        `$wantsTemperature = $${options.temperature ? 'true' : 'false'}`,
        'while ($true) {',
        '    if (-not (Get-Process -Id $parentPid)) { break }',
        '    $performance = \'\'',
        ...(options.clock ? [
            '    $counter = Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ProcessorInformation |',
            '        Where-Object { $_.Name -eq \'_Total\' } | Select-Object -First 1',
            '    if ($counter) { $performance = $counter.PercentProcessorPerformance }'
        ] : []),
        '    $celsius = \'\'',
        '    if ($wantsTemperature) {',
        '        $tenthsOfKelvin = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature |',
        '            ForEach-Object { $_.CurrentTemperature })',
        '        if ($tenthsOfKelvin.Count -eq 0) {',
        '            $tenthsOfKelvin = @(Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation |',
        '                ForEach-Object { $_.Temperature * 10 })',
        '        }',
        '        if ($tenthsOfKelvin.Count -gt 0) {',
        '            $hottest = ($tenthsOfKelvin | Measure-Object -Maximum).Maximum',
        '            $celsius = [math]::Round($hottest / 10 - 273.15, 1)',
        '        } else {',
        '            $wantsTemperature = $false',
        '        }',
        '    }',
        '    Write-Output ("$performance|$celsius")',
        `    Start-Sleep -Milliseconds ${sampleMs}`,
        '}'
    ].join('\n');
}
