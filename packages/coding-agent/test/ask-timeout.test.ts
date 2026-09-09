import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { ExtensionUIDialogOptions, ExtensionUISelectItem } from "../src/extensibility/extensions";
import { HookSelectorComponent } from "../src/modes/components/hook-selector";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";
import type { ToolSession } from "../src/tools";
import { AskTool, type AskToolDetails } from "../src/tools/ask";

type AskExecutionResult = AgentToolResult<AskToolDetails>;
type AskSelect = (
	title: string,
	options: ExtensionUISelectItem[],
	dialogOptions?: ExtensionUIDialogOptions,
) => Promise<string | undefined>;

async function drainMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function createAskTool(): AskTool {
	return new AskTool({
		hasUI: true,
		settings: {
			get(key: string): unknown {
				if (key === "ask.timeout") return 0.01;
				if (key === "ask.notify") return "off";
				if (key === "speech.enabled") return false;
				return undefined;
			},
		},
		getPlanModeState: () => ({ enabled: false }),
	} as unknown as ToolSession);
}

describe("AskTool timeout", () => {
	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("auto-selects the recommended option when the selector does not settle", async () => {
		vi.useFakeTimers();
		const select = vi.fn<AskSelect>(() => Promise.withResolvers<string | undefined>().promise);
		const abort = vi.fn();
		const context = {
			hasUI: true,
			ui: {
				select,
				editor: vi.fn(),
			},
			abort,
		} as unknown as AgentToolContext;
		let result: AskExecutionResult | undefined;
		let rejection: unknown;

		void createAskTool()
			.execute(
				"ask-timeout",
				{
					questions: [
						{
							id: "db",
							question: "Which database?",
							options: [{ label: "SQLite" }, { label: "Postgres" }],
							recommended: 1,
						},
					],
				},
				undefined,
				undefined,
				context,
			)
			.then(
				value => {
					result = value;
				},
				error => {
					rejection = error;
				},
			);

		await drainMicrotasks();
		vi.advanceTimersByTime(10);
		await drainMicrotasks();

		expect(rejection).toBeUndefined();
		expect(result?.details?.selectedOptions).toEqual(["Postgres"]);
		expect(result?.details?.timedOut).toBe(true);
		expect(abort).not.toHaveBeenCalled();
	});

	it("honors selector timeout resets before using the fallback timeout", async () => {
		vi.useFakeTimers();
		let resetTimeout: (() => void) | undefined;
		const select = vi.fn<AskSelect>((_title, _options, dialogOptions) => {
			dialogOptions?.onTimeoutStart?.();
			resetTimeout = dialogOptions?.onTimeoutReset;
			return Promise.withResolvers<string | undefined>().promise;
		});
		const abort = vi.fn();
		const context = {
			hasUI: true,
			ui: {
				select,
				editor: vi.fn(),
			},
			abort,
		} as unknown as AgentToolContext;
		let result: AskExecutionResult | undefined;
		let rejection: unknown;

		void createAskTool()
			.execute(
				"ask-timeout",
				{
					questions: [
						{
							id: "db",
							question: "Which database?",
							options: [{ label: "SQLite" }, { label: "Postgres" }],
							recommended: 1,
						},
					],
				},
				undefined,
				undefined,
				context,
			)
			.then(
				value => {
					result = value;
				},
				error => {
					rejection = error;
				},
			);

		await drainMicrotasks();
		expect(resetTimeout).toBeDefined();

		vi.advanceTimersByTime(9);
		resetTimeout?.();
		vi.advanceTimersByTime(9);
		await drainMicrotasks();

		expect(result).toBeUndefined();

		vi.advanceTimersByTime(1);
		await drainMicrotasks();

		expect(rejection).toBeUndefined();
		expect(result?.details?.selectedOptions).toEqual(["Postgres"]);
		expect(result?.details?.timedOut).toBe(true);
		expect(abort).not.toHaveBeenCalled();
	});

	it("does not run the fallback timeout while the selector is queued", async () => {
		vi.useFakeTimers();
		let startTimeout: (() => void) | undefined;
		const select = vi.fn<AskSelect>((_title, _options, dialogOptions) => {
			startTimeout = dialogOptions?.onTimeoutStart;
			return Promise.withResolvers<string | undefined>().promise;
		});
		const abort = vi.fn();
		const context = {
			hasUI: true,
			ui: {
				timeoutStartsOnPresentation: true,
				select,
				editor: vi.fn(),
			},
			abort,
		} as unknown as AgentToolContext;
		let result: AskExecutionResult | undefined;
		let rejection: unknown;

		void createAskTool()
			.execute(
				"ask-timeout",
				{
					questions: [
						{
							id: "db",
							question: "Which database?",
							options: [{ label: "SQLite" }, { label: "Postgres" }],
							recommended: 1,
						},
					],
				},
				undefined,
				undefined,
				context,
			)
			.then(
				value => {
					result = value;
				},
				error => {
					rejection = error;
				},
			);

		await drainMicrotasks();
		expect(startTimeout).toBeDefined();

		vi.advanceTimersByTime(10);
		await drainMicrotasks();

		expect(result).toBeUndefined();

		startTimeout?.();
		vi.advanceTimersByTime(10);
		await drainMicrotasks();

		expect(rejection).toBeUndefined();
		expect(result?.details?.selectedOptions).toEqual(["Postgres"]);
		expect(result?.details?.timedOut).toBe(true);
		expect(abort).not.toHaveBeenCalled();
	});

	it("auto-selects timed-out single-choice questions before advancing multi-question asks", async () => {
		vi.useFakeTimers();
		let callCount = 0;
		const select = vi.fn<AskSelect>((_title, _options, dialogOptions) => {
			callCount += 1;
			if (callCount === 1) {
				dialogOptions?.onTimeoutStart?.();
				return Promise.withResolvers<string | undefined>().promise;
			}
			return Promise.resolve("OAuth");
		});
		const abort = vi.fn();
		const context = {
			hasUI: true,
			ui: {
				select,
				editor: vi.fn(),
			},
			abort,
		} as unknown as AgentToolContext;
		let result: AskExecutionResult | undefined;
		let rejection: unknown;

		void createAskTool()
			.execute(
				"ask-timeout",
				{
					questions: [
						{
							id: "db",
							question: "Which database?",
							options: [{ label: "SQLite" }, { label: "Postgres" }],
							recommended: 1,
						},
						{
							id: "auth",
							question: "Which auth?",
							options: [{ label: "JWT" }, { label: "OAuth" }],
							recommended: 0,
						},
					],
				},
				undefined,
				undefined,
				context,
			)
			.then(
				value => {
					result = value;
				},
				error => {
					rejection = error;
				},
			);

		await drainMicrotasks();
		vi.advanceTimersByTime(10);
		await drainMicrotasks();
		await drainMicrotasks();

		expect(rejection).toBeUndefined();
		expect(select).toHaveBeenCalledTimes(2);
		expect(result?.details?.results?.[0]?.selectedOptions).toEqual(["Postgres"]);
		expect(result?.details?.results?.[0]?.timedOut).toBe(true);
		expect(result?.details?.results?.[1]?.selectedOptions).toEqual(["OAuth"]);
		expect(result?.details?.results?.[1]?.timedOut).toBeUndefined();
		expect(abort).not.toHaveBeenCalled();
	});

	it("notifies callers when the selector countdown starts and resets", () => {
		vi.useFakeTimers();
		const onTimeoutStart = vi.fn();
		const onTimeoutReset = vi.fn();
		const selector = new HookSelectorComponent("Pick one", ["SQLite", "Postgres"], vi.fn(), vi.fn(), {
			timeout: 10,
			tui: { requestRender: vi.fn() } as unknown as TUI,
			onTimeoutStart,
			onTimeoutReset,
		});

		selector.handleInput("j");

		expect(onTimeoutStart).toHaveBeenCalledTimes(1);
		expect(onTimeoutReset).toHaveBeenCalledTimes(1);
		selector.dispose();
	});
});
