import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { runSessionGc } from "@oh-my-pi/pi-coding-agent/session/session-gc";
import { tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getCustomSessionFilesDir, getSessionsDir } from "@oh-my-pi/pi-utils";

async function touchOld(target: string): Promise<void> {
	const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
	await fs.utimes(target, old, old);
}

async function makeSession(root: string, id: string): Promise<{ transcript: string; artifacts: string }> {
	const base = path.join(getSessionsDir(root), "project", `2026-01-01T00-00-00-000Z_${id}`);
	await fs.mkdir(base, { recursive: true });
	await Bun.write(`${base}.jsonl`, JSON.stringify({ type: "session", id }) + "\n");
	await Bun.write(path.join(base, "artifact"), "data");
	await touchOld(`${base}.jsonl`);
	await touchOld(path.join(base, "artifact"));
	await touchOld(base);
	return { transcript: `${base}.jsonl`, artifacts: base };
}

describe("runSessionGc", () => {
	it("deletes an expired transcript and its artifacts together, retaining either kind of recent activity", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-gc-"));
		try {
			const old = await makeSession(root, "old");
			const freshTranscript = await makeSession(root, "fresh-transcript");
			const freshArtifact = await makeSession(root, "fresh-artifact");
			await Bun.write(freshTranscript.transcript, "recent");
			await Bun.write(path.join(freshArtifact.artifacts, "artifact"), "recent");
			const result = await runSessionGc({ agentDir: root, retentionDays: 30 });
			expect(result.prunedSessions).toBe(1);
			await expect(fs.stat(old.transcript)).rejects.toThrow();
			await expect(fs.stat(old.artifacts)).rejects.toThrow();
			await fs.access(freshTranscript.transcript);
			await fs.access(freshTranscript.artifacts);
			await fs.access(freshArtifact.transcript);
			await fs.access(freshArtifact.artifacts);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("prunes an old transcript without artifacts and leaves unrelated directories untouched", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-gc-"));
		try {
			const project = path.join(getSessionsDir(root), "project");
			const transcript = path.join(project, "2026-01-01_lonely.jsonl");
			const unrelated = path.join(project, "unrelated");
			await Bun.write(transcript, "{}\n");
			await Bun.write(path.join(unrelated, "file"), "data");
			await touchOld(transcript);
			await touchOld(path.join(unrelated, "file"));
			expect((await runSessionGc({ agentDir: root, retentionDays: 30 })).prunedSessions).toBe(1);
			await expect(fs.stat(transcript)).rejects.toThrow();
			await fs.access(path.join(unrelated, "file"));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("preserves explicitly kept, registry-live, and lease-owned sessions", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-gc-"));
		const registry = AgentRegistry.global();
		const registryId = `gc-registry-${Date.now()}`;
		const leaseId = `gc-lease-${Date.now()}`;
		const lease = tryAcquireSessionLease(leaseId);
		try {
			expect(lease).not.toBeNull();
			const current = await makeSession(root, "current");
			const live = await makeSession(root, registryId);
			const owned = await makeSession(root, leaseId);
			registry.register({
				id: registryId,
				displayName: registryId,
				kind: "main",
				session: null,
				sessionFile: live.transcript,
				status: "running",
			});
			const result = await runSessionGc({ agentDir: root, retentionDays: 30, keepSessionIds: new Set(["current"]) });
			expect(result.prunedSessions).toBe(0);
			for (const session of [current, live, owned]) {
				await fs.access(session.transcript);
				await fs.access(session.artifacts);
			}
		} finally {
			registry.unregister(registryId);
			lease?.release();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("removes only markers whose target is missing, regardless of marker age", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-gc-"));
		try {
			const markers = getCustomSessionFilesDir(root);
			const target = path.join(root, "external.jsonl");
			const live = path.join(markers, "live");
			const missing = path.join(markers, "missing");
			const malformed = path.join(markers, "empty");
			await Bun.write(target, "transcript");
			await Bun.write(live, target);
			await Bun.write(missing, path.join(root, "missing.jsonl"));
			await Bun.write(malformed, " ");
			await touchOld(live);
			const result = await runSessionGc({ agentDir: root, retentionDays: 30 });
			expect(result.prunedCustomFiles).toBe(1);
			await fs.access(live);
			await fs.access(malformed);
			await expect(fs.stat(missing)).rejects.toThrow();
			await fs.access(target);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
		"uses XDG data and state roots for default session cleanup",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-gc-xdg-"));
			try {
				const data = path.join(root, "data");
				const state = path.join(root, "state");
				const transcript = path.join(data, "omp", "sessions", "project", "2026-01-01_old.jsonl");
				const marker = path.join(state, "omp", "custom-session-files", "missing");
				await fs.mkdir(path.join(state, "omp"), { recursive: true });
				await Bun.write(transcript, "{}\n");
				await touchOld(transcript);
				await Bun.write(marker, path.join(root, "gone.jsonl"));
				const modulePath = path.resolve(import.meta.dir, "../src/session/session-gc.ts");
				const child = Bun.spawn(
					[
						process.execPath,
						"-e",
						`import { runSessionGc } from ${JSON.stringify(modulePath)}; await runSessionGc({ retentionDays: 30 });`,
					],
					{
						env: {
							...process.env,
							HOME: root,
							PI_CODING_AGENT_DIR: "",
							OMP_PROFILE: "",
							XDG_DATA_HOME: data,
							XDG_STATE_HOME: state,
						},
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				expect(await child.exited).toBe(0);
				await expect(fs.stat(transcript)).rejects.toThrow();
				await expect(fs.stat(marker)).rejects.toThrow();
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);

	it("does nothing when retention is disabled", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-gc-"));
		try {
			const old = await makeSession(root, "old");
			expect(await runSessionGc({ agentDir: root, retentionDays: 0 })).toEqual({
				prunedSessions: 0,
				prunedCustomFiles: 0,
			});
			await fs.access(old.transcript);
			await fs.access(old.artifacts);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
