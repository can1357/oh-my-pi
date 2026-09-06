/**
 * Two independent task subagents must not land in one eval kernel: sibling
 * agents that both name `results` would otherwise overwrite each other's
 * analysis state with no diagnostic. Sharing stays reachable, but only when
 * the spawn (or the `task.shareEvalSession` setting) asks for it.
 *
 * Every case below runs real JS or Python cells under the identities the
 * spawn path hands out, so what is asserted is variable visibility rather
 * than the shape of an identity string.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import { namespaceSessionId as namespacePythonSessionId } from "@oh-my-pi/pi-coding-agent/eval/py/index";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	runStructuredSubagent,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const PARENT_EVAL_SESSION = "session:/parent-session.jsonl:cwd:/tmp";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["read", "eval"],
};

function session(shareSetting?: boolean): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"task.maxRecursionDepth": 2,
			"task.isolation.enabled": false,
			"isolation.backend": "rcopy",
			"task.enableLsp": true,
			...(shareSetting === undefined ? {} : { "task.shareEvalSession": shareSetting }),
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getEvalSessionId: () => PARENT_EVAL_SESSION,
	} as unknown as ToolSession;
}

function settledResult(): SingleResult {
	return {
		index: 0,
		id: "Worker",
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

/**
 * Dispatch `count` spawns and report the eval kernel identity each child was
 * launched under, so cells can be run in the children's own kernels.
 */
async function spawnKernelIdentities(
	toolSession: ToolSession,
	count: number,
	overrides: Partial<StructuredSubagentRequest> = {},
): Promise<string[]> {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
	const received: Array<string | undefined> = [];
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		received.push(options.parentEvalSessionId);
		return settledResult();
	});
	for (let index = 0; index < count; index++) {
		await runStructuredSubagent({
			session: toolSession,
			invocationKind: "task",
			assignment: `Inspect target ${index}.`,
			agent: "worker",
			index,
			...overrides,
		});
	}
	return received.map(identity => {
		if (identity === undefined) throw new Error("subagent was launched without an eval kernel identity");
		return identity;
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	resetRegisteredArtifactDirsForTests();
	await disposeAllVmContexts();
	await disposeAllKernelSessions();
});

describe("subagent eval kernel identity", () => {
	it("keeps sibling JS variables private", async () => {
		using tempDir = TempDir.createSync("@omp-subagent-kernel-");
		const [first, second] = await spawnKernelIdentities(session(), 2);
		const child = session();
		const run = (code: string, sessionId: string, kernelOwnerId: string) =>
			executeJs(code, { cwd: tempDir.path(), sessionId, session: child, kernelOwnerId });

		await run("var findings = 'agent-a';", first, "agent-a");
		const sibling = await run("return typeof findings;", second, "agent-b");
		expect(sibling.output.trim()).toBe("undefined");
		const own = await run("return findings;", first, "agent-a");
		expect(own.output.trim()).toBe("agent-a");
	});

	it("keeps sibling Python kernel state private", async () => {
		// The identity also has to survive the trip to the Python worker in
		// PI_TOOL_BRIDGE_SESSION, which cannot carry a null byte.
		using tempDir = TempDir.createSync("@omp-subagent-kernel-py-");
		const [first, second] = await spawnKernelIdentities(session(), 2);
		const run = (code: string, sessionId: string, kernelOwnerId: string) =>
			executePython(code, {
				cwd: tempDir.path(),
				sessionId: namespacePythonSessionId(sessionId),
				kernelOwnerId,
				kernelMode: "session",
			});

		const seeded = await run("findings = 'agent-a'", first, "agent-a");
		expect(seeded.exitCode).toBe(0);
		const sibling = await run("print('findings' in dir())", second, "agent-b");
		expect(sibling.output.trim()).toBe("False");
		const own = await run("print(findings)", first, "agent-a");
		expect(own.output.trim()).toBe("agent-a");
	});

	it("keeps eval-spawned siblings private from each other and from the parent", async () => {
		using tempDir = TempDir.createSync("@omp-subagent-kernel-eval-");
		const parent = session();
		const [first, second] = await spawnKernelIdentities(parent, 2, { invocationKind: "eval" });
		const run = (code: string, sessionId: string, kernelOwnerId: string) =>
			executeJs(code, { cwd: tempDir.path(), sessionId, session: parent, kernelOwnerId });

		await run("var findings = 'parent';", PARENT_EVAL_SESSION, "parent");
		await run("var findings = 'agent-a';", first, "agent-a");
		expect((await run("return typeof findings;", second, "agent-b")).output.trim()).toBe("undefined");
		expect((await run("return findings;", PARENT_EVAL_SESSION, "parent")).output.trim()).toBe("parent");
	});

	it("runs a child in the parent kernel when the spawn asks to share", async () => {
		using tempDir = TempDir.createSync("@omp-subagent-kernel-shared-");
		const parent = session();
		const [shared] = await spawnKernelIdentities(parent, 1, { shareEvalSession: true });
		const run = (code: string, sessionId: string, kernelOwnerId: string) =>
			executeJs(code, { cwd: tempDir.path(), sessionId, session: parent, kernelOwnerId });

		await run("var findings = 'parent';", PARENT_EVAL_SESSION, "parent");
		expect((await run("return findings;", shared, "agent-a")).output.trim()).toBe("parent");
		await run("var continued = 'agent-a';", shared, "agent-a");
		expect((await run("return continued;", PARENT_EVAL_SESSION, "parent")).output.trim()).toBe("agent-a");
	});

	it("runs a child in the parent kernel when task.shareEvalSession is enabled", async () => {
		using tempDir = TempDir.createSync("@omp-subagent-kernel-shared-setting-");
		const parent = session(true);
		const [shared] = await spawnKernelIdentities(parent, 1);
		const run = (code: string, sessionId: string, kernelOwnerId: string) =>
			executeJs(code, { cwd: tempDir.path(), sessionId, session: parent, kernelOwnerId });

		await run("var findings = 'parent';", PARENT_EVAL_SESSION, "parent");
		expect((await run("return findings;", shared, "agent-a")).output.trim()).toBe("parent");
	});

	it("isolates a child whose spawn declines an enabled task.shareEvalSession", async () => {
		using tempDir = TempDir.createSync("@omp-subagent-kernel-override-");
		const parent = session(true);
		const [isolated] = await spawnKernelIdentities(parent, 1, { shareEvalSession: false });
		const run = (code: string, sessionId: string, kernelOwnerId: string) =>
			executeJs(code, { cwd: tempDir.path(), sessionId, session: parent, kernelOwnerId });

		await run("var findings = 'parent';", PARENT_EVAL_SESSION, "parent");
		expect((await run("return typeof findings;", isolated, "agent-a")).output.trim()).toBe("undefined");
		await run("var ownWork = 'agent-a';", isolated, "agent-a");
		expect((await run("return typeof ownWork;", PARENT_EVAL_SESSION, "parent")).output.trim()).toBe("undefined");
	});
});
