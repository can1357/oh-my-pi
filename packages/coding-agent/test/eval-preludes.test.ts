import { describe, expect, it, vi } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval";
import { getEnabledEvalPreludes, invokeEvalPrelude } from "@oh-my-pi/pi-coding-agent/eval";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function makeSession(getEvalPreludes: () => EvalPreludeDefinition[]): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getEvalPreludes,
	};
}

describe("eval prelude host invocation", () => {
	it("re-resolves live enablement so a captured call loses access when disabled", async () => {
		let enabled = true;
		const invoke = vi.fn(async (): Promise<AgentToolResult<unknown>> => ({
			content: [{ type: "text", text: "ran" }],
		}));
		const definition: EvalPreludeDefinition = {
			name: "probe",
			documentation: "Probe documentation",
			javascript: "globalThis.probe = {};",
			python: "probe = object()",
			exports: ["probe"],
			approval: "read",
			enabled: () => enabled,
			invoke,
		};
		const session = makeSession(() => getEnabledEvalPreludes([definition]));

		expect(await invokeEvalPrelude("probe", {}, { session, toolCallId: "first" })).toEqual({
			content: [{ type: "text", text: "ran" }],
		});
		enabled = false;
		await expect(invokeEvalPrelude("probe", {}, { session, toolCallId: "captured" })).rejects.toThrow(
			/not enabled in the current session/,
		);
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("dispatches replacements from the current session registry", async () => {
		const firstInvoke = vi.fn(async (): Promise<AgentToolResult<unknown>> => ({
			content: [{ type: "text", text: "first" }],
		}));
		const replacementInvoke = vi.fn(async (): Promise<AgentToolResult<unknown>> => ({
			content: [{ type: "text", text: "replacement" }],
		}));
		const first: EvalPreludeDefinition = {
			name: "probe",
			documentation: "First",
			javascript: "globalThis.probe = { version: 1 };",
			python: "probe = {'version': 1}",
			exports: ["probe"],
			approval: "read",
			invoke: firstInvoke,
		};
		const replacement: EvalPreludeDefinition = {
			name: "probe",
			documentation: "Replacement",
			javascript: "globalThis.probe = { version: 2 };",
			python: "probe = {'version': 2}",
			exports: ["probe"],
			approval: "read",
			invoke: replacementInvoke,
		};
		let current = first;
		const session = makeSession(() => [current]);

		await invokeEvalPrelude("probe", {}, { session, toolCallId: "first" });
		current = replacement;
		const result = await invokeEvalPrelude("probe", {}, { session, toolCallId: "replacement" });

		expect(result.content).toEqual([{ type: "text", text: "replacement" }]);
		expect(firstInvoke).toHaveBeenCalledTimes(1);
		expect(replacementInvoke).toHaveBeenCalledTimes(1);
	});

	it("never executes a handler denied by its approval policy", async () => {
		const invoke = vi.fn(async (): Promise<AgentToolResult<unknown>> => ({
			content: [{ type: "text", text: "must not run" }],
		}));
		const definition: EvalPreludeDefinition = {
			name: "guarded",
			documentation: "Guarded",
			javascript: "globalThis.guarded = {};",
			python: "guarded = object()",
			exports: ["guarded"],
			approval: { tier: "exec", policy: "deny", reason: "test policy" },
			invoke,
		};
		const session = makeSession(() => [definition]);

		await expect(invokeEvalPrelude("guarded", {}, { session, toolCallId: "denied" })).rejects.toThrow(
			/blocked by tool policy/,
		);
		expect(invoke).not.toHaveBeenCalled();
	});
});
