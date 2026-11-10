import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { agentLoop, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { AgentLoopConfig } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionFormDialogResult,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AskTool, recoverAskHtml } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

const DB_FORM = `<form>
  <p>Sessions live in memory.</p>
  <fieldset>
    <legend>Session store</legend>
    <label><input type="radio" name="store" value="sqlite" checked> SQLite</label>
    <label><input type="radio" name="store" value="redis"> Redis</label>
  </fieldset>
  <label>Lifetime (days) <input type="number" name="ttl" value="30"></label>
</form>`;

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "ask.notify": "off" }),
		...overrides,
		canPromptUser: overrides.canPromptUser ?? overrides.hasUI ?? true,
	};
}

type Select = (
	title: string,
	options: ExtensionUISelectItem[],
	dialogOptions?: ExtensionUIDialogOptions,
) => Promise<string | undefined>;
type Input = (
	title: string,
	placeholder?: string,
	dialogOptions?: ExtensionUIDialogOptions,
) => Promise<string | undefined>;
type Editor = (
	title: string,
	prefill?: string,
	dialogOptions?: ExtensionUIDialogOptions,
	editorOptions?: { promptStyle?: boolean },
) => Promise<string | undefined>;
type FormDialog = (
	html: string,
	dialogOptions?: ExtensionUIDialogOptions,
) => Promise<ExtensionFormDialogResult | undefined>;

function createContext(args: {
	formDialog?: FormDialog;
	select?: Select;
	input?: Input;
	editor?: Editor;
	abort?: () => void;
	steeringSignal?: AbortSignal;
}): AgentToolContext {
	const unexpected = async () => {
		throw new Error("unexpected prompt");
	};
	// AgentToolContext includes many runtime fields; tests only need UI + abort behavior.
	return {
		hasUI: true,
		ui: {
			...(args.formDialog ? { formDialog: args.formDialog } : {}),
			select: args.select ?? unexpected,
			input: args.input ?? unexpected,
			editor: args.editor ?? unexpected,
		},
		abort: args.abort ?? (() => {}),
		...(args.steeringSignal ? { toolCall: { steeringSignal: args.steeringSignal } } : {}),
	} as unknown as AgentToolContext;
}

function label(option: ExtensionUISelectItem | undefined): string | undefined {
	return typeof option === "string" ? option : option?.label;
}

