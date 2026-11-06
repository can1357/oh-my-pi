import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { describe, expect, it, vi } from "bun:test";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval";
import { getEnabledEvalPreludes, invokeEvalPrelude } from "@oh-my-pi/pi-coding-agent/eval";
import { createBrowserPreludeDefinition } from "@oh-my-pi/pi-coding-agent/tools/browser/prelude-definition";
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

	it("runs extension tool_call hooks: revised input executes, blocks never reach the handler", async () => {
		const invoke = vi.fn(async (parameters: unknown): Promise<AgentToolResult<unknown>> => ({
			content: [{ type: "text", text: JSON.stringify(parameters) }],
		}));
		const definition: EvalPreludeDefinition = {
			name: "probe",
			documentation: "Probe documentation",
			javascript: "globalThis.probe = {};",
			python: "probe = object()",
			exports: ["probe"],
			approval: "read",
			extensionToolCalls: true,
			enabled: () => true,
			invoke,
		};
		const emitToolCall = vi.fn(
			async (event: { toolName: string; toolCallId: string; input: Record<string, unknown> }) =>
				event.input.action === "deny"
					? { block: true, reason: "denied by extension" }
					: { input: { ...event.input, app: { cdp_url: "http://127.0.0.1:9999" } } },
		);
		const session: ToolSession = { ...makeSession(() => [definition]), emitToolCall };

		const result = await invokeEvalPrelude("probe", { action: "open" }, { session, toolCallId: "call-1" });
		expect(result.content).toEqual([
			{ type: "text", text: JSON.stringify({ action: "open", app: { cdp_url: "http://127.0.0.1:9999" } }) },
		]);
		expect(emitToolCall.mock.calls[0]?.[0]).toMatchObject({ toolName: "probe", toolCallId: "call-1" });

		await expect(invokeEvalPrelude("probe", { action: "deny" }, { session, toolCallId: "call-2" })).rejects.toThrow(
			/denied by extension/,
		);
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("does not fire extension hooks for a call its approval policy already denies", async () => {
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
			extensionToolCalls: true,
			invoke,
		};
		const emitToolCall = vi.fn(async () => undefined);
		const session: ToolSession = { ...makeSession(() => [definition]), emitToolCall };

		await expect(invokeEvalPrelude("guarded", {}, { session, toolCallId: "denied" })).rejects.toThrow(
			/blocked by tool policy/,
		);
		expect(emitToolCall).not.toHaveBeenCalled();
		expect(invoke).not.toHaveBeenCalled();
	});

	it("does not fire extension hooks for a prelude that has not opted in", async () => {
		const invoke = vi.fn(async (): Promise<AgentToolResult<unknown>> => ({
			content: [{ type: "text", text: "ran" }],
		}));
		const definition: EvalPreludeDefinition = {
			name: "plain",
			documentation: "Plain",
			javascript: "globalThis.plain = {};",
			python: "plain = object()",
			exports: ["plain"],
			approval: "read",
			invoke,
		};
		const emitToolCall = vi.fn(async () => ({ block: true, reason: "must not be consulted" }));
		const session: ToolSession = { ...makeSession(() => [definition]), emitToolCall };

		expect(await invokeEvalPrelude("plain", {}, { session, toolCallId: "plain-1" })).toEqual({
			content: [{ type: "text", text: "ran" }],
		});
		expect(emitToolCall).not.toHaveBeenCalled();
		expect(invoke).toHaveBeenCalledTimes(1);
	});
});

