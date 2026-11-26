/**
 * Units of the revive from the stored session that no older tree has: the level a revive starts at, the spec's
 * version check, and the custom tools a spec can hold.
 */
import { afterEach, expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createEvalCustomTools } from "@oh-my-pi/pi-coding-agent/task/eval-tools";
import { revivedThinkingLevel } from "@oh-my-pi/pi-coding-agent/task/executor";
import { readSpawnSpec } from "@oh-my-pi/pi-coding-agent/task/spawn-spec";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { logger } from "@oh-my-pi/pi-utils";
import { openReviveEnv, type ReviveEnv, sessionInitRecords } from "./revive-harness";

let env: ReviveEnv | undefined;

afterEach(async () => {
	await env?.close();
	env = undefined;
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