function text(result: { content: { type: string; text?: string }[] }): string | undefined {
	const block = result.content[0];
	return block?.type === "text" ? block.text : undefined;
}

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AskTool form dialog", () => {
	it("returns the submitted form data as JSON and each field's question and answer", async () => {
		const formDialog = vi.fn<FormDialog>(async () => ({ data: { store: "redis", ttl: 7 } }));
		const result = await new AskTool(createSession()).execute(
			"call-1",
			{ html: DB_FORM },
			undefined,
			undefined,
			createContext({ formDialog }),
		);

		expect(formDialog.mock.calls[0]?.[0]).toBe(DB_FORM);
		expect(text(result)).toBe(`User answers:\n${JSON.stringify({ store: "redis", ttl: 7 }, null, 2)}`);
		expect(result.details).toEqual({
			answers: [
				{ name: "store", question: "Session store", answer: "Redis" },
				{ name: "ttl", question: "Lifetime (days)", answer: "7" },
			],
		});
	});

	it("passes the configured timeout, except in plan mode", async () => {
		const timeouts: (number | undefined)[] = [];
		const formDialog: FormDialog = async (_html, options) => {
			timeouts.push(options?.timeout);
			return { data: { store: "sqlite" } };
		};
		const settings = Settings.isolated({ "ask.timeout": 30, "ask.notify": "off" });
		await new AskTool(createSession()).execute(
			"a",
			{ html: DB_FORM },
			undefined,
			undefined,
			createContext({ formDialog }),
		);
		await new AskTool(createSession({ settings })).execute(
			"b",
			{ html: DB_FORM },
			undefined,
			undefined,
			createContext({ formDialog }),
		);
		await new AskTool(
			createSession({ settings, getPlanModeState: () => ({ enabled: true, planFilePath: "/tmp/plan.md" }) }),
		).execute("c", { html: DB_FORM }, undefined, undefined, createContext({ formDialog }));

		expect(timeouts).toEqual([undefined, 30_000, undefined]);
	});

	it("reports a timed-out submission as the form's current values", async () => {
		const result = await new AskTool(createSession()).execute(
			"call-timeout",
			{ html: DB_FORM },
			undefined,
			undefined,
			createContext({ formDialog: async () => ({ data: { store: "sqlite", ttl: 30 }, timedOut: true }) }),
		);

		expect(text(result)).toBe(
			`No answer before the timeout; submitted the form's current values:\n${JSON.stringify({ store: "sqlite", ttl: 30 }, null, 2)}`,
		);
		expect(result.details?.timedOut).toBe(true);
	});

	it("aborts the turn when the user cancels the form", async () => {
		const abort = vi.fn();
		const outcome = new AskTool(createSession()).execute(
			"call-cancel",
			{ html: DB_FORM },
			undefined,
			undefined,
			createContext({ formDialog: async () => undefined, abort }),
		);

		await expect(outcome).rejects.toThrow(new ToolAbortError("Ask tool was cancelled by the user"));
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("tells the model a form without named controls needs one, without showing it", async () => {
		const formDialog = vi.fn<FormDialog>();
		const result = await new AskTool(createSession()).execute(
			"call-unnamed",
			{ html: "<form><p>Pick one</p><label><input type='radio' value='a'> A</label></form>" },
			undefined,
			undefined,
			createContext({ formDialog }),
		);

		expect(text(result)).toContain("no named controls");
		expect(result.details).toEqual({ answers: [] });
		expect(formDialog).not.toHaveBeenCalled();
	});

	it("closes for a message the user queued without cancelling the turn, but stays open for other interrupts", async () => {
		const ask = (source: string) => {
			const steering = new AbortController();
			const abort = vi.fn();
			const formDialog: FormDialog = async (_html, options) => {
				steering.abort(source);
				return options?.signal?.aborted ? undefined : { data: { store: "sqlite" } };
			};
			const outcome = new AskTool(createSession()).execute(
				`call-${source}`,
				{ html: DB_FORM },
				undefined,
				undefined,
				createContext({ formDialog, abort, steeringSignal: steering.signal }),
			);
			return { outcome, abort };
		};

		const user = ask("user");
		await expect(user.outcome).rejects.toThrow("Ask interrupted by message");
		expect(user.abort).not.toHaveBeenCalled();

		const irc = ask("irc");
		expect((await irc.outcome).details?.answers[0]).toMatchObject({ name: "store", answer: "SQLite" });
	});

	it("delivers queued steering while the form is open without cancelling the turn", async () => {
		const abort = vi.fn();
		const wake = Promise.withResolvers<void>();
		let queued = false;
		let closed = false;
		const formDialog: FormDialog = async (_html, options) => {
			queued = true;
			wake.resolve();
			const { promise, resolve } = Promise.withResolvers<undefined>();
			options?.signal?.addEventListener(
				"abort",
				() => {
					closed = true;
					resolve(undefined);
				},
				{ once: true },
			);
			return promise;
		};
		const context = createContext({ formDialog, abort });
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "ask-1", name: "ask", arguments: { html: DB_FORM } }] },
				{ content: ["I will revisit the store after handling the new request."] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: messages => messages as Message[],
			getToolContext: toolCall => ({ ...context, toolCall }) as AgentToolContext,
			hasSteeringMessages: () => queued,
			waitForSteeringMessages: () => wake.promise,
			getSteeringMessages: async () => {
				if (!queued) return [];
				queued = false;
				return [{ role: "user", content: "Check the schema first", timestamp: Date.now() }];
			},
		};
		const controller = new AbortController();
		// Safety only: the real steering watcher must release the dialog before this fires.
		const timer = setTimeout(() => controller.abort("ask stayed open"), 2000);
		try {
			const events = [];
			for await (const event of agentLoop(
				[{ role: "user", content: "Choose a store", timestamp: Date.now() }],
				{ systemPrompt: ["Test"], messages: [], tools: [new AskTool(createSession())] },
				config,
				controller.signal,
				mock.stream,
			)) {
				events.push(event);
			}
			expect(controller.signal.aborted).toBe(false);
			expect(closed).toBe(true);
			expect(abort).not.toHaveBeenCalled();
			const result = events.find(event => event.type === "tool_execution_end" && event.toolName === "ask");
			if (result?.type !== "tool_execution_end") throw new Error("ask did not finish");
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result.result.content)).toContain("Ask interrupted by message");
			expect(mock.calls).toHaveLength(2);
		} finally {
			clearTimeout(timer);
		}
	});

	it("does not emit terminal notifications for non-terminal prompt surfaces", async () => {
		const sendNotification = spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		await new AskTool(
			createSession({ hasUI: false, canPromptUser: true, settings: Settings.isolated({ "ask.notify": "on" }) }),
		).execute(
			"call-acp",
			{ html: DB_FORM },
			undefined,
			undefined,
			createContext({ formDialog: async () => ({ data: { store: "sqlite" } }) }),
		);
		expect(sendNotification).not.toHaveBeenCalled();
	});
});

