import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { TempDir } from "@oh-my-pi/pi-utils";

function transcript(): string {
	return [
		JSON.stringify({ type: "session", id: "s0", parentId: null, timestamp: "2026-08-07T10:34:37.300Z" }),
		JSON.stringify({
			type: "session_init",
			id: "si",
			parentId: "s0",
			timestamp: "2026-08-07T10:34:38.000Z",
			agent: "task",
			task: "change the nested repo",
		}),
	].join("\n");
}

describe("persisted agent isolation artifacts", () => {
	it("restores nested-repo patch files beside a transcript in capture order", async () => {
		using tempDir = TempDir.createSync("@omp-artifacts-nested-");
		const dir = tempDir.path();
		const agentDir = path.join(dir, "main");
		await Bun.write(path.join(dir, "main.jsonl"), "");
		await Bun.write(path.join(agentDir, "Worker.jsonl"), `${transcript()}\n`);
		await Bun.write(path.join(agentDir, "Worker.patch"), "");
		// Written out of lexical order on purpose: index 10 sorts before 2 as text.
		await Bun.write(path.join(agentDir, "Worker.nested-10-vendor_tools.patch"), "diff --git a/z b/z\n");
		await Bun.write(path.join(agentDir, "Worker.nested-2-lib.patch"), "diff --git a/y b/y\n");
		await Bun.write(path.join(agentDir, "Worker.nested-0-engine.patch"), "diff --git a/x b/x\n");
		// A sibling agent's nested patch must not be attributed to Worker.
		await Bun.write(path.join(agentDir, "Other.nested-0-engine.patch"), "diff --git a/o b/o\n");

		const registry = new AgentRegistry();
		await registerPersistedSubagents(registry, path.join(dir, "main.jsonl"));

		const history = registry.get("Worker")?.history;
		expect(history?.patchPath).toBe(path.join(agentDir, "Worker.patch"));
		expect(history?.nestedPatchPaths).toEqual([
			path.join(agentDir, "Worker.nested-0-engine.patch"),
			path.join(agentDir, "Worker.nested-2-lib.patch"),
			path.join(agentDir, "Worker.nested-10-vendor_tools.patch"),
		]);
	});
});
