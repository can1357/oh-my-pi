import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	CODE_MODEL_REVIEW_PROMPT,
	CODE_MODEL_STATE_TYPE,
	type CodeModelBeforeIdleHandler,
	installCodeModelSession,
} from "../src/code-model/session-mode";
import { createCodeModelExtension } from "../src/code-model";
import type { Settings } from "../src/config/settings";
import { formatModelStringWithRouting } from "../src/config/model-resolver";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions/types";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "../src/session/session-entries";
import { getRestorableSessionModels } from "../src/session/session-context";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../src/thinking";

interface RegisteredTool {
	name: string;
	approval?: string;
	loadMode?: string;
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal,
		onUpdate: (value: unknown) => void,
		ctx: ExtensionContext,
	): Promise<{ content: Array<{ type: string; text: string }>; details: { changed: boolean } }>;
}

function model(provider: string, id: string): Model {
	return {
		provider,
		id,
		name: id,
		input: ["text"],
		supportsTools: true,
		thinking: { mode: "openai", efforts: ["low", "high", "xhigh"] },
	} as unknown as Model;
}

function harness(
	options: {
		role?: string;
		setModelAllowed?: boolean;
		initialEffort?: ConfiguredThinkingLevel;
	} = {},
) {
	const main = model("main", "reviewer");
	const coding = model("code", "implementer");
	const fallback = model("fallback", "backup");
	const manual = model("manual", "choice");
	const openRouterRouted = {
		...model("openrouter", "glm-4.7"),
		api: "openai-completions",
		baseUrl: "https://openrouter.ai/api/v1",
		compat: { openRouterRouting: { only: ["cerebras"] } },
	} as unknown as Model;
	const models = [main, coding, fallback, manual, openRouterRouted];
	let current = main;
	let effort: ConfiguredThinkingLevel | undefined = options.initialEffort ?? ThinkingLevel.Low;
	let effectiveEffort: ThinkingLevel | undefined = effort === AUTO_THINKING ? ThinkingLevel.Medium : effort;
	let sessionId = "session-1";
	let setModelAllowed = options.setModelAllowed ?? true;
	let setModelGate: Promise<void> | undefined;
	const branch: Array<Record<string, unknown>> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const tools: RegisteredTool[] = [];

	const settings = {
		getModelRole(role: string) {
			return role === "code" ? (options.role ?? "code/implementer:high") : undefined;
		},
	} as unknown as Settings;
	const pi = {
		zod: {
			enum: () => ({ default: () => ({}) }),
			object: () => ({}),
		},
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		registerCommand() {},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, handler);
		},
		appendEntry(customType: string, data: unknown) {
			branch.push({ type: "custom", customType, data });
		},
		async setModel(next: Model, options?: { ephemeral?: boolean; role?: string }) {
			await setModelGate;
			if (!setModelAllowed) return false;
			current = next;
			branch.push({
				type: "model_change",
				model: formatModelStringWithRouting(next),
				role: options?.ephemeral ? EPHEMERAL_MODEL_CHANGE_ROLE : (options?.role ?? "default"),
			});
			return true;
		},
		getThinkingLevel() {
			return effectiveEffort;
		},
		getConfiguredThinkingLevel() {
			return effort;
		},
		setThinkingLevel(next: ConfiguredThinkingLevel | undefined) {
			effort = next;
			effectiveEffort = next === AUTO_THINKING ? ThinkingLevel.Medium : next;
			branch.push({ type: "thinking_level_change", thinkingLevel: effectiveEffort, configured: next });
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		models: {
			list: () => models,
			current: () => current,
			resolve: (spec: string) => {
				if (spec === "openrouter/glm-4.7@cerebras") return openRouterRouted;
				const [provider, id] = spec.split("@")[0]?.split(":")?.[0]?.split("/") ?? [];
				return models.find(m => m.provider === provider && m.id === id);
			},
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
		},
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
	} as unknown as ExtensionContext;

	return {
		branch,
		coding,
		ctx,
		fallback,
		handlers,
		main,
		manual,
		openRouterRouted,
		notifications,
		pi,
		settings,
		tools,
		current: () => current,
		effort: () => effort,
		effectiveEffort: () => effectiveEffort,
		setCurrent(next: Model, nextEffort: ConfiguredThinkingLevel | undefined, role: string = "default") {
			current = next;
			effort = nextEffort;
			effectiveEffort = nextEffort === AUTO_THINKING ? ThinkingLevel.Medium : nextEffort;
			branch.push({ type: "model_change", model: formatModelStringWithRouting(next), role });
			branch.push({
				type: "thinking_level_change",
				thinkingLevel: effectiveEffort,
				configured: nextEffort,
			});
		},
		setFallback() {
			current = fallback;
			branch.push({
				type: "model_change",
				model: `${fallback.provider}/${fallback.id}`,
				resolvedModelIsFallback: true,
			});
		},
		setModelAllowed(value: boolean) {
			setModelAllowed = value;
		},
		setModelGate(value: Promise<void> | undefined) {
			setModelGate = value;
		},
		setSessionId(value: string) {
			sessionId = value;
		},
	};
}

