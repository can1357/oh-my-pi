import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const fixtureDir = path.join(import.meta.dir, "fixtures");
const probePath = path.join(fixtureDir, "logger-contract-probe.ts");
const fatalProbePath = path.join(fixtureDir, "logger-fatal-flush-probe.ts");
const preloadPath = path.join(fixtureDir, "logger-fixed-date-preload.ts");
const fixedNow = "2026-01-02T03:04:05.006Z";
const fixedTimestamp = "2026-01-01T22:04:05.006-05:00";
const roots: string[] = [];

interface ScenarioResult {
	readonly pid: number;
	readonly root: string;
	readonly primaryDir: string;
	readonly secondaryDir: string;
	readonly resultPath: string;
	readonly stdout: string;
	readonly stderr: string;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function runScenario(
	scenario: string,
	options: { logLevel?: string; probe?: string; exitCode?: number } = {},
): Promise<ScenarioResult> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-logger-contract-"));
	roots.push(root);
	const primaryDir = path.join(root, "primary");
	const secondaryDir = path.join(root, "secondary");
	const resultPath = path.join(root, "result.json");
	const stdoutPath = path.join(root, "stdout.log");
	await Promise.all([fs.mkdir(primaryDir), fs.mkdir(secondaryDir)]);
	const proc = Bun.spawn(
		[
			process.execPath,
			"--preload",
			preloadPath,
			options.probe ?? probePath,
			scenario,
			primaryDir,
			secondaryDir,
			resultPath,
		],
		{
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: {
				...process.env,
				HOME: primaryDir,
				// os.homedir() on Windows reads USERPROFILE, not HOME: without
				// this the default-file scenario logs into the real profile.
				USERPROFILE: primaryDir,
				PI_CONFIG_DIR: ".omp",
				OMP_PROFILE: "",
				PI_PROFILE: "",
				XDG_DATA_HOME: "",
				XDG_STATE_HOME: "",
				XDG_CACHE_HOME: "",
				// Empty XDG_CACHE_HOME makes Bun's transpiler cache path relative,
				// spewing bun/@t@/*.pile into the repo root (the child's cwd) — disable it.
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
				OMP_LOGGER_TEST_NOW: fixedNow,
				OMP_LOG_LEVEL: options.logLevel ?? "",
				TZ: "Etc/GMT+5",
			},
			stdout: Bun.file(stdoutPath),
			stderr: "pipe",
		},
	);
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	expect(exitCode, stderr).toBe(options.exitCode ?? 0);
	const stdout = await fs.readFile(stdoutPath, "utf8");
	return { pid: proc.pid, root, primaryDir, secondaryDir, resultPath, stdout, stderr };
}

async function logFileNames(directory: string): Promise<string[]> {
	return (await fs.readdir(directory))
		.filter(name => /^omp\.\d{4}-\d{2}-\d{2}\.\d+\.log(?:\.\d+)?$/.test(name))
		.sort();
}

async function readSingleLog(directory: string): Promise<{ name: string; text: string }> {
	const names = await logFileNames(directory);
	expect(names).toHaveLength(1);
	const name = names[0];
	if (!name) throw new Error("expected one log file");
	return { name, text: await fs.readFile(path.join(directory, name), "utf8") };
}

interface LogEntry {
	readonly level: string;
	readonly message: string;
}

async function readLogEntries(directory: string): Promise<LogEntry[]> {
	const lines = (await readSingleLog(directory)).text.split(os.EOL).filter(line => line.length > 0);
	return lines.map(line => {
		const entry: LogEntry = JSON.parse(line);
		return entry;
	});
}

function expectedLine(
	pid: number,
	level: "error" | "warn" | "info" | "debug",
	message: string,
	context: Record<string, unknown> = {},
	timestamp = fixedTimestamp,
): string {
	return `${JSON.stringify({ timestamp, level, pid, message, ...context })}${os.EOL}`;
}

