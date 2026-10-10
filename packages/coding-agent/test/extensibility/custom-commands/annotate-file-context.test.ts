import { beforeAll, describe, expect, it } from "bun:test";
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
import { CopySelectorComponent } from "@oh-my-pi/pi-tui/overlays/copy-selector";
import { initTheme, theme, type Theme } from "@oh-my-pi/pi-tui/theme";
import type { CustomCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { TextReviewSource } from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { selectSessionTextReviewSource } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/text-source";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

const ENTER = "\r";
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";
const USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

beforeAll(async () => {
	await initTheme();
});

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "annotate-file-context-"));
	try {
		return await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function toolCallEntry(
	id: string,
	callId: string,
	toolName: string,
	args: Record<string, unknown>,
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-10-10T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: toolName, arguments: args }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			stopReason: "toolUse",
			usage: USAGE,
			timestamp: 1,
		} as unknown as AgentMessage,
	};
}

function toolResultEntry(
	id: string,
	callId: string,
	toolName: string,
	output: string,
	details?: unknown,
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: "assistant-call",
		timestamp: "2026-10-10T00:00:01.000Z",
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content: [{ type: "text", text: output }],
			details,
			isError: false,
			timestamp: 2,
		} as unknown as AgentMessage,
	};
}

function toolBranch(
	toolName: string,
	args: Record<string, unknown>,
	output = "selected result",
	details?: unknown,
): SessionMessageEntry[] {
	const callId = `call-${toolName}`;
	return [
		toolCallEntry("assistant-call", callId, toolName, args),
		toolResultEntry("tool-result", callId, toolName, output, details),
	];
}