describe("code-model session phase", () => {
	it("switches the same session and restores its original model and effort", async () => {
		const state = harness();
		const session = installCodeModelSession(state.pi, state.settings);
		const started = await session.run("start", state.ctx);
		expect(started.changed).toBe(true);
		expect(state.current()).toBe(state.coding);
		expect(state.effort()).toBe(ThinkingLevel.High);

		const finished = await session.run("finish", state.ctx);
		expect(finished.changed).toBe(true);
		expect(finished.message).toContain(CODE_MODEL_REVIEW_PROMPT);
		expect(state.current()).toBe(state.main);
		expect(state.effort()).toBe(ThinkingLevel.Low);
	});

	it("restores the main model after an automatic retry fallback", async () => {
		const state = harness();
		const session = installCodeModelSession(state.pi, state.settings);
		await session.run("start", state.ctx);
		state.setFallback();
		const finished = await session.run("finish", state.ctx);
		expect(finished.changed).toBe(true);
		expect(state.current()).toBe(state.main);
		expect(state.effort()).toBe(ThinkingLevel.Low);
	});

	it("records phase ownership when only effort changes", async () => {
		const state = harness({ role: "main/reviewer:high" });
		const session = installCodeModelSession(state.pi, state.settings);
		const started = await session.run("start", state.ctx);
		expect(started.changed).toBe(true);
		expect(state.current()).toBe(state.main);
		expect(state.effort()).toBe(ThinkingLevel.High);
		expect(state.branch.findLast(entry => entry.type === "model_change")?.role).toBe(EPHEMERAL_MODEL_CHANGE_ROLE);

		const finished = await session.run("finish", state.ctx);
		expect(finished.changed).toBe(true);
		expect(state.current()).toBe(state.main);
		expect(state.effort()).toBe(ThinkingLevel.Low);
		expect(state.branch.findLast(entry => entry.type === "model_change")?.role).toBe("default");
	});

	it("requires the exact retry primary before starting a coding phase", async () => {
		const state = harness();
		const sibling = { ...state.main, id: "reviewer-new" };
		state.setFallback();
		state.ctx.models.list = () => [state.coding, state.fallback, sibling];
		const resolve = state.ctx.models.resolve;
		state.ctx.models.resolve = selector => (selector === "main/reviewer" ? sibling : resolve(selector));
		const session = installCodeModelSession(state.pi, state.settings, {
			getRetryFallbackPrimary: () => ({ selector: "main/reviewer", effort: ThinkingLevel.Low }),
		});
		await expect(session.run("start", state.ctx)).rejects.toThrow("catalogue must contain main/reviewer");
		expect(state.current()).toBe(state.fallback);
		expect(state.branch.filter(entry => entry.type === "custom")).toHaveLength(0);
	});

	it("restores the main model when a retry fallback applies its own effort", async () => {
		const state = harness();
		const session = installCodeModelSession(state.pi, state.settings, {
			getRetryFallbackPrimary: () =>
				state.current() === state.fallback
					? {
							selector: `${state.main.provider}/${state.main.id}`,
							effort: ThinkingLevel.Low,
							fallbackEffort: ThinkingLevel.Low,
						}
					: undefined,
		});
		await session.run("start", state.ctx);
		state.setCurrent(state.fallback, ThinkingLevel.Low);
		state.setFallback();
		const finished = await session.run("finish", state.ctx);
		expect(finished.changed).toBe(true);
		expect(state.current()).toBe(state.main);
		expect(state.effort()).toBe(ThinkingLevel.Low);
	});

	it("restores the retry primary when a fallback starts the coding phase", async () => {
		const state = harness();
		state.setFallback();
		const session = installCodeModelSession(state.pi, state.settings, {
			getRetryFallbackPrimary: () => ({
				selector: `${state.main.provider}/${state.main.id}`,
				effort: ThinkingLevel.Low,
			}),
		});
		await session.run("start", state.ctx);
		expect(state.current()).toBe(state.coding);
		const finished = await session.run("finish", state.ctx);
		expect(finished.changed).toBe(true);
		expect(state.current()).toBe(state.main);
		expect(state.effort()).toBe(ThinkingLevel.Low);
	});

	it("restores an undefined retry-primary effort", async () => {
		const state = harness();
		state.setCurrent(state.fallback, ThinkingLevel.High);
		state.setFallback();
		const session = installCodeModelSession(state.pi, state.settings, {
			getRetryFallbackPrimary: () => ({
				selector: `${state.main.provider}/${state.main.id}`,
				effort: undefined,
			}),
		});
		await session.run("start", state.ctx);
		const finished = await session.run("finish", state.ctx);
		expect(finished.changed).toBe(true);
		expect(state.current()).toBe(state.main);
		expect(state.effort()).toBeUndefined();
	});
	it("preserves manual effort when an automatic retry fallback occurs", async () => {
		const state = harness();
		const session = installCodeModelSession(state.pi, state.settings);
		await session.run("start", state.ctx);
		// User manually updates effort during the coding phase.
		state.pi.setThinkingLevel(ThinkingLevel.XHigh);
		state.setFallback();
		const finished = await session.run("finish", state.ctx);
		expect(finished.changed).toBe(false);
		expect(state.current()).toBe(state.fallback);
		expect(state.effort()).toBe(ThinkingLevel.XHigh);
	});

	it("preserves routed model identity across coding phase and restoration", async () => {
		const state = harness();
		state.setCurrent(state.openRouterRouted, ThinkingLevel.Low);
		const session = installCodeModelSession(state.pi, state.settings);
		const started = await session.run("start", state.ctx);
		expect(started.changed).toBe(true);
		expect(state.current()).toBe(state.coding);

		const finished = await session.run("finish", state.ctx);
		expect(finished.changed).toBe(true);
		expect(state.current()).toBe(state.openRouterRouted);
		expect(state.effort()).toBe(ThinkingLevel.Low);
	});

	it("applies the configured coding route and restores the original model", async () => {
		const state = harness({ role: "openrouter/glm-4.7@cerebras:high" });
		const session = installCodeModelSession(state.pi, state.settings);
		const status = await session.run("status", state.ctx);
		expect(status.message).toContain("openrouter/glm-4.7@cerebras · high");

		const started = await session.run("start", state.ctx);
		expect(started.changed).toBe(true);
		expect(state.current()).toBe(state.openRouterRouted);
		expect(state.effort()).toBe(ThinkingLevel.High);

		const finished = await session.run("finish", state.ctx);
		expect(finished.changed).toBe(true);
		expect(state.current()).toBe(state.main);
		expect(state.effort()).toBe(ThinkingLevel.Low);
		expect(state.branch).toContainEqual({
			type: "model_change",
			model: "openrouter/glm-4.7@cerebras",
			role: EPHEMERAL_MODEL_CHANGE_ROLE,
		});
	});

	it("preserves active role and default fallback across coding phase switches", async () => {
		const state = harness();
		state.branch.push({
			type: "model_change",
			model: formatModelStringWithRouting(state.main),
			role: "default",
		});
		state.setCurrent(state.fallback, ThinkingLevel.High, "slow");

		const session = installCodeModelSession(state.pi, state.settings);
		const started = await session.run("start", state.ctx);
		expect(started.changed).toBe(true);
		expect(state.current()).toBe(state.coding);

		expect(state.branch.findLast(entry => entry.type === "model_change")).toMatchObject({
			type: "model_change",
			model: formatModelStringWithRouting(state.coding),
			role: EPHEMERAL_MODEL_CHANGE_ROLE,
		});

		const finished = await session.run("finish", state.ctx);
		expect(finished.changed).toBe(true);
		expect(state.current()).toBe(state.fallback);
		expect(state.effort()).toBe(ThinkingLevel.High);

		const lastModelChange = state.branch.findLast(entry => entry.type === "model_change");
		expect(lastModelChange).toMatchObject({
			type: "model_change",
			model: formatModelStringWithRouting(state.fallback),
			role: "slow",
		});
		const roles = Object.fromEntries(
			state.branch
				.filter(entry => entry.type === "model_change")
				.map(entry => [entry.role ?? "default", entry.model]),
		);
		expect(roles.default).toBe(formatModelStringWithRouting(state.main));
		expect(getRestorableSessionModels(roles, "slow")).toEqual([
			formatModelStringWithRouting(state.fallback),
			formatModelStringWithRouting(state.main),
		]);
	});
	it("keeps a manually selected model when finishing", async () => {
		const state = harness();
		const session = installCodeModelSession(state.pi, state.settings);
		await session.run("start", state.ctx);
		state.setCurrent(state.manual, ThinkingLevel.XHigh);
		const finished = await session.run("finish", state.ctx);
		expect(finished.changed).toBe(false);
		expect(state.current()).toBe(state.manual);
		expect(state.effort()).toBe(ThinkingLevel.XHigh);
	});

	it("preserves a named-role selection matching the coding model and effort", async () => {
		const state = harness();
		const session = installCodeModelSession(state.pi, state.settings);
		await session.run("start", state.ctx);
		state.setCurrent(state.coding, ThinkingLevel.High, "slow");
		const finished = await session.run("finish", state.ctx);
		expect(finished.changed).toBe(false);
		expect(state.current()).toBe(state.coding);
		expect(state.effort()).toBe(ThinkingLevel.High);
		expect(state.branch.findLast(entry => entry.type === "model_change")?.role).toBe("slow");
	});
	it("rolls back the original model state when entering fails", async () => {
		const state = harness({ setModelAllowed: false });
		const session = installCodeModelSession(state.pi, state.settings);
		await expect(session.run("start", state.ctx)).rejects.toThrow("authentication");
		expect(state.current()).toBe(state.main);
		expect(state.effort()).toBe(ThinkingLevel.Low);
		expect(state.branch.at(-1)).toMatchObject({ type: "custom", customType: CODE_MODEL_STATE_TYPE, data: undefined });
	});

	it("restores on a normal terminal stop and requests original-model review", async () => {
		const state = harness();
		const session = installCodeModelSession(state.pi, state.settings);
		await session.run("start", state.ctx);
		const stop = state.handlers.get("session_stop");
		expect(stop).toBeDefined();
		const result = await stop?.(
			{
				type: "session_stop",
				messages: [],
				last_assistant_message: { role: "assistant", stopReason: "stop", content: [], timestamp: Date.now() },
				signal: new AbortController().signal,
			},
			state.ctx,
		);
		expect(result).toEqual({ continue: true, additionalContext: CODE_MODEL_REVIEW_PROMPT });
		expect(state.current()).toBe(state.main);
	});

	it("awaits the internal terminal restoration immediately before idle", async () => {
		const state = harness();
		let finalizer: CodeModelBeforeIdleHandler | undefined;
		const session = installCodeModelSession(state.pi, state.settings, {
			registerBeforeIdle: handler => {
				finalizer = handler;
			},
		});
		await session.run("start", state.ctx);
		expect(finalizer).toBeDefined();
		expect(state.handlers.has("session_before_idle")).toBe(false);
		await finalizer?.({ type: "session_before_idle", messages: [], willContinue: true }, state.ctx);
		expect(state.current()).toBe(state.coding);
		await finalizer?.({ type: "session_before_idle", messages: [], willContinue: false }, state.ctx);
		expect(state.current()).toBe(state.main);
		expect(state.effort()).toBe(ThinkingLevel.Low);
	});

	it("awaits an in-flight stop restoration before idle", async () => {
		const state = harness();
		let finalizer: CodeModelBeforeIdleHandler | undefined;
		const session = installCodeModelSession(state.pi, state.settings, {
			registerBeforeIdle: handler => {
				finalizer = handler;
			},
		});
		await session.run("start", state.ctx);
		const gate = Promise.withResolvers<void>();
		state.setModelGate(gate.promise);
		const stop = state.handlers.get("session_stop");
		if (!stop || !finalizer) throw new Error("Expected terminal restoration handlers");
		const stopPromise = stop(
			{
				type: "session_stop",
				messages: [],
				last_assistant_message: { role: "assistant", stopReason: "stop", content: [], timestamp: Date.now() },
				signal: new AbortController().signal,
			},
			state.ctx,
		);
		await Promise.resolve();
		let idleSettled = false;
		const idlePromise = finalizer({ type: "session_before_idle", messages: [], willContinue: false }, state.ctx).then(
			result => {
				idleSettled = true;
				return result;
			},
		);
		await Bun.sleep(1);
		expect(idleSettled).toBe(false);
		gate.resolve();
		expect(await stopPromise).toBeUndefined();
		expect(await idlePromise).toEqual({ continue: true, additionalContext: CODE_MODEL_REVIEW_PROMPT });
		expect(state.current()).toBe(state.main);
		expect(idleSettled).toBe(true);
	});

	it("consumes a pending review when explicit finish recovers restoration", async () => {
		const state = harness();
		let finalizer: CodeModelBeforeIdleHandler | undefined;
		const session = installCodeModelSession(state.pi, state.settings, {
			registerBeforeIdle: handler => {
				finalizer = handler;
			},
		});
		await session.run("start", state.ctx);
		state.setModelAllowed(false);
		const stop = state.handlers.get("session_stop");
		if (!stop || !finalizer) throw new Error("Expected terminal restoration handlers");
		await expect(
			stop(
				{
					type: "session_stop",
					messages: [],
					last_assistant_message: {
						role: "assistant",
						stopReason: "stop",
						content: [],
						timestamp: Date.now(),
					},
					signal: new AbortController().signal,
				},
				state.ctx,
			),
		).rejects.toThrow("authentication");
		state.setModelAllowed(true);
		const finished = await session.run("finish", state.ctx);
		expect(finished.changed).toBe(true);
		expect(state.current()).toBe(state.main);
		expect(
			await finalizer({ type: "session_before_idle", messages: [], willContinue: false }, state.ctx),
		).toBeUndefined();
	});

	it.each([
		["session_before_switch", "session_switch"],
		["session_before_branch", "session_branch"],
		["session_before_tree", "session_tree"],
	])("consumes pending review when %s recovers navigation", async (beforeEvent, afterEvent) => {
		const state = harness();
		let finalizer: CodeModelBeforeIdleHandler | undefined;
		const session = installCodeModelSession(state.pi, state.settings, {
			registerBeforeIdle: handler => {
				finalizer = handler;
			},
		});
		await session.run("start", state.ctx);
		state.setModelAllowed(false);
		const stop = state.handlers.get("session_stop");
		if (!stop || !finalizer) throw new Error("Expected terminal restoration handlers");
		await expect(
			stop(
				{
					type: "session_stop",
					messages: [],
					last_assistant_message: { role: "assistant", stopReason: "stop", content: [], timestamp: Date.now() },
					signal: new AbortController().signal,
				},
				state.ctx,
			),
		).rejects.toThrow("authentication");
		await finalizer({ type: "session_before_idle", messages: [], willContinue: false }, state.ctx);
		state.setModelAllowed(true);
		expect(await state.handlers.get(beforeEvent)?.({ type: beforeEvent }, state.ctx)).toBeUndefined();
		state.branch.splice(0);
		state.setSessionId("destination-session");
		await state.handlers.get(afterEvent)?.({ type: afterEvent }, state.ctx);
		expect(state.current()).toBe(state.main);
		expect(
			await finalizer({ type: "session_before_idle", messages: [], willContinue: false }, state.ctx),
		).toBeUndefined();
	});

	it("restores a persisted coding phase when the session resumes", async () => {
		const state = harness();
		state.setCurrent(state.coding, ThinkingLevel.High);
		state.branch.push({
			type: "custom",
			customType: CODE_MODEL_STATE_TYPE,
			data: {
				version: 1,
				sessionId: "old-process-id",
				phase: "coding",
				original: { provider: state.main.provider, id: state.main.id, effort: "low" },
				coding: { provider: state.coding.provider, id: state.coding.id, effort: "high" },
			},
		});
		installCodeModelSession(state.pi, state.settings);
		const resume = state.handlers.get("session_start");
		await resume?.({ type: "session_start" }, state.ctx);
		expect(state.current()).toBe(state.main);
		expect(state.effort()).toBe(ThinkingLevel.Low);
	});

	it("restores the outgoing phase before session navigation", async () => {
		for (const [beforeEvent, afterEvent] of [
			["session_before_switch", "session_switch"],
			["session_before_branch", "session_branch"],
			["session_before_tree", "session_tree"],
		] as const) {
			const state = harness();
			const session = installCodeModelSession(state.pi, state.settings);
			await session.run("start", state.ctx);
			const prepare = state.handlers.get(beforeEvent);
			const result = await prepare?.({ type: beforeEvent }, state.ctx);
			expect(result).toBeUndefined();
			state.branch.splice(0);
			const recover = state.handlers.get(afterEvent);
			await recover?.({ type: afterEvent }, state.ctx);
			expect(state.current()).toBe(state.main);
			expect(state.effort()).toBe(ThinkingLevel.Low);
		}
	});

	it("ignores persisted phase state with an invalid effort", async () => {
		const state = harness();
		state.setCurrent(state.coding, ThinkingLevel.High);
		state.branch.push({
			type: "custom",
			customType: CODE_MODEL_STATE_TYPE,
			data: {
				version: 1,
				sessionId: "old-process-id",
				phase: "coding",
				original: { provider: state.main.provider, id: state.main.id, effort: "invalid" },
				coding: { provider: state.coding.provider, id: state.coding.id, effort: "high" },
			},
		});
		installCodeModelSession(state.pi, state.settings);
		const resume = state.handlers.get("session_start");
		await resume?.({ type: "session_start" }, state.ctx);
		expect(state.current()).toBe(state.coding);
		expect(state.effort()).toBe(ThinkingLevel.High);
	});

	it("reports an active phase without applying a second switch", async () => {
		const state = harness();
		const session = installCodeModelSession(state.pi, state.settings);
		await session.run("start", state.ctx);
		const again = await session.run("start", state.ctx);
		expect(again.changed).toBe(false);
		expect(again.phase).toBe("coding");
	});

	it("restores auto from a fresh session without a thinking-level entry", async () => {
		const state = harness({ initialEffort: AUTO_THINKING });
		const session = installCodeModelSession(state.pi, state.settings);
		await session.run("start", state.ctx);
		await session.run("finish", state.ctx);
		expect(state.effort()).toBe(AUTO_THINKING);
		expect(state.effectiveEffort()).toBe(ThinkingLevel.Medium);
	});

	it("restores auto thinking as the configured selector", async () => {
		const state = harness();
		state.setCurrent(state.main, AUTO_THINKING);
		const session = installCodeModelSession(state.pi, state.settings);
		await session.run("start", state.ctx);
		await session.run("finish", state.ctx);
		expect(state.effort()).toBe("auto");
	});

	it("runs the registered tool through the built-in extension lifecycle", async () => {
		const state = harness();
		let beforeIdle: CodeModelBeforeIdleHandler | undefined;
		createCodeModelExtension(state.settings, {
			registerBeforeIdle: handler => {
				beforeIdle = handler;
			},
		})(state.pi);
		expect(state.handlers.has("session_before_idle")).toBe(false);
		expect(state.tools.map(tool => tool.name)).toEqual(["code-model"]);
		const tool = state.tools[0];
		if (!tool) throw new Error("The code-model tool must be registered.");
		expect(tool.approval).toBe("exec");
		expect(tool.loadMode).toBe("essential");

		const signal = new AbortController().signal;
		const started = await tool.execute("start-call", { action: "start" }, signal, () => {}, state.ctx);
		expect(started.details.changed).toBe(true);
		expect(state.current()).toBe(state.coding);
		expect(state.effort()).toBe(ThinkingLevel.High);

		const finished = await tool.execute("finish-call", { action: "finish" }, signal, () => {}, state.ctx);
		expect(finished.details.changed).toBe(true);
		expect(finished.content[0]?.text).toContain(CODE_MODEL_REVIEW_PROMPT);
		expect(state.current()).toBe(state.main);
		expect(beforeIdle).toBeDefined();
		expect(state.effort()).toBe(ThinkingLevel.Low);
	});
});
