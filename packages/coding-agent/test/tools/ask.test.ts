import { beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { type } from "@oh-my-pi/omptype";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUISelectItem,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { getThemeByName, initTheme, theme, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AskTool, askToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { TERMINAL } from "@oh-my-pi/pi-tui";

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
		canPromptUser: overrides.canPromptUser ?? overrides.hasUI ?? true,
	};
}

function createContext(args: {
	select?: (
		prompt: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: {
			initialIndex?: number;
			timeout?: number;
			signal?: AbortSignal;
			outline?: boolean;
			onTimeout?: () => void;
			onLeft?: () => void;
			onRight?: () => void;
			selectionMarker?: "radio" | "checkbox";
			checkedIndices?: readonly number[];
			markableCount?: number;
		},
	) => Promise<string | undefined>;
	editor?: (
		title: string,
		prefill?: string,
		dialogOptions?: { signal?: AbortSignal },
		editorOptions?: { promptStyle?: boolean },
	) => Promise<string | undefined>;
	askDialog?: (
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: any,
	) => Promise<ExtensionAskDialogResult | undefined>;
	abort?: () => void;
}): AgentToolContext {
	// AgentToolContext includes many runtime fields; tests only need UI + abort behavior.
	return {
		hasUI: true,
		ui: {
			...(args.select ? { select: args.select } : {}),
			...(args.askDialog ? { askDialog: args.askDialog } : {}),
			editor: (
				title: string,
				prefill?: string,
				dialogOptions?: { signal?: AbortSignal },
				editorOptions?: { promptStyle?: boolean },
			) => args.editor?.(title, prefill, dialogOptions, editorOptions) ?? Promise.resolve(undefined),
		},
		abort: args.abort ?? (() => {}),
	} as unknown as AgentToolContext;
}

function stripAnsi(text: string): string {
	return stripVTControlCharacters(text);
}

function selectItemLabel(option: ExtensionUISelectItem | undefined): string | undefined {
	return typeof option === "string" ? option : option?.label;
}

let darkTheme: Theme;

beforeAll(async () => {
	await initTheme(false);
	const loadedTheme = await getThemeByName("dark");
	if (!loadedTheme) throw new Error("Expected dark theme");
	darkTheme = loadedTheme;
});

