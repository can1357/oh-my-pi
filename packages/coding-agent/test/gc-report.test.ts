import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { collectStorageReport, formatStorageReport, type StorageReport } from "@oh-my-pi/pi-coding-agent/cli/gc-report";
import Gc from "@oh-my-pi/pi-coding-agent/commands/gc";
import { getBlobsDir, getHistoryDbPath, getSessionsDir, TempDir } from "@oh-my-pi/pi-utils";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

const commandConfig: CliConfig = { bin: "omp", version: "test", commands: new Map([["gc", Gc]]) };

describe("read-only storage reports", () => {
	test("classifies nested journals, logs, archives and database sidecars without reading their contents", async () => {
		await using temp = await TempDir.create("@omp-gc-report-");
		const agentDir = temp.join("agent");
		const sessions = getSessionsDir(agentDir);
		const archive = path.join(path.dirname(sessions), "archive", "sessions");
		const blobDir = getBlobsDir(agentDir);
		const hash = "a".repeat(64);
		const entries = [
			[path.join(sessions, "project", "main.jsonl"), "invalid journal"],
			[path.join(sessions, "project", "main", "Child.jsonl"), "nested journal"],
			[path.join(sessions, "project", "main", "0.bash.log"), "output".repeat(40)],
			[path.join(sessions, "project", "main", "Child.md"), "child output"],
			[path.join(sessions, "project", "main", "local", "capture.jsonl"), "local capture"],
			[path.join(sessions, "project", "main", "local", "nested", "build.log"), "local log"],
			[path.join(archive, "project", "old.jsonl.gz"), "not a gzip stream"],
			[path.join(archive, "project", "old", "1.read.log"), "old output"],
			[path.join(archive, "project", "old", "local", "asset.txt"), "archived local file"],
			[path.join(archive, "project", "old", "local", "capture.jsonl"), "archived local capture"],
			[path.join(archive, "project", "legacy.jsonl..bak"), "legacy backup"],
			[path.join(archive, "project", "old", "local", "nested", "build.log"), "archived local log"],
			[path.join(blobDir, hash), "blob"],
			[path.join(blobDir, "index.json"), "blob index"],
			[getHistoryDbPath(agentDir), "not a database"],
			[path.join(agentDir, "stats.db"), "stats database"],
			[`${getHistoryDbPath(agentDir)}-wal`, "wal"],
			[`${getHistoryDbPath(agentDir)}-shm`, "shm"],
		] as const;
		for (const [file, content] of entries) await Bun.write(file, content);
		const before = await Promise.all(entries.map(async ([file]) => ({ file, info: await fs.stat(file) })));

		const report = await collectStorageReport(agentDir);

		expect(report.categories.sessionJournals.files).toBe(2);
		expect(report.categories.sessionJournals.logicalBytes).toBe(Buffer.byteLength("invalid journalnested journal"));
		expect(report.categories.sessionLogs.logicalBytes).toBe(240);
		expect(report.categories.archiveJournals.logicalBytes).toBe(Buffer.byteLength("not a gzip streamlegacy backup"));
		expect(report.categories.sessionArtifacts).toEqual({ files: 3, logicalBytes: 34 });
		expect(report.categories.archiveLogs).toEqual({ files: 1, logicalBytes: 10 });
		expect(report.categories.archiveArtifacts).toEqual({ files: 3, logicalBytes: 59 });
		expect(report.categories.blobs).toEqual({ files: 1, logicalBytes: 4 });
		expect(report.categories.blobAuxiliary).toEqual({ files: 1, logicalBytes: 10 });
		expect(report.categories.databases).toEqual({ files: 2, logicalBytes: 28 });
		expect(report.categories.databaseSidecars).toEqual({ files: 2, logicalBytes: 6 });
		expect(report.total).toEqual({
			files: entries.length,
			logicalBytes: entries.reduce((total, [, content]) => total + Buffer.byteLength(content), 0),
		});
		expect(report.errors).toEqual([]);
		expect(report.largestFiles[0].path).toBe(path.join(sessions, "project", "main", "0.bash.log"));
		for (const { file, info } of before) {
			const after = await fs.stat(file);
			expect({ size: after.size, mtime: after.mtimeMs, ino: after.ino }).toEqual({
				size: info.size,
				mtime: info.mtimeMs,
				ino: info.ino,
			});
		}
		expect(await fs.readdir(agentDir)).toEqual(expect.not.arrayContaining(["gc.lock", "agent.db", "config.yml"]));
	});

	test.skipIf(process.platform === "win32")(
		"does not follow linked files or directories and escapes filenames in text output",
		async () => {
			await using temp = await TempDir.create("@omp-gc-report-links-");
			const agentDir = temp.join("agent");
			const sessions = getSessionsDir(agentDir);
			const outside = temp.join("outside");
			await Bun.write(path.join(outside, "large.log"), "must not count".repeat(1024));
			await Bun.write(path.join(outside, "sessions", "unexpected.jsonl"), "must not count either");
			const namedFile = path.join(sessions, "project", "tab\tand\nline.log");
			await Bun.write(namedFile, "kept");
			await fs.symlink(outside, path.join(sessions, "linked-dir"), "junction");
			await fs.symlink(path.join(outside, "large.log"), path.join(sessions, "linked.log"));
			await fs.symlink(outside, path.join(path.dirname(sessions), "archive"));

			const report = await collectStorageReport(agentDir);

			expect(report.total).toEqual({ files: 1, logicalBytes: 4 });
			expect(report.skipped.symlinks).toBe(3);
			expect(formatStorageReport(report)).toContain(JSON.stringify(namedFile));
			expect(formatStorageReport(report)).not.toContain("tab\tand\nline.log");
		},
	);

	test("reports an unreadable subtree as an error instead of a complete empty inventory", async () => {
		await using temp = await TempDir.create("@omp-gc-report-denied-");
		const agentDir = temp.join("agent");
		const sessions = getSessionsDir(agentDir);
		await fs.mkdir(sessions, { recursive: true });
		const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
		const originalOpen = fs.opendir;
		const openSpy = spyOn(fs, "opendir").mockImplementation((file, options) => {
			if (file === sessions) return Promise.reject(denied);
			return originalOpen(file, options);
		});
		try {
			const report = await collectStorageReport(agentDir);
			expect(report.errors).toEqual([{ path: sessions, message: "permission denied" }]);
		} finally {
			openSpy.mockRestore();
		}
	});

	test("CLI text sanitizes paths and errors while JSON preserves their original values", async () => {
		await using temp = await TempDir.create("@omp-gc-report-controls-");
		const controls = String.fromCharCode(...Array.from({ length: 33 }, (_, index) => 0x7f + index));
		const agentDir = temp.join(`agent${controls}`);
		const sessions = getSessionsDir(agentDir);
		const largestFile = path.join(sessions, `largest${controls}.log`);
		const deniedDir = path.join(sessions, `denied${controls}`);
		const message = `permission${controls} denied\nretry\tlater`;
		await Bun.write(largestFile, "output");
		await fs.mkdir(deniedDir);
		const denied = Object.assign(new Error(message), { code: "EACCES" });
		const originalOpen = fs.opendir;
		const openSpy = spyOn(fs, "opendir").mockImplementation((file, options) => {
			if (file === deniedDir) return Promise.reject(denied);
			return originalOpen(file, options);
		});
		const output: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			output.push(String(chunk));
			return true;
		});
		const originalExitCode = process.exitCode;
		try {
			await new Gc(["--report", "--agent-dir", agentDir], commandConfig).run();
			const text = output.join("");
			for (const control of controls) expect(text).not.toContain(control);
			const safeAgentDir = temp.join("agent");
			expect(text).toContain(JSON.stringify(safeAgentDir));
			expect(text).toContain(JSON.stringify(path.join(safeAgentDir, "sessions", "largest.log")));
			expect(text).toContain(JSON.stringify(path.join(safeAgentDir, "sessions", "denied")));
			expect(text).toContain(JSON.stringify("permission denied\nretry\tlater"));
			output.length = 0;
			await new Gc(["--report", "--json", "--agent-dir", agentDir], commandConfig).run();
			const report = JSON.parse(output.join("")) as StorageReport;
			expect(report.agentDir).toBe(agentDir);
			expect(report.largestFiles).toEqual([{ path: largestFile, category: "sessionLogs", logicalBytes: 6 }]);
			expect(report.errors).toEqual([{ path: deniedDir, message }]);
		} finally {
			process.exitCode = originalExitCode ?? 0;
			stdoutSpy.mockRestore();
			openSpy.mockRestore();
		}
	});

	test("report-only CLI emits JSON without creating a missing agent directory", async () => {
		await using temp = await TempDir.create("@omp-gc-report-cli-");
		const agentDir = temp.join("missing");
		const output: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			output.push(String(chunk));
			return true;
		});
		try {
			await new Gc(["--report", "--json", "--agent-dir", agentDir], commandConfig).run();
		} finally {
			stdoutSpy.mockRestore();
		}
		const report = JSON.parse(output.join("")) as StorageReport;
		expect(report.total).toEqual({ files: 0, logicalBytes: 0 });
		expect(report.consistentSnapshot).toBe(false);
		expect(await fs.readdir(temp.path())).toEqual([]);
	});

	test("rejects mutating and policy selectors before a report touches storage", async () => {
		await using temp = await TempDir.create("@omp-gc-report-flags-");
		const agentDir = temp.join("missing");
		await expect(new Gc(["--report", "--apply", "--agent-dir", agentDir], commandConfig).run()).rejects.toThrow(
			/--report cannot be combined/,
		);
		await expect(
			new Gc(["--report", "--retain-newest-global=0", "--agent-dir", agentDir], commandConfig).run(),
		).rejects.toThrow(/--report cannot be combined/);
		expect(await fs.readdir(temp.path())).toEqual([]);
	});
});