function createContext(
	branch: SessionMessageEntry[],
	options: { cwd: string; cwdAfterPick?: string; keys?: readonly string[] },
): { ctx: CustomCommandContext } {
	let liveCwd = options.cwd;
	const custom: ExtensionUIContext["custom"] = async <T>(
		factory: (
			tui: TUI,
			uiTheme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => ExtensionUiComponent | Promise<ExtensionUiComponent>,
		_options?: ExtensionCustomOptions,
	): Promise<T> => {
		const tui = new TUI(new VirtualTerminal(120, 30));
		const completion = Promise.withResolvers<T>();
		const done = (result: T): void => {
			if (options.cwdAfterPick && typeof result === "object" && result !== null && "entry" in result) {
				liveCwd = options.cwdAfterPick;
			}
			completion.resolve(result);
		};
		const component = await factory(tui, theme, KeybindingsManager.inMemory(), done);
		if (!(component instanceof CopySelectorComponent)) throw new Error("expected the native copy selector");
		component.render(120);
		for (const key of options.keys ?? [RIGHT, ENTER]) component.handleInput(key);
		component.dispose?.();
		return completion.promise;
	};
	return {
		ctx: {
			hasUI: true,
			cwd: options.cwd,
			sessionManager: {
				getBranch: () => branch,
				getCwd: () => liveCwd,
				getSessionId: () => "session-file-context",
			},
			ui: { custom, notify: () => undefined },
		} as unknown as CustomCommandContext,
	};
}

async function selectSource(
	branch: SessionMessageEntry[],
	options: { cwd: string; cwdAfterPick?: string; keys?: readonly string[] },
): Promise<TextReviewSource | undefined> {
	return selectSessionTextReviewSource(createContext(branch, options).ctx);
}

describe("/annotate transcript file context", () => {
	it("opens the full file for a selected read excerpt against the live nested cwd", async () => {
		await withTempDir(async root => {
			const originalCwd = join(root, "workspace");
			const nestedCwd = join(originalCwd, "nested");
			const sourcePath = join(nestedCwd, "src", "module.ts");
			await mkdir(join(nestedCwd, "src"), { recursive: true });
			await writeFile(sourcePath, "first\nsecond\nthird\n");
			const excerpt = "2: second\n3: third";
			const source = await selectSource(toolBranch("read", { path: "src/module.ts:2-3" }, excerpt), {
				cwd: originalCwd,
				cwdAfterPick: nestedCwd,
			});

			expect(source?.editorFilePath).toBe(sourcePath);
			expect(source?.text).toBe(excerpt);
			expect(source?.provenance).toEqual({ kind: "session", entryId: "tool-result" });
		});
	});

	it("prefers authoritative resolved read metadata to its input argument", async () => {
		await withTempDir(async cwd => {
			const resolvedPath = join(cwd, "actual.ts");
			const metadataPath = join(cwd, "source-metadata.ts");
			await writeFile(resolvedPath, "actual file\n");
			await writeFile(metadataPath, "metadata source file\n");
			const source = await selectSource(
				toolBranch("read", { path: "old-name.ts:1-2" }, "excerpt from the resolved file\n", {
					resolvedPath,
					meta: { source: { type: "path", value: metadataPath } },
				}),
				{ cwd, keys: [ENTER] },
			);

			expect(source?.editorFilePath).toBe(resolvedPath);
			expect(source?.text).toBe("excerpt from the resolved file");
		});
	});

	it("preserves a real selector-shaped filename over selector interpretation", async () => {
		await withTempDir(async cwd => {
			const basePath = join(cwd, "module.ts");
			const literalPath = join(cwd, "module.ts:2-3");
			await writeFile(basePath, "base file\n");
			await writeFile(literalPath, "literal file\n");
			const source = await selectSource(toolBranch("read", { path: "module.ts:2-3" }), { cwd });

			expect(source?.editorFilePath).toBe(literalPath);
		});
	});

	it("preserves selector-bearing semicolon filenames from metadata and literal-first resolution", async () => {
		await withTempDir(async cwd => {
			const literalPath = join(cwd, "module;draft.ts");
			await writeFile(literalPath, "first\nsecond\nthird\n");
			const selectedPath = "module;draft.ts:2-3";
			const metadataSource = await selectSource(
				toolBranch("read", { path: selectedPath }, "selected metadata excerpt", {
					resolvedPath: literalPath,
					meta: { source: { type: "path", value: literalPath } },
				}),
				{ cwd },
			);
			const literalFallback = await selectSource(
				toolBranch("read", { path: selectedPath }, "selected literal excerpt"),
				{ cwd },
			);

			expect(metadataSource?.editorFilePath).toBe(literalPath);
			expect(literalFallback?.editorFilePath).toBe(literalPath);
		});
	});

	it("pairs a selected tool result with its call by toolCallId", async () => {
		await withTempDir(async cwd => {
			const localPath = join(cwd, "src", "local.ts");
			await mkdir(join(cwd, "src"), { recursive: true });
			await writeFile(localPath, "local file\n");

			const assistant = toolCallEntry("assistant-call", "remote-call", "read", {
				path: "https://example.invalid/remote.ts",
			});
			if (assistant.message.role !== "assistant") throw new Error("expected an assistant tool-call entry");
			assistant.message.content.push({
				type: "toolCall",
				id: "local-call",
				name: "read",
				arguments: { path: "src/local.ts" },
			});
			const branch = [
				assistant,
				toolResultEntry("remote-result", "remote-call", "read", "remote excerpt"),
				toolResultEntry("local-result", "local-call", "read", "local excerpt"),
			];
			const source = await selectSource(branch, { cwd, keys: [RIGHT, DOWN, ENTER] });

			expect(source?.editorFilePath).toBe(localPath);
			expect(source?.text).toBe("local excerpt");
		});
	});

	it("uses path arguments and authoritative single-file edit metadata", async () => {
		await withTempDir(async cwd => {
			const editPath = join(cwd, "src", "edited.ts");
			const metadataEditPath = join(cwd, "src", "hashline-edited.ts");
			const writePath = join(cwd, "src", "created.ts");
			await mkdir(join(cwd, "src"), { recursive: true });
			await writeFile(metadataEditPath, "edited through hashline mode\n");
			const edited = await selectSource(
				toolBranch("edit", { path: "src/edited.ts", old_string: "old", new_string: "new" }, "edit result"),
				{ cwd },
			);
			const metadataEdit = await selectSource(
				toolBranch("edit", { input: "[src/hashline-edited.ts#ABCD]\n1: old\n1: new" }, "hashline edit result", {
					path: metadataEditPath,
					diff: "--- a/src/hashline-edited.ts\n+++ b/src/hashline-edited.ts",
				}),
				{ cwd },
			);
			const renameSourcePath = join(cwd, "src", "before-rename.ts");
			const renameTargetPath = join(cwd, "src", "after-rename.ts");
			await writeFile(renameTargetPath, "renamed file\n");
			const renamed = await selectSource(
				toolBranch(
					"edit",
					{ input: "[src/before-rename.ts#ABCD]\nMV src/after-rename.ts" },
					"renamed edit result",
					{
						path: renameTargetPath,
						sourcePath: renameSourcePath,
						move: renameTargetPath,
						diff: "--- a/src/before-rename.ts\n+++ b/src/after-rename.ts",
					},
				),
				{ cwd },
			);
			const applyPatchPath = join(cwd, "src", "apply-patched.ts");
			await writeFile(applyPatchPath, "old\n");
			const applyPatch = await selectSource(
				[
					toolCallEntry("assistant-call", "call-apply-patch", "apply_patch", {
						input: [
							"*** Begin Patch",
							"*** Update File: src/apply-patched.ts",
							"@@",
							"-old",
							"+new",
							"*** End Patch",
						].join("\n"),
					}),
					toolResultEntry("tool-result", "call-apply-patch", "edit", "applied patch", {
						path: applyPatchPath,
						diff: "--- a/src/apply-patched.ts\n+++ b/src/apply-patched.ts",
					}),
				],
				{ cwd },
			);
			const written = await selectSource(
				toolBranch("write", { path: "src/created.ts", content: "new file" }, "write result"),
				{ cwd },
			);

			expect(edited?.editorFilePath).toBe(editPath);
			expect(metadataEdit?.editorFilePath).toBe(metadataEditPath);
			expect(renamed?.editorFilePath).toBe(renameTargetPath);
			expect(applyPatch?.editorFilePath).toBe(applyPatchPath);
			expect(written?.editorFilePath).toBe(writePath);
		});
	});

	it("rejects URLs, internal resources, and directories", async () => {
		await withTempDir(async cwd => {
			const directory = join(cwd, "listing");
			await mkdir(directory);
			const external = await selectSource(
				toolBranch("read", { path: "https://example.invalid/file.ts" }, "remote excerpt", {
					kind: "url",
					url: "https://example.invalid/file.ts",
					resolvedPath: join(cwd, "cache.ts"),
				}),
				{ cwd },
			);
			const internal = await selectSource(
				toolBranch("read", { path: "skill://example/SKILL.md" }, "internal resource", {
					resolvedPath: join(cwd, "skill-cache.md"),
					meta: { source: { type: "internal", value: "skill://example/SKILL.md" } },
				}),
				{ cwd },
			);
			const internalBackingPath = join(cwd, "internal-resource-backing.md");
			const internalSourceEdit = await selectSource(
				toolBranch(
					"apply_patch",
					{
						input: [
							"*** Begin Patch",
							"*** Update File: local://scratch.md",
							"@@",
							"-old",
							"+new",
							"*** End Patch",
						].join("\n"),
					},
					"internal edit result",
					{ path: internalBackingPath, diff: "" },
				),
				{ cwd },
			);
			const internalMoveEdit = await selectSource(
				toolBranch(
					"apply_patch",
					{
						input: [
							"*** Begin Patch",
							"*** Update File: src/source.md",
							"*** Move to: local://moved.md",
							"@@",
							"-old",
							"+new",
							"*** End Patch",
						].join("\n"),
					},
					"internal move result",
					{ path: internalBackingPath, diff: "" },
				),
				{ cwd },
			);
			const directoryRead = await selectSource(
				toolBranch("read", { path: "listing" }, "directory listing", {
					isDirectory: true,
					resolvedPath: directory,
				}),
				{ cwd },
			);

			expect(external?.editorFilePath).toBeUndefined();
			expect(internal?.editorFilePath).toBeUndefined();
			expect(internalSourceEdit?.editorFilePath).toBeUndefined();
			expect(internalMoveEdit?.editorFilePath).toBeUndefined();
			expect(directoryRead?.editorFilePath).toBeUndefined();
		});
	});

	it("rejects ambiguous multi-file results and non-file tools", async () => {
		await withTempDir(async cwd => {
			const multipleReads = await selectSource(
				toolBranch("read", { path: "src/one.ts;src/two.ts" }, "two excerpts", {
					displayReadTargets: ["src/one.ts", "src/two.ts"],
					displayReadTargetLinks: [join(cwd, "src/one.ts"), join(cwd, "src/two.ts")],
				}),
				{ cwd },
			);
			const multipleEdits = await selectSource(
				toolBranch("edit", { path: "src/one.ts", input: "multi-file patch" }, "two edits", {
					perFileResults: [{ path: join(cwd, "src/one.ts") }, { path: join(cwd, "src/two.ts") }],
				}),
				{ cwd },
			);
			const nonFileTool = await selectSource(toolBranch("grep", { path: "src/one.ts", pattern: "value" }), { cwd });

			expect(multipleReads?.editorFilePath).toBeUndefined();
			expect(multipleEdits?.editorFilePath).toBeUndefined();
			expect(nonFileTool?.editorFilePath).toBeUndefined();
		});
	});

	it("does not infer a file from plain transcript prose", async () => {
		await withTempDir(async cwd => {
			const userEntry: SessionMessageEntry = {
				type: "message",
				id: "user-message",
				parentId: null,
				timestamp: "2026-10-10T00:00:00.000Z",
				message: { role: "user", content: "Please inspect /tmp/private.ts", timestamp: 1 } as AgentMessage,
			};
			const source = await selectSource([userEntry], { cwd, keys: [ENTER] });

			expect(source?.editorFilePath).toBeUndefined();
			expect(source?.text).toBe("Please inspect /tmp/private.ts");
		});
	});
});
