import { describe, expect, it, vi } from "bun:test";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval";
import { getEnabledEvalPreludes, invokeEvalPrelude } from "@oh-my-pi/pi-coding-agent/eval";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createBrowserPreludeDefinition } from "@oh-my-pi/pi-coding-agent/tools/browser/prelude-definition";

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
});

describe("eval prelude extension tool events", () => {
	const hooked = (invoke: EvalPreludeDefinition["invoke"], extensionToolCalls = true): EvalPreludeDefinition => ({
		name: "probe",
		documentation: "Probe documentation",
		javascript: "globalThis.probe = {};",
		python: "probe = object()",
		exports: ["probe"],
		approval: "read",
		extensionToolCalls,
		enabled: () => true,
		invoke,
	});

	it("runs the revised input and surfaces a block without invoking the prelude", async () => {
		const invoke = vi.fn(async (parameters: unknown): Promise<AgentToolResult<unknown>> => ({
			content: [{ type: "text", text: JSON.stringify(parameters) }],
		}));
		const definition = hooked(invoke);
		const emitToolCall = vi.fn(async (event: { input: Record<string, unknown> }) =>
			event.input.action === "deny"
				? { block: true, reason: "denied by extension" }
				: { input: { ...event.input, app: { cdp_url: "http://127.0.0.1:9999" } } },
		);
		const session: ToolSession = { ...makeSession(() => [definition]), emitToolCall };

		const result = await invokeEvalPrelude("probe", { action: "open" }, { session, toolCallId: "call-1" });
		expect(result.content).toEqual([
			{ type: "text", text: JSON.stringify({ action: "open", app: { cdp_url: "http://127.0.0.1:9999" } }) },
		]);
		await expect(invokeEvalPrelude("probe", { action: "deny" }, { session, toolCallId: "call-2" })).rejects.toThrow(
			/denied by extension/,
		);
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("never consults extensions for a prelude that did not opt in or whose policy denies the call", async () => {
		const invoke = vi.fn(async (): Promise<AgentToolResult<unknown>> => ({
			content: [{ type: "text", text: "ran" }],
		}));
		const emitToolCall = vi.fn(async () => ({ block: true, reason: "must not be consulted" }));
		const notOptedIn = hooked(invoke, false);
		const plain: ToolSession = { ...makeSession(() => [notOptedIn]), emitToolCall };
		expect(await invokeEvalPrelude("probe", {}, { session: plain, toolCallId: "plain" })).toEqual({
			content: [{ type: "text", text: "ran" }],
		});

		const denied: EvalPreludeDefinition = {
			...hooked(invoke),
			approval: { tier: "exec", policy: "deny", reason: "test policy" },
		};
		const guarded: ToolSession = { ...makeSession(() => [denied]), emitToolCall };
		await expect(invokeEvalPrelude("probe", {}, { session: guarded, toolCallId: "denied" })).rejects.toThrow(
			/blocked by tool policy/,
		);
		expect(emitToolCall).not.toHaveBeenCalled();
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("reports success, failure and an extension block to tool_result so a handler can release what it set up", async () => {
		const invoke = vi.fn(async (parameters: unknown): Promise<AgentToolResult<unknown>> => {
			if ((parameters as { action?: string }).action === "fail") throw new Error("open failed");
			return { content: [{ type: "text", text: "ran" }] };
		});
		const results: { toolCallId: string; isError: boolean }[] = [];
		const definition = hooked(invoke);
		const session: ToolSession = {
			...makeSession(() => [definition]),
			emitToolCall: async event =>
				(event.input as { action?: string }).action === "block" ? { block: true, reason: "blocked" } : undefined,
			emitToolResult: async event => {
				results.push({ toolCallId: event.toolCallId, isError: event.isError });
			},
		};

		await invokeEvalPrelude("probe", { action: "open" }, { session, toolCallId: "ok" });
		await expect(invokeEvalPrelude("probe", { action: "fail" }, { session, toolCallId: "fail" })).rejects.toThrow(
			/open failed/,
		);
		await expect(invokeEvalPrelude("probe", { action: "block" }, { session, toolCallId: "block" })).rejects.toThrow(
			/blocked/,
		);
		expect(results).toEqual([
			{ toolCallId: "ok", isError: false },
			{ toolCallId: "fail", isError: true },
			{ toolCallId: "block", isError: true },
		]);
	});

	it("opts the browser prelude in under the native browser tool name", () => {
		const definition = createBrowserPreludeDefinition(
			makeSession(() => []),
			{ invoke: async () => ({ content: [{ type: "text", text: "" }] }), status: () => undefined },
		);
		expect(definition.name).toBe("browser");
		expect(definition.extensionToolCalls).toBe(true);
	});
});
