import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeDefaultSessionDir, writeTerminalBreadcrumb } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getAgentDir, getCustomSessionRootsDir, getSessionsDir, hashPath, setAgentDir } from "@oh-my-pi/pi-utils";

const cleanup: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

function legacySessionDir(sessionsRoot: string, cwd: string): string {
	const name = `--${path
		.resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return path.join(sessionsRoot, name);
}

afterEach(() => {
	for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("legacy session directory migration", () => {
	test("keeps a colliding live legacy session reachable through its path", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const canonicalDir = computeDefaultSessionDir(cwd, storage, sessionsRoot);
		const legacyDir = legacySessionDir(sessionsRoot, cwd);
		const source = path.join(legacyDir, "active.jsonl");
		const destination = path.join(canonicalDir, "active.jsonl");
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(source, "live-before\n");
		fs.writeFileSync(destination, "stale\n");
		const fd = fs.openSync(source, "a");

		computeDefaultSessionDir(cwd, storage, sessionsRoot);
		fs.writeSync(fd, "live-after\n");
		fs.closeSync(fd);

		expect(fs.readFileSync(source, "utf8")).toBe("live-before\nlive-after\n");
		expect(fs.readFileSync(destination, "utf8")).toBe("stale\n");
	});

	test("preserves writes when an older process recreates its cached legacy directory", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const canonicalDir = computeDefaultSessionDir(cwd, storage, sessionsRoot);
		const legacyDir = legacySessionDir(sessionsRoot, cwd);
		const destination = path.join(canonicalDir, "active.jsonl");
		fs.writeFileSync(destination, "canonical\n");

		fs.mkdirSync(legacyDir, { recursive: true });
		const recreated = path.join(legacyDir, "active.jsonl");
		fs.writeFileSync(recreated, "older-process-write\n");
		computeDefaultSessionDir(cwd, storage, sessionsRoot);

		expect(fs.readFileSync(recreated, "utf8")).toBe("older-process-write\n");
		expect(fs.readFileSync(destination, "utf8")).toBe("canonical\n");
	});
});

describe("custom session-root registry", () => {
	test("records a relocated session root and skips managed ones", () => {
		const agentDir = makeTempDir("omp-agent-");
		const cwd = makeTempDir("omp-cwd-");
		const originalAgentDir = getAgentDir();
		setAgentDir(agentDir);
		try {
			// A relative --session-dir resolves against cwd and lands in the registry.
			writeTerminalBreadcrumb(cwd, path.join(".omp-sessions", "work.jsonl"));
			const expectedRoot = path.join(cwd, ".omp-sessions");
			const marker = path.join(getCustomSessionRootsDir(agentDir), hashPath(expectedRoot));
			expect(fs.readFileSync(marker, "utf8")).toBe(expectedRoot);

			// A transcript under the managed sessions root is never registered.
			const managedFile = path.join(getSessionsDir(agentDir), "project", "s.jsonl");
			writeTerminalBreadcrumb(cwd, managedFile);
			const managedMarker = path.join(getCustomSessionRootsDir(agentDir), hashPath(path.dirname(managedFile)));
			expect(fs.existsSync(managedMarker)).toBe(false);
		} finally {
			setAgentDir(originalAgentDir);
		}
	});
});
