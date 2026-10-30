import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createReportBundle } from "@oh-my-pi/pi-coding-agent/debug/report-bundle";
import { getConfigRootDir, getLogsDir, localDay, logger, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tmpEnvNames = ["TMPDIR", "TMP", "TEMP"] as const;
const originalTmpEnv = tmpEnvNames.map(name => process.env[name]);
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
let cleanupRoot: string | undefined;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

// Points the report dir at `root`. XDG_STATE_HOME is only honored on Linux/macOS;
// elsewhere the config root follows the home dir, so redirect that instead —
// otherwise the bundle lands in the user's real ~/.omp/reports. A test process's
// logs dir lives under the temp dir, so point that at `root` too.
async function isolateLogsRoot(root: string): Promise<void> {
	if (process.platform === "linux" || process.platform === "darwin") {
		const xdgStateHome = path.join(root, "state");
		await fs.mkdir(path.join(xdgStateHome, "omp"), { recursive: true });
		process.env.XDG_STATE_HOME = xdgStateHome;
	} else {
		process.env.HOME = root;
		process.env.USERPROFILE = root;
	}
	for (const name of tmpEnvNames) process.env[name] = root;
	setAgentDir(fallbackAgentDir);
}

afterEach(async () => {
	restoreEnv("XDG_STATE_HOME", originalXdgStateHome);
	restoreEnv("HOME", originalHome);
	restoreEnv("USERPROFILE", originalUserProfile);
	tmpEnvNames.forEach((name, index) => restoreEnv(name, originalTmpEnv[index]));
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	if (cleanupRoot) {
		await removeWithRetries(cleanupRoot);
		cleanupRoot = undefined;
	}
});

describe("report bundle logs", () => {
	it("collects every same-day PID log, not only the current process", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-report-logs-"));
		await isolateLogsRoot(cleanupRoot);

		const logsDir = getLogsDir();
		await fs.mkdir(logsDir, { recursive: true });
		// Log files are named with the local day (RotatingFileSink naming); same-day
		// collection must match them with the local day too, not the UTC key.
		const today = localDay(new Date());
		const crashedName = `omp.${today}.4242.log`;
		const rotatedName = `${crashedName}.1`;
		const currentName = `omp.${today}.${process.pid}.log`;
		await Bun.write(path.join(logsDir, crashedName), '{"pid":4242,"message":"fatal in crashed pid"}\n');
		await fs.utimes(path.join(logsDir, crashedName), 1, 1);
		await Bun.write(path.join(logsDir, rotatedName), '{"pid":4242,"message":"earlier rotated crash output"}\n');
		await fs.utimes(path.join(logsDir, rotatedName), 0, 0);
		await Bun.write(path.join(logsDir, currentName), '{"pid":0,"message":"later invocation"}\n');
		await fs.utimes(path.join(logsDir, currentName), 2, 2);
		// When the local and UTC days differ (00:00–08:00 in UTC+8), a log named
		// with the stale UTC key must not be collected anymore.
		const utcToday = new Date().toISOString().slice(0, 10);
		let staleUtcName: string | undefined;
		if (utcToday !== today) {
			staleUtcName = `omp.${utcToday}.4243.log`;
			await Bun.write(path.join(logsDir, staleUtcName), '{"pid":4243,"message":"stale utc-keyed"}\n');
			await fs.utimes(path.join(logsDir, staleUtcName), 3, 3);
		}

		const result = await createReportBundle({ sessionFile: undefined });

		expect(result.files).toContain("logs.txt");
		const archive = new Bun.Archive(await Bun.file(result.path).bytes());
		const files = await archive.files();
		const logsText = (await files.get("logs.txt")?.text()) ?? "";
		expect(logsText).toContain(crashedName);
		expect(logsText).toContain("fatal in crashed pid");
		expect(logsText).toContain(rotatedName);
		expect(logsText).toContain("earlier rotated crash output");
		expect(logsText).toContain(currentName);
		expect(logsText).toContain("later invocation");
		expect(logsText.indexOf(crashedName)).toBeLessThan(logsText.indexOf(currentName));
		if (staleUtcName) expect(logsText).not.toContain(staleUtcName);
	});

	it("includes this process's records still buffered by the batching file transport", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-report-buffered-"));
		await isolateLogsRoot(cleanupRoot);
		const logsDir = getLogsDir();
		logger.setTransports({ console: false, file: logsDir });
		const marker = `report-buffered-${crypto.randomUUID()}`;
		logger.debug("report bundle buffered probe", { marker });

		const result = await createReportBundle({ sessionFile: undefined }).finally(() =>
			logger.setTransports({ file: true }),
		);

		const archive = new Bun.Archive(await Bun.file(result.path).bytes());
		const logsText = (await (await archive.files()).get("logs.txt")?.text()) ?? "";
		await fs.rm(result.path, { force: true });
		expect(logsText).toContain(`omp.${localDay(new Date())}.${process.pid}.log`);
		expect(logsText).toContain(marker);
	});

	it("bundles every same-day record of the session and its subagents, past the per-file tail", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-report-session-logs-"));
		await isolateLogsRoot(cleanupRoot);
		const logsDir = getLogsDir();
		await fs.mkdir(logsDir, { recursive: true });
		const sessionFile = path.join(cleanupRoot, "session-main.jsonl");
		await Bun.write(
			sessionFile,
			'{"type":"title","v":1,"title":"t","updatedAt":"2026-01-01T00:00:00.000Z","pad":""}\n' +
				'{"type":"session","version":3,"id":"main-session","cwd":"/"}\n',
		);
		// A header the session loader accepts need not be compactly serialized.
		await Bun.write(
			path.join(cleanupRoot, "session-main", "0-Worker.jsonl"),
			'{"type": "session", "version": 3, "id": "sub-session", "cwd": "/"}\n',
		);
		// A JSONL artifact that is no subagent transcript names a session that is not ours.
		await Bun.write(
			path.join(cleanupRoot, "session-main", "local", "copied.jsonl"),
			'{"type":"session","version":3,"id":"copied-session","cwd":"/"}\n',
		);
		const record = (message: string, sessionId?: string) =>
			JSON.stringify({ level: "warn", pid: 4242, message, ...(sessionId ? { sessionId } : {}) });
		const lines = [
			record("main early", "main-session"),
			record("subagent early", "sub-session"),
			record("other session", "other-session"),
			record("copied artifact's session", "copied-session"),
			record("nested only", undefined).replace("}", ',"detail":{"sessionId":"main-session"}}'),
			...Array.from({ length: 1500 }, (_, i) => record(`filler ${i}`)),
			record("main late", "main-session"),
		];
		await Bun.write(path.join(logsDir, `omp.${localDay(new Date())}.4242.log`), `${lines.join("\n")}\n`);

		const result = await createReportBundle({ sessionFile });

		const archive = await new Bun.Archive(await Bun.file(result.path).bytes()).files();
		await fs.rm(result.path, { force: true });
		// The 1000-line tail of the crashed process's file misses the early records.
		expect((await archive.get("logs.txt")?.text()) ?? "").not.toContain("main early");
		const sessionLogs = (await archive.get("session-logs.txt")?.text()) ?? "";
		expect(sessionLogs.split("\n").map(line => JSON.parse(line).message)).toEqual([
			"main early",
			"subagent early",
			"main late",
		]);
	});

	it("keeps the 2 MB tail cap on logs.txt when it also collects session records", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-report-tail-cap-"));
		await isolateLogsRoot(cleanupRoot);
		const logsDir = getLogsDir();
		await fs.mkdir(logsDir, { recursive: true });
		const sessionFile = path.join(cleanupRoot, "session-main.jsonl");
		await Bun.write(sessionFile, '{"type":"session","version":3,"id":"main-session","cwd":"/"}\n');
		const big = JSON.stringify({ level: "warn", message: "big", pad: "x".repeat(3 * 1024 * 1024) });
		const last = JSON.stringify({ level: "warn", message: "last", sessionId: "main-session" });
		await Bun.write(path.join(logsDir, `omp.${localDay(new Date())}.4242.log`), `${big}\n${last}\n`);

		const result = await createReportBundle({ sessionFile });

		const archive = await new Bun.Archive(await Bun.file(result.path).bytes()).files();
		await fs.rm(result.path, { force: true });
		const logsText = (await archive.get("logs.txt")?.text()) ?? "";
		// The 3 MB record starts before the tail window, so only the line after it remains.
		expect(logsText).not.toContain('"message":"big"');
		expect(logsText).toContain('"message":"last"');
		expect((await archive.get("session-logs.txt")?.text()) ?? "").toBe(last);
	});
});
