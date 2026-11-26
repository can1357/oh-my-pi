/**
 * What a revive from the stored session takes from the record, what it holds to the live process, and what it
 * does where the record is old, damaged or names a model the registry no longer serves.
 */
import { afterEach, expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { formatModelStringWithRouting } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgEvalToolsEnabled } from "@oh-my-pi/pi-coding-agent/eval/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createEvalCustomTools } from "@oh-my-pi/pi-coding-agent/task/eval-tools";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { logger } from "@oh-my-pi/pi-utils";
import { localSession } from "../helpers/local-session";
import {
	editSessionRecords,
	editStoredSpawnSpecs,
	fixtureAgent,
	openReviveEnv,
	type ReviveEnv,
	SPAWN_MODEL,
	sessionInitRecords,
} from "./revive-harness";

let env: ReviveEnv | undefined;

afterEach(async () => {
	await env?.close();
	env = undefined;
});

/** Opens a process with `settings`, spawns `id` with `extra` over the task spawn, and parks it. */
async function spawnAndPark(id: string, settings: Readonly<Record<string, unknown>>, extra = {}) {
	const opened = await openReviveEnv(settings);
	env = opened;
	const root = opened.createLiveParent();
	opened.installColdReviver(root);
	const spawned = await opened.spawn(opened.taskSpawn(root, id, extra));
	await opened.park(id);
	return { env: opened, spawned };
}

it("revives a record with no spawn spec on its record's model and tools, with the live wake limit", async () => {
	const { env, spawned } = await spawnAndPark("OlderRecord", { "task.maxRuntimeMs": 60_000 });
	const [record] = await sessionInitRecords(spawned.sessionFile);
	// A record an older omp wrote holds no spawn spec.
	expect(
		await editSessionRecords(
			spawned.sessionFile,
			record => record.type === "session_init" && delete record.spawnSpec,
		),
	).toBeGreaterThan(0);
	env.dropWarmReviver(spawned.id);

	const cold = await env.revive(spawned.id);

	expect(cold.session.model ? formatModelStringWithRouting(cold.session.model) : undefined).toBe(SPAWN_MODEL);
	expect(cold.build.options.toolNames).toEqual(record?.tools as string[]);
	expect(cold.build.options.cacheWarming).toBe("streaming");
	// The wake turn is held to the live `task.maxRuntimeMs`, as a spawn's is.
	expect(cold.wake?.maxRuntimeMs).toBe(60_000);
});

it("holds a spec whose wake part is malformed to the live wake limit", async () => {
	const { env, spawned } = await spawnAndPark(
		"MalformedWake",
		{ "task.maxRuntimeMs": 60_000 },
		{ maxRuntimeMs: 30_000 },
	);
	await editStoredSpawnSpecs(spawned.sessionFile, spec => {
		(spec.wake as Record<string, unknown>).maxRuntimeMs = "0";
	});
	env.dropWarmReviver(spawned.id);

	const cold = await env.revive(spawned.id);

	expect(cold.wake?.maxRuntimeMs).toBe(60_000);
});

it("keeps the MCP tools of a spec whose policy part is malformed", async () => {
	const opened = await openReviveEnv();
	env = opened;
	opened.mcp.setFixtureTools(["lookup"]);
	const root = opened.createLiveParent();
	opened.installColdReviver(root);
	const spawned = await opened.spawn(opened.taskSpawn(root, "MalformedPolicy"));
	await opened.park(spawned.id);
	await editStoredSpawnSpecs(spawned.sessionFile, spec => {
		spec.policy = "damaged";
	});
	opened.dropWarmReviver(spawned.id);

	const cold = await opened.revive(spawned.id);

	expect(cold.build.options.enableMCP).not.toBe(false);
	expect(cold.build.options.mcpManager).toBe(opened.mcp);
	expect(cold.session.getToolByName("mcp__fixture__lookup")).toBeDefined();
});

it("revives a subagent whose stored model is gone on the parent's model, unless its spawn held the model", async () => {
	const opened = await openReviveEnv();
	env = opened;
	opened.addModel("mock-named");
	const root = opened.createLiveParent();
	opened.installColdReviver(root);
	const held = await opened.spawn(opened.taskSpawn(root, "HeldNamed", { modelOverride: "mock/mock-named" }));
	const free = await opened.spawn(opened.taskSpawn(root, "FreeNamed", { modelOverride: "mock/mock-named" }));
	for (const spawned of [held, free]) await opened.park(spawned.id);
	// The hook a held named-model setting writes at the spawn.
	await editStoredSpawnSpecs(held.sessionFile, spec => {
		spec.parentFallbackHeld = true;
	});
	opened.removeModel("mock/mock-named");
	for (const spawned of [held, free]) opened.dropWarmReviver(spawned.id);
	const warn = vi.spyOn(logger, "warn");

	const builds = opened.builds.length;
	await expect(opened.revive(held.id)).rejects.toThrow("its spawn holds it to that model");
	expect(opened.builds.slice(builds).filter(build => build.options.agentId === held.id)).toEqual([]);

	const revived = await opened.revive(free.id);
	expect(revived.session.model ? formatModelStringWithRouting(revived.session.model) : undefined).toBe(SPAWN_MODEL);
	expect(warn).toHaveBeenCalledWith(expect.stringContaining('Model "mock/mock-named" not found'), {
		subagent: free.id,
		model: SPAWN_MODEL,
	});
});