describe("eval prelude tool_call opt-in", () => {
	const probeDefinition = (invoke: EvalPreludeDefinition["invoke"]): EvalPreludeDefinition => ({
		name: "probe",
		documentation: "Probe documentation",
		javascript: "globalThis.probe = {};",
		python: "probe = object()",
		exports: ["probe"],
		approval: "read",
		extensionToolCalls: true,
		enabled: () => true,
		invoke,
	});

	/** Builds a session whose `emitToolCall` is wired the way `sdk.ts` wires it. */
	async function makeRunnerSession(
		definition: EvalPreludeDefinition,
		register: (api: ExtensionAPI) => void,
	): Promise<{ session: ToolSession; runner: ExtensionRunner }> {
		const runtime = new ExtensionRuntime();
		const manager = SessionManager.inMemory();
		const extension = await loadExtensionFromFactory(register, manager.getCwd(), new EventBus(), runtime);
		const authStorage = await AuthStorage.create(":memory:");
		const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
		const runner = new ExtensionRunner([extension], runtime, manager.getCwd(), manager, registry);
		const session: ToolSession = {
			...makeSession(() => [definition]),
			emitToolCall: (event, signal) =>
				runner.hasToolCallHandlers(event.source) ? runner.emitToolCall(event, signal) : Promise.resolve(undefined),
		};
		return { session, runner };
	}

	it("does not show eval prelude calls to a handler that did not opt in, but still shows loop calls", async () => {
		const invoke = vi.fn(async (): Promise<AgentToolResult<unknown>> => ({
			content: [{ type: "text", text: "ran" }],
		}));
		const plain = vi.fn(async () => ({ block: true, reason: "plain handler saw it" }));
		const { session, runner } = await makeRunnerSession(probeDefinition(invoke), api => {
			api.on("tool_call", plain);
		});

		expect(await invokeEvalPrelude("probe", {}, { session, toolCallId: "prelude-1" })).toEqual({
			content: [{ type: "text", text: "ran" }],
		});
		expect(plain).not.toHaveBeenCalled();
		expect(invoke).toHaveBeenCalledTimes(1);

		const loopResult = await runner.emitToolCall({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "loop-1",
			input: { command: "ls" },
		});
		expect(loopResult).toEqual({ block: true, reason: "plain handler saw it" });
		expect(plain).toHaveBeenCalledTimes(1);
	});

	it("lets an opted-in handler see, block, and revise eval prelude calls", async () => {
		const invoke = vi.fn(async (parameters: unknown): Promise<AgentToolResult<unknown>> => ({
			content: [{ type: "text", text: JSON.stringify(parameters) }],
		}));
		const seen: unknown[] = [];
		const optedIn = vi.fn(async (event: ToolCallEvent) => {
			seen.push(event.source);
			const input = event.input as Record<string, unknown>;
			if (input.action === "deny") return { block: true, reason: "denied by opted-in handler" };
			return { input: { ...input, app: { cdp_url: "http://127.0.0.1:9999" } } };
		});
		const { session } = await makeRunnerSession(probeDefinition(invoke), api => {
			api.on("tool_call", optedIn, { evalPreludes: true });
		});

		const result = await invokeEvalPrelude("probe", { action: "open" }, { session, toolCallId: "call-1" });
		expect(result.content).toEqual([
			{ type: "text", text: JSON.stringify({ action: "open", app: { cdp_url: "http://127.0.0.1:9999" } }) },
		]);
		expect(seen).toEqual(["eval-prelude"]);

		await expect(invokeEvalPrelude("probe", { action: "deny" }, { session, toolCallId: "call-2" })).rejects.toThrow(
			/denied by opted-in handler/,
		);
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("delivers eval prelude calls once to a handler registered both with and without the option", async () => {
		const invoke = vi.fn(async (): Promise<AgentToolResult<unknown>> => ({
			content: [{ type: "text", text: "ran" }],
		}));
		const shared = vi.fn(async () => undefined);
		const { session } = await makeRunnerSession(probeDefinition(invoke), api => {
			api.on("tool_call", shared);
			api.on("tool_call", shared, { evalPreludes: true });
		});

		await invokeEvalPrelude("probe", {}, { session, toolCallId: "prelude-2" });
		expect(shared).toHaveBeenCalledTimes(1);
	});
});

describe("browser eval prelude", () => {
	it("opts into extension tool_call events under the native browser tool name", () => {
		const definition = createBrowserPreludeDefinition(
			makeSession(() => []),
			{
				invoke: async () => ({ content: [{ type: "text", text: "" }] }),
				status: () => undefined,
			},
		);
		expect(definition.name).toBe("browser");
		expect(definition.extensionToolCalls).toBe(true);
	});
});
