import { beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentToolContext } from "@pk-nerdsaver-ai/pi-agent-core";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import type { ExtensionUISelectItem } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions";
import { getThemeByName, initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { AskTool, askToolRenderer } from "@pk-nerdsaver-ai/pi-coding-agent/tools/ask";
import { ToolAbortError } from "@pk-nerdsaver-ai/pi-coding-agent/tools/tool-errors";

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function createContext(args: {
	select: (
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
	abort?: () => void;
}): AgentToolContext {
	// AgentToolContext includes many runtime fields; tests only need UI + abort behavior.
	return {
		hasUI: true,
		ui: {
			select: args.select,
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

beforeAll(async () => {
	await initTheme(false);
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
				const timeout = dialogOptions?.timeout ?? 1;
				await Bun.sleep(timeout + 5);
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
				const timeout = dialogOptions?.timeout ?? 1;
				await Bun.sleep(timeout + 5);
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
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
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

		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
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

		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
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

		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
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
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
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
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
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
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
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
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
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
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
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
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
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
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
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
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
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
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
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
