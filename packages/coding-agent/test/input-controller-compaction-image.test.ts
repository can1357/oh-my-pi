/**
 * Images attached during compaction must survive the compaction queue.
 *
 * Previously, typing a steer/follow-up message with a pending clipboard image
 * while the session was compacting was rejected outright ("Retry after it
 * completes to send images"). Now `queueCompactionMessage` carries the images,
 * and `flushCompactionQueue` forwards them to the session on delivery.
 *
 * Contracts defended here:
 *   - `queueCompactionMessage(text, mode, images)` stores the images on the
 *     queued entry and consumes the pending-image state (so the next message
 *     does not resend them).
 *   - On flush, the first queued prompt forwards its images via `session.prompt`.
 *   - On a `willRetry` flush, a queued follow-up forwards its images via
 *     `session.followUp` (the `#deliverQueuedMessage` path).
 *   - When `restoreQueuedMessagesToEditor` reinjects queued image-messages
 *     into a draft that already holds pending image(s), the merged text's
 *     `[Image #N]` markers stay aligned with the merged `pendingImages` order
 *     (#2531). Bug-by-design before that fix: queued markers (1..K) collided
 *     with the draft's leading markers and submit picked the wrong images.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { RestoredQueuedMessage } from "@oh-my-pi/pi-coding-agent/session/agent-session";

beforeAll(() => {
	initTheme();
});

type PromptOpts = { streamingBehavior?: "steer" | "followUp"; images?: ImageContent[] } | undefined;

function makeCtx(initialQueue: CompactionQueuedMessage[] = []) {
	const promptCalls: Array<{ text: string; opts: PromptOpts }> = [];
	const steerCalls: Array<{ text: string; images?: ImageContent[] }> = [];
	const followUpCalls: Array<{ text: string; images?: ImageContent[] }> = [];

	const session = {
		isStreaming: false,
		isCompacting: false,
		extensionRunner: undefined,
		customCommands: [] as Array<{ command: { name: string } }>,
		getQueuedMessages: () => ({ steering: [] as string[], followUp: [] as string[] }),
		clearQueue: () => ({ steering: [] as RestoredQueuedMessage[], followUp: [] as RestoredQueuedMessage[] }),
		prompt: mock(async (text: string, opts?: PromptOpts): Promise<void> => {
			promptCalls.push({ text, opts });
		}),
		steer: mock(async (text: string, images?: ImageContent[]): Promise<void> => {
			steerCalls.push({ text, images });
		}),
		followUp: mock(async (text: string, images?: ImageContent[]): Promise<void> => {
			followUpCalls.push({ text, images });
		}),
	};

	let editorText = "";

	const ctx = {
		session,
		compactionQueuedMessages: [...initialQueue],
		pendingMessagesContainer: { clear: () => {}, addChild: () => {}, removeChild: () => {} },
		editor: {
			addToHistory: () => {},
			clearDraft: (_historyText?: string) => {
				editorText = "";
				ctx.editor.pendingImages = [];
				ctx.editor.pendingImageLinks = [];
				ctx.editor.imageLinks = undefined;
			},
			setText: (text: string) => {
				editorText = text;
			},
			// The stub skips chip collapsing so assertions read the wire-format text.
			setCollapsedText: (text: string) => {
				editorText = text;
			},
			getText: () => editorText,
			imageLinks: undefined as (string | undefined)[] | undefined,
			pendingImages: [] as ImageContent[],
			pendingImageLinks: [] as (string | undefined)[],
		},
		keybindings: { getDisplayString: () => "Alt+Up" },
		fileSlashCommands: new Set<string>(),
		locallySubmittedUserSignatures: new Set<string>(),
		isKnownSlashCommand: (text: string) => text.startsWith("/"),
		recordLocalSubmission: () => () => {},
		async withLocalSubmission<T>(_text: string, fn: () => Promise<T>): Promise<T> {
			return await fn();
		},
		updatePendingMessagesDisplay: () => {},
		showError: () => {},
		showStatus: () => {},
	} as unknown as InteractiveModeContext;

	return { ctx, session, promptCalls, steerCalls, followUpCalls };
}

const img = (data: string): ImageContent => ({ type: "image", mimeType: "image/png", data });

describe("compaction queue image forwarding", () => {
	test("queueCompactionMessage stores images and consumes pending-image state", () => {
		const image = img("aGVsbG8=");
		const { ctx } = makeCtx();
		ctx.editor.pendingImages = [image];
		ctx.editor.pendingImageLinks = ["clipboard"];
		ctx.editor.imageLinks = ["clipboard"];

		new UiHelpers(ctx).queueCompactionMessage("look at this screenshot", "steer", [image]);

		expect(ctx.compactionQueuedMessages).toEqual([
			{ text: "look at this screenshot", mode: "steer", images: [image] },
		]);
		// Pending state is consumed so the next message does not resend the image.
		expect(ctx.editor.pendingImages).toEqual([]);
		expect(ctx.editor.pendingImageLinks).toEqual([]);
		expect(ctx.editor.imageLinks).toBeUndefined();
	});

	test("empty image list is normalized to undefined on the queued entry", () => {
		const { ctx } = makeCtx();
		new UiHelpers(ctx).queueCompactionMessage("no images here", "followUp", []);
		expect(ctx.compactionQueuedMessages).toEqual([{ text: "no images here", mode: "followUp", images: undefined }]);
	});

	test("flush forwards the first queued prompt's images via session.prompt", async () => {
		const image = img("d29ybGQ=");
		const { ctx, promptCalls } = makeCtx([{ text: "describe this", mode: "steer", images: [image] }]);

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		await Promise.resolve();
		await Promise.resolve();

		expect(promptCalls).toHaveLength(1);
		expect(promptCalls[0].text).toBe("describe this");
		expect(promptCalls[0].opts?.images).toEqual([image]);
	});

	test("willRetry flush forwards a follow-up's images via session.followUp", async () => {
		const image = img("Zm9v");
		const { ctx, followUpCalls } = makeCtx([{ text: "and this one", mode: "followUp", images: [image] }]);

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: true });

		expect(followUpCalls).toEqual([{ text: "and this one", images: [image] }]);
	});
});

describe("compaction queue Alt+Up restore", () => {
	test("restoreQueuedMessagesToEditor drains a compaction-queued skill", () => {
		const { ctx } = makeCtx([{ text: "/skill:foo bar", mode: "followUp", images: undefined }]);
		const restored = new InputController(ctx).restoreQueuedMessagesToEditor();
		expect(restored).toBe(1);
		expect(ctx.editor.getText()).toBe("/skill:foo bar");
		expect(ctx.compactionQueuedMessages).toEqual([]);
	});

	test("restored compaction images return to the pending-image buffer", () => {
		const image = img("YmF6");
		const { ctx } = makeCtx([{ text: "look", mode: "steer", images: [image] }]);
		const restored = new InputController(ctx).restoreQueuedMessagesToEditor();
		expect(restored).toBe(1);
		expect(ctx.editor.pendingImages).toEqual([image]);
	});

	test("session and compaction queues restore in pending-bar order", () => {
		const { ctx, session } = makeCtx([
			{ text: "compaction steer", mode: "steer", images: undefined },
			{ text: "compaction followup", mode: "followUp", images: undefined },
		]);
		session.clearQueue = () => ({
			steering: [{ text: "session steer" }],
			followUp: [{ text: "session followup" }],
		});
		const restored = new InputController(ctx).restoreQueuedMessagesToEditor();
		expect(restored).toBe(4);
		expect(ctx.editor.getText()).toBe("session steer\n\ncompaction steer\n\nsession followup\n\ncompaction followup");
	});
});

/**
 * Restore path: when the editor draft already holds pending image(s) and a
 * queued image-message is restored (Alt+Up, Esc-abort, …), the merged text's
 * `[Image #N]` markers must still map positionally to `pendingImages`. The
 * old code prepended queued text but appended queued images, so the queued
 * markers (1..K) collided with the draft markers (1..M) and resolved to the
 * wrong images at submit time.
 */
