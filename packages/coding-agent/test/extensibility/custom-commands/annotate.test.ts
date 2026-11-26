import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import type { ExtensionRender, ExtensionUiHost } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/render-types";
import type {
	ExtensionCustomFactory,
	ExtensionCustomOptions,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { extensionOutput, extensionTheme, singleNode } from "../../../src/ui/extensions/render-output";
import type { SessionPick } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/text-source";
import {
	AnnotateCommand,
	runAnnotateCommand,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate";
import {
	type AnnotationOverlayContext,
	showCodeReviewOverlay,
	showTextReviewOverlay,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/fullscreen";
import { loadAnnotationDrafts } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/draft-store";
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
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/annotation-types";
import * as gh from "@oh-my-pi/pi-coding-agent/tools/gh";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ProtocolHandler } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const ENTER = "\r";
const UP = "\x1b[A";
const RIGHT = "\x1b[C";
const CTRL_E = "\x05";

/** Raw input of the keys these tests press, as key ids. */
const RAW_KEYS: Readonly<Record<string, string>> = {
	"\r": "enter",
	"\x1b": "escape",
	"\t": "tab",
	"\x1b[A": "up",
	"\x1b[B": "down",
	"\x1b[C": "right",
	"\x05": "ctrl+e",
};

/** The UI host a custom view receives (no terminal to hand to an editor: `suspend` just runs). */
const HOST: ExtensionUiHost = {
	requestRender() {},
	size: () => ({ columns: 120, rows: 40 }),
	suspend: run => run(),
};

/** Mount a custom view the way the host's overlay does: one root node holding keyboard focus. */
function mountView(output: ExtensionRender): TestTerminal {
	const adapted = extensionOutput(output);
	if (adapted === undefined) throw new Error("custom view drew nothing");
	const node = singleNode(adapted);
	const term = createTestTerminal(() => ({ layer: node }), { columns: 120, rows: 40 });
	term.focus(node);
	return term;
}

/** Feed one raw input chunk: a known key sequence as that key, anything else typed. */
function feed(term: TestTerminal, raw: string): void {
	const id = RAW_KEYS[raw];
	if (id) term.press(id);
	else term.type(raw);
}

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
	/** The running session's router; a context without a session classifies URLs by the built-ins. */
	urlRouter?: InternalUrlRouter;
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
		factory: ExtensionCustomFactory<T>,
		_options?: ExtensionCustomOptions,
	): Promise<T> => {
		customCalls++;
		const completion = Promise.withResolvers<T>();
		let settled = false;
		const done = (result: T): void => {
			if (typeof result === "object" && result !== null && "entry" in result && "content" in result) {
				pickedSelections.push(result as unknown as SessionPick);
			}
			settled = true;
			completion.resolve(result);
		};
		const output = await factory(HOST, extensionTheme(currentTheme()), KeybindingsManager.inMemory(), done);
		if (options.customResult !== undefined) {
			done(options.customResult as T);
			return completion.promise;
		}
		const term = mountView(output);
		try {
			for (const key of options.customKeys ?? [ENTER]) feed(term, key);
		} finally {
			term.dispose();
		}
		if (!settled) throw new Error("custom view did not complete");
		return completion.promise;
	};
	const ctx = {
		hasUI: true,
		cwd: options.cwd ?? "/workspace",
		sessionManager: {
			getBranch: () => branch,
			getCwd: () => options.cwd ?? "/workspace",
			getSessionId: () => "session-1",
			getArtifactsDir: () => null,
		},
		ui: { select, input, editor, custom, pasteToEditor, notify, setStatus },
		urlRouter: options.urlRouter ?? InternalUrlRouter.builtins(),
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

/**
 * Mounts a real annotation overlay with the external-editor key remapped to Ctrl+E, feeds
 * `keys`, and resolves with whatever it completed. After each key it yields one macrotask so
 * the microtask chain of an already-resolved mocked editor finishes before the next key.
 */
async function driveEditorOverlay<T>(
	cwd: string,
	keys: readonly string[],
	show: (ctx: CustomCommandContext) => Promise<T | undefined>,
	artifactsDir: string | null = null,
): Promise<T | undefined> {
	const ctx = {
		cwd,
		sessionManager: {
			getCwd: () => cwd,
			getSessionId: () => "session-1",
			getArtifactsDir: () => artifactsDir,
			ensureOnDisk: async () => {},
		},
		ui: {
			notify: vi.fn(),
			custom: async <R>(factory: ExtensionCustomFactory<R>) => {
				let result: R | undefined;
				const output = await factory(
					HOST,
					extensionTheme(currentTheme()),
					KeybindingsManager.inMemory({ "app.editor.external": "ctrl+e" }),
					value => {
						result = value;
					},
				);
				const term = mountView(output);
				try {
					for (const key of keys) {
						feed(term, key);
						await new Promise<void>(resolve => setImmediate(resolve));
					}
				} finally {
					term.dispose();
				}
				return result;
			},
		},
	} as unknown as CustomCommandContext;
	return await show(ctx);
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

afterEach(() => {
	vi.restoreAllMocks();
});

describe("/annotate contracts", () => {
	it("saves notes from an overlay closed with Escape, restores them on reopen, and drops them on discard", async () => {
		await withTempDir(async artifactsDir => {
			const source = { id: "p", kind: "prompt", label: "Prompt", text: "alpha\nbeta" } as const;
			const session = {
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "session-1",
				ensureOnDisk: async () => {},
			};
			const show = (ctx: CustomCommandContext) => showTextReviewOverlay(ctx, source);
			await driveEditorOverlay("/w", ["A", "kept", ENTER, "a", "half", "\x1b"], show, artifactsDir);
			const [saved] = await loadAnnotationDrafts(session);
			expect(saved?.state).toMatchObject({
				annotations: [{ annotation: { note: "kept" } }],
				editor: { text: "half" },
			});

			// Reopened, the unfinished note is back in the editor; Enter commits it, then paste keeps the draft.
			const result = await driveEditorOverlay("/w", [ENTER, "\t", ENTER], show, artifactsDir);
			expect(result?.annotations.map(annotation => annotation.note)).toEqual(["kept", "half"]);

			// Discard needs a second Enter; the draft is gone once it closes.
			await driveEditorOverlay("/w", ["\t", "\x1b[B", ENTER, ENTER], show, artifactsDir);
			expect(await loadAnnotationDrafts(session)).toEqual([]);
		});
	});

	it("resolves the selected local target in the live session cwd and pastes code notes without submitting", async () => {
		const { ctx, select, pasteToEditor } = createContext({
			selectResults: ["Code review", "2. Review uncommitted changes"],
			cwd: "/live-worktree",
		});
		spyOn(vcs, "repo").mockReturnValue({} as VcsRepo);
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
		expect(showCodeReviewOverlay).toHaveBeenCalledWith(ctx, target, undefined, undefined);
		expect(pasteToEditor).toHaveBeenCalledTimes(1);
		expect(pasteToEditor.mock.calls[0]?.[0]).toContain(annotation.note);
	});

	it("resolves a PR picked from the open pull request list in the live session repo", async () => {
		const { ctx, pasteToEditor } = createContext({
			selectResults: ["Code review", "4. Review a specific PR/MR", "#42  Fix login  @octocat"],
			cwd: "/live-worktree",
		});
		spyOn(vcs, "repo").mockReturnValue({} as VcsRepo);
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
		expect(showCodeReviewOverlay).toHaveBeenCalledWith(ctx, target, undefined, undefined);
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
		expect(showCodeReviewOverlay).toHaveBeenCalledWith(ctx, target, "focus on this line", undefined);
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
		const showTextReviewOverlay = vi.fn(async (_ctx: AnnotationOverlayContext, source: TextReviewSource) => {
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
		const showTextReviewOverlay = vi.fn(async (_ctx: AnnotationOverlayContext, source: TextReviewSource) => {
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
		const showTextReviewOverlay = vi.fn(async (_ctx: AnnotationOverlayContext, source: TextReviewSource) => {
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

	it("opens the session picker on a turn that wrote a reply and read an internal URL", async () => {
		const base = makeAssistantEntry("assistant-tools", "unused", "user-tools");
		const assistant: SessionMessageEntry = {
			...base,
			message: {
				...base.message,
				content: [
					{ type: "text", text: "Replying and reading." },
					{
						type: "toolCall",
						id: "write-call",
						name: "write",
						arguments: { path: "agent://Main", content: "on it" },
					},
					{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "skill://commit" } },
				],
			} as AgentMessage,
		};
		const { ctx, pickedSelections } = createContext({
			branch: [makeUserEntry("user-tools", "reply and read"), assistant],
			customKeys: [ENTER],
		});
		const showTextReviewOverlay = vi.fn(async (_ctx: AnnotationOverlayContext, source: TextReviewSource) => {
			expect(source.text).toContain("Replying and reading.");
			return { action: "paste" as const, annotations: [{ scope: "text" as const, note: "tool turn note" }] };
		});

		const result = await runAnnotateCommand(API, "session", ctx, { showTextReviewOverlay });

		expect(result).toBeUndefined();
		expect(pickedSelections[0]?.entry).toBe(assistant);
		expect(showTextReviewOverlay).toHaveBeenCalledTimes(1);
	});

	it("reads a reply written to an extension's scheme as the picked turn's prose through the session's router", async () => {
		using dir = TempDir.createSync("@annotate-session-router-");
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		// `memo://` sends its writes to the user, like `out://`.
		const memo: ProtocolHandler = {
			scheme: "memo",
			spec: {
				backing: "remote",
				selectors: "none",
				immutable: false,
				write: { via: "handler", payload: "verbatim", scope: "reply", tier: () => "write" },
			},
			resolve: async url => ({ url: url.href, content: "memo", contentType: "text/plain" }),
			write: async () => {},
		};
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, dir.join("models.yml")),
			settings: Settings.isolated({ "async.enabled": false, "compaction.enabled": false, "todo.enabled": false }),
			model,
			toolNames: ["read", "write"],
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			sessionManager: SessionManager.inMemory(dir.path()),
			extensions: [
				pi => {
					pi.registerUrlScheme(memo);
				},
			],
		});
		try {
			const base = makeAssistantEntry("assistant-memo", "unused", "user-memo");
			const assistant: SessionMessageEntry = {
				...base,
				message: {
					...base.message,
					content: [
						{ type: "text", text: "Answering through memo." },
						{
							type: "toolCall",
							id: "memo-write",
							name: "write",
							arguments: { path: "memo://user", content: "the memo reply" },
						},
					],
				} as AgentMessage,
			};
			const { ctx, pickedSelections } = createContext({
				branch: [makeUserEntry("user-memo", "answer via memo"), assistant],
				customKeys: [ENTER],
				urlRouter: session.urlRouter,
			});
			let picked: TextReviewSource | undefined;
			const showTextReviewOverlay = vi.fn(async (_ctx: AnnotationOverlayContext, source: TextReviewSource) => {
				picked = source;
				return { action: "paste" as const, annotations: [{ scope: "text" as const, note: "memo note" }] };
			});

			await runAnnotateCommand(API, "session", ctx, { showTextReviewOverlay });

			expect(pickedSelections[0]?.entry).toBe(assistant);
			// The session's router knows `memo://` writes are replies, so the turn's prose carries the reply.
			expect(picked?.text).toBe("Answering through memo.\n\nthe memo reply");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}, 30_000);

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
			const showTextReviewOverlay = vi.fn(async (_ctx: AnnotationOverlayContext, source: TextReviewSource) => {
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
		const showTextReviewOverlay = vi.fn(async (_ctx: AnnotationOverlayContext, source: TextReviewSource) => {
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
});
