import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { Container, getKeybindings, setKeybindings, TUI } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import * as terminalMultiplexer from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { getEditorTheme, initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { HookSelectorComponent } from "@oh-my-pi/pi-tui/overlays/hook-selector";
import type {
	ExtensionCustomOptions,
	ExtensionUIContext,
	ExtensionUiComponent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { CopySelectorComponent } from "@oh-my-pi/pi-tui/overlays/copy-selector";
import { AnnotationOverlay } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import type { SessionPick } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/text-source";
import {
	AnnotateCommand,
	runAnnotateCommand,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate";
import {
	showCodeReviewOverlay,
	showTextReviewOverlay,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/fullscreen";
import * as externalEditor from "@oh-my-pi/pi-coding-agent/utils/external-editor";
import type {
	CustomCommandAPI,
	CustomCommandContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { ReviewPrRef } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review";
import {
	createResolvedReviewTarget,
	type ResolvedReviewTarget,
	type ReviewTargetUI,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review/target";
import { buildTextReviewPrompt } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/text-review";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type {
	CodeReviewAnnotation,
	TextReviewAnnotation,
	TextReviewSource,
	TextReviewOverlayResult,
} from "@oh-my-pi/pi-tui/overlays/annotation-types";
import * as gh from "@oh-my-pi/pi-coding-agent/tools/gh";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "../../../src/modes/types";
import { VirtualRenderScheduler } from "../../../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";
import type { TerminalLaunchRequest, TerminalLaunchResult } from "../../../src/subprocess/terminal-launch";

const ENTER = "\r";
const UP = "\x1b[A";
const RIGHT = "\x1b[C";
const CTRL_E = "\x05";

const SAMPLE_DIFF = `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -1 +1 @@
-const value = 1;
+const value = 2;
`;

const API = { cwd: "/workspace" } as unknown as CustomCommandAPI;

interface ContextOptions {
	selectResults?: Array<string | undefined>;
	branch?: SessionMessageEntry[];
	cwd?: string;
	customKeys?: readonly string[];
	customResult?: unknown;
	inputResult?: string | undefined;
	editorResult?: string | undefined;
}

function createContext(options: ContextOptions = {}) {
	const selectResults = [...(options.selectResults ?? [])];
	const branch = options.branch ?? [];
	const select = vi.fn(async (_title: string, _choices: string[]) => selectResults.shift());
	const input = vi.fn(async (_title: string) => options.inputResult);
	const editor = vi.fn(async (_title: string, _placeholder?: string) => options.editorResult);
	const pasteToEditor = vi.fn((_text: string) => undefined);
	const notify = vi.fn((_message: string, _type?: "info" | "warning" | "error") => undefined);
	const setStatus = vi.fn((_key: string, _text: string | undefined) => undefined);
	const pickedSelections: SessionPick[] = [];
	let customCalls = 0;
	const custom: ExtensionUIContext["custom"] = async <T>(
		factory: (
			tui: TUI,
			uiTheme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => ExtensionUiComponent | Promise<ExtensionUiComponent>,
		_options?: ExtensionCustomOptions,
	): Promise<T> => {
		customCalls++;
		const terminal = new VirtualTerminal(120, 30);
		const tui = new TUI(terminal);
		const completion = Promise.withResolvers<T>();
		const done = (result: T): void => {
			if (typeof result === "object" && result !== null && "entry" in result && "content" in result) {
				pickedSelections.push(result as unknown as SessionPick);
			}
			completion.resolve(result);
		};
		const component = await factory(tui, theme, KeybindingsManager.inMemory(), done);
		if (component instanceof CopySelectorComponent) {
			component.render(120);
			for (const key of options.customKeys ?? [ENTER]) component.handleInput?.(key);
		} else {
			if (options.customResult === undefined) throw new Error("test custom result missing");
			done(options.customResult as T);
		}
		component.dispose?.();
		return completion.promise;
	};
	const ctx = {
		hasUI: true,
		cwd: options.cwd ?? "/workspace",
		sessionManager: {
			getBranch: () => branch,
			getCwd: () => options.cwd ?? "/workspace",
			getSessionId: () => "session-1",
		},
		ui: { select, input, editor, custom, pasteToEditor, notify, setStatus },
	} as unknown as CustomCommandContext;
	return {
		ctx,
		select,
		pasteToEditor,
		input,
		editor,
		notify,
		setStatus,
		pickedSelections,
		customCalls: () => customCalls,
	};
}

function makeUserEntry(id: string, content: string, parentId: string | null = null): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-09-20T00:00:00.000Z",
		message: { role: "user", content, timestamp: 1 } as AgentMessage,
	};
}

function makeAssistantEntry(
	id: string,
	text: string,
	parentId = "user",
	toolCallCommand?: string,
): SessionMessageEntry {
	const content =
		toolCallCommand === undefined
			? [{ type: "text" as const, text }]
			: [{ type: "toolCall" as const, id: `${id}-call`, name: "bash", arguments: { command: toolCallCommand } }];
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-09-20T00:00:00.000Z",
		message: {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 2,
		} as unknown as AgentMessage,
	};
}

function localTarget(): ResolvedReviewTarget {
	return createResolvedReviewTarget("uncommitted", "Uncommitted changes", SAMPLE_DIFF, "No uncommitted changes");
}

function messageWithEditorFile(filePath: string, text = "frozen selected excerpt"): TextReviewSource {
	return {
		id: "session-message",
		kind: "message",
		label: "Selected session message",
		text,
		provenance: { kind: "session", entryId: "session-message" },
		editorFilePath: filePath,
	};
}

/**
 * Mounts a real annotation overlay with the external-editor key remapped to Ctrl+E, feeds
 * `keys`, and resolves with whatever it completed. After each key it yields one macrotask so
 * the microtask chain of an already-resolved mocked editor finishes before the next key.
 */
async function driveEditorOverlay<T>(
	cwd: string,
	keys: readonly string[],
	show: (ctx: CustomCommandContext) => Promise<T | undefined>,
	uiOverrides: Partial<Pick<ExtensionUIContext, "openTerminal" | "confirm" | "notify">> = {},
	onComponent?: (component: ExtensionUiComponent) => void,
	tuiLifecycle: Partial<Pick<TUI, "stop" | "start" | "requestRender">> = {},
): Promise<T | undefined> {
	const previous = getKeybindings();
	setKeybindings(KeybindingsManager.inMemory({ "app.editor.external": "ctrl+e" }));
	const tui = {
		terminal: { rows: 40 },
		requestRender() {},
		stop() {},
		start() {},
		...tuiLifecycle,
	} as unknown as TUI;
	const ctx = {
		cwd,
		sessionManager: { getCwd: () => cwd },
		ui: {
			notify: vi.fn(),
			custom: async (factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
				let result: unknown;
				const component = await factory(tui, theme, KeybindingsManager.inMemory(), value => {
					result = value;
				});
				component.render(120);
				for (const key of keys) {
					component.handleInput?.(key);
					await new Promise<void>(resolve => setImmediate(resolve));
					component.render(120);
					onComponent?.(component);
				}
				return result;
			},
			...uiOverrides,
		},
	} as unknown as CustomCommandContext;
	try {
		return await show(ctx);
	} finally {
		setKeybindings(previous);
	}
}

function overlayText(component: ExtensionUiComponent): string | undefined {
	if (!("textSourceText" in component) || typeof component.textSourceText !== "function") return undefined;
	const text = component.textSourceText();
	return typeof text === "string" ? text : undefined;
}

async function settleExternalAction(action: Promise<unknown>): Promise<void> {
	await action;
	await new Promise<void>(resolve => setImmediate(resolve));
}

function countOccurrences(text: string, value: string): number {
	return value ? text.split(value).length - 1 : 0;
}

async function withTempDir<T>(callback: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "annotate-contract-"));
	try {
		return await callback(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("/annotate contracts", () => {
	it("resolves the selected local target in the live session cwd and pastes code notes without submitting", async () => {
		const { ctx, select, pasteToEditor } = createContext({
			selectResults: ["Code review", "2. Review uncommitted changes"],
			cwd: "/live-worktree",
		});
		const target = localTarget();
		const resolveLocalReviewTarget = vi.fn(
			async (kind: "base-branch" | "uncommitted" | "commit", cwd: string, _ui: ReviewTargetUI) => {
				expect(kind).toBe("uncommitted");
				expect(cwd).toBe("/live-worktree");
				return target;
			},
		);
		const annotation: CodeReviewAnnotation = {
			scope: "file",
			path: "src/value.ts",
			occurrence: 1,
			note: "paste this code-review note",
		};
		const showCodeReviewOverlay = vi.fn(async () => ({
			action: "paste" as const,
			annotations: [annotation],
		}));

		const result = await runAnnotateCommand(API, "", ctx, {
			resolveLocalReviewTarget,
			showCodeReviewOverlay,
		});

		expect(result).toBeUndefined();
		expect(select).toHaveBeenCalledTimes(2);
		expect(resolveLocalReviewTarget).toHaveBeenCalledTimes(1);
		expect(showCodeReviewOverlay).toHaveBeenCalledTimes(1);
		expect(showCodeReviewOverlay).toHaveBeenCalledWith(ctx, target);
		expect(pasteToEditor).toHaveBeenCalledTimes(1);
		expect(pasteToEditor.mock.calls[0]?.[0]).toContain(annotation.note);
	});

	it("resolves a PR picked from the open pull request list in the live session repo", async () => {
		const { ctx, pasteToEditor } = createContext({
			selectResults: ["Code review", "4. Review a specific PR", "#42  Fix login  @octocat"],
			cwd: "/live-worktree",
		});
		const repoSpy = spyOn(gh, "resolveDefaultRepoMemoized").mockResolvedValue("acme/project");
		spyOn(github, "json").mockResolvedValue([{ number: 42, title: "Fix login", author: { login: "octocat" } }]);
		const target = createResolvedReviewTarget("pr", "PR acme/project#42", SAMPLE_DIFF, "PR has no diff");
		const resolvePrReviewTarget = vi.fn(
			async (_cwd: string, _ctx: CustomCommandContext, _ref: ReviewPrRef) => target,
		);
		const showCodeReviewOverlay = vi.fn(async () => ({
			action: "paste" as const,
			annotations: [{ scope: "file" as const, path: "src/value.ts", occurrence: 1, note: "picked PR note" }],
		}));

		await runAnnotateCommand(API, "", ctx, { resolvePrReviewTarget, showCodeReviewOverlay });

		expect(repoSpy).toHaveBeenCalledWith("/live-worktree");
		expect(resolvePrReviewTarget).toHaveBeenCalledTimes(1);
		expect(resolvePrReviewTarget.mock.calls[0]?.[0]).toBe("/live-worktree");
		expect(resolvePrReviewTarget.mock.calls[0]?.[2]).toMatchObject({ repo: "acme/project", number: 42 });
		expect(showCodeReviewOverlay).toHaveBeenCalledWith(ctx, target);
		expect(pasteToEditor.mock.calls[0]?.[0]).toContain("picked PR note");
	});

	it("freezes an explicit PR target before opening the overlay and keeps PR annotations and context exact", async () => {
		const { ctx, pasteToEditor } = createContext();
		const prUrl = "https://github.com/acme/project/pull/42";
		const contextInstruction =
			"MUST NOT read local workspace files for PR file context; use the fetched PR diff only";
		const target = createResolvedReviewTarget("pr", "PR acme/project#42", SAMPLE_DIFF, "PR has no diff", {
			diffInstruction: "MUST read the fetched PR diff",
			contextInstruction,
		});
		const exactNote = "exact annotation note: preserve once";
		const annotation: CodeReviewAnnotation = {
			scope: "line",
			path: "src/value.ts",
			occurrence: 1,
			hunkHeader: "@@ -1 +1 @@",
			oldLine: 1,
			newLine: 1,
			rawLine: "+const value = 2;",
			note: exactNote,
		};
		const resolvePrReviewTarget = vi.fn(async (cwd: string, _ctx: CustomCommandContext, ref: ReviewPrRef) => {
			expect(cwd).toBe("/workspace");
			expect(ref.repo).toBe("acme/project");
			expect(ref.number).toBe(42);
			return target;
		});
		const showCodeReviewOverlay = vi.fn(async () => ({
			action: "review" as const,
			annotations: [annotation],
		}));

		const prompt = await runAnnotateCommand(API, `code-review ${prUrl} focus on this line`, ctx, {
			resolvePrReviewTarget,
			showCodeReviewOverlay,
		});

		expect(prompt).toBeDefined();
		expect(resolvePrReviewTarget).toHaveBeenCalledTimes(1);
		expect(showCodeReviewOverlay).toHaveBeenCalledTimes(1);
		expect(showCodeReviewOverlay).toHaveBeenCalledWith(ctx, target);
		expect(prompt).toContain(contextInstruction);
		expect(prompt).not.toContain("MAY read full file context as needed via `read`");
		expect(countOccurrences(prompt!, "focus on this line")).toBe(1);
		expect(countOccurrences(prompt!, exactNote)).toBe(1);
		expect(prompt).toContain(SAMPLE_DIFF.trim());
		expect(pasteToEditor).not.toHaveBeenCalled();
	});

	it("pastes the latest reply as a text annotation and never auto-submits it", async () => {
		const latestText = "The latest answer";
		const { ctx, pasteToEditor } = createContext({
			branch: [makeAssistantEntry("latest", latestText)],
		});
		const note = "text note for the editor";
		const showTextReviewOverlay = vi.fn(async () => ({
			action: "paste" as const,
			annotations: [{ scope: "text" as const, note }],
		}));

		const result = await runAnnotateCommand(API, "last", ctx, { showTextReviewOverlay });

		expect(result).toBeUndefined();
		expect(pasteToEditor).toHaveBeenCalledTimes(1);
		expect(pasteToEditor.mock.calls[0]?.[0]).toContain(note);
		expect(pasteToEditor.mock.calls[0]?.[0]).not.toContain(latestText);
	});

	it("uses the native selector for a whole session message and preserves its entry without a block", async () => {
		const wholeText = "The selected answer, including exact spacing.";
		const assistant = makeAssistantEntry("assistant-whole", wholeText);
		const { ctx, pasteToEditor, pickedSelections, customCalls } = createContext({
			branch: [makeUserEntry("user-whole", "preserve this"), assistant],
			customKeys: [ENTER],
		});
		const note = "whole-message note";
		const showTextReviewOverlay = vi.fn(async (_ctx: CustomCommandContext, source: TextReviewSource) => {
			expect(source.kind).toBe("message");
			expect(source.text).toBe(wholeText);
			return { action: "paste" as const, annotations: [{ scope: "text" as const, note }] };
		});

		const result = await runAnnotateCommand(API, "session", ctx, { showTextReviewOverlay });

		expect(result).toBeUndefined();
		expect(customCalls()).toBe(1);
		expect(pickedSelections).toHaveLength(1);
		expect(pickedSelections[0]?.entry).toBe(assistant);
		expect(pickedSelections[0]?.block).toBeUndefined();
		expect(pasteToEditor.mock.calls[0]?.[0]).toContain(note);
	});

	it("uses the native selector for an exact code block and bypasses source summarization", async () => {
		const code = `const value = "exact";\n${"return value;\n".repeat(280)}`;
		const assistant = makeAssistantEntry("assistant-code", `Before\n\`\`\`ts\n${code}\n\`\`\`\nAfter`);
		const { ctx, pasteToEditor, pickedSelections } = createContext({
			branch: [makeUserEntry("user-code", "select the code"), assistant],
			customKeys: [RIGHT, ENTER],
		});
		const note = "code note";
		const generateTextReviewContextSummary = vi.fn(async () => {
			throw new Error("code sources must not request a summary");
		});
		const showTextReviewOverlay = vi.fn(async (_ctx: CustomCommandContext, source: TextReviewSource) => {
			expect(source.kind).toBe("code");
			expect(source.text).toBe(code);
			return { action: "paste" as const, annotations: [{ scope: "text" as const, note }] };
		});

		const result = await runAnnotateCommand(API, "session", ctx, {
			showTextReviewOverlay,
			generateTextReviewContextSummary,
		});

		expect(result).toBeUndefined();
		expect(pickedSelections[0]?.entry).toBe(assistant);
		expect(pickedSelections[0]?.block?.content).toBe(code);
		expect(pickedSelections[0]?.block?.kind).toBe("code");
		expect(generateTextReviewContextSummary).not.toHaveBeenCalled();
		expect(countOccurrences(pasteToEditor.mock.calls[0]?.[0] ?? "", code)).toBe(1);
	});
	it("selects a long assistant bash command as a command source without summarizing it", async () => {
		const longCommand = `printf 'native-command-marker'\n${"printf 'long command line'\n".repeat(280)}`;
		const assistant = makeAssistantEntry("assistant-command", "Running the command.", "user-command", longCommand);
		const { ctx, pasteToEditor, pickedSelections } = createContext({
			branch: [makeUserEntry("user-command", "run this"), assistant],
			customKeys: [RIGHT, ENTER],
		});
		const generateTextReviewContextSummary = vi.fn(async () => {
			throw new Error("command sources must not request a summary");
		});
		const note = "general command note";
		const showTextReviewOverlay = vi.fn(async (_ctx: CustomCommandContext, source: TextReviewSource) => {
			expect(source.kind).toBe("command");
			expect(source.text).toBe(longCommand);
			return { action: "paste" as const, annotations: [{ scope: "text" as const, note }] };
		});

		const result = await runAnnotateCommand(API, "session", ctx, {
			showTextReviewOverlay,
			generateTextReviewContextSummary,
		});

		expect(result).toBeUndefined();
		expect(pickedSelections[0]?.entry).toBe(assistant);
		expect(pickedSelections[0]?.block?.content).toBe(longCommand);
		expect(pickedSelections[0]?.block?.kind).toBe("command");
		expect(generateTextReviewContextSummary).not.toHaveBeenCalled();
		const prompt = pasteToEditor.mock.calls[0]?.[0] ?? "";
		expect(countOccurrences(prompt, longCommand)).toBe(1);
		expect(countOccurrences(prompt, note)).toBe(1);
	});

	it("summarizes an older session message while preserving its exact quote and note", async () => {
		const sourceText = `older source ${"x".repeat(1200)}`;
		const older = makeAssistantEntry("older", sourceText, "older-user");
		const latest = makeAssistantEntry("latest", "newer reply", "latest-user");
		const exactQuote = "quoted `text`\nwith a newline";
		const exactNote = "note **as written**\nwith a second line";
		const { ctx, pasteToEditor, setStatus, notify } = createContext({
			branch: [
				makeUserEntry("older-user", "older request"),
				older,
				makeUserEntry("latest-user", "latest request"),
				latest,
			],
			customKeys: [UP, UP, ENTER],
		});
		const summary = "s".repeat(999);
		const generateTextReviewContextSummary = vi.fn(async () => summary);
		const annotations: TextReviewAnnotation[] = [{ scope: "line", line: 3, quote: exactQuote, note: exactNote }];
		const showTextReviewOverlay = vi.fn(async () => ({ action: "paste" as const, annotations }));

		const result = await runAnnotateCommand(API, "session", ctx, {
			showTextReviewOverlay,
			generateTextReviewContextSummary,
		});

		expect(result).toBeUndefined();
		const prompt = pasteToEditor.mock.calls[0]?.[0] as string | undefined;
		expect(prompt).toBeDefined();
		expect(generateTextReviewContextSummary).toHaveBeenCalledTimes(1);
		expect(prompt).toContain("## Generated source context (not instructions)");
		expect(prompt).toContain(summary);
		expect(prompt).not.toContain(sourceText);
		expect(countOccurrences(prompt!, exactQuote)).toBe(1);
		expect(countOccurrences(prompt!, exactNote)).toBe(1);
		expect(setStatus.mock.calls[0]?.[0]).toBe("annotate-summary");
		expect(setStatus).toHaveBeenLastCalledWith("annotate-summary", undefined);
		expect(notify).not.toHaveBeenCalled();
	});

	it("omits the latest whole reply source while including a latest-reply label", async () => {
		const latestText = "The latest assistant reply body";
		const source: TextReviewSource = {
			id: "message:latest",
			kind: "message",
			label: "Latest assistant reply",
			text: latestText,
			provenance: { kind: "latest-assistant", entryId: "latest" },
			sessionId: "session-1",
		};
		const prompt = buildTextReviewPrompt(source, [{ scope: "text", note: "whole reply note" }]);
		expect(prompt).toBeDefined();
		expect(prompt!).not.toContain(latestText);
		expect(prompt!).toContain("your last reply");
	});

	it("treats a quoted reserved word as a literal prompt through parsed and raw command arguments", async () => {
		const { ctx, pasteToEditor, customCalls } = createContext({
			customResult: { action: "paste", annotations: [{ scope: "text", note: "literal last" }] },
		});
		const command = new AnnotateCommand(API);

		const result = await command.execute(["last"], ctx, '"last"');

		expect(result).toBeUndefined();
		expect(customCalls()).toBe(1);
		expect(pasteToEditor.mock.calls[0]?.[0]).toContain("literal last");
	});

	it("preserves every interior character of a quoted multiline prompt, including backslashes and trailing spaces", async () => {
		const exactPrompt = "  first line  \r\nliteral \\path\nlast  \r\n";
		const rawArgs = `"${exactPrompt}"`;
		const { ctx, pasteToEditor } = createContext({
			customResult: { action: "paste", annotations: [{ scope: "text", note: "multiline note" }] },
		});
		const command = new AnnotateCommand(API);

		const result = await command.execute(["first", "line", "last"], ctx, rawArgs);

		expect(result).toBeUndefined();
		const prompt = pasteToEditor.mock.calls[0]?.[0] as string | undefined;
		expect(prompt).toContain(exactPrompt);
		expect(prompt).toContain("multiline note");
	});

	it("reads a relative path with spaces through the central resolver, retaining CRLF and trailing newline", async () => {
		await withTempDir(async directory => {
			const relativePath = "nested folder/exact source file.txt";
			const fileText = `first line\r\nsecond line\r\n${"x".repeat(1200)}\r\n`;
			await mkdir(join(directory, "nested folder"), { recursive: true });
			await writeFile(join(directory, relativePath), fileText, "utf8");
			const api = { ...API, cwd: directory } as unknown as CustomCommandAPI;
			const { ctx, pasteToEditor, notify } = createContext({
				cwd: directory,
				customResult: { action: "paste", annotations: [{ scope: "text", note: "file note" }] },
			});
			const command = new AnnotateCommand(api);

			const result = await command.execute(relativePath.split(/\s+/), ctx, relativePath);

			expect(result).toBeUndefined();
			expect(notify).not.toHaveBeenCalled();
			const prompt = pasteToEditor.mock.calls[0]?.[0] as string | undefined;
			expect(prompt).toBeDefined();
			expect(countOccurrences(prompt!, fileText)).toBe(1);
		});
	});

	it("completes spaced file paths from the live cwd without quotes and keeps quoted text literal", async () => {
		await withTempDir(async directory => {
			const relativePath = "nested folder/source file.txt";
			await mkdir(join(directory, "nested folder"), { recursive: true });
			await writeFile(join(directory, relativePath), "completion source", "utf8");
			// The load-time API cwd is stale; completions must follow the live cwd argument.
			const command = new AnnotateCommand(API);

			const empty = await command.getArgumentCompletions("", directory);
			expect(empty?.map(item => item.label)).toEqual([
				"last",
				"session",
				"code-review",
				"<file path>",
				'"prompt text"',
			]);

			const partial = await command.getArgumentCompletions("se", directory);
			expect(partial?.map(item => item.label)).toEqual(["session"]);

			const fileMatches = await command.getArgumentCompletions("./nested folder/source", directory);
			expect(fileMatches?.map(item => item.value)).toContain("./nested folder/source file.txt");
			expect(fileMatches?.every(item => !item.value.startsWith('"'))).toBe(true);

			const literalMatches = await command.getArgumentCompletions('"nested folder/source', directory);
			expect(literalMatches?.map(item => item.value)).toEqual(['"nested folder/source"']);
			expect(literalMatches?.some(item => item.value.includes("source file.txt"))).toBe(false);
			const whitespaceLiteralMatches = await command.getArgumentCompletions('  "nested folder/source', directory);
			expect(whitespaceLiteralMatches?.map(item => item.value)).toEqual(['  "nested folder/source"']);
		});
	});

	it("keeps a long file selected from the source menu verbatim without requesting a model summary", async () => {
		await withTempDir(async directory => {
			const relativePath = "source with spaces.txt";
			const fileText = `menu file\r\n${"preserve this line\r\n".repeat(80)}`;
			await writeFile(join(directory, relativePath), fileText, "utf8");
			const api = { ...API, cwd: directory } as unknown as CustomCommandAPI;
			const { ctx, pasteToEditor } = createContext({
				cwd: directory,
				selectResults: ["File"],
				inputResult: relativePath,
			});
			const generateTextReviewContextSummary = vi.fn(async () => {
				throw new Error("direct files must not request a summary");
			});
			const showTextReviewOverlay = vi.fn(async (_ctx: CustomCommandContext, source: TextReviewSource) => {
				expect(source.kind).toBe("file");
				expect(source.text).toBe(fileText);
				return {
					action: "paste" as const,
					annotations: [{ scope: "text" as const, note: "menu file note" }],
				};
			});

			const result = await runAnnotateCommand(api, "", ctx, {
				showTextReviewOverlay,
				generateTextReviewContextSummary,
			});

			expect(result).toBeUndefined();
			expect(generateTextReviewContextSummary).not.toHaveBeenCalled();
			expect(pasteToEditor.mock.calls[0]?.[0]).toContain(fileText);
		});
	});

	it("keeps a long prompt selected from the source menu verbatim without requesting a model summary", async () => {
		const exactPrompt = `menu prompt\r\n${"preserve this line\r\n".repeat(80)}`;
		const { ctx, pasteToEditor } = createContext({
			selectResults: ["Text prompt"],
			editorResult: exactPrompt,
		});
		const generateTextReviewContextSummary = vi.fn(async () => {
			throw new Error("direct prompts must not request a summary");
		});
		const showTextReviewOverlay = vi.fn(async (_ctx: CustomCommandContext, source: TextReviewSource) => {
			expect(source.kind).toBe("prompt");
			expect(source.text).toBe(exactPrompt);
			return {
				action: "paste" as const,
				annotations: [{ scope: "text" as const, note: "menu prompt note" }],
			};
		});

		const result = await runAnnotateCommand(API, "", ctx, {
			showTextReviewOverlay,
			generateTextReviewContextSummary,
		});

		expect(result).toBeUndefined();
		expect(generateTextReviewContextSummary).not.toHaveBeenCalled();
		expect(pasteToEditor.mock.calls[0]?.[0]).toContain(exactPrompt);
	});

	it("keeps a long direct prompt verbatim without requesting a model summary", async () => {
		const exactPrompt = `direct prompt\n${"preserve this line\r\n".repeat(120)}`;
		const { ctx, pasteToEditor } = createContext({
			customResult: { action: "paste", annotations: [{ scope: "text", note: "prompt note" }] },
		});
		const command = new AnnotateCommand(API);

		const result = await command.execute(["direct", "prompt"], ctx, `"${exactPrompt}"`);

		expect(result).toBeUndefined();
		expect(countOccurrences(pasteToEditor.mock.calls[0]?.[0] ?? "", exactPrompt)).toBe(1);
	});

	it.each([
		{ label: "a missing path", rawArgs: "missing source.txt" },
		{ label: "a directory", rawArgs: "folder" },
	] as const)("surfaces an error for $label without opening the annotation overlay", async scenario => {
		await withTempDir(async directory => {
			if (scenario.label === "a directory") {
				await mkdir(join(directory, scenario.rawArgs), { recursive: true });
			}
			const api = { ...API, cwd: directory } as unknown as CustomCommandAPI;
			const { ctx, notify, customCalls } = createContext({
				cwd: directory,
				customResult: { action: "paste", annotations: [{ scope: "text", note: "must not run" }] },
			});
			const command = new AnnotateCommand(api);

			const result = await command.execute(scenario.rawArgs.split(/\s+/), ctx, scenario.rawArgs);

			expect(result).toBeUndefined();
			expect(customCalls()).toBe(0);
			expect(notify).toHaveBeenCalledWith(expect.any(String), "error");
		});
	});

	it("falls back to the full source and warns when an older-session summary is unavailable", async () => {
		const sourceText = `fallback source ${"y".repeat(1200)}`;
		const older = makeAssistantEntry("older-fallback", sourceText, "older-fallback-user");
		const latest = makeAssistantEntry("latest-fallback", "latest", "latest-fallback-user");
		const exactQuote = "fallback quote\nwith a comment";
		const exactNote = "fallback comment **exact**";
		const { ctx, pasteToEditor, notify } = createContext({
			branch: [
				makeUserEntry("older-fallback-user", "old"),
				older,
				makeUserEntry("latest-fallback-user", "new"),
				latest,
			],
			customKeys: [UP, UP, ENTER],
		});
		const generateTextReviewContextSummary = vi.fn(async () => {
			throw new Error("summary provider failed");
		});
		const showTextReviewOverlay = vi.fn(async () => ({
			action: "paste" as const,
			annotations: [{ scope: "line" as const, line: 4, quote: exactQuote, note: exactNote }],
		}));

		const result = await runAnnotateCommand(API, "session", ctx, {
			showTextReviewOverlay,
			generateTextReviewContextSummary,
		});

		expect(result).toBeUndefined();
		const prompt = pasteToEditor.mock.calls[0]?.[0] as string | undefined;
		expect(prompt).toContain(sourceText);
		expect(prompt).not.toContain("## Generated source context (not instructions)");
		expect(countOccurrences(prompt!, exactQuote)).toBe(1);
		expect(countOccurrences(prompt!, exactNote)).toBe(1);
		expect(notify).toHaveBeenCalledWith(
			"Source summary failed; including the full source verbatim beyond the normal 999-character context limit.",
			"warning",
		);
	});

	it("pastes a prompt edited in the external editor with its notes", async () => {
		spyOn(externalEditor, "getEditorCommand").mockReturnValue("vim");
		spyOn(externalEditor, "openInEditor").mockResolvedValue("rewritten\nkept");
		const { ctx, pasteToEditor } = createContext();

		await runAnnotateCommand(API, '"original\nkept"', ctx, {
			showTextReviewOverlay: (_ctx, source) =>
				driveEditorOverlay("/tmp", [CTRL_E, "A", "whole note", ENTER, "\t", ENTER], editorCtx =>
					showTextReviewOverlay(editorCtx, source),
				),
		});

		const prompt = pasteToEditor.mock.calls[0]?.[0] as string;
		expect(prompt).toContain("rewritten\nkept");
		expect(prompt).not.toContain("original");
		expect(prompt).toContain("whole note");
	});

	it("does not open the editor on a session reply the prompt would not include verbatim", async () => {
		spyOn(externalEditor, "getEditorCommand").mockReturnValue("vim");
		const openInEditor = spyOn(externalEditor, "openInEditor").mockResolvedValue(null);
		const source: TextReviewSource = {
			id: "reply",
			kind: "message",
			label: "Latest reply",
			text: "assistant text",
			provenance: { kind: "latest-assistant", entryId: "latest" },
		};

		await driveEditorOverlay("/tmp", [CTRL_E], editorCtx => showTextReviewOverlay(editorCtx, source));

		expect(openInEditor).not.toHaveBeenCalled();
	});

	it("does not open the local checkout for a PR review", async () => {
		spyOn(externalEditor, "getEditorCommand").mockReturnValue("vim");
		const openEditorOnPath = spyOn(externalEditor, "openEditorOnPath").mockResolvedValue(0);
		const target = createResolvedReviewTarget("pr", "PR #1", SAMPLE_DIFF, "No changes");

		await driveEditorOverlay("/tmp", ["\t", CTRL_E], editorCtx => showCodeReviewOverlay(editorCtx, target));

		expect(openEditorOnPath).not.toHaveBeenCalled();
	});

	it("opens the current diff file from the repository root when the session cwd is a subdirectory", async () => {
		spyOn(externalEditor, "getEditorCommand").mockReturnValue("vim");
		const opened = Promise.withResolvers<string>();
		spyOn(externalEditor, "openEditorOnPath").mockImplementation(async (_editor, filePath) => {
			opened.resolve(filePath);
			return 0;
		});
		await withTempDir(async directory => {
			const dir = await realpath(directory);
			const cwd = join(dir, "packages");
			await Bun.$`git init -q ${dir}`.quiet();
			await mkdir(cwd);
			await mkdir(join(dir, "src"));
			await writeFile(join(dir, "src/value.ts"), "const value = 2;\n");

			await driveEditorOverlay(cwd, ["\t", CTRL_E], editorCtx => showCodeReviewOverlay(editorCtx, localTarget()));

			// The open follows a real filesystem check, so wait for the call rather than the key loop.
			expect(await opened.promise).toBe(join(dir, "src/value.ts"));
		});
	});

	it.each([
		{ label: "without the optional launcher", multiplexer: "tmux" as const, launcherAvailable: false },
		{ label: "without a multiplexer", multiplexer: null, launcherAvailable: true },
		{ label: "inside an unsupported multiplexer", multiplexer: "screen" as const, launcherAvailable: true },
	] as const)("keeps direct-file editing in the current terminal $label and refreshes its source", async scenario => {
		await withTempDir(async directory => {
			const filePath = join(directory, "direct file with spaces.txt");
			const updatedText = "saved direct-file contents";
			await writeFile(filePath, "original direct-file contents");
			spyOn(externalEditor, "getEditorCommand").mockReturnValue("vim");
			spyOn(terminalMultiplexer, "classifyTerminalMultiplexer").mockReturnValue(scenario.multiplexer);
			const sourceRefreshed = Promise.withResolvers<number>();
			const originalReplaceTextSource = AnnotationOverlay.prototype.replaceTextSource;
			const replaceTextSource = spyOn(AnnotationOverlay.prototype, "replaceTextSource").mockImplementation(function (
				this: AnnotationOverlay,
				text: string,
			) {
				const dropped = originalReplaceTextSource.call(this, text);
				sourceRefreshed.resolve(dropped);
				return dropped;
			});
			const openEditorOnPath = spyOn(externalEditor, "openEditorOnPath").mockImplementation(
				async (_editor, path) => {
					await writeFile(path, updatedText);
					return 0;
				},
			);
			const openTerminal = vi.fn(async (_request: TerminalLaunchRequest): Promise<TerminalLaunchResult> => ({
				multiplexer: "tmux",
				placement: "pane",
			}));
			const notify = vi.fn();
			const uiOverrides: Partial<Pick<ExtensionUIContext, "openTerminal" | "notify">> = { notify };
			if (scenario.launcherAvailable) uiOverrides.openTerminal = openTerminal;
			const source: TextReviewSource = {
				id: `file:${filePath}`,
				kind: "file",
				label: filePath,
				text: "original direct-file contents",
				provenance: { kind: "file", path: filePath },
			};
			let overlayComponent: ExtensionUiComponent | undefined;

			await driveEditorOverlay(
				directory,
				[CTRL_E],
				ctx => showTextReviewOverlay(ctx, source),
				uiOverrides,
				component => {
					overlayComponent = component;
				},
			);
			await sourceRefreshed.promise;

			expect(openEditorOnPath).toHaveBeenCalledWith("vim", filePath);
			expect(openTerminal).not.toHaveBeenCalled();
			expect(replaceTextSource).toHaveBeenCalledWith(updatedText);
			expect(overlayComponent ? overlayText(overlayComponent) : undefined).toBe(updatedText);
			expect(notify).not.toHaveBeenCalled();
		});
	});

	it.each([
		{ label: "a transcript-associated file", directFile: false },
		{ label: "direct file provenance", directFile: true },
	] as const)("opens $label in a pane with safe full-path editor argv and keeps the source frozen", async scenario => {
		await withTempDir(async directory => {
			const filePath = join(directory, "source with spaces ; $(not-a-command).txt");
			const editor = '"Editor With Spaces" --wait';
			await writeFile(filePath, "original full file");
			spyOn(externalEditor, "getEditorCommand").mockReturnValue(editor);
			spyOn(terminalMultiplexer, "classifyTerminalMultiplexer").mockReturnValue("tmux");
			const paneLaunchCompleted = Promise.withResolvers<void>();
			const openEditorOnPath = spyOn(externalEditor, "openEditorOnPath").mockResolvedValue(0);
			spyOn(externalEditor, "openInEditor").mockResolvedValue("unexpected");
			const openTerminal = vi.fn(async (_request: TerminalLaunchRequest): Promise<TerminalLaunchResult> => {
				await writeFile(filePath, "new full-file contents from the detached editor");
				paneLaunchCompleted.resolve();
				return { multiplexer: "tmux", placement: "pane" };
			});
			const notify = vi.fn();
			const source: TextReviewSource = scenario.directFile
				? {
						id: `file:${filePath}`,
						kind: "file",
						label: filePath,
						text: "original full file",
						provenance: { kind: "file", path: filePath },
					}
				: messageWithEditorFile(filePath);
			let overlayComponent: ExtensionUiComponent | undefined;
			const stop = vi.fn();
			const start = vi.fn();
			const requestRender = vi.fn();

			await driveEditorOverlay(
				directory,
				[CTRL_E],
				ctx => showTextReviewOverlay(ctx, source),
				{ openTerminal, notify },
				component => {
					overlayComponent = component;
				},
				{ stop, start, requestRender },
			);
			await settleExternalAction(paneLaunchCompleted.promise);

			const request = openTerminal.mock.calls[0]?.[0];
			expect(request?.multiplexer).toBe("tmux");
			expect(request?.placement).toBe("pane");
			const command = request?.command;
			if (process.platform !== "win32") {
				expect(command?.[1]).toBe("-c");
				expect(command?.[2]).toBe(`${editor} "$1"`);
				expect(command?.[2]).not.toContain(filePath);
				expect(command?.at(-1)).toBe(filePath);
			} else {
				expect(command?.slice(0, 4)).toEqual(["cmd.exe", "/d", "/s", "/c"]);
				expect(command?.[4]).toContain(`"${filePath}"`);
			}
			expect(openEditorOnPath).not.toHaveBeenCalled();
			expect(stop).not.toHaveBeenCalled();
			expect(start).not.toHaveBeenCalled();
			expect(requestRender).toHaveBeenCalledWith(true);
			expect(overlayComponent ? overlayText(overlayComponent) : undefined).toBe(source.text);
			expect(source.text).toBe(scenario.directFile ? "original full file" : "frozen selected excerpt");
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("annotation source remains frozen"), "info");
		});
	});

	it("opens the selected local diff file from the repo root in a new pane", async () => {
		const editor = '"Editor With Spaces" --wait';
		spyOn(externalEditor, "getEditorCommand").mockReturnValue(editor);
		spyOn(terminalMultiplexer, "classifyTerminalMultiplexer").mockReturnValue("tmux");
		const paneLaunchCompleted = Promise.withResolvers<void>();
		const openEditorOnPath = spyOn(externalEditor, "openEditorOnPath").mockResolvedValue(0);
		const openTerminal = vi.fn(async (_request: TerminalLaunchRequest): Promise<TerminalLaunchResult> => {
			paneLaunchCompleted.resolve();
			return { multiplexer: "tmux", placement: "pane" };
		});
		const notify = vi.fn();
		await withTempDir(async directory => {
			const repoRoot = await realpath(directory);
			const cwd = join(repoRoot, "packages");
			const filePath = join(repoRoot, "src/value.ts");
			await Bun.$`git init -q ${repoRoot}`.quiet();
			await mkdir(cwd);
			await mkdir(join(repoRoot, "src"));
			await writeFile(filePath, "const value = 2;\n");

			await driveEditorOverlay(cwd, ["\t", CTRL_E], ctx => showCodeReviewOverlay(ctx, localTarget()), {
				openTerminal,
				notify,
			});
			await settleExternalAction(paneLaunchCompleted.promise);

			const request = openTerminal.mock.calls[0]?.[0];
			expect(request?.cwd).toBe(cwd);
			const command = request?.command;
			if (process.platform !== "win32") {
				expect(command?.[1]).toBe("-c");
				expect(command?.[2]).toBe(`${editor} "$1"`);
				expect(command?.at(-1)).toBe(filePath);
			} else {
				expect(command?.slice(0, 4)).toEqual(["cmd.exe", "/d", "/s", "/c"]);
				expect(command?.[4]).toContain(`"${filePath}"`);
			}
			expect(openEditorOnPath).not.toHaveBeenCalled();
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("review diff remains frozen"), "info");
		});
	});

	it("falls back to the stopped local editor for an associated file without refreshing the session excerpt", async () => {
		const editor = "vim";
		spyOn(externalEditor, "getEditorCommand").mockReturnValue(editor);
		const editorCompleted = Promise.withResolvers<void>();
		const openEditorOnPath = spyOn(externalEditor, "openEditorOnPath").mockImplementation(
			async (_editor, filePath) => {
				await writeFile(filePath, "edited associated file");
				editorCompleted.resolve();
				return 0;
			},
		);
		const notify = vi.fn();
		const stop = vi.fn();
		const start = vi.fn();
		const requestRender = vi.fn();

		await withTempDir(async directory => {
			const filePath = join(directory, "associated source.txt");
			await writeFile(filePath, "original associated file");
			const source = messageWithEditorFile(filePath);
			let overlayComponent: ExtensionUiComponent | undefined;

			await driveEditorOverlay(
				directory,
				[CTRL_E],
				ctx => showTextReviewOverlay(ctx, source),
				{ notify },
				component => {
					overlayComponent = component;
				},
				{ stop, start, requestRender },
			);
			await settleExternalAction(editorCompleted.promise);

			expect(openEditorOnPath).toHaveBeenCalledWith(editor, filePath);
			expect(await Bun.file(filePath).text()).toBe("edited associated file");
			expect(overlayComponent ? overlayText(overlayComponent) : undefined).toBe("frozen selected excerpt");
			expect(source.text).toBe("frozen selected excerpt");
			expect(stop).toHaveBeenCalledTimes(1);
			expect(start).toHaveBeenCalledTimes(1);
			expect(requestRender).toHaveBeenCalledWith(true);
			expect(notify).toHaveBeenCalledWith(`Opened ${filePath}. The annotation source remains frozen.`, "info");
		});
	});

	it.each(["herdr", "cmux", "orca"] as const)(
		"confirms POSIX shell compatibility before launching in %s",
		async multiplexer => {
			await withTempDir(async directory => {
				const filePath = join(directory, "selected source.txt");
				await writeFile(filePath, "source");
				spyOn(externalEditor, "getEditorCommand").mockReturnValue("vim");
				spyOn(terminalMultiplexer, "classifyTerminalMultiplexer").mockReturnValue(multiplexer);
				const confirm = vi.fn(async () => true);
				const paneLaunchCompleted = Promise.withResolvers<void>();
				const openTerminal = vi.fn(async (_request: TerminalLaunchRequest): Promise<TerminalLaunchResult> => {
					paneLaunchCompleted.resolve();
					return { multiplexer, placement: "pane" };
				});

				await driveEditorOverlay(
					directory,
					[CTRL_E],
					ctx => showTextReviewOverlay(ctx, messageWithEditorFile(filePath)),
					{
						confirm,
						openTerminal,
					},
				);
				await settleExternalAction(paneLaunchCompleted.promise);

				expect(confirm).toHaveBeenCalledWith(
					"Confirm destination shell compatibility",
					expect.stringContaining("This editor command uses POSIX shell syntax."),
				);
				expect(openTerminal.mock.calls[0]?.[0]).toMatchObject({
					multiplexer,
					placement: "pane",
					shellGrammar: "posix",
				});
			});
		},
	);

	it("does not fall back locally after POSIX shell compatibility is declined", async () => {
		spyOn(externalEditor, "getEditorCommand").mockReturnValue("vim");
		spyOn(terminalMultiplexer, "classifyTerminalMultiplexer").mockReturnValue("cmux");
		const confirmationCompleted = Promise.withResolvers<void>();
		const confirm = vi.fn(async () => {
			confirmationCompleted.resolve();
			return false;
		});
		const openTerminal = vi.fn(async (_request: TerminalLaunchRequest): Promise<TerminalLaunchResult> => ({
			multiplexer: "cmux",
			placement: "pane",
		}));
		const openEditorOnPath = spyOn(externalEditor, "openEditorOnPath").mockResolvedValue(0);
		const notify = vi.fn();

		await withTempDir(async directory => {
			const filePath = join(directory, "selected source.txt");
			await writeFile(filePath, "source");
			await driveEditorOverlay(
				directory,
				[CTRL_E],
				ctx => showTextReviewOverlay(ctx, messageWithEditorFile(filePath)),
				{
					confirm,
					notify,
					openTerminal,
				},
			);
			await settleExternalAction(confirmationCompleted.promise);
		});

		expect(openTerminal).not.toHaveBeenCalled();
		expect(openEditorOnPath).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Editor launch cancelled"), "warning");
	});

	it("cancels a real POSIX confirmation without losing fullscreen annotation focus", async () => {
		spyOn(externalEditor, "getEditorCommand").mockReturnValue("vim");
		spyOn(terminalMultiplexer, "classifyTerminalMultiplexer").mockReturnValue("cmux");
		const openEditorOnPath = spyOn(externalEditor, "openEditorOnPath").mockResolvedValue(0);

		await withTempDir(async directory => {
			const filePath = join(directory, "selected source.txt");
			await writeFile(filePath, "source");
			const terminal = new VirtualTerminal(120, 40);
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(terminal, true, { renderScheduler: scheduler });
			const editor = new CustomEditor(getEditorTheme());
			const editorContainer = new Container();
			editorContainer.addChild(editor);
			tui.addChild(editorContainer);
			tui.setFocus(editor);
			let launchCancelled = false;
			const notify = vi.fn((message: string) => {
				if (message.startsWith("Editor launch cancelled")) launchCancelled = true;
			});
			const openTerminal = vi.fn(async (_request: TerminalLaunchRequest): Promise<TerminalLaunchResult> => ({
				multiplexer: "cmux",
				placement: "pane",
			}));
			const interactiveContext = { editor, editorContainer, ui: tui } as unknown as InteractiveModeContext;
			const controller = new ExtensionUiController(interactiveContext);
			const ui = tui as unknown as ExtensionUIContext;
			ui.confirm = (title, message, options) => controller.showHookConfirm(title, message, options);
			ui.custom = (factory, options) => controller.showHookCustom(factory, options);
			ui.notify = notify;
			ui.openTerminal = openTerminal;
			const ctx = {
				cwd: directory,
				sessionManager: { getCwd: () => directory },
				ui,
			} as unknown as CustomCommandContext;
			const previousKeybindings = getKeybindings();
			setKeybindings(KeybindingsManager.inMemory({ "app.editor.external": "ctrl+e" }));

			tui.start();
			let result: Promise<TextReviewOverlayResult | undefined> | undefined;
			try {
				await scheduler.settle(terminal);
				result = showTextReviewOverlay(ctx, messageWithEditorFile(filePath));
				for (let attempt = 0; attempt < 50 && !(tui.getFocused() instanceof AnnotationOverlay); attempt++) {
					await new Promise<void>(resolve => setImmediate(resolve));
				}
				await scheduler.settle(terminal);
				expect(tui.getFocused()).toBeInstanceOf(AnnotationOverlay);
				const overlay = tui.getFocused() as AnnotationOverlay;

				terminal.sendInput(CTRL_E);
				for (let attempt = 0; attempt < 50 && !(tui.getFocused() instanceof HookSelectorComponent); attempt++) {
					await new Promise<void>(resolve => setImmediate(resolve));
				}
				await scheduler.settle(terminal);
				expect(tui.getFocused()).toBeInstanceOf(HookSelectorComponent);
				const confirmation = stripVTControlCharacters(tui.getDebugDocument().join("\n"));
				expect(confirmation).toContain("Confirm destination shell compatibility");
				expect(confirmation).toContain("This editor command uses POSIX shell syntax.");

				terminal.sendInput("\x1b");
				for (let attempt = 0; attempt < 50 && !launchCancelled; attempt++) {
					await new Promise<void>(resolve => setImmediate(resolve));
				}
				await scheduler.settle(terminal);
				expect(launchCancelled).toBe(true);
				expect(tui.getFocused()).toBe(overlay);

				terminal.sendInput("A");
				for (const character of "responsive note") terminal.sendInput(character);
				terminal.sendInput(ENTER);
				await scheduler.settle(terminal);
				expect(overlay.getTextAnnotations()).toEqual([{ scope: "text", note: "responsive note" }]);
				expect(openTerminal).not.toHaveBeenCalled();
				expect(openEditorOnPath).not.toHaveBeenCalled();

				terminal.sendInput("\x1b");
				expect(await result).toBeUndefined();
			} finally {
				tui.stop();
				setKeybindings(previousKeybindings);
			}
		});
	});

	it("surfaces a pane launch failure instead of opening a second editor locally", async () => {
		spyOn(externalEditor, "getEditorCommand").mockReturnValue("vim");
		spyOn(terminalMultiplexer, "classifyTerminalMultiplexer").mockReturnValue("tmux");
		const launchStarted = Promise.withResolvers<void>();
		const openTerminal = vi.fn(async (_request: TerminalLaunchRequest): Promise<TerminalLaunchResult> => {
			launchStarted.resolve();
			throw new Error("mock pane launcher failure");
		});
		const openEditorOnPath = spyOn(externalEditor, "openEditorOnPath").mockResolvedValue(0);
		const notify = vi.fn();

		await withTempDir(async directory => {
			const filePath = join(directory, "selected source.txt");
			await writeFile(filePath, "source");
			await driveEditorOverlay(
				directory,
				[CTRL_E],
				ctx => showTextReviewOverlay(ctx, messageWithEditorFile(filePath)),
				{
					notify,
					openTerminal,
				},
			);
			await settleExternalAction(launchStarted.promise);
		});

		expect(openTerminal).toHaveBeenCalledTimes(1);
		expect(openEditorOnPath).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Failed to open external editor: mock pane launcher failure"),
			"warning",
		);
	});

	it("surfaces missing editor paths and missing editor configuration", async () => {
		await withTempDir(async directory => {
			const missingPath = join(directory, "missing source.txt");
			const getEditorCommand = spyOn(externalEditor, "getEditorCommand").mockReturnValue("vim");
			const missingPathShown = Promise.withResolvers<void>();
			const missingPathNotify = vi.fn(() => missingPathShown.resolve());
			const openTerminal = vi.fn(async (_request: TerminalLaunchRequest): Promise<TerminalLaunchResult> => ({
				multiplexer: "tmux",
				placement: "pane",
			}));
			const openEditorOnPath = spyOn(externalEditor, "openEditorOnPath").mockResolvedValue(0);
			await driveEditorOverlay(
				directory,
				[CTRL_E],
				ctx => showTextReviewOverlay(ctx, messageWithEditorFile(missingPath)),
				{ notify: missingPathNotify, openTerminal },
			);
			await settleExternalAction(missingPathShown.promise);
			expect(missingPathNotify).toHaveBeenCalledWith(
				expect.stringContaining("missing source.txt is not on disk."),
				"warning",
			);
			expect(openEditorOnPath).not.toHaveBeenCalled();
			expect(openTerminal).not.toHaveBeenCalled();

			const existingPath = join(directory, "existing source.txt");
			await writeFile(existingPath, "source");
			getEditorCommand.mockReturnValue(undefined);
			const missingEditorShown = Promise.withResolvers<void>();
			const missingEditorNotify = vi.fn(() => missingEditorShown.resolve());
			await driveEditorOverlay(
				directory,
				[CTRL_E],
				ctx => showTextReviewOverlay(ctx, messageWithEditorFile(existingPath)),
				{ notify: missingEditorNotify, openTerminal },
			);
			await settleExternalAction(missingEditorShown.promise);
			expect(missingEditorNotify).toHaveBeenCalledWith(
				expect.stringContaining("Set $VISUAL or $EDITOR to edit in an external editor."),
				"warning",
			);
			expect(openTerminal).not.toHaveBeenCalled();
			expect(openEditorOnPath).not.toHaveBeenCalled();
		});
	});
});
