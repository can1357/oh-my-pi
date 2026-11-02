import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

interface RetentionProbeResult {
	baselineBytes: number;
	liveBytes: number;
	releasedBytes: number;
	retainedEntries: number;
}

describe("SessionManager artifact terminal release", () => {
	let tempDir: TempDir;
	const managers: SessionManager[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-artifact-release-");
	});

	afterEach(async () => {
		for (const manager of managers.splice(0)) await manager.close();
		tempDir.removeSync();
	});

	function inMemory(): SessionManager {
		const manager = SessionManager.inMemory(tempDir.path());
		managers.push(manager);
		return manager;
	}

	it("makes spill payloads collectible while the released manager remains reachable", async () => {
		const probe = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "../fixtures/sdk-artifact-retention-probe.ts")],
			{
				cwd: path.join(import.meta.dir, "../../../.."),
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: tempDir.path(),
					BUN_JSC_useConcurrentJIT: "0",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(probe.stdout).text(),
			new Response(probe.stderr).text(),
			probe.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const result = JSON.parse(stdout) as RetentionProbeResult;
		expect(result.liveBytes - result.baselineBytes).toBeGreaterThan(8 * 1024 * 1024);
		expect(result.releasedBytes - result.baselineBytes).toBeLessThan(2 * 1024 * 1024);
		expect(result.retainedEntries).toBe(0);
	});

	it("drops new spill writes after terminal release", async () => {
		const manager = inMemory();
		const payload = `live-${crypto.randomUUID()}`;
		expect(await manager.saveArtifact(payload, "read")).toBe("0");
		await manager.close();
		manager.releaseRetainedEntries();
		manager.releaseRetainedEntries();
		expect(await manager.saveArtifact(`late-${crypto.randomUUID()}`, "read")).toBeUndefined();
	});

	it("keeps accepting spill writes across nonterminal close and branch changes", async () => {
		const manager = inMemory();
		const firstEntry = manager.appendMessage({ role: "user", content: "first branch", timestamp: Date.now() });
		expect(await manager.saveArtifact("first spill", "read")).toBe("0");
		await manager.close();
		manager.appendMessage({ role: "user", content: "second branch", timestamp: Date.now() });
		manager.branch(firstEntry);
		expect(await manager.saveArtifact("second spill", "read")).toBe("1");
	});

	it("preserves adopted artifacts and their owner when a child is released", async () => {
		const shared = new ArtifactManager(path.join(tempDir.path(), "shared"));
		const child = inMemory();
		const sibling = inMemory();
		child.adoptArtifactManager(shared);
		sibling.adoptArtifactManager(shared);
		const firstId = await child.saveArtifact("completed child output", "task");
		if (!firstId) throw new Error("Expected a child artifact id");
		await child.close();
		child.releaseRetainedEntries();
		expect(await child.saveArtifact(`late-${crypto.randomUUID()}`, "task")).toBeUndefined();
		expect(await child.allocateArtifactPath("task")).toEqual({});
		const secondId = await sibling.saveArtifact("sibling output", "task");
		if (!secondId) throw new Error("Expected a sibling artifact id");
		expect(secondId).not.toBe(firstId);
		const firstPath = await child.getArtifactPath(firstId);
		const secondPath = await sibling.getArtifactPath(secondId);
		if (!firstPath || !secondPath) throw new Error("Expected retained artifact paths");
		expect(await Bun.file(firstPath).text()).toBe("completed child output");
		expect(await Bun.file(secondPath).text()).toBe("sibling output");
		expect(await shared.listFiles()).toHaveLength(2);
	});

	it("finishes a disk spill admitted before release and keeps persisted output readable", async () => {
		const ready = Promise.withResolvers<void>();
		const shared = new ArtifactManager(path.join(tempDir.path(), "pending"), ready.promise);
		const manager = inMemory();
		manager.adoptArtifactManager(shared);
		const content = `complete-${crypto.randomUUID()}-${"x".repeat(32 * 1024)}`;
		const saving = manager.saveArtifact(content, "task");
		await manager.close();
		manager.releaseRetainedEntries();
		ready.resolve();
		const id = await saving;
		if (!id) throw new Error("Expected the admitted spill to finish");
		const artifactPath = await manager.getArtifactPath(id);
		if (!artifactPath) throw new Error("Expected the completed artifact to remain readable");
		expect(await Bun.file(artifactPath).text()).toBe(content);
	});

	it("keeps owned disk artifacts readable after release without creating new spills", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		managers.push(manager);
		const id = await manager.saveArtifact("persisted output", "bash");
		if (!id) throw new Error("Expected a persisted artifact id");
		await manager.close();
		manager.releaseRetainedEntries();
		const artifactPath = await manager.getArtifactPath(id);
		if (!artifactPath) throw new Error("Expected the persisted artifact path");
		expect(await Bun.file(artifactPath).text()).toBe("persisted output");
		expect(await manager.saveArtifact(`late-${crypto.randomUUID()}`, "bash")).toBeUndefined();
		expect(await manager.allocateArtifactPath("bash")).toEqual({});
	});
});