it("revives on the parent's model at its lowest effort, with a visible notice, where that model is over the ceiling", async () => {
	const opened = await openReviveEnv({ "task.maxEffort": "low" });
	env = opened;
	opened.addModel("mock-thinking", { thinking: true });
	// The parent's model has no effort at or below the spawn's ceiling.
	const parentModel = opened.addModel("mock-high", { thinking: true, efforts: [Effort.Medium, Effort.High] });
	const root = opened.createLiveParent({}, parentModel);
	opened.installColdReviver(root);
	// An effort hint stores the live `task.maxEffort` as the spawn's ceiling.
	const spawned = await opened.spawn(
		opened.taskSpawn(root, "CeilingMiss", { modelOverride: "mock/mock-thinking", effort: "lo" }),
	);
	await opened.park(spawned.id);
	opened.removeModel("mock/mock-thinking");
	opened.dropWarmReviver(spawned.id);

	const cold = await opened.revive(spawned.id);

	expect(cold.session.model ? formatModelStringWithRouting(cold.session.model) : undefined).toBe("mock/mock-high");
	expect(cold.session.thinkingLevel).toBe(Effort.Medium);
	const notices = cold.session.sessionManager
		.getEntries()
		.filter(entry => entry.type === "custom_message" && entry.customType === "effort-ceiling-not-honoured");
	expect(notices).toHaveLength(1);
	const [notice] = notices;
	if (notice?.type !== "custom_message") throw new Error("Expected the ceiling notice");
	expect(notice.display).toBe(true);
	for (const named of ['"mock/mock-thinking"', "mock/mock-high", "task.maxEffort=low", "lowest effort, medium"]) {
		expect(String(notice.content)).toContain(named);
	}
});

it("keeps an effort set on the live subagent through both revives", async () => {
	const opened = await openReviveEnv();
	env = opened;
	opened.addModel("mock-thinking", { thinking: true });
	const root = opened.createLiveParent();
	opened.installColdReviver(root);
	const spawned = await opened.spawn(
		opened.taskSpawn(root, "EffortChanged", { agent: fixtureAgent(), modelOverride: "mock/mock-thinking" }),
	);
	const live = localSession(AgentRegistry.global().get(spawned.id)?.session);
	expect(live.thinkingLevel).toBe(Effort.Low);
	// What `agent://<id>/effort` does on the live session.
	live.setThinkingLevel(Effort.High);
	await opened.park(spawned.id);

	const warm = await opened.revive(spawned.id);
	expect(warm.session.thinkingLevel).toBe(Effort.High);
	expect((await opened.wake(warm.session, spawned.id)).reasoning).toBe(Effort.High);
	await opened.park(spawned.id);
	opened.dropWarmReviver(spawned.id);

	const cold = await opened.revive(spawned.id);
	expect(cold.session.thinkingLevel).toBe(Effort.High);
	expect((await opened.wake(cold.session, spawned.id)).reasoning).toBe(Effort.High);
});

/** Opens a process whose registry also serves a thinking model, and spawns `id` on it at the agent's `low` level. */
async function spawnThinking(id: string) {
	const opened = await openReviveEnv();
	env = opened;
	opened.addModel("mock-thinking", { thinking: true });
	const root = opened.createLiveParent();
	opened.installColdReviver(root);
	const spawned = await opened.spawn(opened.taskSpawn(root, id, { modelOverride: "mock/mock-thinking" }));
	const live = localSession(AgentRegistry.global().get(spawned.id)?.session);
	return { env: opened, spawned, live };
}

it("revives a subagent parked during a retry-fallback hop at its spawn's level, not the hop's", async () => {
	const { env, spawned, live } = await spawnThinking("FallbackHop");
	// What a hop to a `:high` chain entry writes: its `model_change`, with the fallback cause, then its level.
	live.sessionManager.appendModelChange("mock/mock-thinking", "fallback", {
		fallback: { from: "mock/mock-thinking", trigger: "request-error" },
	});
	live.sessionManager.appendThinkingLevelChange(Effort.High);
	await env.park(spawned.id);

	const warm = await env.revive(spawned.id);
	expect(warm.session.thinkingLevel).toBe(Effort.Low);
	await env.park(spawned.id);
	env.dropWarmReviver(spawned.id);
	const cold = await env.revive(spawned.id);
	expect(cold.session.thinkingLevel).toBe(Effort.Low);
});

it("revives on the held model, with a warning naming the cause, where a session-local switch is gone", async () => {
	const { env, spawned, live } = await spawnThinking("SwitchGone");
	// What `agent://<id>/model` writes on the live session.
	live.sessionManager.appendModelChange("mock/gone", "temporary");
	await env.park(spawned.id);
	const warn = vi.spyOn(logger, "warn");

	const warm = await env.revive(spawned.id);

	expect(warm.session.model ? formatModelStringWithRouting(warm.session.model) : undefined).toBe("mock/mock-thinking");
	expect(warn).toHaveBeenCalledWith(expect.stringContaining('Model "mock/gone" not found'), {
		subagent: spawned.id,
		model: "mock/mock-thinking",
	});
});

it("keeps on the revive in memory the eval tools its spawn was given, after eval.tools.enabled is turned off", async () => {
	const opened = await openReviveEnv();
	env = opened;
	const root = opened.createLiveParent();
	opened.installColdReviver(root);
	const enabled = { settings: Settings.isolated({ "eval.tools.enabled": true }) } as unknown as ToolSession;
	const customTools = createEvalCustomTools(enabled, [
		{
			name: "lookup_rows",
			description: "Looks up rows.",
			parameters: { type: "object", properties: {} },
			language: "js",
		},
	]);
	const spawned = await opened.spawn(opened.taskSpawn(root, "EvalOff", { customTools }));
	await opened.park(spawned.id);
	// The setting gates the tools a spawn may be given, not those of a subagent already running, as on main.
	cfgEvalToolsEnabled.override(opened.settings, false);

	const warm = await opened.revive(spawned.id);

	expect(warm.build.options.customTools?.map(tool => tool.name)).toEqual(["lookup_rows"]);
});
