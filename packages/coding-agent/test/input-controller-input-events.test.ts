import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { BlobPutOptions, BlobPutResult } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const ENTER = "\r";
const FOLLOW_UP = "\x1b[13;5u";
const originalImage: ImageContent = { type: "image", mimeType: "image/png", data: "b3JpZ2luYWw=" };

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
		followUp: vi.fn(async (_text: string, _images?: ImageContent[]) => {}),
		promptCustomMessage: vi.fn(async () => true),
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
	ctx.queueCompactionMessage = (text, mode, images, options) =>
		helpers.queueCompactionMessage(text, mode, images, options);
	const controller = new InputController(ctx);
	ctx.handleQueueCommand = (message, detached) => controller.handleQueueCommand(message, detached);
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
	it("Ctrl+Enter /queue queues the attachments of its detached draft", async () => {
		const h = await createHarness(() => {});
		h.draftWithImage("/queue inspect [Image #1]");
		await h.pressSubmit(FOLLOW_UP);
		expect(h.session.followUp.mock.calls).toEqual([["inspect [Image #1]", [originalImage]]]);
	});
});