describe("AskTool without a form surface", () => {
	it("asks each named field in order and builds the form data", async () => {
		const selects: { title: string; options: (string | undefined)[]; initialIndex?: number }[] = [];
		const select: Select = async (title, options, dialogOptions) => {
			selects.push({ title, options: options.map(label), initialIndex: dialogOptions?.initialIndex });
			if (title === "Session store") return "Redis";
			// Checkbox loop: tick Metrics, untick Logs, then finish.
			const ticks = selects.filter(call => call.title.endsWith("Telemetry")).length;
			if (ticks === 1) return "Metrics";
			if (ticks === 2) return "Logs";
			return options.map(label).find(option => option?.endsWith("Done selecting"));
		};
		const input = vi.fn<Input>(async () => "7");
		const editor = vi.fn<Editor>(async () => "Keep it simple");
		const result = await new AskTool(createSession()).execute(
			"call-fallback",
			{
				html: `<form>
  <input type="hidden" name="version" value="2">
  <fieldset>
    <legend>Session store</legend>
    <label><input type="radio" name="store" value="sqlite"> SQLite</label>
    <label><input type="radio" name="store" value="redis" checked> Redis</label>
  </fieldset>
  <fieldset>
    <legend>Telemetry</legend>
    <label><input type="checkbox" name="telemetry" value="logs" checked> Logs</label>
    <label><input type="checkbox" name="telemetry" value="metrics"> Metrics</label>
  </fieldset>
  <label>Lifetime (days) <input type="number" name="ttl" placeholder="30"></label>
  <label>Notes <textarea name="notes">draft</textarea></label>
</form>`,
			},
			undefined,
			undefined,
			createContext({ select, input, editor }),
		);

		expect(selects[0]).toEqual({
			title: "Session store",
			options: ["SQLite", "Redis", "Other (type your own)"],
			initialIndex: 1,
		});
		expect(input.mock.calls[0]?.slice(0, 2)).toEqual(["Lifetime (days)", "30"]);
		expect(editor.mock.calls[0]?.slice(0, 2)).toEqual(["Notes", "draft"]);
		expect(JSON.parse(text(result)?.replace("User answers:\n", "") ?? "")).toEqual({
			version: "2",
			store: "redis",
			telemetry: ["metrics"],
			ttl: 7,
			notes: "Keep it simple",
		});
	});

	it("takes a radio's typed Other text as its value and appends a checkbox group's", async () => {
		const selects: { title: string; checked?: readonly number[] }[] = [];
		const picks = ["Other (type your own)", "Other (type your own)", "CI", "Other (type your own)"];
		const select: Select = async (title, options, dialogOptions) => {
			selects.push({ title, checked: dialogOptions?.checkedIndices });
			return picks.shift() ?? options.map(label).find(option => option?.endsWith("Done selecting"));
		};
		// A blank Other answer returns to the options.
		const typed = ["  ", " MySQL 8 ", "terraform"];
		const input = vi.fn<Input>(async () => typed.shift());
		const result = await new AskTool(createSession()).execute(
			"call-other",
			{
				html: `<form>
  <fieldset><legend>Database</legend>
    <label><input type="radio" name="db" value="postgres" checked> Postgres</label>
    <label><input type="radio" name="db" value="sqlite"> SQLite</label>
  </fieldset>
  <fieldset><legend>Tools</legend>
    <label><input type="checkbox" name="tools" value="ci"> CI</label>
    <label><input type="checkbox" name="tools" value="lint"> Lint</label>
  </fieldset>
</form>`,
			},
			undefined,
			undefined,
			createContext({ select, input }),
		);

		expect(input.mock.calls.map(call => call[0])).toEqual(["Database", "Database", "Tools"]);
		expect(selects.at(-1)?.checked).toEqual([0, 2]);
		expect(JSON.parse(text(result)?.replace("User answers:\n", "") ?? "")).toEqual({
			db: "MySQL 8",
			tools: ["ci", "terraform"],
		});
	});

	it("re-asks a text field with its validation error until the answer is valid", async () => {
		const titles: string[] = [];
		const answers = ["", "abc", "12"];
		const input: Input = async title => {
			titles.push(title);
			return answers.shift();
		};
		const result = await new AskTool(createSession()).execute(
			"call-validate",
			{ html: `<form><label>Port <input type="number" name="port" required></label></form>` },
			undefined,
			undefined,
			createContext({ input }),
		);

		expect(titles).toHaveLength(3);
		expect(titles[0]).toBe("Port");
		expect(titles[1]).not.toBe("Port");
		expect(titles[2]).not.toBe("Port");
		expect(result.details?.answers).toEqual([{ name: "port", question: "Port", answer: "12" }]);
	});

	it("omits a lone checkbox the user leaves unchecked", async () => {
		const select: Select = async (_title, options) =>
			options.map(label).find(option => option?.endsWith("Done selecting"));
		const result = await new AskTool(createSession()).execute(
			"call-flag",
			{ html: `<form><label><input type="checkbox" name="force" value="yes"> Force push</label></form>` },
			undefined,
			undefined,
			createContext({ select }),
		);

		expect(text(result)).toBe("User answers:\n{}");
	});

	it("aborts the turn when the user cancels a later field", async () => {
		const abort = vi.fn();
		const outcome = new AskTool(createSession()).execute(
			"call-cancel-later",
			{ html: DB_FORM },
			undefined,
			undefined,
			createContext({ select: async () => "SQLite", editor: async () => undefined, abort }),
		);

		await expect(outcome).rejects.toBeInstanceOf(ToolAbortError);
		expect(abort).toHaveBeenCalledTimes(1);
	});
});

