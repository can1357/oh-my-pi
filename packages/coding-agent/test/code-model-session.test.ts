import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	CODE_MODEL_REVIEW_PROMPT,
	CODE_MODEL_STATE_TYPE,
	installCodeModelSession,
} from "../src/code-model/session-mode";
import { createCodeModelExtension } from "../src/code-model";
import type { Settings } from "../src/config/settings";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions/types";
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

function harness(options: { role?: string; setModelAllowed?: boolean } = {}) {
	const main = model("main", "reviewer");
	const coding = model("code", "implementer");
	const manual = model("manual", "choice");
	const models = [main, coding, manual];
	let current = main;
	let effort: ConfiguredThinkingLevel | undefined = ThinkingLevel.Low;
	let sessionId = "session-1";
	let setModelAllowed = options.setModelAllowed ?? true;
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
		async setModel(next: Model) {
			if (!setModelAllowed) return false;
			current = next;
			branch.push({ type: "model_change", model: `${next.provider}/${next.id}` });
			return true;
		},
		getThinkingLevel() {
			return effort === "auto" ? undefined : effort;
		},
		setThinkingLevel(next: ConfiguredThinkingLevel | undefined) {
			effort = next;
			branch.push({ type: "thinking_level_change", thinkingLevel: next, configured: next });
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		models: {
			list: () => models,
			current: () => current,
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
		handlers,
		main,
		manual,
		notifications,
		pi,
		tools,
		settings,
		current: () => current,
		effort: () => effort,
		setCurrent(next: Model, nextEffort: ConfiguredThinkingLevel | undefined) {
			current = next;
			effort = nextEffort;
			branch.push({ type: "model_change", model: `${next.provider}/${next.id}` });
			branch.push({ type: "thinking_level_change", thinkingLevel: nextEffort, configured: nextEffort });
		},
		setModelAllowed(value: boolean) {
			setModelAllowed = value;
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
		createCodeModelExtension(state.settings)(state.pi);
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
		expect(state.effort()).toBe(ThinkingLevel.Low);
	});
});
