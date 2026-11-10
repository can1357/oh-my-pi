import { describe, expect, it, vi } from "bun:test";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
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

	it("fails closed when the execute-time context is present but empty", async () => {
		const invoke = vi.fn(async (): Promise<AgentToolResult<unknown>> => ({
			content: [{ type: "text", text: "must not run" }],
		}));
		const definition: EvalPreludeDefinition = {
			name: "guarded",
			documentation: "Guarded",
			javascript: "globalThis.guarded = {};",
			python: "guarded = object()",
			exports: ["guarded"],
			approval: "exec",
			invoke,
		};
		const session = makeSession(() => [definition]);

		await expect(
			invokeEvalPrelude(
				"guarded",
				{},
				{
					session,
					toolCallId: "empty-context",
					// Execute-time context with no settings and no grant: must fail closed.
					context: {} as unknown as AgentToolContext,
				},
			),
		).rejects.toThrow(/requires approval but no interactive UI is available/);
		expect(invoke).not.toHaveBeenCalled();
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

	it("sends the first-call guide with the first printed result of each conversation, never without read", async () => {
		let outcome: "throw" | "bare" | "ok" = "throw";
		const definition: EvalPreludeDefinition = {
			name: "probe",
			documentation: "Probe documentation",
			firstCallDocumentation: "PROBE GUIDE",
			javascript: "globalThis.probe = {};",
			python: "probe = object()",
			exports: ["probe"],
			approval: "read",
			invoke: async () => {
				if (outcome === "throw") throw new Error("no such tab");
				// Without details the bridge returns a bare string the facades never print.
				return { content: [{ type: "text", text: "ran" }], details: outcome === "ok" ? {} : undefined };
			},
		};
		let conversation = "first";
		let canRead = true;
		const session = {
			...makeSession(() => [definition]),
			getSessionId: () => conversation,
			isToolActive: (name: string) => name !== "read" || canRead,
		};
		const text = async () =>
			(await invokeEvalPrelude("probe", {}, { session, toolCallId: "call" })).content
				.map(part => (part.type === "text" ? part.text : ""))
				.join("");

		await expect(invokeEvalPrelude("probe", {}, { session, toolCallId: "call" })).rejects.toThrow(/^no such tab$/);
		outcome = "bare";
		expect(await text()).toBe("ran");
		outcome = "ok";
		expect(await text()).toContain("PROBE GUIDE");
		expect(await text()).toBe("ran");
		conversation = "second";
		expect(await text()).toContain("PROBE GUIDE");
		conversation = "third";
		canRead = false;
		expect(await text()).toBe("ran");
	});

	it("sends the first-call guide again once the context no longer holds it, and not while it does", async () => {
		const definition: EvalPreludeDefinition = {
			name: "probe",
			documentation: "Probe documentation",
			firstCallDocumentation: "PROBE GUIDE",
			javascript: "globalThis.probe = {};",
			python: "probe = object()",
			exports: ["probe"],
			approval: "read",
			invoke: async () => ({ content: [{ type: "text", text: "ran" }], details: {} }),
		};
		let revision = 0;
		let context: Message[] = [];
		const session = {
			...makeSession(() => [definition]),
			getSessionId: () => "conversation",
			getContextRevision: () => revision,
			getContextMessages: () => context,
		};
		const call = async () => (await invokeEvalPrelude("probe", {}, { session, toolCallId: "call" })).content;
		const text = (content: AgentToolResult<unknown>["content"]) =>
			content.map(part => (part.type === "text" ? part.text : "")).join("");

		const delivered = await call();
		expect(text(delivered)).toContain("PROBE GUIDE");
		expect(text(await call())).toBe("ran");
		// A compaction summarized the delivering result away.
		revision++;
		expect(text(await call())).toContain("PROBE GUIDE");
		// Rewording the guide does not change its delivery marker across rewind or resume.
		context = [
			{
				role: "toolResult",
				toolCallId: "call",
				toolName: "eval",
				content: [{ type: "text", text: '<eval-guide name="probe">\nReworded guide.\n</eval-guide>' }],
				isError: false,
				timestamp: 0,
			},
		];
		revision++;
		expect(text(await call())).toBe("ran");
		const resumed = { ...session, getContextRevision: () => 0 };
		expect(text((await invokeEvalPrelude("probe", {}, { session: resumed, toolCallId: "call" })).content)).toBe(
			"ran",
		);
	});
});
