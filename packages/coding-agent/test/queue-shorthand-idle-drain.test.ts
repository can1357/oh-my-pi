import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Context, ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext, SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Newest user-authored text in a provider context — the message that triggered the turn. */
function lastUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message?.role !== "user") continue;
		const content = message.content;
		if (typeof content === "string") return content;
		return content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map(part => part.text)
			.join("");
	}
	return "";
}

describe("queue shorthand on an idle mid-session (#10802)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-queue-idle-drain-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("mock", "mock-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("queues the full list before the first turn finishes, preserving FIFO with later input", async () => {
		const contexts: Context[] = [];
		const firstStarted = Promise.withResolvers<void>();
		const finishFirst = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: async (context: Context) => {
				contexts.push(context);
				if (lastUserText(context) === "ITEM ONE") {
					firstStarted.resolve();
					await finishFirst.promise;
				}
				return { content: ["ok"], stopReason: "stop" };
			},
		});
		const agent = new Agent({
			getApiKey: () => "mock-test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		session.setFollowUpMode("one-at-a-time");

		// Seed a mid-session transcript so the tail is an assistant message — the
		// distinguishing precondition: on an empty transcript the idle-drain gate
		// declines and the bug does not manifest.
		await session.prompt("earlier turn");
		await session.waitForIdle();

		let text = "";
		const editor = {
			onSubmit: undefined as undefined | ((t: string) => Promise<void>),
			getText: () => text,
			setText: (t: string) => {
				text = t;
			},
			setCollapsedText: (t: string) => {
				text = t;
			},
			getExpandedText: () => text,
			composerChips: () => [],
			addToHistory: vi.fn(),
			pendingImages: [] as ImageContent[],
			pendingImageLinks: [] as (string | undefined)[],
			imageLinks: undefined as (string | undefined)[] | undefined,
			clearDraft(historyText?: string) {
				if (historyText !== undefined) this.addToHistory(historyText);
				text = "";
				this.imageLinks = undefined;
				this.pendingImages = [];
				this.pendingImageLinks = [];
			},
		};
		// The run loop submits asynchronously; admission must precede the provider
		// request while completion still waits for the held response.
		const runLoop = { session };
		const submissionTurns: Promise<void>[] = [];
		const onInputCallback = vi.fn((submission: SubmittedUserInput) => {
			queueMicrotask(() => {
				submissionTurns.push(
					(async () => {
						try {
							const admission = {
								onPromptAdmitted: submission.onAdmitted,
								onPromptRejected: submission.onRejected,
							};
							if (submission.skillPrompt) {
								await runLoop.session.promptCustomMessage(submission.skillPrompt.message, {
									...submission.skillPrompt.options,
									...admission,
								});
							} else {
								await runLoop.session.prompt(submission.text, {
									images: submission.images,
									streamingBehavior: submission.streamingBehavior,
									...admission,
								});
							}
						} catch (error) {
							ctx.showError(error instanceof Error ? error.message : String(error));
						} finally {
							submission.onSettled?.();
						}
					})(),
				);
			});
		});

		const ctx = {
			editor,
			session,
			focusedAgentId: undefined,
			collabGuest: undefined,
			showStatus: vi.fn(),
			onInputCallback,
			startPendingSubmission: (input: {
				text: string;
				images?: ImageContent[];
				imageLinks?: (string | undefined)[];
				customType?: string;
				display?: boolean;
				streamingBehavior?: "steer" | "followUp";
			}): SubmittedUserInput => ({ ...input, cancelled: false, started: false }),
			ui: { requestRender: vi.fn() },
			compactionQueuedMessages: [],
			skillCommands: new Map(),
			fileSlashCommands: new Set<string>(),
			withLocalSubmission: async (_text: string, fn: () => Promise<unknown>) => fn(),
			updatePendingMessagesDisplay: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;

		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		const input = "=>\n1. ITEM ONE\n2. ITEM TWO\n3. ITEM THREE";
		editor.setText(input);
		const submitting = editor.onSubmit?.(input);
		await firstStarted.promise;
		try {
			expect(session.getQueuedMessages().followUp).toEqual(["ITEM TWO", "ITEM THREE"]);
			await session.followUp("LATER");
		} finally {
			finishFirst.resolve();
		}
		await submitting;
		await session.waitForIdle();
		expect(contexts.slice(1).map(lastUserText)).toEqual(["ITEM ONE", "ITEM TWO", "ITEM THREE", "LATER"]);
		await session.waitForIdle();
		expect(session.isStreaming).toBe(false);
		authStorage.removeRuntimeApiKey("mock");
		const rejected = "=>\n1. REJECTED\n2. UNSENT";
		editor.setText(rejected);
		await editor.onSubmit?.(rejected);
		await Promise.all(submissionTurns);
		await session.waitForIdle();
		expect(session.getQueuedMessages().followUp).toEqual([]);
		expect(editor.getText()).toBe(rejected);
		expect(contexts.slice(1).map(lastUserText)).toEqual(["ITEM ONE", "ITEM TWO", "ITEM THREE", "LATER"]);
		onInputCallback.mockImplementationOnce(submission => {
			submission.cancelled = true;
			editor.setText(submission.text);
			submission.onSettled?.();
		});
		const cancelled = "=>\n1. CANCELLED\n2. ALSO CANCELLED";
		editor.setText(cancelled);
		await editor.onSubmit?.(cancelled);
		expect(editor.getText()).toBe(cancelled);
		expect(session.getQueuedMessages().followUp).toEqual([]);
		authStorage.setRuntimeApiKey("mock", "mock-test-key");
		const skillPath = path.join(tempDir.path(), "sample.md");
		await Bun.write(skillPath, "---\nname: sample\n---\nGrill the steak thoroughly.\n");
		ctx.skillCommands.set("skill:sample", {
			name: "sample",
			description: "Grilling skill",
			filePath: skillPath,
			baseDir: tempDir.path(),
			source: "test",
		});
		const beforeSkill = contexts.length;
		const skillBatch = "=>\n1. /skill:sample\n2. AFTER SKILL";
		editor.setText(skillBatch);
		await editor.onSubmit?.(skillBatch);
		await Promise.all(submissionTurns);
		await session.waitForIdle();
		expect(lastUserText(contexts[beforeSkill]!)).toContain("Grill the steak thoroughly.");
		expect(lastUserText(contexts[beforeSkill + 1]!)).toBe("AFTER SKILL");
		const beforeCompaction = contexts.length;
		ctx.compactionQueuedMessages.push(
			{ text: "COMPACT FIRST", mode: "steer" },
			{ text: "COMPACT SECOND", mode: "steer" },
			{ text: "COMPACT THIRD", mode: "followUp" },
		);
		const compactionCtx = {
			...ctx,
			isKnownSlashCommand: () => false,
			recordLocalSubmission: () => () => {},
		};
		await new UiHelpers(compactionCtx).flushCompactionQueue({ willRetry: false });
		await session.waitForIdle();
		expect(contexts.slice(beforeCompaction).map(lastUserText)).toEqual([
			"COMPACT FIRST",
			"COMPACT SECOND",
			"COMPACT THIRD",
		]);
	});
});
