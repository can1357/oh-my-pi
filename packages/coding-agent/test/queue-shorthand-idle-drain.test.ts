import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Context, ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext, SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
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

	it("dispatches the first item and delivers the rest one-per-yield in order", async () => {
		const contexts: Context[] = [];
		const mock = createMockModel({
			handler: (context: Context) => {
				contexts.push(context);
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
		// Faithful stand-in for the interactive run loop: onInputCallback only
		// resolves the input promise; the actual session.prompt() for the first item
		// runs later (a queued microtask here), and the submission settles (as
		// submitInteractiveInput's finally does) once that prompt has dispatched.
		const runLoop = { session };
		const onInputCallback = vi.fn((submission: SubmittedUserInput) => {
			queueMicrotask(() => {
				void (async () => {
					try {
						await runLoop.session.prompt(submission.text, {
							images: submission.images,
							streamingBehavior: submission.streamingBehavior,
						});
					} finally {
						submission.onSettled?.();
					}
				})();
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
		await editor.onSubmit?.(input);

		await session.waitForIdle();

		// The seed turn is contexts[0]; the three queued items follow in order.
		const queued = contexts.slice(1).map(lastUserText);
		expect(queued).toEqual(["ITEM ONE", "ITEM TWO", "ITEM THREE"]);
	});
});
