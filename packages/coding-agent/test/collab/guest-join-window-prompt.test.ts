import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { generateRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { formatCollabLink, generateRoomId } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Regression (issue #11067): `omp join` boots a full local session and only
 * installs `ctx.collabGuest` after the host snapshot finishes replicating.
 * A prompt typed during that sync window has no guest to forward to, so it used
 * to run against the guest's own local model — failing with
 * "No API key found for <guest's default provider>" even though the host owns
 * the credential. `ctx.collabJoining` now holds such prompts until the join
 * completes.
 *
 * Contract: while a join is in flight (`collabJoining` set, `collabGuest`
 * unset) a free-text submit must NOT reach the local session prompt. The real
 * editor clears its buffer before invoking `onSubmit`, so the controller must
 * restore the submitted text and image chips while showing a status hint. Once
 * the join settles the flag clears and prompts flow normally.
 */

type FakeEditor = {
	onSubmit?: (text: string) => Promise<void>;
	submit(text: string): Promise<void>;
	imageLinks?: readonly (string | undefined)[];
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
	setText(text: string): void;
	getText(): string;
	getExpandedText(): string;
	setCollapsedText(text: string): void;
	composerChips(): unknown[];
	addToHistory(text: string): void;
	clearDraft(historyText?: string): void;
	setActionKeys(action: string, keys: string[]): void;
	setCustomKeyHandler(key: string, handler: () => void): void;
	clearCustomKeyHandlers(): void;
};

function createContext() {
	let editorText = "";
	const steer = vi.fn(async (_text: string, _images?: unknown) => {});
	const prompt = vi.fn(async () => {});
	const followUp = vi.fn(async () => {});
	const startPendingSubmission = vi.fn((submission: unknown) => submission);
	const showStatus = vi.fn();
	const addToHistory = vi.fn();
	const requestRender = vi.fn();

	const editor: FakeEditor = {
		async submit(text: string) {
			// Mirrors Editor.#submitValue: the visible buffer and atom table are
			// cleared before the callback receives the expanded submission.
			editorText = "";
			await this.onSubmit?.(text);
		},
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		setText(text: string) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		getExpandedText() {
			return editorText;
		},
		setCollapsedText(text: string) {
			editorText = text;
		},
		composerChips() {
			return [];
		},
		addToHistory,
		clearDraft(historyText?: string) {
			if (historyText !== undefined) addToHistory(historyText);
			editorText = "";
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
		setActionKeys: vi.fn(),
		setCustomKeyHandler: vi.fn(),
		clearCustomKeyHandlers: vi.fn(),
	};

	const session = {
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		isEvalRunning: false,
		extensionRunner: undefined,
		settings: Settings.isolated({}),
		steer,
		prompt,
		followUp,
		maybeStartTitleGeneration: vi.fn(),
		queuedMessageCount: 0,
		customCommands: [],
		promptTemplates: [],
		getQueuedMessages: () => ({ steering: [], followUp: [] }),
	} as unknown as InteractiveModeContext["session"];

	const ctx = {
		editor: editor as unknown as InteractiveModeContext["editor"],
		ui: { requestRender } as unknown as InteractiveModeContext["ui"],
		session,
		settings: session.settings,
		sessionManager: { getSessionName: () => "named-session" } as InteractiveModeContext["sessionManager"],
		compactionQueuedMessages: [] as InteractiveModeContext["compactionQueuedMessages"],
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		locallySubmittedUserSignatures: new Set<string>(),
		isKnownSlashCommand: () => false,
		showStatus,
		collabJoining: false,
		collabGuest: undefined,
		recordLocalSubmission(this: InteractiveModeContext, text: string, imageCount = 0) {
			const sig = `${text}\u0000${imageCount}`;
			this.locallySubmittedUserSignatures.add(sig);
			return () => {
				this.locallySubmittedUserSignatures.delete(sig);
			};
		},
		async withLocalSubmission<T>(
			this: InteractiveModeContext,
			text: string,
			fn: () => Promise<T>,
			options?: { imageCount?: number },
		): Promise<T> {
			const dispose = this.recordLocalSubmission(text, options?.imageCount ?? 0);
			try {
				return await fn();
			} catch (err) {
				dispose();
				throw err;
			}
		},
		startPendingSubmission,
		onInputCallback: undefined,
		updatePendingMessagesDisplay: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		showError: vi.fn(),
		isBashMode: false,
		isPythonMode: false,
	} as unknown as InteractiveModeContext;

	return { ctx, editor, spies: { steer, prompt, followUp, startPendingSubmission, showStatus, requestRender } };
}

describe("InputController collab join window", () => {
	it("restores typed text and image chips while a collab join is still syncing", async () => {
		const { ctx, editor, spies } = createContext();
		const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };
		const imageLink = "file:///tmp/collab-draft.png";
		const text = "is agent working? [Image #1]";
		ctx.collabJoining = true;
		ctx.collabGuest = undefined;
		editor.setText(text);
		editor.pendingImages = [image];
		editor.pendingImageLinks = [imageLink];
		editor.imageLinks = editor.pendingImageLinks;
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.submit(text);

		expect(spies.prompt).not.toHaveBeenCalled();
		expect(spies.steer).not.toHaveBeenCalled();
		expect(editor.getText()).toBe(text);
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.pendingImageLinks).toEqual([imageLink]);
		expect(editor.imageLinks).toEqual([imageLink]);
		expect(spies.showStatus).toHaveBeenCalledTimes(1);
		expect(spies.showStatus.mock.calls[0]?.[0]).toMatch(/collab/i);
		expect(spies.requestRender).toHaveBeenCalledTimes(1);
	});

	it("holds a `=> ` queue-shorthand prompt while a collab join is still syncing", async () => {
		const { ctx, editor, spies } = createContext();
		const text = "=> investigate this";
		ctx.collabJoining = true;
		ctx.collabGuest = undefined;
		editor.setText(text);
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.submit(text);

		// The queue path must not reach any local dispatch during the join.
		expect(spies.prompt).not.toHaveBeenCalled();
		expect(spies.followUp).not.toHaveBeenCalled();
		expect(spies.startPendingSubmission).not.toHaveBeenCalled();
		expect(editor.getText()).toBe(text);
		expect(spies.showStatus).toHaveBeenCalledTimes(1);
		expect(spies.showStatus.mock.calls[0]?.[0]).toMatch(/collab/i);
	});

	it("holds a Ctrl+Enter follow-up prompt while a collab join is still syncing", async () => {
		const { ctx, editor, spies } = createContext();
		const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };
		const imageLink = "file:///tmp/collab-followup.png";
		const text = "wrap up [Image #1]";
		ctx.collabJoining = true;
		ctx.collabGuest = undefined;
		editor.setText(text);
		editor.pendingImages = [image];
		editor.pendingImageLinks = [imageLink];
		editor.imageLinks = editor.pendingImageLinks;
		const controller = new InputController(ctx);

		await controller.handleFollowUp();

		expect(spies.prompt).not.toHaveBeenCalled();
		expect(spies.followUp).not.toHaveBeenCalled();
		expect(editor.getText()).toBe(text);
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.pendingImageLinks).toEqual([imageLink]);
		expect(spies.showStatus).toHaveBeenCalledTimes(1);
		expect(spies.showStatus.mock.calls[0]?.[0]).toMatch(/collab/i);
	});

	it("runs prompts locally once the join window has closed", async () => {
		const { ctx, editor, spies } = createContext();
		ctx.collabJoining = false;
		ctx.collabGuest = undefined;
		editor.setText("is agent working?");
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await editor.submit("is agent working?");

		expect(spies.prompt).toHaveBeenCalledWith("is agent working?", {
			streamingBehavior: "steer",
			images: undefined,
		});
		expect(spies.showStatus).not.toHaveBeenCalled();
	});
});

describe("CollabGuestLink join guard", () => {
	it("arms before room-key import and clears when the import fails", async () => {
		const keyImport = Promise.withResolvers<CryptoKey>();
		vi.spyOn(crypto.subtle, "importKey").mockReturnValueOnce(keyImport.promise);
		const ctx = { collabJoining: false } as unknown as InteractiveModeContext;
		const guest = new CollabGuestLink(ctx);
		const link = formatCollabLink("https://relay.omp.test", generateRoomId(), generateRoomKey());

		const join = guest.join(link);

		expect(ctx.collabJoining).toBe(true);
		keyImport.reject(new Error("room-key import failed"));
		await expect(join).rejects.toThrow("room-key import failed");
		expect(ctx.collabJoining).toBe(false);
	});
});
