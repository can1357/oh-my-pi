import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Settings } from "../src/config/settings";
import type { ExtensionUIDialogOptions, ExtensionUISelectItem } from "../src/extensibility/extensions";
import { HookSelectorComponent } from "@oh-my-pi/pi-tui/overlays/hook-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { ToolSession } from "../src/tools";
import { AskTool } from "../src/tools/ask";
import { type AskToolDetails } from "@oh-my-pi/pi-tui/tools/ask";

type AskExecutionResult = AgentToolResult<AskToolDetails>;
type AskSelect = (
	title: string,
	options: ExtensionUISelectItem[],
	dialogOptions?: ExtensionUIDialogOptions,
) => Promise<string | undefined>;

const DB_FORM = `<form>
  <p>Which database?</p>
  <label><input type="radio" name="db" value="sqlite"> SQLite</label>
  <label><input type="radio" name="db" value="postgres" checked> Postgres</label>
</form>`;

async function drainMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function createAskTool(): AskTool {
	return new AskTool({
		hasUI: true,
		settings: Settings.isolated({ "ask.timeout": 0.01, "ask.notify": "off", "speech.enabled": false }),
		getPlanModeState: () => ({ enabled: false }),
	} as unknown as ToolSession);
}

function selectContext(select: AskSelect, extra: Record<string, unknown> = {}) {
	const abort = vi.fn();
	const context = {
		hasUI: true,
		ui: { select, input: vi.fn(), editor: vi.fn(), ...extra },
		abort,
	} as unknown as AgentToolContext;
	return { context, abort };
}

function runAsk(html: string, context: AgentToolContext) {
	const outcome: { result?: AskExecutionResult; rejection?: unknown } = {};
	void createAskTool()
		.execute("ask-timeout", { html }, undefined, undefined, context)
		.then(
			value => {
				outcome.result = value;
			},
			error => {
				outcome.rejection = error;
			},
		);
	return outcome;
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

	it("submits the preselected option when the selector does not settle", async () => {
		vi.useFakeTimers();
		const select = vi.fn<AskSelect>(() => Promise.withResolvers<string | undefined>().promise);
		const { context, abort } = selectContext(select);
		const outcome = runAsk(DB_FORM, context);

		await drainMicrotasks();
		vi.advanceTimersByTime(10);
		await drainMicrotasks();

		expect(outcome.rejection).toBeUndefined();
		expect(outcome.result?.details?.answers).toEqual([
			{ name: "db", question: "Which database?", answer: "Postgres" },
		]);
		expect(outcome.result?.details?.timedOut).toBe(true);
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
		const { context, abort } = selectContext(select);
		const outcome = runAsk(DB_FORM, context);

		await drainMicrotasks();
		expect(resetTimeout).toBeDefined();

		vi.advanceTimersByTime(9);
		resetTimeout?.();
		vi.advanceTimersByTime(9);
		await drainMicrotasks();

		expect(outcome.result).toBeUndefined();

		vi.advanceTimersByTime(1);
		await drainMicrotasks();

		expect(outcome.rejection).toBeUndefined();
		expect(outcome.result?.details?.timedOut).toBe(true);
		expect(abort).not.toHaveBeenCalled();
	});

	it("does not run the fallback timeout while the selector is queued", async () => {
		vi.useFakeTimers();
		let startTimeout: (() => void) | undefined;
		const select = vi.fn<AskSelect>((_title, _options, dialogOptions) => {
			startTimeout = dialogOptions?.onTimeoutStart;
			return Promise.withResolvers<string | undefined>().promise;
		});
		const { context, abort } = selectContext(select, { timeoutStartsOnPresentation: true });
		const outcome = runAsk(DB_FORM, context);

		await drainMicrotasks();
		expect(startTimeout).toBeDefined();

		vi.advanceTimersByTime(10);
		await drainMicrotasks();

		expect(outcome.result).toBeUndefined();

		startTimeout?.();
		vi.advanceTimersByTime(10);
		await drainMicrotasks();

		expect(outcome.rejection).toBeUndefined();
		expect(outcome.result?.details?.timedOut).toBe(true);
		expect(abort).not.toHaveBeenCalled();
	});

	it("keeps answered fields and defaults the rest when a later field times out", async () => {
		vi.useFakeTimers();
		const select = vi.fn<AskSelect>(async (title, _options, dialogOptions) => {
			if (title === "Which database?") return "SQLite";
			dialogOptions?.onTimeoutStart?.();
			return Promise.withResolvers<string | undefined>().promise;
		});
		const { context, abort } = selectContext(select);
		const outcome = runAsk(
			`<form>
  <p>Which database?</p>
  <label><input type="radio" name="db" value="sqlite"> SQLite</label>
  <label><input type="radio" name="db" value="postgres" checked> Postgres</label>
  <p>Which auth?</p>
  <label><input type="radio" name="auth" value="jwt" checked> JWT</label>
  <label><input type="radio" name="auth" value="oauth"> OAuth</label>
  <label>Notes <textarea name="notes">none</textarea></label>
</form>`,
			context,
		);

		await drainMicrotasks();
		await drainMicrotasks();
		vi.advanceTimersByTime(10);
		await drainMicrotasks();
		await drainMicrotasks();

		expect(outcome.rejection).toBeUndefined();
		expect(select).toHaveBeenCalledTimes(2);
		expect(outcome.result?.content[0]).toEqual({
			type: "text",
			text: `No answer before the timeout; submitted the form's current values:\n${JSON.stringify(
				{ db: "sqlite", auth: "jwt", notes: "none" },
				null,
				2,
			)}`,
		});
		expect(outcome.result?.details?.timedOut).toBe(true);
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
