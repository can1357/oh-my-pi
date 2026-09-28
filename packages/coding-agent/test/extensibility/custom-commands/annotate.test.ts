import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { TUI } from "@oh-my-pi/pi-tui";
import type {
	ExtensionCustomOptions,
	ExtensionUIContext,
	ExtensionUiComponent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { CopySelectorComponent } from "@oh-my-pi/pi-tui/overlays/copy-selector";
import type { SessionPick } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/text-source";
import {
	AnnotateCommand,
	runAnnotateCommand,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate";
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
} from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

const ENTER = "\r";
const UP = "\x1b[A";
const RIGHT = "\x1b[C";

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
});