describe("central logger byte contract", () => {
	test("pins levels, metadata normalization, key order, timestamp, errors, pid, and EOL", async () => {
		const result = await runScenario("matrix");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const log = await readSingleLog(result.primaryDir);
		expect(log.name).toBe(`omp.2026-01-01.${result.pid}.log`);
		const expected = [
			expectedLine(result.pid, "error", "level-error", { ordinal: 1 }),
			expectedLine(result.pid, "warn", "level-warn", { ordinal: 2 }),
			expectedLine(result.pid, "info", "level-info", { ordinal: 3 }),
			expectedLine(result.pid, "debug", "level-debug", { ordinal: 4 }),
			expectedLine(result.pid, "info", "context-matrix", {
				stringValue: "text",
				numberValue: 7,
				booleanValue: false,
				nullValue: null,
				nested: { alpha: "a", values: [1, null, null, null] },
				infinity: null,
				nan: null,
			}),
			expectedLine(result.pid, "warn", "reserved-primary metadata-message", { before: "first", after: "last" }),
			expectedLine(result.pid, "debug", "reserved-falsy", { after: true }),
			expectedLine(result.pid, "error", "error-matrix", {
				error: {
					name: "CustomError",
					message: "upstream",
					stack: "OUTER_STACK",
					code: "E_FIXTURE",
					detail: { retry: false },
					cause: { name: "Error", message: "downstream", stack: "CAUSE_STACK" },
				},
			}),
		].join("");
		expect(log.text).toBe(expected);
		expect(log.text.endsWith(os.EOL)).toBe(true);
		expect((await fs.readdir(result.primaryDir)).filter(name => name.endsWith("-audit.json"))).toEqual([]);
	});

	test("treats Winston format tokens as a splat branch and omits context", async () => {
		const result = await runScenario("format-tokens");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const tokenMessages = [
			"token-%s",
			"token-%c",
			"token-%d",
			"token-%j",
			"token-%i",
			"token-%f",
			"token-%o",
			"token-%O",
			"token-%%",
		];
		const expected = [
			...tokenMessages.map(message => expectedLine(result.pid, "info", message)),
			expectedLine(result.pid, "info", "non-token-%q", { value: 7 }),
			expectedLine(result.pid, "info", "circular-%s"),
			expectedLine(result.pid, "info", "bigint-%d"),
		].join("");
		expect((await readSingleLog(result.primaryDir)).text).toBe(expected);
	});

	test("drops native JSON failures locally but sends original contexts to sinks", async () => {
		const result = await runScenario("serialization-failures");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		// Nothing serialized, so the lazily created file never appears.
		expect(await logFileNames(result.primaryDir)).toEqual([]);
		const payload = JSON.parse(await fs.readFile(result.resultPath, "utf8")) as {
			events: Array<{ level: string; message: string; sameContext: boolean; timestamp: string }>;
		};
		expect(payload.events).toEqual([
			{ level: "info", message: "circular-drop", sameContext: true, timestamp: fixedNow },
			{ level: "error", message: "bigint-drop", sameContext: true, timestamp: fixedNow },
		]);
	});
});

describe("central logger file level and batching", () => {
	test("persists debug records by default", async () => {
		const result = await runScenario("debug-only");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect((await readSingleLog(result.primaryDir)).text).toBe(
			expectedLine(result.pid, "debug", "debug-only-first", { ordinal: 1 }) +
				expectedLine(result.pid, "debug", "debug-only-second", { ordinal: 2 }),
		);
	});

	test("OMP_LOG_LEVEL=warn gates info and debug while warn and error stay on disk", async () => {
		const result = await runScenario("matrix", { logLevel: "WARN" });
		expect((await readLogEntries(result.primaryDir)).map(entry => entry.message)).toEqual([
			"level-error",
			"level-warn",
			"reserved-primary metadata-message",
			"error-matrix",
		]);
	});

	test("the fatal record lands after the buffered records that preceded it", async () => {
		const result = await runScenario("uncaught", { probe: fatalProbePath, exitCode: 1 });
		expect((await readLogEntries(result.primaryDir)).map(entry => [entry.level, entry.message])).toEqual([
			["info", "before-crash-info"],
			["debug", "before-crash-debug"],
			["error", "Uncaught exception"],
		]);
	});

	test("a hard exit through exitProcess writes the buffered records", async () => {
		const result = await runScenario("exit-process", { probe: fatalProbePath, exitCode: 3 });
		expect((await readLogEntries(result.primaryDir)).map(entry => [entry.level, entry.message])).toEqual([
			["info", "before-exit-info"],
			["debug", "before-exit-debug"],
		]);
	});
});

