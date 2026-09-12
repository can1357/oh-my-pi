import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory, InputEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { getEditorTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { BlobPutOptions, BlobPutResult } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const ENTER = "\r";
const FOLLOW_UP = "\x1b[13;5u";
const originalImage: ImageContent = { type: "image", mimeType: "image/png", data: "b3JpZ2luYWw=" };
const transformedImage: ImageContent = { type: "image", mimeType: "image/jpeg", data: "cmVwbGFjZW1lbnQ=" };

async function createHarness(factory: ExtensionFactory) {
	const runtime = new ExtensionRuntime();
	const generatedMessages: Array<string | (TextContent | ImageContent)[]> = [];
	runtime.sendUserMessage = (content?: string | (TextContent | ImageContent)[]) => {
		if (content !== undefined) generatedMessages.push(content);
	};
	const sessionManager = SessionManager.inMemory(process.cwd());
	const blobs = new Map<string, Buffer>();
	vi.spyOn(sessionManager, "putBlob").mockImplementation(
		async (data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> => {
			const hash = new Bun.CryptoHasher("sha256").update(data).digest("hex");
			const displayPath = `blob:${hash}.${options?.extension ?? "bin"}`;
			blobs.set(displayPath, data);
			return { hash, path: `blob:${hash}`, displayPath, ref: `blob:sha256:${hash}` };
		},
	);
	const extension = await loadExtensionFromFactory(
		factory,
		process.cwd(),
		new EventBus(),
		runtime,
		"native-input-test",
	);
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, {} as ModelRegistry);
	const editor = new CustomEditor(getEditorTheme());
	const prompt = vi.fn(async (_text: string, _options?: PromptOptions) => true);
	const session = {
		extensionRunner: runner,
		isStreaming: true,
		isCompacting: false,
		queuedMessageCount: 0,
		prompt,
		abort: vi.fn(async () => {}),
		maybeStartTitleGeneration: vi.fn(),
	};
	const ctx = {
		editor,
		session,
		viewSession: session,
		sessionManager,
		settings: Settings.isolated({}),
		keybindings: KeybindingsManager.inMemory(),
		ui: {
			requestRender: vi.fn(),
			addInputListener: vi.fn(),
			addStartListener: vi.fn(),
			getFocused: () => editor,
			terminal: { write: vi.fn() },
		},
		compactionQueuedMessages: [],
		skillCommands: new Map<string, Skill>(),
		fileSlashCommands: new Set<string>(),
		locallySubmittedUserSignatures: new Set<string>(),
		mcpTestEscapeHandlers: new Set<() => void>(),
		isBashMode: false,
		isPythonMode: false,
		lastSigintTime: 0,
		hasActiveBtw: () => false,
		hasActiveOmfg: () => false,
		hasActiveCleanse: () => false,
		updateEditorBorderColor: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		handleClearCommand: vi.fn(),
		resetDisplayAfterAppearanceRefresh: vi.fn(),
		shutdown: vi.fn(async () => {}),
		clearEditor: () => editor.clearDraft(),
		withLocalSubmission: async <T>(_text: string, submit: () => Promise<T>) => submit(),
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	ctx.queueCompactionMessage = (text, mode, images) => helpers.queueCompactionMessage(text, mode, images);
	const controller = new InputController(ctx);
	controller.setupKeyHandlers();
	controller.setupEditorSubmitHandler();
	const onSubmit = editor.onSubmit;
	let enterCompletion: Promise<void> | undefined;
	editor.onSubmit = text => {
		enterCompletion = Promise.resolve(onSubmit?.(text));
		return enterCompletion;
	};
	const followUp = vi.spyOn(controller, "handleFollowUp");
	function pressSubmit(key: string): Promise<void> {
		enterCompletion = undefined;
		const followUpCount = followUp.mock.calls.length;
		editor.handleInput(key);
		if (key === ENTER && enterCompletion) return enterCompletion;
		if (key === FOLLOW_UP && followUp.mock.calls.length === followUpCount + 1) {
			return followUp.mock.results[followUpCount].value as Promise<void>;
		}
		throw new Error("The editor did not dispatch the submit key");
	}
	function draftWithImage(text = "original [Image #1]") {
		editor.pendingImages = [originalImage];
		editor.pendingImageLinks = ["local://original.png"];
		editor.imageLinks = editor.pendingImageLinks;
		editor.setText(text);
	}
	return { ctx, editor, session, prompt, runner, blobs, generatedMessages, pressSubmit, draftWithImage };
}

afterEach(() => vi.restoreAllMocks());

describe("interactive native input ingress", () => {
	it("Ctrl+Enter chains partial text/image transforms and restores materialized images after rejection", async () => {
		const seen: InputEvent[] = [];
		const h = await createHarness(pi => {
			pi.on("input", event => {
				seen.push(event);
				return { text: "changed [Image #1]" };
			});
			pi.on("input", event => {
				seen.push(event);
				return { images: [transformedImage] };
			});
			pi.on("input", event => {
				seen.push(event);
				return { text: `${event.text} final` };
			});
		});
		h.prompt.mockRejectedValueOnce(new Error("queue rejected"));
		h.draftWithImage();

		await h.pressSubmit(FOLLOW_UP);

		expect(seen).toEqual([
			{ type: "input", source: "interactive", text: "original [Image #1]", images: [originalImage] },
			{ type: "input", source: "interactive", text: "changed [Image #1]", images: [originalImage] },
			{ type: "input", source: "interactive", text: "changed [Image #1]", images: [transformedImage] },
		]);
		expect(h.prompt.mock.calls).toEqual([
			["changed [Image #1] final", { streamingBehavior: "followUp", images: [transformedImage] }],
		]);
		expect(h.editor.pendingImages).toEqual([transformedImage]);
		const link = h.editor.pendingImageLinks[0];
		if (!link) throw new Error("transformed image has no restored link");
		expect(link.endsWith(".jpg")).toBe(true);
		expect(h.blobs.get(link)?.toString()).toBe("replacement");
		expect(h.editor.imageLinks).toEqual([link]);
		expect(h.ctx.showError).toHaveBeenCalledWith("queue rejected");
	});

	for (const [label, key] of [
		["Enter", ENTER],
		["Ctrl+Enter", FOLLOW_UP],
	] as const) {
		it(`${label} stops handlers and built-in commands when native input is handled`, async () => {
			const downstream = vi.fn();
			const h = await createHarness(pi => {
				pi.on("input", () => ({ handled: true }));
				pi.on("input", downstream);
			});
			h.editor.setText("/clear");

			await h.pressSubmit(key);

			expect(downstream).not.toHaveBeenCalled();
			expect(h.ctx.handleClearCommand).not.toHaveBeenCalled();
			expect(h.prompt).not.toHaveBeenCalled();
			expect(h.editor.getText()).toBe("");
		});

		it(`${label} consumes transformed-empty input before compaction queueing`, async () => {
			const h = await createHarness(pi => {
				pi.on("input", () => ({ text: "  ", images: [] }));
			});
			h.session.isCompacting = true;
			h.draftWithImage();

			await h.pressSubmit(key);

			expect(h.ctx.compactionQueuedMessages).toEqual([]);
			expect(h.prompt).not.toHaveBeenCalled();
			expect(h.editor.getText()).toBe("");
			expect(h.editor.pendingImages).toEqual([]);
			expect(h.editor.pendingImageLinks).toEqual([]);
			expect(h.editor.imageLinks).toBeUndefined();
		});

		it(`${label} excludes focused chat and its command restrictions from main-session hooks`, async () => {
			const input = vi.fn(() => ({ handled: true }));
			const h = await createHarness(pi => pi.on("input", input));
			const focusedPrompt = vi.fn(async () => true);
			Object.defineProperties(h.ctx, {
				focusedAgentId: { value: "focused-task" },
				viewSession: { value: { isStreaming: true, prompt: focusedPrompt } },
			});
			h.editor.setText("focused chat");
			await h.pressSubmit(key);
			expect(focusedPrompt).toHaveBeenCalledWith("focused chat", {
				streamingBehavior: key === ENTER ? "steer" : "followUp",
				images: undefined,
			});
			for (const text of ["/clear", "!echo blocked", "$ print('blocked')"]) {
				h.editor.setText(text);
				await h.pressSubmit(key);
			}
			expect(focusedPrompt).toHaveBeenCalledTimes(1);
			expect(input).not.toHaveBeenCalled();
			expect(h.prompt).not.toHaveBeenCalled();
			expect(h.ctx.handleClearCommand).not.toHaveBeenCalled();
		});
	}

	it("Ctrl+Enter keeps omitted attachments but explicit images:[] removes images and links", async () => {
		let clearImages = false;
		const h = await createHarness(pi => {
			pi.on("input", () => (clearImages ? { text: "text only", images: [] } : { text: "changed [Image #1]" }));
		});
		h.prompt.mockRejectedValue(new Error("rejected"));
		h.draftWithImage();
		await h.pressSubmit(FOLLOW_UP);
		expect(h.editor.pendingImages).toEqual([originalImage]);
		expect(h.editor.pendingImageLinks).toEqual(["local://original.png"]);
		expect(h.blobs.size).toBe(0);

		clearImages = true;
		await h.pressSubmit(FOLLOW_UP);
		expect(h.prompt.mock.calls[1]).toEqual(["text only", { streamingBehavior: "followUp", images: [] }]);
		expect(h.editor.getText()).toBe("text only");
		expect(h.editor.pendingImages).toEqual([]);
		expect(h.editor.pendingImageLinks).toEqual([]);
		expect(h.editor.imageLinks).toBeUndefined();
	});

	it("Enter dispatches input once, while continue shortcuts remain synthetic", async () => {
		const seen: InputEvent[] = [];
		const h = await createHarness(pi => {
			pi.on("input", event => {
				seen.push(event);
				return { text: "transformed" };
			});
		});
		h.editor.setText("original");
		await h.pressSubmit(ENTER);
		expect(seen).toEqual([{ type: "input", source: "interactive", text: "original", images: undefined }]);
		expect(h.prompt.mock.calls).toEqual([["transformed", { streamingBehavior: "steer", images: undefined }]]);

		const callback = vi.fn();
		h.ctx.onInputCallback = callback;
		for (const text of [".", "c"]) {
			h.editor.setText(text);
			await h.pressSubmit(ENTER);
		}
		expect(callback).toHaveBeenCalledTimes(2);
		expect(callback.mock.calls[0][0]).toMatchObject({ synthetic: true, started: true, userInitiated: true });
		expect(seen).toHaveLength(1);
		expect(h.prompt).toHaveBeenCalledTimes(1);
	});

	it("Ctrl+Enter transforms before compacting a skill-shaped input without expanding it", async () => {
		const seen: InputEvent[] = [];
		const h = await createHarness(pi => {
			pi.on("input", event => {
				seen.push(event);
				return { text: "/skill:review changed [Image #1]", images: [transformedImage] };
			});
		});
		h.session.isCompacting = true;
		h.ctx.skillCommands.set("skill:review", {
			name: "review",
			description: "",
			filePath: "unread-skill-path",
			baseDir: process.cwd(),
			source: "test",
		});
		h.draftWithImage();

		await h.pressSubmit(FOLLOW_UP);

		expect(h.ctx.compactionQueuedMessages).toEqual([
			{ text: "/skill:review changed [Image #1]", mode: "followUp", images: [transformedImage] },
		]);
		expect(seen).toHaveLength(1);
		expect(h.prompt).not.toHaveBeenCalled();
		expect(h.editor.pendingImages).toEqual([]);
	});

	it("a delayed Ctrl+Enter handler leaves display, abort and shutdown keys responsive and retains generated work", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const downstream = vi.fn();
		const h = await createHarness(pi => {
			pi.on("input", async () => {
				entered.resolve();
				await release.promise;
				pi.sendUserMessage("handler-generated work");
				return { handled: true };
			});
			pi.on("input", downstream);
		});
		h.editor.setText("local action");
		const submitting = h.pressSubmit(FOLLOW_UP);
		await entered.promise;
		try {
			h.editor.handleInput("\x1bl");
			h.editor.handleInput("\x1b");
			h.editor.handleInput("\x03");
			h.editor.handleInput("\x03");
			expect(h.ctx.resetDisplayAfterAppearanceRefresh).toHaveBeenCalled();
			expect(h.session.abort).toHaveBeenCalledTimes(1);
			expect(h.ctx.shutdown).toHaveBeenCalledTimes(1);
			expect(h.prompt).not.toHaveBeenCalled();
		} finally {
			release.resolve();
			await submitting;
		}
		expect(h.generatedMessages).toEqual(["handler-generated work"]);
		expect(downstream).not.toHaveBeenCalled();
		expect(h.prompt).not.toHaveBeenCalled();
	});
});
