import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createReportBundle } from "@oh-my-pi/pi-coding-agent/debug/report-bundle";
import { getConfigRootDir, getLogsDir, localDay, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
let cleanupRoot: string | undefined;

afterEach(async () => {
	if (originalXdgStateHome === undefined) {
		delete process.env.XDG_STATE_HOME;
	} else {
		process.env.XDG_STATE_HOME = originalXdgStateHome;
	}
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
		const xdgStateHome = path.join(cleanupRoot, "state");
		await fs.mkdir(path.join(xdgStateHome, "omp"), { recursive: true });
		process.env.XDG_STATE_HOME = xdgStateHome;
		setAgentDir(fallbackAgentDir);

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
});