describe("restoreQueuedMessagesToEditor image marker alignment", () => {
	function makeRestoreCtx(opts: {
		draftText?: string;
		draftImages?: ImageContent[];
		queued?: { text: string; images?: ImageContent[] }[];
	}) {
		let editorText = opts.draftText ?? "";
		const editor = {
			setText: (text: string) => {
				editorText = text;
			},
			// The stub skips chip collapsing so assertions read the wire-format text.
			setCollapsedText: (text: string) => {
				editorText = text;
			},
			getText: () => editorText,
			addToHistory: () => {},
			clearDraft: (_historyText?: string) => {
				editorText = "";
				editor.pendingImages = [];
				editor.pendingImageLinks = [];
				editor.imageLinks = undefined;
			},
			imageLinks: undefined as (string | undefined)[] | undefined,
			pendingImages: opts.draftImages ? [...opts.draftImages] : ([] as ImageContent[]),
			pendingImageLinks: opts.draftImages ? opts.draftImages.map(() => undefined) : ([] as (string | undefined)[]),
		};
		const session = {
			clearQueue: mock(() => ({ steering: opts.queued ?? [], followUp: [] })),
			abort: mock(async () => {}),
		};
		const ctx = {
			session,
			editor,
			compactionQueuedMessages: [],
			locallySubmittedUserSignatures: new Set<string>(),
			updatePendingMessagesDisplay: () => {},
		} as unknown as InteractiveModeContext;
		return { ctx, editor };
	}

	test("renumbers queued markers when the draft already holds a pending image", () => {
		const draftImg = img("ZHJhZnQ=");
		const queuedImg = img("cXVldWVk");
		const { ctx, editor } = makeRestoreCtx({
			draftText: "[Image #1] draft text",
			draftImages: [draftImg],
			queued: [{ text: "[Image #1] queued text", images: [queuedImg] }],
		});

		const restored = new InputController(ctx).restoreQueuedMessagesToEditor();

		// The draft marker stays at #1 (its image kept slot 0); the queued
		// marker is bumped to #2 because the queued image is appended at slot 1.
		expect(restored).toBe(1);
		expect(editor.getText()).toBe("[Image #2] queued text\n\n[Image #1] draft text");
		expect(ctx.editor.pendingImages).toEqual([draftImg, queuedImg]);
		// Marker → image positional mapping after restore.
		expect(ctx.editor.pendingImages[0]).toBe(draftImg); // matches [Image #1]
		expect(ctx.editor.pendingImages[1]).toBe(queuedImg); // matches [Image #2]
	});

	test("preserves the WxH metadata tail when renumbering", () => {
		const draftImg = img("ZHJhZnQ=");
		const queuedImg = img("cXVldWVk");
		const { ctx, editor } = makeRestoreCtx({
			draftText: "[Image #1, 100x100]",
			draftImages: [draftImg],
			queued: [{ text: "look [Image #1, 800x600] now", images: [queuedImg] }],
		});

		new InputController(ctx).restoreQueuedMessagesToEditor();

		expect(editor.getText()).toBe("look [Image #2, 800x600] now\n\n[Image #1, 100x100]");
	});

	test("accumulates the offset across multiple queued image-messages", () => {
		const draftImg = img("ZHJhZnQ=");
		const queued1 = img("cTE=");
		const queued2a = img("cTJh");
		const queued2b = img("cTJi");
		const { ctx, editor } = makeRestoreCtx({
			draftText: "see [Image #1]",
			draftImages: [draftImg],
			queued: [
				{ text: "first [Image #1]", images: [queued1] },
				{ text: "second [Image #1] and [Image #2]", images: [queued2a, queued2b] },
			],
		});

		new InputController(ctx).restoreQueuedMessagesToEditor();

		// msg1 markers shift by 1 (draft images), msg2 markers shift by 1+1=2.
		expect(editor.getText()).toBe("first [Image #2]\n\nsecond [Image #3] and [Image #4]\n\nsee [Image #1]");
		expect(ctx.editor.pendingImages).toEqual([draftImg, queued1, queued2a, queued2b]);
	});

	test("leaves the queued text untouched when the draft has no pending images", () => {
		const queuedImg = img("cXVldWVk");
		const { ctx, editor } = makeRestoreCtx({
			queued: [{ text: "[Image #1] queued", images: [queuedImg] }],
		});

		new InputController(ctx).restoreQueuedMessagesToEditor();

		expect(editor.getText()).toBe("[Image #1] queued");
		expect(ctx.editor.pendingImages).toEqual([queuedImg]);
	});
});