describe("AskTool cancellation", () => {
	it("aborts the turn when the user cancels selection", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const context = createContext({
			select: async () => undefined,
			abort,
		});

		expect(
			tool.execute(
				"call-1",
				{
					questions: [
						{
							id: "confirm",
							question: "Proceed?",
							options: [{ label: "yes" }, { label: "no" }],
						},
					],
				},
				undefined,
				undefined,
				context,
			),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("defaults to no timeout when ask.timeout is unset", async () => {
		// Regression for the surprise-auto-select report: a fresh install must let the user
		// deliberate indefinitely. The dialog timeout is opt-in via the `ask.timeout` setting.
		const tool = new AskTool(createSession());
		const select = vi.fn(
			async (
				_prompt: string,
				options: ExtensionUISelectItem[],
				_dialogOptions?: { initialIndex?: number; timeout?: number },
			) => (typeof options[0] === "string" ? options[0] : options[0]?.label),
		);
		const context = createContext({ select });

		await tool.execute(
			"call-default-no-timeout",
			{
				questions: [
					{
						id: "confirm",
						question: "Proceed?",
						options: [{ label: "yes" }, { label: "no" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0]?.[2]?.timeout).toBeUndefined();
	});

	it("still aborts when user explicitly cancels with timeout configured", async () => {
		const tool = new AskTool(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 30 }),
			}),
		);
		const abort = vi.fn();
		const context = createContext({
			select: async () => undefined,
			abort,
		});

		expect(
			tool.execute(
				"call-timeout-cancel",
				{
					questions: [
						{
							id: "confirm",
							question: "Proceed?",
							options: [{ label: "yes" }, { label: "no" }],
						},
					],
				},
				undefined,
				undefined,
				context,
			),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(abort).toHaveBeenCalledTimes(1);
	});
	it("auto-selects the recommended option on ask timeout", async () => {
		const tool = new AskTool(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			}),
		);
		const abort = vi.fn();
		const select = vi.fn(
			async (
				_prompt: string,
				options: ExtensionUISelectItem[],
				dialogOptions?: { initialIndex?: number; timeout?: number; onTimeout?: () => void },
			) => {
				dialogOptions?.onTimeout?.();
				const selected = options[dialogOptions?.initialIndex ?? 0];
				return typeof selected === "string" ? selected : selected?.label;
			},
		);
		const context = createContext({
			select,
			abort,
		});

		const result = await tool.execute(
			"call-2",
			{
				questions: [
					{
						id: "confirm",
						question: "Proceed?",
						options: [{ label: "yes" }, { label: "no" }],
						recommended: 1,
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User selected: no");
		expect(result.details?.selectedOptions).toEqual(["no"]);
		expect(abort).not.toHaveBeenCalled();
		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0]?.[2]?.initialIndex).toBe(1);
		expect(select.mock.calls[0]?.[2]?.timeout).toBeGreaterThan(0);
	}, 30_000);

	it("auto-selects the first option when timeout elapses without a selected option", async () => {
		const tool = new AskTool(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			}),
		);
		const abort = vi.fn();
		const context = createContext({
			select: async (_prompt, _options, dialogOptions) => {
				dialogOptions?.onTimeout?.();
				return undefined;
			},
			abort,
		});

		const result = await tool.execute(
			"call-timeout-none",
			{
				questions: [
					{
						id: "confirm",
						question: "Proceed?",
						options: [{ label: "yes" }, { label: "no" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User selected: yes");
		expect(result.details?.selectedOptions).toEqual(["yes"]);
		expect(abort).not.toHaveBeenCalled();
	}, 30_000);

	it("routes custom input through editor with promptStyle after choosing Other", async () => {
		const tool = new AskTool(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			}),
		);
		const abort = vi.fn();
		const editor = vi.fn(
			async (
				_title: string,
				_prefill?: string,
				_dialogOptions?: unknown,
				editorOptions?: { promptStyle?: boolean },
			) => {
				// Verify promptStyle is passed
				expect(editorOptions?.promptStyle).toBe(true);
				return "custom response";
			},
		);
		const select = vi.fn(async () => "Other (type your own)");
		const context = createContext({
			select,
			editor,
			abort,
		});

		const result = await tool.execute(
			"call-custom-input",
			{
				questions: [
					{
						id: "confirm",
						question: "Proceed?",
						options: [{ label: "yes" }, { label: "no" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("custom response");
		expect(result.details?.selectedOptions).toEqual([]);
		expect(result.details?.customInput).toBe("custom response");
		expect((select.mock.calls[0] as unknown[])?.[2] as Record<string, unknown>).toHaveProperty("timeout");
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("does not enter custom input when timeout resolves to Other in multi-select", async () => {
		const tool = new AskTool(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			}),
		);
		const abort = vi.fn();
		const editor = vi.fn(async () => "should-not-be-used");
		const context = createContext({
			select: async (_prompt, _options, dialogOptions) => {
				const timeout = dialogOptions?.timeout ?? 1;
				await Bun.sleep(timeout + 5);
				dialogOptions?.onTimeout?.();
				return "Other (type your own)";
			},
			editor,
			abort,
		});

		const result = await tool.execute(
			"call-timeout-other-multi",
			{
				questions: [
					{
						id: "confirm",
						question: "Proceed?",
						options: [{ label: "yes" }, { label: "no" }],
						multi: true,
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User selected: yes");
		expect(result.details?.selectedOptions).toEqual(["yes"]);
		expect(result.details?.customInput).toBeUndefined();
		expect(editor).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
	}, 30_000);

	it("aborts multi-question ask when any question is explicitly cancelled", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const context = createContext({
			select: async prompt => {
				if (prompt.includes("First")) return "one";
				return undefined;
			},
			abort,
		});

		await expect(
			tool.execute(
				"call-3",
				{
					questions: [
						{
							id: "first",
							question: "First",
							options: [{ label: "one" }, { label: "two" }],
						},
						{
							id: "second",
							question: "Second",
							options: [{ label: "alpha" }, { label: "beta" }],
						},
					],
				},
				undefined,
				undefined,
				context,
			),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(abort).toHaveBeenCalledTimes(1);
	});
});

describe("AskTool option descriptions", () => {
	it("passes descriptions to the selector while returning selected labels", async () => {
		const tool = new AskTool(createSession());
		const select = vi.fn(async (_prompt: string, options: ExtensionUISelectItem[]) => {
			expect(options[0]).toEqual({
				label: "Use local credentials",
				description: "Authenticate with provider keys already configured under ~/.omp.",
			});
			expect(options[1]).toEqual({
				label: "Set up in terminal",
				description: "Launch the terminal setup flow to add credentials before continuing.",
			});
			const selected = options[1];
			return typeof selected === "string" ? selected : selected?.label;
		});
		const context = createContext({ select });

		const result = await tool.execute(
			"call-option-descriptions",
			{
				questions: [
					{
						id: "auth",
						question: "How should authentication continue?",
						options: [
							{
								label: "Use local credentials",
								description: "Authenticate with provider keys already configured under ~/.omp.",
							},
							{
								label: "Set up in terminal",
								description: "Launch the terminal setup flow to add credentials before continuing.",
							},
						],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User selected: Set up in terminal");
		expect(result.details?.selectedOptions).toEqual(["Set up in terminal"]);
		expect(result.content[0].text).not.toContain("Launch the terminal setup flow");
		expect(result.details?.options).toEqual(["Use local credentials", "Set up in terminal"]);
	});

	it("renders descriptions under labels in ask call previews", async () => {
		const theme = darkTheme;
		const rendered = askToolRenderer.renderCall(
			{
				question: "How should authentication continue?",
				options: [
					{
						label: "Use local credentials",
						description: "Authenticate with provider keys already configured under ~/.omp.",
					},
					{
						label: "Set up in terminal",
						description: "Launch the terminal setup flow to add credentials before continuing.",
					},
				],
			},
			{ expanded: true, isPartial: false },
			theme!,
		);
		const renderedLines = stripAnsi(rendered.render(120).join("\n")).split("\n");
		const labelLine = renderedLines.findIndex(line => line.includes("Use local credentials"));
		const descriptionLine = renderedLines.findIndex(line =>
			line.includes("Authenticate with provider keys already configured"),
		);
		expect(labelLine).toBeGreaterThanOrEqual(0);
		expect(descriptionLine).toBeGreaterThan(labelLine);
	});

	it("forwards descriptions through multi-select and returns bare labels", async () => {
		const tool = new AskTool(createSession());
		let step = 0;
		let firstOptions: ExtensionUISelectItem[] = [];
		const editor = vi.fn(async () => undefined);
		const context = createContext({
			select: async (_prompt, options) => {
				if (step === 0) {
					firstOptions = options;
					step += 1;
					return selectItemLabel(options.find(o => selectItemLabel(o)?.endsWith("alpha")));
				}
				if (step === 1) {
					step += 1;
					return selectItemLabel(options.find(o => selectItemLabel(o)?.endsWith("beta")));
				}
				return selectItemLabel(options.find(o => selectItemLabel(o)?.includes("Done selecting")));
			},
			editor,
		});

		const result = await tool.execute(
			"call-multi-desc",
			{
				questions: [
					{
						id: "multi",
						question: "Pick answers",
						options: [
							{ label: "alpha", description: "First choice detail." },
							{ label: "beta", description: "Second choice detail." },
						],
						multi: true,
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.details?.selectedOptions).toEqual(["alpha", "beta"]);
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User selected: alpha, beta");
		expect(result.content[0].text).not.toContain("First choice detail");
		const alphaOption = firstOptions.find(o => selectItemLabel(o)?.endsWith("alpha"));
		expect(typeof alphaOption === "object" ? alphaOption.description : undefined).toBe("First choice detail.");
	});
});

describe("AskTool custom input", () => {
	it("routes custom input through editor and preserves raw multiline strings", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const multilineText = "first line\nsecond line";
		const editor = vi.fn(async () => multilineText);
		const questions = [
			{
				id: "details",
				question: "Share details",
				options: [{ label: "yes" }, { label: "no" }],
			},
		];
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
			abort,
		});

		const result = await tool.execute("call-editor-single", { questions }, undefined, undefined, context);
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toBe("User provided custom input:\n  first line\n  second line");
		expect(result.details?.customInput).toBe(multilineText);
		expect(result.details?.selectedOptions).toEqual([]);
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});
	it("keeps question context visible while entering Other custom input", async () => {
		const tool = new AskTool(createSession());
		const editor = vi.fn(async (_title: string) => "custom");
		const questions = [
			{
				id: "details",
				question: "Share details",
				options: [{ label: "yes" }, { label: "no", description: "Skip the optional detail." }],
			},
		];
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
		});

		await tool.execute("call-editor-context", { questions }, undefined, undefined, context);

		const title = editor.mock.calls[0]?.[0] ?? "";
		expect(title).toContain("Share details");
		expect(title).toContain("yes");
		expect(title).toContain("no");
		expect(title).toContain("Skip the optional detail.");
		expect(title).toContain("Other (type your own)");
		expect(title).toContain("Enter your response:");
	});

	it("caps Other editor context for long option lists with long descriptions", async () => {
		const tool = new AskTool(createSession());
		const editor = vi.fn(async (_title: string) => "custom");
		const longDescription = "x".repeat(400);
		const optionCount = 20;
		const options = Array.from({ length: optionCount }, (_, i) => ({
			label: `option-${i}`,
			description: longDescription,
		}));
		const questions = [{ id: "pick", question: "Pick one", options }];
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
		});

		await tool.execute("call-editor-cap", { questions }, undefined, undefined, context);

		const title = editor.mock.calls[0]?.[0] ?? "";
		const lineCount = title.split("\n").length;
		// Cap is 8 option rows + their (single-line) descriptions + chrome; far below
		// 20 options × (label + multi-line description) the unbounded path would emit.
		expect(lineCount).toBeLessThanOrEqual(22);
		expect(title).toContain("Pick one");
		expect(title).toContain("option-0");
		expect(title).toContain("Other (type your own)");
		expect(title).toContain("more option");
		expect(title).toContain("Enter your response:");
		// Descriptions are flattened to a single line and truncated.
		expect(title).not.toContain("x".repeat(400));
		// Every option-row description must fit on one line.
		for (const line of title.split("\n")) {
			expect(line.length).toBeLessThanOrEqual(160);
		}
	});

	it("keeps user-checked options visible in capped multi-select context", async () => {
		const tool = new AskTool(createSession());
		const editor = vi.fn(async (_title: string) => "custom");
		const options = Array.from({ length: 20 }, (_, i) => ({ label: `opt-${i}` }));
		const questions = [{ id: "pick", question: "Multi pick", options, multi: true }];
		let call = 0;
		const context = createContext({
			select: async (_prompt, opts) => {
				call += 1;
				if (call === 1) return selectItemLabel(opts.find(o => selectItemLabel(o) === "opt-12"));
				if (call === 2) return selectItemLabel(opts.find(o => selectItemLabel(o) === "opt-17"));
				return "Other (type your own)";
			},
			editor,
		});

		await tool.execute("call-editor-cap-multi", { questions }, undefined, undefined, context);

		const title = editor.mock.calls[0]?.[0] ?? "";
		// Checked options must survive the window so the user sees what they had
		// already toggled before switching to Other.
		expect(title).toContain("opt-12");
		expect(title).toContain("opt-17");
		expect(title).toContain("Other (type your own)");
		expect(title).toContain("more option");
	});

	it("summarizes excess checked options instead of exceeding the context cap", async () => {
		const tool = new AskTool(createSession());
		const editor = vi.fn(async (_title: string) => "custom");
		const options = Array.from({ length: 20 }, (_, i) => ({ label: `checked-${i}` }));
		const questions = [{ id: "pick", question: "Pick many", options, multi: true }];
		let call = 0;
		const context = createContext({
			select: async (_prompt, opts) => {
				if (call < 12) {
					const label = `checked-${call}`;
					call += 1;
					return selectItemLabel(opts.find(o => selectItemLabel(o) === label));
				}
				return "Other (type your own)";
			},
			editor,
		});

		await tool.execute("call-editor-cap-many-checked", { questions }, undefined, undefined, context);

		const title = editor.mock.calls[0]?.[0] ?? "";
		const optionRows = title
			.split("\n")
			.filter(line => line.includes("checked-") || line.includes("Other (type your own)"));
		expect(optionRows.length).toBeLessThanOrEqual(8);
		expect(title).toContain("Other (type your own)");
		expect(title).toContain("checked");
		expect(title).toContain("more option");
		expect(title).toContain("Enter your response:");
	});

	it("keeps sparse checked gap markers within the Other title budget", async () => {
		const tool = new AskTool(createSession());
		const editor = vi.fn(async (_title: string) => "custom");
		const checkedLabels = [10, 20, 30, 40, 50, 60].map(i => `opt-${i}`);
		const options = Array.from({ length: 61 }, (_, i) => ({ label: `opt-${i}` }));
		const questions = [{ id: "pick", question: "Pick sparse", options, multi: true }];
		let call = 0;
		const context = createContext({
			select: async (_prompt, opts) => {
				const next = checkedLabels[call++];
				return next ? selectItemLabel(opts.find(o => selectItemLabel(o) === next)) : "Other (type your own)";
			},
			editor,
		});

		await tool.execute("call-editor-cap-sparse-checked", { questions }, undefined, undefined, context);

		const title = editor.mock.calls[0]?.[0] ?? "";
		expect(title.split("\n").length).toBeLessThanOrEqual(16);
		expect(title).toContain("Other (type your own)");
		expect(title).toContain("more option");
		expect(title).toContain("Enter your response:");
	});

	it("enforces total title row budget under narrow terminals", async () => {
		const originalColumns = process.stdout.columns;
		// Force an 80-wide terminal so long descriptions would wrap to multiple
		// rendered rows without per-line width truncation + total row budget.
		Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
		try {
			const tool = new AskTool(createSession());
			const editor = vi.fn(async (_title: string) => "custom");
			const longDescription = "x".repeat(400);
			const options = Array.from({ length: 8 }, (_, i) => ({
				label: `option-${i}`,
				description: longDescription,
			}));
			const questions = [{ id: "pick", question: "Pick one", options }];
			const context = createContext({
				select: async () => "Other (type your own)",
				editor,
			});

			await tool.execute("call-editor-row-budget", { questions }, undefined, undefined, context);

			const title = editor.mock.calls[0]?.[0] ?? "";
			const lines = title.split("\n");
			// 16-row hard budget keeps the input row + hint reachable on 80x24.
			expect(lines.length).toBeLessThanOrEqual(16);
			// Every emitted line must fit on a single 80-cell row after truncation.
			for (const line of lines) {
				expect(stripAnsi(line).length).toBeLessThanOrEqual(80);
			}
			expect(title).toContain("Pick one");
			expect(title).toContain("Other (type your own)");
			expect(title).toContain("Enter your response:");
			expect(title).not.toContain("x".repeat(400));
		} finally {
			if (originalColumns === undefined) {
				Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
			} else {
				Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true });
			}
		}
	});

	it("returns to the option selector when custom input is dismissed in single-question flow", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const editor = vi.fn(async () => undefined);
		let selectCalls = 0;
		const questions = [
			{
				id: "details",
				question: "Share details",
				options: [{ label: "yes" }, { label: "no" }],
			},
		];
		const context = createContext({
			select: async () => {
				selectCalls += 1;
				return selectCalls === 1 ? "Other (type your own)" : "yes";
			},
			editor,
			abort,
		});

		const result = await tool.execute("call-editor-cancel", { questions }, undefined, undefined, context);
		expect(result.details?.selectedOptions).toEqual(["yes"]);
		expect(result.details?.customInput).toBeUndefined();
		expect(selectCalls).toBe(2);
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("returns to the option selector when custom input is dismissed in multi-question flow", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const editor = vi.fn(async () => undefined);
		let detailsVisits = 0;
		const questions = [
			{
				id: "first",
				question: "First?",
				options: [{ label: "one" }, { label: "two" }],
			},
			{
				id: "details",
				question: "Details?",
				options: [{ label: "short" }, { label: "long" }],
			},
		];
		const context = createContext({
			select: async prompt => {
				if (prompt.includes("First?")) return "one";
				if (prompt.includes("Details?")) {
					detailsVisits += 1;
					return detailsVisits === 1 ? "Other (type your own)" : "short";
				}
				return undefined;
			},
			editor,
			abort,
		});

		const result = await tool.execute("call-editor-multi-dismiss", { questions }, undefined, undefined, context);

		expect(result.details?.results?.[0]?.selectedOptions).toEqual(["one"]);
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["short"]);
		expect(result.details?.results?.[1]?.customInput).toBeUndefined();
		expect(detailsVisits).toBe(2);
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("surfaces external abort during editor mode as ToolAbortError", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const controller = new AbortController();
		const editor = vi.fn(async (_title: string, _prefill?: string, dialogOptions?: { signal?: AbortSignal }) => {
			expect(dialogOptions?.signal).toBe(controller.signal);
			return await new Promise<string | undefined>((_resolve, reject) => {
				dialogOptions?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
					once: true,
				});
				queueMicrotask(() => controller.abort());
			});
		});
		const questions = [
			{
				id: "details",
				question: "Share details",
				options: [{ label: "yes" }, { label: "no" }],
			},
		];
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
			abort,
		});

		await expect(
			tool.execute("call-editor-abort", { questions }, controller.signal, undefined, context),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("treats explicit empty-string custom input as submitted input", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const editor = vi.fn(async () => "");
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
			abort,
		});

		const result = await tool.execute(
			"call-empty-custom",
			{
				questions: [
					{
						id: "details",
						question: "Share details",
						options: [{ label: "yes" }, { label: "no" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User provided custom input:");
		expect(result.details?.customInput).toBe("");
		expect(result.details?.selectedOptions).toEqual([]);
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("renders checked options together with custom text in multi-select answers", async () => {
		const tool = new AskTool(createSession());
		let step = 0;
		const editor = vi.fn(async () => "custom detail");
		const context = createContext({
			select: async (_prompt, options) => {
				if (step === 0) {
					step += 1;
					const alphaOption = options.find(option => selectItemLabel(option)?.endsWith("alpha"));
					if (!alphaOption) throw new Error("Missing alpha option");
					return selectItemLabel(alphaOption);
				}
				return "Other (type your own)";
			},
			editor,
		});

		const result = await tool.execute(
			"call-multi-custom-render",
			{
				questions: [
					{
						id: "multi",
						question: "Pick answers",
						options: [{ label: "alpha" }, { label: "beta" }],
						multi: true,
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.details?.selectedOptions).toEqual(["alpha"]);
		expect(result.details?.customInput).toBe("custom detail");
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("alpha");
		expect(result.content[0].text).toContain("custom detail");

		const theme = darkTheme;
		const rendered = askToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme!);
		const renderedText = stripAnsi(rendered.render(120).join("\n"));
		expect(renderedText).toContain("alpha");
		expect(renderedText).toContain("custom detail");
	});

	it("returns to the option selector when multi-select custom input is dismissed", async () => {
		const tool = new AskTool(createSession());
		let step = 0;
		const editor = vi.fn(async () => undefined);
		const context = createContext({
			select: async (_prompt, options) => {
				if (step === 0) {
					step += 1;
					const alphaOption = options.find(option => selectItemLabel(option)?.endsWith("alpha"));
					if (!alphaOption) throw new Error("Missing alpha option");
					return selectItemLabel(alphaOption);
				}
				if (step === 1) {
					step += 1;
					return "Other (type your own)";
				}
				const doneOption = options.find(option => selectItemLabel(option)?.includes("Done selecting"));
				if (!doneOption) throw new Error("Missing done option");
				return selectItemLabel(doneOption);
			},
			editor,
		});

		const result = await tool.execute(
			"call-multi-custom-dismiss",
			{
				questions: [
					{
						id: "multi",
						question: "Pick answers",
						options: [{ label: "alpha" }, { label: "beta" }],
						multi: true,
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.details?.selectedOptions).toEqual(["alpha"]);
		expect(result.details?.customInput).toBeUndefined();
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User selected: alpha");
		expect(step).toBe(2);
		expect(editor).toHaveBeenCalledTimes(1);
	});
});

describe("AskTool multiline custom input rendering", () => {
	it("renders multiline custom answer as one block, not multiple checked items", async () => {
		const tool = new AskTool(createSession());
		const multilineText = "first line\nsecond line\nthird line";
		const editor = vi.fn(async () => multilineText);
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
		});

		const result = await tool.execute(
			"call-multiline-render",
			{
				questions: [
					{
						id: "details",
						question: "Share details",
						options: [{ label: "yes" }, { label: "no" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.details?.customInput).toBe(multilineText);

		const theme = darkTheme;
		const rendered = askToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme!);
		const renderedText = stripAnsi(rendered.render(120).join("\n"));

		// All three lines should appear
		expect(renderedText).toContain("first line");
		expect(renderedText).toContain("second line");
		expect(renderedText).toContain("third line");

		// Count success glyphs — should be exactly one for the custom input block.
		// The key contract is that continuation lines do NOT get their own glyph.
		const successGlyph = theme!.symbol("status.success");
		const successIconCount = (
			renderedText.match(new RegExp(successGlyph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []
		).length;
		// One glyph on the custom input first line; header uses the tool.ask icon.
		expect(successIconCount).toBe(1);

		// Ensure "second line" and "third line" are NOT preceded by a success icon on their own line
		const lines = renderedText.split("\n");
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.includes("second line") || trimmed.includes("third line")) {
				// These continuation lines must NOT start with a success icon
				expect(trimmed.startsWith(successGlyph)).toBe(false);
			}
		}
	});

	it("does not fabricate placeholder text for empty first-line custom input", async () => {
		const tool = new AskTool(createSession());
		const multilineText = "\nsecond line";
		const editor = vi.fn(async () => multilineText);
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
		});

		const result = await tool.execute(
			"call-leading-empty-line-render",
			{
				questions: [
					{
						id: "details",
						question: "Share details",
						options: [{ label: "yes" }, { label: "no" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		const theme = darkTheme;
		const rendered = askToolRenderer.renderResult(result, { expanded: true, isPartial: false }, theme!);
		const renderedText = stripAnsi(rendered.render(120).join("\n"));

		expect(renderedText).toContain("second line");
		expect(renderedText).not.toContain("(empty)");
	});
});

describe("AskTool multi-question navigation", () => {
	const questions = [
		{
			id: "first",
			question: "First?",
			options: [{ label: "one" }, { label: "two" }],
		},
		{
			id: "second",
			question: "Second?",
			options: [{ label: "alpha" }, { label: "beta" }],
		},
		{
			id: "third",
			question: "Third?",
			options: [{ label: "red" }, { label: "blue" }],
		},
	];

	it("keeps back unavailable on the first question and supports returning from later questions", async () => {
		const tool = new AskTool(createSession());
		const firstQuestionOptions: ExtensionUISelectItem[][] = [];
		let firstVisits = 0;
		let secondVisits = 0;
		const context = createContext({
			select: async (prompt, options, dialogOptions) => {
				if (prompt.includes("First?")) {
					firstQuestionOptions.push(options);
					firstVisits += 1;
					if (firstVisits === 1) return "one";
					dialogOptions?.onRight?.();
					return undefined;
				}
				if (prompt.includes("Second?")) {
					secondVisits += 1;
					if (secondVisits === 1) {
						dialogOptions?.onLeft?.();
						return undefined;
					}
					return "alpha";
				}
				dialogOptions?.onRight?.();
				return undefined;
			},
		});

		const result = await tool.execute("call-nav-1", { questions }, undefined, undefined, context);
		expect(result.details?.results?.[0]?.selectedOptions).toEqual(["one"]);
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["alpha"]);
		expect(firstQuestionOptions[0]).not.toContain("← Back");
		expect(firstQuestionOptions[1]).not.toContain("← Back");
	});

	it("allows forward action on the last question", async () => {
		const tool = new AskTool(createSession());
		const context = createContext({
			select: async (prompt, _options, dialogOptions) => {
				if (prompt.includes("First?")) return "one";
				if (prompt.includes("Second?")) return "alpha";
				dialogOptions?.onRight?.();
				return undefined;
			},
		});

		const result = await tool.execute("call-nav-2", { questions }, undefined, undefined, context);
		expect(result.details?.results?.[2]?.selectedOptions).toEqual([]);
		expect(result.details?.results?.[2]?.customInput).toBeUndefined();
	});

	it("persists state when changing an earlier answer and continuing", async () => {
		const tool = new AskTool(createSession());
		let firstVisits = 0;
		let secondVisits = 0;
		let thirdVisits = 0;
		const context = createContext({
			select: async (prompt, _options, dialogOptions) => {
				if (prompt.includes("First?")) {
					firstVisits += 1;
					if (firstVisits === 1) return "one";
					return "two";
				}
				if (prompt.includes("Second?")) {
					secondVisits += 1;
					if (secondVisits === 1) return "alpha";
					if (secondVisits === 2) {
						dialogOptions?.onLeft?.();
						return undefined;
					}
					dialogOptions?.onRight?.();
					return undefined;
				}
				if (prompt.includes("Third?")) {
					thirdVisits += 1;
					if (thirdVisits === 1) {
						dialogOptions?.onLeft?.();
						return undefined;
					}
					dialogOptions?.onRight?.();
					return undefined;
				}
				return undefined;
			},
		});

		const result = await tool.execute("call-nav-3", { questions }, undefined, undefined, context);
		expect(result.details?.results?.[0]?.selectedOptions).toEqual(["two"]);
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["alpha"]);
	});

	it("handles timeout with navigation and allows revisiting timed-out questions", async () => {
		const tool = new AskTool(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			}),
		);
		let secondVisits = 0;
		let thirdVisits = 0;
		const context = createContext({
			select: async (prompt, _options, dialogOptions) => {
				if (prompt.includes("First?")) return "one";
				if (prompt.includes("Second?")) {
					secondVisits += 1;
					if (secondVisits === 1) {
						await Bun.sleep(5);
						dialogOptions?.onTimeout?.();
						return undefined;
					}
					return "beta";
				}
				if (prompt.includes("Third?")) {
					thirdVisits += 1;
					if (thirdVisits === 1) {
						dialogOptions?.onLeft?.();
						return undefined;
					}
					dialogOptions?.onRight?.();
					return undefined;
				}
				return undefined;
			},
		});

		const result = await tool.execute("call-nav-4", { questions }, undefined, undefined, context);
		expect(result.details?.results?.[0]?.selectedOptions).toEqual(["one"]);
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["beta"]);
		expect(result.details?.results?.[2]?.selectedOptions).toEqual([]);
	}, 30_000);
	it("preserves custom input when navigating back and forward", async () => {
		const tool = new AskTool(createSession());
		const multilineText = "line 1\nline 2";
		let detailVisits = 0;
		let summaryVisits = 0;
		const editor = vi.fn(async () => multilineText);
		const questions = [
			{
				id: "details",
				question: "Details?",
				options: [{ label: "short" }, { label: "long" }],
			},
			{
				id: "summary",
				question: "Summary?",
				options: [{ label: "one" }, { label: "two" }],
			},
		];
		const context = createContext({
			select: async (prompt, _options, dialogOptions) => {
				if (prompt.includes("Details?")) {
					detailVisits += 1;
					if (detailVisits === 1) return "Other (type your own)";
					dialogOptions?.onRight?.();
					return undefined;
				}
				if (prompt.includes("Summary?")) {
					summaryVisits += 1;
					if (summaryVisits === 1) {
						dialogOptions?.onLeft?.();
						return undefined;
					}
					return "two";
				}
				return undefined;
			},
			editor,
		});

		const result = await tool.execute("call-nav-multiline", { questions }, undefined, undefined, context);

		expect(result.details?.results?.[0]?.customInput).toBe(multilineText);
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["two"]);
		expect(editor).toHaveBeenCalledTimes(1);
	});

	it("preserves prior single-select answer when custom editor is dismissed during navigation", async () => {
		const tool = new AskTool(createSession());
		let detailVisits = 0;
		const editor = vi.fn(async () => undefined);
		const questions = [
			{
				id: "details",
				question: "Details?",
				options: [{ label: "short" }, { label: "long" }],
			},
			{
				id: "summary",
				question: "Summary?",
				options: [{ label: "one" }, { label: "two" }],
			},
		];
		const context = createContext({
			select: async (prompt, _options, dialogOptions) => {
				if (prompt.includes("Details?")) {
					detailVisits += 1;
					if (detailVisits === 1) return "short";
					// Second visit: try Other then dismiss editor, then forward
					if (detailVisits === 2) return "Other (type your own)";
					dialogOptions?.onRight?.();
					return undefined;
				}
				if (prompt.includes("Summary?")) {
					const summaryVisit = detailVisits;
					if (summaryVisit <= 2) {
						// Navigate back to re-visit details
						dialogOptions?.onLeft?.();
						return undefined;
					}
					return "two";
				}
				return undefined;
			},
			editor,
		});

		const result = await tool.execute("call-nav-single-dismiss", { questions }, undefined, undefined, context);

		// The prior selection "short" should survive the editor dismiss
		expect(result.details?.results?.[0]?.selectedOptions).toEqual(["short"]);
		expect(result.details?.results?.[0]?.customInput).toBeUndefined();
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["two"]);
		expect(editor).toHaveBeenCalledTimes(1);
	});
});

describe("AskTool option markers", () => {
	it("renders single-choice call options with circular radio markers, not checkboxes", async () => {
		const theme = darkTheme;
		const rendered = askToolRenderer.renderCall(
			{ question: "Pick one", options: [{ label: "Alpha" }, { label: "Beta" }] },
			{ expanded: true, isPartial: false },
			theme!,
		);
		const text = stripAnsi(rendered.render(120).join("\n"));
		expect(text).toContain(theme!.radio.unselected);
		expect(text).not.toContain(theme!.checkbox.unchecked);
	});

	it("renders multi-select call options with rectangular checkbox markers, not radios", async () => {
		const theme = darkTheme;
		const rendered = askToolRenderer.renderCall(
			{ question: "Pick many", options: [{ label: "Alpha" }, { label: "Beta" }], multi: true },
			{ expanded: true, isPartial: false },
			theme!,
		);
		const text = stripAnsi(rendered.render(120).join("\n"));
		expect(text).toContain(theme!.checkbox.unchecked);
		expect(text).not.toContain(theme!.radio.unselected);
	});

	it("keeps option rows stable across repeated renders", async () => {
		const theme = darkTheme;
		const options = [
			{ label: "TypeScript" },
			{ label: "Rust" },
			{ label: "Python" },
			{ label: "Go" },
			{ label: "C" },
			{ label: "C++" },
			{ label: "Zig" },
			{ label: "Java" },
			{ label: "Swift" },
			{ label: "Haskell" },
		];
		const renderedCall = askToolRenderer.renderCall(
			{ questions: [{ id: "fav_lang", question: "Which programming language?", options }] },
			{ expanded: true, isPartial: true },
			theme!,
		);

		const firstCall = stripAnsi(renderedCall.render(120).join("\n"));
		const secondCall = stripAnsi(renderedCall.render(120).join("\n"));
		expect(secondCall).toBe(firstCall);
		expect(secondCall.match(/TypeScript/g)?.length).toBe(1);
		expect(secondCall.match(/Haskell/g)?.length).toBe(1);

		const renderedResult = askToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					results: [
						{
							id: "fav_lang",
							question: "Which programming language?",
							options: options.map(option => option.label),
							multi: false,
							selectedOptions: ["Python"],
						},
					],
				},
			},
			{ expanded: true, isPartial: false },
			theme!,
		);
		const firstResult = stripAnsi(renderedResult.render(120).join("\n"));
		const secondResult = stripAnsi(renderedResult.render(120).join("\n"));
		expect(secondResult).toBe(firstResult);
		expect(secondResult.match(/TypeScript/g)?.length).toBe(1);
		expect(secondResult.match(/Haskell/g)?.length).toBe(1);
	});

	it("keeps single-question option rows stable across repeated renders", async () => {
		const theme = darkTheme;
		// The question body comes from the Markdown render cache, which returns
		// the SAME array on every render of identical text at identical width.
		// Appending option rows in place would poison that cached entry, so a
		// second render of the component would duplicate the options.
		const renderedCall = askToolRenderer.renderCall(
			{ question: "Which **language** do you prefer?", options: [{ label: "OptionDupCanary" }] },
			{ expanded: true, isPartial: false },
			theme!,
		);
		const first = stripAnsi(renderedCall.render(120).join("\n"));
		const second = stripAnsi(renderedCall.render(120).join("\n"));
		expect(second).toBe(first);
		expect(second.match(/OptionDupCanary/g)?.length).toBe(1);

		const renderedResult = askToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					question: "Which **language** do you prefer?",
					multi: false,
					options: ["OptionDupCanary"],
					selectedOptions: ["OptionDupCanary"],
				},
			},
			{ expanded: true, isPartial: false },
			theme!,
		);
		const firstResult = stripAnsi(renderedResult.render(120).join("\n"));
		const secondResult = stripAnsi(renderedResult.render(120).join("\n"));
		expect(secondResult).toBe(firstResult);
		expect(secondResult.match(/OptionDupCanary/g)?.length).toBe(1);
	});
	it("renders single-choice result selection with a filled radio marker", async () => {
		const theme = darkTheme;
		const rendered = askToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: { question: "Pick one", multi: false, selectedOptions: ["Alpha"] },
			},
			{ expanded: true, isPartial: false },
			theme!,
		);
		const text = stripAnsi(rendered.render(120).join("\n"));
		expect(text).toContain(theme!.radio.selected);
		expect(text).not.toContain(theme!.checkbox.checked);
	});

	it("renders multi-select result selections with checkbox markers", async () => {
		const theme = darkTheme;
		const rendered = askToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: { question: "Pick many", multi: true, selectedOptions: ["Alpha", "Beta"] },
			},
			{ expanded: true, isPartial: false },
			theme!,
		);
		const text = stripAnsi(rendered.render(120).join("\n"));
		expect(text).toContain(theme!.checkbox.checked);
		expect(text).not.toContain(theme!.radio.selected);
	});
});

describe("askToolRenderer malformed call args", () => {
	it("renders double-encoded questions string instead of crashing the TUI", async () => {
		const theme = darkTheme;
		// Models occasionally JSON-encode the questions array as a string; a bare
		// string passes a truthy `.length` check but has no `.map` (TUI crash).
		const doubleEncoded = JSON.stringify([
			{ id: "q1", question: "Pick one", options: [{ label: "Alpha" }, { label: "Beta" }] },
		]);
		const rendered = askToolRenderer.renderCall(
			{ questions: doubleEncoded } as never,
			{ expanded: true, isPartial: false },
			theme!,
		);
		const text = stripAnsi(rendered.render(120).join("\n"));
		expect(text).toContain("[q1]");
		expect(text).toContain("Pick one");
		expect(text).toContain("Alpha");
	});

	it("falls back to the error frame for unparseable questions without throwing", async () => {
		const theme = darkTheme;
		for (const questions of ["[{trunc", 42, { 0: { id: "x" } }]) {
			const rendered = askToolRenderer.renderCall(
				{ questions } as never,
				{ expanded: true, isPartial: true },
				theme!,
			);
			const text = stripAnsi(rendered.render(120).join("\n"));
			expect(text).toContain("No question provided");
		}
	});

	it("drops malformed question entries and option items while keeping valid ones", async () => {
		const theme = darkTheme;
		const rendered = askToolRenderer.renderCall(
			{
				questions: [
					null,
					"garbage",
					{ id: "ok", question: "Real question", options: ["BareString", { label: "Proper" }, { nope: 1 }, 7] },
				],
			} as never,
			{ expanded: true, isPartial: true },
			theme!,
		);
		const text = stripAnsi(rendered.render(120).join("\n"));
		expect(text).toContain("[ok]");
		expect(text).toContain("Real question");
		expect(text).toContain("BareString");
		expect(text).toContain("Proper");
	});
});

describe("AskTool rich ask dialog", () => {
	it("accepts new schema fields (header, preview, note) and maps them into AskToolDetails", async () => {
		const tool = new AskTool(createSession());
		const askDialog = vi.fn().mockResolvedValue({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Q1?",
					options: ["Option A"],
					multi: false,
					selectedOptions: ["Option A"],
					note: "My Custom Note",
					timedOut: undefined,
				},
			],
		});
		const context = createContext({ askDialog });

		const result = await tool.execute(
			"call-rich-dialog",
			{
				questions: [
					{
						id: "q1",
						question: "Q1?",
						header: "Chip Header",
						options: [{ label: "Option A", preview: "My Preview" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(askDialog).toHaveBeenCalledTimes(1);
		// Check that header and preview were forwarded
		expect(askDialog.mock.calls[0][0]).toEqual([
			{
				id: "q1",
				question: "Q1?",
				header: "Chip Header",
				options: [{ label: "Option A", preview: "My Preview" }],
			},
		]);

		// Verify result contains details with note mapping
		expect(result.details).toEqual({
			question: "Q1?",
			options: ["Option A"],
			multi: false,
			selectedOptions: ["Option A"],
			customInput: undefined,
			note: "My Custom Note",
			timedOut: undefined,
		});
	});

	it("does not emit terminal notifications for non-terminal prompt surfaces", async () => {
		const sendNotification = spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		const askDialog = vi.fn().mockResolvedValue({
			kind: "submit",
			results: [
				{
					id: "storage",
					question: "Storage?",
					options: ["SQLite", "PostgreSQL"],
					multi: false,
					selectedOptions: ["PostgreSQL"],
				},
			],
		});
		const tool = new AskTool(
			createSession({
				hasUI: false,
				canPromptUser: true,
				settings: Settings.isolated({ "ask.notify": "on" }),
			}),
		);

		try {
			await tool.execute(
				"call-acp-dialog",
				{
					questions: [
						{
							id: "storage",
							question: "Storage?",
							options: [{ label: "SQLite" }, { label: "PostgreSQL" }],
						},
					],
				},
				undefined,
				undefined,
				createContext({ askDialog }),
			);
			expect(sendNotification).not.toHaveBeenCalled();
		} finally {
			sendNotification.mockRestore();
		}
	});

	it("aborts and throws ToolAbortError when askDialog returns undefined", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const askDialog = vi.fn().mockResolvedValue(undefined);
		const context = createContext({ askDialog, abort });

		await expect(
			tool.execute(
				"call-rich-dialog-cancel",
				{
					questions: [{ id: "q1", question: "Q1?", options: [{ label: "Option A" }] }],
				},
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow(ToolAbortError);

		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("accepts an empty multi-select submission instead of aborting", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const askDialog = vi.fn().mockResolvedValue({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Choose?",
					options: ["A", "B"],
					multi: true,
					selectedOptions: [],
					customInput: undefined,
					timedOut: undefined,
				},
			],
		});
		const context = createContext({ askDialog, abort });

		const result = await tool.execute(
			"call-empty-multi",
			{
				questions: [{ id: "q1", question: "Choose?", options: [{ label: "A" }, { label: "B" }], multi: true }],
			},
			undefined,
			undefined,
			context,
		);

		expect(abort).not.toHaveBeenCalled();
		expect(result.details?.selectedOptions).toEqual([]);
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type === "text") {
			expect(stripAnsi(result.content[0].text)).toContain("User did not select any options");
		}
	});

	it("formats an empty multi-select answer in a multi-question response as an empty selection", async () => {
		const tool = new AskTool(createSession());
		const askDialog = vi.fn().mockResolvedValue({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Choose any?",
					options: ["A", "B"],
					multi: true,
					selectedOptions: [],
				},
				{
					id: "q2",
					question: "Choose one?",
					options: ["C", "D"],
					multi: false,
					selectedOptions: ["C"],
				},
			],
		});

		const result = await tool.execute(
			"call-empty-multi-among-many",
			{
				questions: [
					{ id: "q1", question: "Choose any?", options: [{ label: "A" }, { label: "B" }], multi: true },
					{ id: "q2", question: "Choose one?", options: [{ label: "C" }, { label: "D" }] },
				],
			},
			undefined,
			undefined,
			createContext({ askDialog }),
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type === "text") {
			expect(stripAnsi(result.content[0].text)).toBe("User answers:\nq1: []\nq2: C");
		}
	});

	it("returns chat redirect result when askDialog returns kind chat", async () => {
		const tool = new AskTool(createSession());
		const abort = vi.fn();
		const askDialog = vi.fn().mockResolvedValue({ kind: "chat" });
		const context = createContext({ askDialog, abort });

		const result = await tool.execute(
			"call-rich-dialog-chat",
			{
				questions: [{ id: "q1", question: "Q1?", options: [{ label: "Option A" }] }],
			},
			undefined,
			undefined,
			context,
		);

		expect(abort).not.toHaveBeenCalled();
		expect(result.details).toEqual({ chatRedirect: true, questions: ["Q1?"] });
		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { text: string }).text).toContain("chat about this");
	});

	it("ignores preview and header in degraded select path", async () => {
		const tool = new AskTool(createSession());
		const select = vi.fn().mockResolvedValue("Option A");
		const context = createContext({ select });

		await tool.execute(
			"call-degraded",
			{
				questions: [
					{
						id: "q1",
						question: "Q1?",
						header: "Chip Header",
						options: [{ label: "Option A", description: "Desc A", preview: "My Preview" }],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(select).toHaveBeenCalledTimes(1);
		// verify preview/header are NOT forwarded to select options
		expect(select.mock.calls[0][1]).toEqual([{ label: "Option A", description: "Desc A" }, "Other (type your own)"]);
	});

	it("rejects reserved-label collision in parameters validation", async () => {
		const tool = new AskTool(createSession());

		const valid = tool.parameters({
			questions: [{ id: "q1", question: "Q?", options: [{ label: "ok" }] }],
		});
		expect(valid instanceof type.errors).toBe(false);

		const reservedOther = tool.parameters({
			questions: [{ id: "q1", question: "Q?", options: [{ label: "Other (type your own)" }] }],
		});
		expect(reservedOther instanceof type.errors).toBe(true);

		const reservedChat = tool.parameters({
			questions: [{ id: "q1", question: "Q?", options: [{ label: "Chat about this" }] }],
		});
		expect(reservedChat instanceof type.errors).toBe(true);

		const reservedNext = tool.parameters({
			questions: [{ id: "q1", question: "Q?", options: [{ label: "Next →" }] }],
		});
		expect(reservedNext instanceof type.errors).toBe(true);
	});
});

describe("AskTool carriage-return sanitization", () => {
	it("strips \\r runs from dialog input and result echo (GLM-style degenerate JSON strings)", async () => {
		const tool = new AskTool(createSession());
		let captured: ExtensionAskDialogQuestion[] = [];
		const context = createContext({
			askDialog: async questions => {
				captured = questions;
				return {
					kind: "submit",
					results: [
						{
							id: "q3a",
							question: "Q3 A  —  Fallback  path .  What  happens ?",
							options: ["Abort   +  log", "Continue  anyway"],
							multi: false,
							selectedOptions: ["Abort   +  log"],
						},
					],
				};
			},
		});
		const result = await tool.execute(
			"call-cr-sanitize",
			{
				questions: [
					{
						id: "q3a",
						question: "Q3\r\rA\r\r —\r\r Fallback\r\r path\r\r.\r\r What\r\r happens\r\r?",
						header: "Fallback\r\r path",
						options: [
							{
								label: "Abort\r\r \r\r+\r\r log",
								description: "The\r\r worker\r\r pool\r\r sees\r\r nothing\r\r.",
								preview: 'idle\r\r loop\r\r:\r\n\r\r \r\r if\r\r "done"\r\r in\r\r state',
							},
							{ label: "Continue\r\r anyway" },
						],
					},
				],
			},
			undefined,
			undefined,
			context,
		);

		expect(captured).toHaveLength(1);
		const [dialogQuestion] = captured;
		expect(dialogQuestion?.question).toBe("Q3 A  —  Fallback  path .  What  happens ?");
		expect(dialogQuestion?.header).toBe("Fallback  path");
		expect(dialogQuestion?.options[0]?.label).toBe("Abort   +  log");
		expect(dialogQuestion?.options[0]?.description).toBe("The  worker  pool  sees  nothing .");
		expect(dialogQuestion?.options[0]?.preview).toBe('idle  loop :\n    if  "done"  in  state');
		expect(JSON.stringify(captured)).not.toContain("\r");

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") throw new Error("Expected text result");
		expect(result.content[0].text).toContain("User selected: Abort   +  log");
		expect(result.content[0].text).not.toContain("\r");
	});
	it("fails closed when sanitization collapses a label into a reserved runtime label", async () => {
		const tool = new AskTool(createSession());
		const askDialog = vi.fn(async () => undefined);
		const context = createContext({ askDialog: askDialog as never });
		// Raw args pass schema validation — no literal reserved label — but
		// sanitizing `Other\r(type your own)` forms the exact custom-input
		// sentinel, which would hijack the OTHER_OPTION branch and duplicate
		// the rich dialog row.
		const args = {
			questions: [{ id: "q1", question: "Q?", options: [{ label: "Other\r(type your own)" }] }],
		};
		expect(tool.parameters(args) instanceof type.errors).toBe(false);
		const result = await tool.execute("call-cr-reserved", args, undefined, undefined, context);
		expect(askDialog).not.toHaveBeenCalled();
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") throw new Error("Expected text result");
		expect(result.content[0].text).toContain("reserved runtime labels");
		expect(result.content[0].text).toContain("Other (type your own)");
		expect(result.content[0].text).not.toContain("\r");
	});

	it("sanitizes carriage returns in legacy question text and transcript question ids", async () => {
		const theme = darkTheme;
		const rendered = askToolRenderer.renderCall(
			{
				questions: [{ id: "q\r\r3a", question: "Q3\r\rA?", options: [{ label: "Alpha" }] }],
			} as never,
			{ expanded: true, isPartial: true },
			theme!,
		);
		const text = stripAnsi(rendered.render(120).join("\n"));
		expect(text).toContain("[q 3a]");
		expect(text).toContain("Q3 A?");
		expect(text).not.toContain("\r");

		const legacy = askToolRenderer.renderCall(
			{ question: "Idle\r\rloop?", options: [{ label: "Alpha" }] },
			{ expanded: true, isPartial: false },
			theme!,
		);
		const legacyText = stripAnsi(legacy.render(120).join("\n"));
		expect(legacyText).toContain("Idle loop?");
		expect(legacyText).not.toContain("\r");
	});

	it("fails closed when sanitization merges distinct labels into one", async () => {
		const tool = new AskTool(createSession());
		const askDialog = vi.fn(async () => undefined);
		const context = createContext({ askDialog: askDialog as never });
		// Distinct raw labels, but dialog selection is label-keyed — sanitized,
		// one row would check both and submit duplicates.
		const args = {
			questions: [{ id: "q1", question: "Q?", options: [{ label: "Retry\rnow" }, { label: "Retry now" }] }],
		};
		const result = await tool.execute("call-cr-duplicate", args, undefined, undefined, context);
		expect(askDialog).not.toHaveBeenCalled();
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") throw new Error("Expected text result");
		expect(result.content[0].text).toContain("unique within a question");
		expect(result.content[0].text).toContain("Retry now");
		expect(result.content[0].text).not.toContain("\r");
	});

	it("sanitizes persisted result details so pre-fix transcripts render as prose", async () => {
		const theme = darkTheme;
		// Multi-part branch: `\r`-laden id/question/labels flow into section labels and Markdown.
		const multi = askToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					results: [
						{
							id: "q\r\r3a",
							question: "Q3\r\rA?",
							options: ["Abort\r\rlog", "Continue\r\ranyway"],
							multi: false,
							selectedOptions: ["Abort\r\rlog"],
						},
					],
				},
			},
			{ expanded: true, isPartial: false },
			theme!,
		);
		const multiText = stripAnsi(multi.render(120).join("\n"));
		expect(multiText).toContain("[q 3a]");
		expect(multiText).toContain("Q3 A?");
		expect(multiText).toContain("Abort log");
		expect(multiText).not.toContain("\r");

		// Single-question branch plus user-authored echo fields.
		const single = askToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					question: "Idle\r\rloop?",
					options: ["Alpha"],
					multi: false,
					selectedOptions: ["Alpha"],
					note: "a\r\rnote",
				},
			},
			{ expanded: true, isPartial: false },
			theme!,
		);
		const singleText = stripAnsi(single.render(120).join("\n"));
		expect(singleText).toContain("Idle loop?");
		expect(singleText).toContain("a note");
		expect(singleText).not.toContain("\r");

		// Chat-redirect branch.
		const chat = askToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: { chatRedirect: true, questions: ["Chat\r\rabout?"] },
			},
			{ expanded: true, isPartial: false },
			theme!,
		);
		const chatText = stripAnsi(chat.render(120).join("\n"));
		expect(chatText).toContain("Chat about?");
		expect(chatText).not.toContain("\r");

		// Content-text fallbacks (no details / no question).
		for (const stale of [
			{ content: [{ type: "text", text: "stale\r\rtranscript" }] },
			{ content: [{ type: "text", text: "stale\r\rtranscript" }], details: {} },
		]) {
			const fallback = askToolRenderer.renderResult(stale, { expanded: true, isPartial: false }, theme!);
			const fallbackText = stripAnsi(fallback.render(120).join("\n"));
			expect(fallbackText).toContain("stale transcript");
			expect(fallbackText).not.toContain("\r");
		}
	});

	it("keeps pre-fix colliding selections on their original row", async () => {
		const theme = darkTheme;
		// Pre-fix persisted result: distinct raw options merged by
		// sanitization, only the second selected. Label matching would mark
		// both rows; resolving against the raw labels keeps the marker right.
		const rendered = askToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					results: [
						{
							id: "q1",
							question: "Retry?",
							options: ["Retry\rnow", "Retry now"],
							multi: true,
							selectedOptions: ["Retry now"],
						},
					],
				},
			},
			{ expanded: true, isPartial: false },
			theme!,
		);
		const text = stripAnsi(rendered.render(120).join("\n"));
		expect(text).not.toContain("\r");
		const rows = text.split("\n").filter(line => line.includes("Retry now"));
		expect(rows).toHaveLength(2);
		const checked = theme!.checkbox.checked;
		expect(rows[0]).not.toContain(checked);
		expect(rows[1]).toContain(checked);
	});

	it("keeps every duplicate selection marked on pre-guard replay", async () => {
		const theme = darkTheme;
		// Before the duplicate-label guard, `options: ["A", "A"]` could record
		// both rows selected. Each occurrence must consume a distinct index
		// or replay unmarks history the old renderer showed as checked.
		const rendered = askToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					results: [
						{
							id: "q1",
							question: "Pick?",
							options: ["A", "A"],
							multi: true,
							selectedOptions: ["A", "A"],
						},
					],
				},
			},
			{ expanded: true, isPartial: false },
			theme!,
		);
		const text = stripAnsi(rendered.render(120).join("\n"));
		const checked = theme!.checkbox.checked;
		const unchecked = theme!.checkbox.unchecked;
		const rows = text.split("\n").filter(line => line.includes(checked) || line.includes(unchecked));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain(checked);
		expect(rows[1]).toContain(checked);
	});

	it("fails closed when sanitization merges distinct question ids", async () => {
		const tool = new AskTool(createSession());
		const askDialog = vi.fn(async () => undefined);
		const context = createContext({ askDialog: askDialog as never });
		// Distinct raw ids, but multi-question answers echo `id: ...` lines
		// the model uses to correlate — merged ids would be unanswerable.
		const args = {
			questions: [
				{ id: "deploy\rmode", question: "Deploy?", options: [{ label: "Yes" }] },
				{ id: "deploy mode", question: "Really?", options: [{ label: "No" }] },
			],
		};
		const result = await tool.execute("call-cr-id-collision", args, undefined, undefined, context);
		expect(askDialog).not.toHaveBeenCalled();
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") throw new Error("Expected text result");
		expect(result.content[0].text).toContain("question ids must be unique");
		expect(result.content[0].text).toContain("deploy mode");
		expect(result.content[0].text).not.toContain("\r");
	});

	it("marks every duplicate row for a single persisted occurrence", async () => {
		const theme = darkTheme;
		// The legacy selector recorded one occurrence for duplicate rows it
		// marked together; the old label-keyed renderer showed both checked,
		// so replay must too — not just the first index.
		const rendered = askToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					results: [
						{
							id: "q1",
							question: "Pick?",
							options: ["A", "A"],
							multi: true,
							selectedOptions: ["A"],
						},
					],
				},
			},
			{ expanded: true, isPartial: false },
			theme!,
		);
		const text = stripAnsi(rendered.render(120).join("\n"));
		const checked = theme!.checkbox.checked;
		const unchecked = theme!.checkbox.unchecked;
		const rows = text.split("\n").filter(line => line.includes(checked) || line.includes(unchecked));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain(checked);
		expect(rows[1]).toContain(checked);
	});

	it("expands tabs and clamps long values in validation errors", async () => {
		const tool = new AskTool(createSession());
		const askDialog = vi.fn(async () => undefined);
		const context = createContext({ askDialog: askDialog as never });
		// Degenerate duplicate values echo through the plain Text fallback
		// renderer — raw tabs or kilobytes of text would corrupt the frame.
		const dupe = `Tab\there${"\t".repeat(40)}${"x".repeat(500)}`;
		const args = {
			questions: [{ id: "q1", question: "Q?", options: [{ label: dupe }, { label: dupe }] }],
		};
		const result = await tool.execute("call-cr-error-value", args, undefined, undefined, context);
		expect(askDialog).not.toHaveBeenCalled();
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") throw new Error("Expected text result");
		const text = result.content[0].text;
		expect(text).toContain("unique within a question");
		expect(text).not.toContain("\t");
		expect(text).not.toContain("\r");
		expect(text.length).toBeLessThan(250);
	});

	it("preserves suffixed labels through the degraded selector", async () => {
		const tool = new AskTool(createSession());
		// `Use cache\r(Recommended)` sanitizes to a label ending with the
		// recommendation suffix; mapping the displayed choice back by
		// stripping would corrupt it to `Use cache`.
		const select = vi.fn(async (_prompt: string, options: ExtensionUISelectItem[]) => {
			const selected = options[0];
			return typeof selected === "string" ? selected : selected?.label;
		});
		const context = createContext({ select });
		const result = await tool.execute(
			"call-cr-suffix",
			{
				questions: [
					{
						id: "q1",
						question: "Cache?",
						options: [{ label: "Use cache\r(Recommended)" }, { label: "Fetch anew" }],
						recommended: 0,
					},
				],
			},
			undefined,
			undefined,
			context,
		);
		expect(result.details?.selectedOptions).toEqual(["Use cache (Recommended)"]);
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") throw new Error("Expected text result");
		expect(result.content[0].text).toContain("Use cache (Recommended)");
		expect(result.content[0].text).not.toContain("\r");
	});

	it("disambiguates badged rows in the degraded selector", async () => {
		const tool = new AskTool(createSession());
		// Recommended `Retry\rnow` badges to `Retry now (Recommended)`,
		// colliding with the literal second option — rows must stay distinct
		// and the second row must map back to its own original.
		const select = vi.fn(async (_prompt: string, options: ExtensionUISelectItem[]) => {
			const labels = options.map(selectItemLabel);
			expect(labels.slice(0, 2)).toEqual(["Retry now (Recommended)", "Retry now (Recommended) (2)"]);
			return "Retry now (Recommended) (2)";
		});
		const context = createContext({ select });
		const result = await tool.execute(
			"call-cr-degraded-badge",
			{
				questions: [
					{
						id: "q1",
						question: "Retry?",
						options: [{ label: "Retry\rnow" }, { label: "Retry now (Recommended)" }],
						recommended: 0,
					},
				],
			},
			undefined,
			undefined,
			context,
		);
		expect(result.details?.selectedOptions).toEqual(["Retry now (Recommended)"]);
	});

	it("fails closed when a label sanitizes to the multi-select Done action", async () => {
		const tool = new AskTool(createSession());
		const select = vi.fn(async () => "unreached");
		const context = createContext({ select });
		// The degraded Done row is theme-labeled and conditional, but the
		// choice handler matches it unconditionally — a sanitized model
		// label would exit instead of selecting.
		const args = {
			questions: [
				{
					id: "q1",
					question: "Q?",
					options: [{ label: `${theme.status.success}\rDone selecting` }, { label: "Other" }],
					multi: true,
				},
			],
		};
		const result = await tool.execute("call-cr-done", args, undefined, undefined, context);
		expect(select).not.toHaveBeenCalled();
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") throw new Error("Expected text result");
		expect(result.content[0].text).toContain("reserved runtime labels");
		expect(result.content[0].text).not.toContain("\r");
	});
});
