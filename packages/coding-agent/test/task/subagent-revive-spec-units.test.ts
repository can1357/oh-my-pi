/**
 * Units of the revive from the stored session that no older tree has: the level a revive starts at, the spec's
 * version check, the custom tools a spec can hold, the ones a live kernel serves again, and what a parent homed in
 * a worker serves a revive on main.
 */
import { afterEach, expect, it, vi } from "bun:test";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as jsContext from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import * as pythonExecutor from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { EvalToolDescriptor } from "@oh-my-pi/pi-coding-agent/eval/types";
import type { HindsightSessionStateApi } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { MnemopiSessionStateApi } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createEvalCustomTools, definedEvalCustomTools } from "@oh-my-pi/pi-coding-agent/task/eval-tools";
import { revivedThinkingLevel } from "@oh-my-pi/pi-coding-agent/task/executor";
import { serveSubagentParentInputs } from "@oh-my-pi/pi-coding-agent/task/revive-parent-inputs";
import { readSpawnSpec } from "@oh-my-pi/pi-coding-agent/task/spawn-spec";
import {
	type RpcApi,
	type RpcEndpoint,
	type RpcFrame,
	RpcLink,
	type RpcMethod,
} from "@oh-my-pi/pi-coding-agent/thread/rpc";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { logger } from "@oh-my-pi/pi-utils";
import { openReviveEnv, type ReviveEnv, sessionInitRecords } from "./revive-harness";

let env: ReviveEnv | undefined;
let channel: MessageChannel | undefined;

afterEach(async () => {
	await env?.close();
	env = undefined;
	channel?.port1.close();
	channel = undefined;
	vi.restoreAllMocks();
});

it("takes the newest level no hop wrote after the spawn's session_init, and none from a branch without one", () => {
	const manager = SessionManager.inMemory("/revive-level");
	manager.appendThinkingLevelChange(Effort.High);
	// A branch without the spawn's session_init (a fork that left it off): the SDK restores the transcript's level.
	expect(revivedThinkingLevel(manager, Effort.Low)).toBeUndefined();
	manager.appendSessionInit({ systemPrompt: ["spawn prompt"], task: "spawn task", tools: [] });
	expect(revivedThinkingLevel(manager, Effort.Low)).toBe(Effort.Low);
	manager.appendThinkingLevelChange(Effort.High);
	expect(revivedThinkingLevel(manager, Effort.Low)).toBe(Effort.High);
	manager.appendModelChange("mock/fallback", "fallback");
	manager.appendThinkingLevelChange(Effort.Medium);
	expect(revivedThinkingLevel(manager, Effort.Low)).toBe(Effort.High);
});

it("reads a stored spec whose version is not 1 as none, though each of its parts is well formed", async () => {
	const opened = await openReviveEnv();
	env = opened;
	const spawned = await opened.spawn(opened.taskSpawn(opened.createLiveParent(), "SpecVersion"));
	const [record] = await sessionInitRecords(spawned.sessionFile);
	const spec = record?.spawnSpec as Record<string, unknown>;
	const parts = readSpawnSpec({ spawnSpec: spec });
	const { model, thinking, settings, tools, policy, identity, prompt, wake } = parts;
	expect(parts.stored).toBe(true);
	expect([model, thinking, settings, tools, policy, identity, prompt, wake].map(part => part !== undefined)).toEqual(
		Array(8).fill(true),
	);
	expect(readSpawnSpec({ spawnSpec: { ...spec, v: 2 } })).toEqual({ stored: false });
});

it("leaves out of the stored spec, with a warning, a custom tool whose name no strict validator accepts", async () => {
	const opened = await openReviveEnv();
	env = opened;
	const enabled = { settings: Settings.isolated({ "eval.tools.enabled": true }) } as unknown as ToolSession;
	const parameters = { type: "object", properties: {} };
	const longName = "x".repeat(65);
	const customTools = createEvalCustomTools(enabled, [
		{ name: "lookup_rows", description: "Looks up rows.", parameters, language: "js" },
		{ name: longName, description: "A name over 64 characters.", parameters, language: "js" },
	]);
	const warn = vi.spyOn(logger, "warn");
	const spawned = await opened.spawn(opened.taskSpawn(opened.createLiveParent(), "LongToolName", { customTools }));
	const [record] = await sessionInitRecords(spawned.sessionFile);

	// The other tools stay readable, so a revive keeps them.
	expect(readSpawnSpec({ spawnSpec: record?.spawnSpec }).tools?.customTools.map(tool => tool.name)).toEqual([
		"lookup_rows",
	]);
	expect(warn).toHaveBeenCalledWith("Subagent custom tools left out of the stored spawn spec", {
		subagent: "LongToolName",
		tools: [longName],
	});
});