describe("central logger transport lifecycle", () => {
	test("defaults to file-only without touching stdout or stderr", async () => {
		const result = await runScenario("default-file");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const defaultLogsDir = path.join(result.primaryDir, ".omp", "logs");
		const log = await readSingleLog(defaultLogsDir);
		expect(log.text).toBe(expectedLine(result.pid, "info", "mode-default", { mode: "default" }));
	});

	test("emits file-only, console-only, and dual modes exactly once", async () => {
		const fileOnly = await runScenario("file-only");
		const fileLine = expectedLine(fileOnly.pid, "info", "mode-file", { mode: "file" });
		expect(fileOnly.stdout).toBe("");
		expect(fileOnly.stderr).toBe("");
		expect((await readSingleLog(fileOnly.primaryDir)).text).toBe(fileLine);

		const consoleOnly = await runScenario("console-only");
		const consoleLine = expectedLine(consoleOnly.pid, "info", "mode-console", { mode: "console" });
		expect(consoleOnly.stdout).toBe(consoleLine);
		expect(consoleOnly.stderr).toBe("");
		expect(await logFileNames(consoleOnly.primaryDir)).toEqual([]);

		const both = await runScenario("both");
		const bothLine = expectedLine(both.pid, "info", "mode-both", { mode: "both" });
		expect(both.stdout).toBe(bothLine);
		expect(both.stderr).toBe("");
		expect((await readSingleLog(both.primaryDir)).text).toBe(bothLine);
	});

	test("keeps disabled mode silent, sends sinks, preserves void returns, and re-enables", async () => {
		const result = await runScenario("disabled-reenable");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect((await readSingleLog(result.primaryDir)).text).toBe(
			expectedLine(result.pid, "warn", "mode-reenabled", { mode: "file" }),
		);
		const payload = JSON.parse(await fs.readFile(result.resultPath, "utf8")) as {
			disabledSinkSameContext: boolean;
			sinkCount: number;
			returnsUndefined: boolean;
		};
		expect(payload).toEqual({ disabledSinkSameContext: true, sinkCount: 2, returnsUndefined: true });
	});

	test("closes A before reconfiguring to B and never cross-writes", async () => {
		const result = await runScenario("reconfigure");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect((await readSingleLog(result.primaryDir)).text).toBe(
			expectedLine(result.pid, "info", "directory-a", { destination: "a" }),
		);
		expect((await readSingleLog(result.secondaryDir)).text).toBe(
			expectedLine(result.pid, "info", "directory-b", { destination: "b" }),
		);
	});

	test("invalidates closed transports when warm replacement construction fails", async () => {
		const result = await runScenario("reconfigure-failure");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect((await readSingleLog(result.primaryDir)).text).toBe(
			expectedLine(result.pid, "info", "before-failed-reconfigure"),
		);
		expect(await logFileNames(result.secondaryDir)).toEqual([]);
		const payload = JSON.parse(await fs.readFile(result.resultPath, "utf8")) as {
			reconfigureThrew: boolean;
			sinkCount: number;
			sinkSameContext: boolean;
		};
		expect(payload).toEqual({ reconfigureThrew: true, sinkCount: 1, sinkSameContext: true });
	});

	// Two sequential probe children writing 1000 records each measure ~4.4 s
	// on an unloaded runner — bun's 5 s default test timeout SIGTERMed the
	// probe (exit 143) whenever CI runners shared cores. The contract is
	// order + drain, not latency; give it an explicit budget.
	test("preserves burst order and drains on close and natural child exit", async () => {
		for (const scenario of ["burst-close", "burst-natural"] as const) {
			const result = await runScenario(scenario);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			const text = (await readSingleLog(result.primaryDir)).text;
			expect(text.endsWith(os.EOL)).toBe(true);
			const lines = text.split(os.EOL);
			expect(lines.pop()).toBe("");
			expect(lines).toHaveLength(1_000);
			for (const [index, line] of lines.entries()) {
				const entry = JSON.parse(line) as { message: string; index: number };
				expect(entry).toMatchObject({ message: scenario, index });
			}
		}
	}, 30_000);

	test("runs local console output before sinks and isolates throwing or disposed sinks", async () => {
		const result = await runScenario("sink-order");
		const first = expectedLine(result.pid, "info", "sink-first", { identity: "same" });
		const second = expectedLine(result.pid, "info", "sink-disposed");
		expect(result.stdout).toBe(`${first}SINK:true\n${second}`);
		expect(result.stderr).toBe("");
	});
});

describe("DailyRotateFile option and retention contract", () => {
	test("uses local-day names and retains exactly five rotations without an audit file", async () => {
		const result = await runScenario("date-retention");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const expectedNames = [2, 3, 4, 5, 6].map(day => `omp.2026-01-0${day}.${result.pid}.log`);
		expect(await logFileNames(result.primaryDir)).toEqual(expectedNames);
		for (const [offset, name] of expectedNames.entries()) {
			const day = offset + 2;
			const timestamp = `2026-01-0${day}T22:04:05.006-05:00`;
			expect(await fs.readFile(path.join(result.primaryDir, name), "utf8")).toBe(
				expectedLine(result.pid, "info", `date-${day}`, {}, timestamp),
			);
		}
		expect((await fs.readdir(result.primaryDir)).sort()).toEqual(expectedNames);
	});

	test("crosses 10 MiB before rolling the following record to suffix .1", async () => {
		const result = await runScenario("size-rotation");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const baseName = `omp.2026-01-01.${result.pid}.log`;
		const rotatedName = `${baseName}.1`;
		expect(await logFileNames(result.primaryDir)).toEqual([baseName, rotatedName]);
		const basePath = path.join(result.primaryDir, baseName);
		const baseStat = await fs.stat(basePath);
		const recordSize = (message: string, payloadSize: number): number =>
			`{"timestamp":"${fixedTimestamp}","level":"info","pid":${result.pid},"message":"${message}","payload":"`
				.length +
			payloadSize +
			`"}${os.EOL}`.length;
		const expectedBytes =
			recordSize("size-nine-mib", 9 * 1024 * 1024) +
			recordSize("size-half-mib", 512 * 1024) +
			recordSize("size-crosses-ten-mib", 1024 * 1024);
		expect(baseStat.size).toBe(expectedBytes);
		expect(baseStat.size).toBeGreaterThan(10 * 1024 * 1024);
		expect(await fs.readFile(path.join(result.primaryDir, rotatedName), "utf8")).toBe(
			expectedLine(result.pid, "info", "rotation-trigger"),
		);
		expect((await fs.readdir(result.primaryDir)).sort()).toEqual([baseName, rotatedName]);
	});
});