describe("AskTool without an interactive UI", () => {
	it("aborts the turn in an ordinary session", async () => {
		const abort = vi.fn();
		const outcome = new AskTool(createSession()).execute("call-headless", { html: DB_FORM }, undefined, undefined, {
			hasUI: false,
			abort,
		} as unknown as AgentToolContext);

		await expect(outcome).rejects.toThrow(new ToolAbortError("Ask tool requires interactive mode"));
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("tells a headless fork's model to answer in its final message instead of aborting", async () => {
		const abort = vi.fn();
		const outcome = new AskTool(createSession({ hasUI: false, advertiseHeadlessAsk: true })).execute(
			"call-fork",
			{ html: DB_FORM },
			undefined,
			undefined,
			{ hasUI: false, abort } as unknown as AgentToolContext,
		);

		await expect(outcome).rejects.toBeInstanceOf(ToolError);
		expect(abort).not.toHaveBeenCalled();
	});
});

describe("recoverAskHtml", () => {
	it("recovers the form of an html call and nothing from legacy question calls", () => {
		expect(recoverAskHtml({ html: DB_FORM })).toBe(DB_FORM);
		expect(recoverAskHtml({ questions: [{ id: "q", question: "Q?", options: [] }] })).toBeUndefined();
		expect(recoverAskHtml("<form></form>")).toBeUndefined();
	});
});