it("serves a stored eval tool again though another name is defined in both the Python and the JS kernel", async () => {
	const parameters = { type: "object", properties: {} };
	const tool = (name: string, language: EvalToolDescriptor["language"]): EvalToolDescriptor => ({
		name,
		description: `${language} ${name}`,
		parameters,
		language,
	});
	// Both kernels define `shared`; only the Python one defines `lookup_rows`, the tool the spawn was given.
	const kernels = { python: [tool("shared", "python"), tool("lookup_rows", "python")], js: [tool("shared", "js")] };
	const served = (defined: EvalToolDescriptor[], names: string[]) => {
		const tools = names.length === 0 ? defined : defined.filter(descriptor => names.includes(descriptor.name));
		return { tools, missing: names.filter(name => !tools.some(descriptor => descriptor.name === name)) };
	};
	vi.spyOn(pythonExecutor, "describePythonTools").mockImplementation(async names => served(kernels.python, names));
	vi.spyOn(jsContext, "invokeJsTool").mockImplementation(async request => ({
		ok: true as const,
		...served(kernels.js, request.op === "describe" ? request.names : []),
	}));
	const session = {
		cwd: "/revive-eval-tools",
		settings: Settings.isolated({ "eval.tools.enabled": true }),
		getEvalSessionId: () => "revive-eval-tools",
	} as unknown as ToolSession;

	const tools = await definedEvalCustomTools(session, [tool("lookup_rows", "python")]);

	expect(tools.map(served => served.name)).toEqual(["lookup_rows"]);
});

function portEndpoint(port: MessagePort): RpcEndpoint {
	return {
		send: frame => port.postMessage(frame),
		listen: handler => {
			const listener = (frame: RpcFrame): void => handler(frame);
			port.on("message", listener);
			return () => port.off("message", listener);
		},
	};
}

/** A memory state of the main thread, as a worker imports it. */
class MainMemoryState {
	readonly bankId = "main-bank";
}

it("serves a worker parent's memory states as the main states its own aliases wrap", async () => {
	const pair = new MessageChannel();
	channel = pair;
	type MainApi = { states: RpcMethod<[], MainMemoryState[]> };
	const main = new RpcLink<MainApi, RpcApi>(portEndpoint(pair.port1), { name: "main" });
	const worker = new RpcLink<RpcApi, MainApi>(portEndpoint(pair.port2), { name: "worker" });
	main.exportClass<MainMemoryState, RpcApi>(
		"fixture-memory-state",
		(value): value is MainMemoryState => value instanceof MainMemoryState,
		{},
	);
	worker.importClass<object, RpcApi>("fixture-memory-state", remote => ({ remote }));
	main.handle("states", () => [new MainMemoryState(), new MainMemoryState()]);
	// The states reach the worker as proxies of main's, which a parent's own aliases wrap.
	const [hindsight, mnemopi] = (await worker.call("states")) as unknown as [
		HindsightSessionStateApi,
		MnemopiSessionStateApi,
	];
	// A subagent homed in the worker holds aliases of its own parent's states on main; they are not main's objects.
	const tools = {
		cwd: "/revive-worker-parent",
		settings: Settings.isolated(),
		getHindsightSessionState: () => ({ bankId: "main-bank", aliasOf: hindsight }),
		getMnemopiSessionState: () => ({ sessionId: "worker-parent", aliasOf: mnemopi }),
	} as unknown as ToolSession;

	const served = await serveSubagentParentInputs({ evalToolSession: tools } as unknown as AgentSession, "Child", []);

	expect(served?.live.parentHindsightSessionState).toBe(hindsight);
	expect(served?.live.parentMnemopiSessionState).toBe(mnemopi);
});
