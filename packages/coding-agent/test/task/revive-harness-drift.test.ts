/**
 * The revive harness spawns through its own copy of the spawner's options (`spawnerOptions`), so its tests also load
 * on a tree whose spawner has no `subagentLiveInputs`. This test holds the copy to production: on every live input
 * and policy field a spawner passes, the copy gives the value production gives, a value either side leaves out
 * included.
 */
import { afterEach, expect, it } from "bun:test";
import { SPAWNER_LIVE_INPUT_NAMES } from "@oh-my-pi/pi-coding-agent/task/spawn-spec";
import { subagentLiveInputs, subagentSpawnerPolicy } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import { openReviveEnv, type ReviveEnv, spawnerOptions } from "./revive-harness";

/** The other keys of `SubagentSpawnerLiveInputs`, and the spawner's policy fields. */
const SPAWNER_KEYS = [
	...SPAWNER_LIVE_INPUT_NAMES,
	"authStorage",
	"modelRegistry",
	"settings",
	"parentActiveProvider",
	"mcpManager",
	"noContextFiles",
	"parentArtifactManager",
	"parentTelemetry",
	"additionalDirectories",
	"credentialSourceSessionId",
] as const;

let env: ReviveEnv | undefined;

afterEach(async () => {
	await env?.close();
	env = undefined;
});

/** `value` with the functions of a plain object (a fresh `localProtocolOptions`, say) replaced by their kind. */
function comparable(value: unknown): unknown {
	if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, member]) => [key, typeof member === "function" ? "function" : member]),
	);
}

// The test compares `subagentLiveInputs` and `subagentSpawnerPolicy`. Neither returns these four fields, which
// `buildExecutorOptions` sets itself, so they are not compared here: `enableLsp` from the request's own
// `EffectiveSubagentPolicy`, and `mcpToolScope`, `parentSessionKey` and `parentPromptCacheKey` from the spawning
// session.
it("the harness's spawner options equal production's on every live-input and policy key", async () => {
	env = await openReviveEnv();
	const { toolSession } = env.createLiveParent();
	const production: Record<string, unknown> = {
		...subagentLiveInputs(toolSession),
		...subagentSpawnerPolicy(toolSession),
	};
	const copy: Record<string, unknown> = { ...spawnerOptions(toolSession) };
	// Every key production gives is one the list names, so the list cannot fall behind production.
	expect(Object.keys(production).filter(key => !(SPAWNER_KEYS as readonly string[]).includes(key))).toEqual([]);
	for (const key of SPAWNER_KEYS) expect([key, comparable(copy[key])]).toEqual([key, comparable(production[key])]);
});
