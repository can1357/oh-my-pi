import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TempDir } from "@oh-my-pi/pi-utils";

function sessionHeader(id: string): string {
	return JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-08-13T17:14:48.125Z",
		cwd: "/tmp",
	});
}

async function registerFrom(dir: string): Promise<AgentRegistry> {
	const registry = new AgentRegistry();
	await registerPersistedSubagents(registry, path.join(dir, "main.jsonl"));
	return registry;
}

describe("registerPersistedSubagents mid-spawn stubs", () => {
	it("does not park a child that only has the SessionManager header", async () => {
		using tempDir = TempDir.createSync("@omp-mid-spawn-stub-");
		const dir = tempDir.path();
		await Bun.write(path.join(dir, "main.jsonl"), `${sessionHeader("main")}\n`);
		await Bun.write(
			path.join(dir, "main", "Adversary.jsonl"),
			`${JSON.stringify({ type: "title", v: 1, title: "", updatedAt: "2026-08-13T17:14:48.125Z", pad: " " })}\n${sessionHeader("adversary")}\n`,
		);

		const registry = await registerFrom(dir);
		expect(registry.get("Adversary")).toBeUndefined();
	});

	it("still parks a finished child that recorded session_init", async () => {
		using tempDir = TempDir.createSync("@omp-mid-spawn-init-");
		const dir = tempDir.path();
		await Bun.write(path.join(dir, "main.jsonl"), `${sessionHeader("main")}\n`);
		await Bun.write(
			path.join(dir, "main", "Worker.jsonl"),
			`${[
				sessionHeader("worker"),
				JSON.stringify({
					type: "session_init",
					id: "si",
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					systemPrompt: "review",
					task: "review the diff",
					tools: ["read"],
					agent: "adversarial-reviewer",
				}),
			].join("\n")}\n`,
		);

		const registry = await registerFrom(dir);
		expect(registry.get("Worker")?.status).toBe("parked");
		expect(registry.get("Worker")?.sessionFile).toBe(path.join(dir, "main", "Worker.jsonl"));
	});

	it("still parks a legacy child that has messages but no session_init", async () => {
		using tempDir = TempDir.createSync("@omp-mid-spawn-legacy-");
		const dir = tempDir.path();
		await Bun.write(path.join(dir, "main.jsonl"), `${sessionHeader("main")}\n`);
		await Bun.write(
			path.join(dir, "main", "Legacy.jsonl"),
			`${[
				sessionHeader("legacy"),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);

		const registry = await registerFrom(dir);
		expect(registry.get("Legacy")?.status).toBe("parked");
	});

	it("does not replace a live generation claimed while metadata is being read", async () => {
		using tempDir = TempDir.createSync("@omp-mid-spawn-claim-");
		const dir = tempDir.path();
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(path.join(dir, "main.jsonl"), `${sessionHeader("main")}\n`);
		await Bun.write(
			childFile,
			`${[
				sessionHeader("worker"),
				JSON.stringify({
					type: "session_init",
					id: "si",
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					systemPrompt: "review",
					task: "review the diff",
					tools: ["read"],
				}),
			].join("\n")}\n`,
		);

		const registry = new AgentRegistry();
		const liveSession = {} as AgentSession;
		const originalGet = registry.get.bind(registry);
		let injectClaim = true;
		registry.get = id => {
			const current = originalGet(id);
			if (id === "Worker" && injectClaim && !current) {
				injectClaim = false;
				queueMicrotask(() => {
					registry.register({
						id,
						displayName: id,
						kind: "sub",
						parentId: "main",
						session: liveSession,
						sessionFile: childFile,
						status: "running",
					});
				});
			}
			return current;
		};

		await registerPersistedSubagents(registry, path.join(dir, "main.jsonl"));

		expect(originalGet("Worker")?.status).toBe("running");
		expect(originalGet("Worker")?.session).toBe(liveSession);
	});

	it("retries under the disambiguated key instead of grafting descendants onto a foreign winner of the bare id", async () => {
		using tempDir = TempDir.createSync("@omp-mid-spawn-foreign-bare-win-");
		const dir = tempDir.path();
		const sessionBFile = path.join(dir, "sessionB.jsonl");
		const workerFileB = path.join(dir, "sessionB", "Worker.jsonl");
		const grandchildFileB = path.join(dir, "sessionB", "Worker", "Grandchild.jsonl");
		const workerFileA = path.join(dir, "sessionA", "Worker.jsonl");
		await Bun.write(sessionBFile, `${sessionHeader("sessionB")}\n`);
		await Bun.write(
			workerFileB,
			`${[
				sessionHeader("workerB"),
				JSON.stringify({
					type: "session_init",
					id: "siB",
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					systemPrompt: "review",
					task: "session B's own Worker",
					tools: ["read"],
				}),
			].join("\n")}\n`,
		);
		await Bun.write(
			grandchildFileB,
			`${[
				sessionHeader("grandchildB"),
				JSON.stringify({
					type: "session_init",
					id: "siGB",
					parentId: null,
					timestamp: "2026-08-13T17:14:50.000Z",
					systemPrompt: "review",
					task: "session B's own Worker's child",
					tools: ["read"],
				}),
			].join("\n")}\n`,
		);

		const registry = new AgentRegistry();
		const originalGet = registry.get.bind(registry);
		let injected = false;
		registry.get = id => {
			const current = originalGet(id);
			// Simulate an unrelated session (A) winning the race for the bare
			// "Worker" id between this scan's own upfront read and its metadata
			// read — the same mid-scan-claim technique as above, but the
			// winner is a FOREIGN owner rather than a live spawn of this scan.
			if (id === "Worker" && !injected && !current) {
				injected = true;
				queueMicrotask(() => {
					registry.register({
						id: "Worker",
						displayName: "Worker",
						kind: "sub",
						parentId: "AcpSessionA",
						session: null,
						sessionFile: workerFileA,
						status: "parked",
					});
				});
			}
			return current;
		};

		await registerPersistedSubagents(registry, sessionBFile, { rootParentId: "AcpSessionB" });

		// Session A's win is untouched — the fix never clobbers a foreign winner.
		expect(originalGet("Worker")?.sessionFile).toBe(workerFileA);

		// Session B's OWN "Worker" retried under its disambiguated key instead
		// of being silently dropped after losing the race for the bare id.
		expect(originalGet("AcpSessionB/Worker")?.sessionFile).toBe(workerFileB);

		// Before the fix: the recursive descendant scan always used the bare
		// "Worker" id regardless of whether this scan's own claim to it
		// succeeded, so this nested child would have been parented onto
		// session A's unrelated family instead of session B's own.
		expect(originalGet("Grandchild")?.parentId).toBe("AcpSessionB/Worker");
	});
});
