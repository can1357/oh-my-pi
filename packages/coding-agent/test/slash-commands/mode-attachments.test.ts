import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type {
	InteractiveModeContext,
	ModeCommandResult,
	SubmittedUserInput,
} from "@oh-my-pi/pi-coding-agent/modes/types";

type Attachments = Pick<SubmittedUserInput, "images" | "imageLinks">;

function createHarness(
	inputResult: { images?: ImageContent[]; text?: string } | Promise<{ images?: ImageContent[]; text?: string }>,
) {
	const oldImage: ImageContent = { type: "image", data: "b2xk", mimeType: "image/png" };
	const handlePlanModeCommand = vi.fn(
		async (_prompt?: string, _input?: Attachments): Promise<ModeCommandResult> => true,
	);
	const handleVibeModeCommand = vi.fn(
		async (_prompt?: string, _input?: Attachments): Promise<ModeCommandResult> => true,
	);
	const handleGoalModeCommand = vi.fn(
		async (_prompt?: string, _input?: Attachments): Promise<ModeCommandResult> => true,
	);
	const handleGuidedGoalCommand = vi.fn(async (_prompt?: string, _input?: Attachments) => true);
	let editorText = "";
	const editor = {
		onSubmit: undefined as undefined | ((text: string) => Promise<void>),
		addToHistory: vi.fn(),
		getText: () => editorText,
		getExpandedText: () => editorText,
		setText(text: string) {
			editorText = text;
		},
		// The stub skips chip collapsing so assertions read the wire-format text.
		setCollapsedText(text: string) {
			editorText = text;
		},
		captureComposerDraft() {
			return { text: editorText, images: [...this.pendingImages], links: [...this.pendingImageLinks] };
		},
		restoreComposerDraft(draft: { text: string; images: ImageContent[]; links: (string | undefined)[] }) {
			editorText = draft.text;
			this.pendingImages = [...draft.images];
			this.pendingImageLinks = [...draft.links];
			this.imageLinks = this.pendingImageLinks.length > 0 ? this.pendingImageLinks : undefined;
		},
		pendingImages: [oldImage],
		pendingImageLinks: ["file:///old.png"] as (string | undefined)[],
		imageLinks: undefined as (string | undefined)[] | undefined,
		clearDraft() {
			editorText = "";
			this.pendingImages = [];
			this.pendingImageLinks = [];
			this.imageLinks = undefined;
		},
	};
	const showError = vi.fn();
	const ctx = {
		editor,
		planModeEnabled: false,
		planModePaused: false,
		vibeModeEnabled: false,
		goalModeEnabled: false,
		goalModePaused: false,
		skillCommands: new Map(),
		fileSlashCommands: new Set(),
		session: {
			isStreaming: false,
			isCompacting: false,
			queuedMessageCount: 0,
			customCommands: [],
			promptTemplates: [],
			extensionRunner: {
				hasHandlers: (event: string) => event === "input",
				emitInput: vi.fn(async () => inputResult),
				getCommand: () => undefined,
			},
		},
		sessionManager: {
			putBlob: vi.fn(async () => ({ displayPath: "file:///replacement.png" })),
		},
		focusedAgentId: undefined,
		collabGuest: undefined,
		ui: { requestRender: vi.fn() },
		compactionQueuedMessages: [],
		updatePendingMessagesDisplay: vi.fn(),
		showStatus: vi.fn(),
		notifyComposerStash: vi.fn(),
		cancelComposerStashNotice: vi.fn(),
		showWarning: vi.fn(),
		showError,
		handlePlanModeCommand,
		handleVibeModeCommand,
		handleGoalModeCommand,
		handleGuidedGoalCommand,
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupEditorSubmitHandler();
	return {
		controller,
		editor,
		showError,
		handlePlanModeCommand,
		handleVibeModeCommand,
		handleGoalModeCommand,
		handleGuidedGoalCommand,
	};
}

describe("mode command attachments", () => {
	it("uses extension-replaced images and regenerated links", async () => {
		const replacements: ImageContent[] = [{ type: "image", data: "bmV3", mimeType: "image/jpeg" }];
		const harness = createHarness({ images: replacements });

		await harness.editor.onSubmit?.("/plan inspect this");

		const input = harness.handlePlanModeCommand.mock.calls[0]?.[1];
		expect(input?.images).toBe(replacements);
		expect(input?.imageLinks).toEqual(["file:///replacement.png"]);
		expect(harness.editor.pendingImages).toEqual([]);
		expect(harness.editor.pendingImageLinks).toEqual([]);
	});

	it("does not submit images removed by an extension", async () => {
		const harness = createHarness({ images: [] });

		await harness.editor.onSubmit?.("/goal keep this private");

		expect(harness.handleGoalModeCommand.mock.calls[0]?.[1]?.images).toEqual([]);
		expect(harness.editor.pendingImages).toEqual([]);
		expect(harness.editor.pendingImageLinks).toEqual([]);
	});

	it("preserves source links when an extension leaves attachments unchanged", async () => {
		const harness = createHarness({});

		await harness.editor.onSubmit?.("/vibe inspect this [Image #1]");

		expect(harness.handleVibeModeCommand).toHaveBeenCalledWith(
			"inspect this [Image #1]",
			expect.objectContaining({ imageLinks: ["file:///old.png"] }),
		);
		expect(harness.editor.pendingImages).toEqual([]);
		expect(harness.editor.pendingImageLinks).toEqual([]);
	});
	it("restores attachments when a mode command does not submit", async () => {
		const harness = createHarness({});
		harness.handleGoalModeCommand.mockResolvedValueOnce(false);

		await harness.editor.onSubmit?.("/goal blocked [Image #1]");

		expect(harness.editor.getText()).toBe("");
		expect(harness.editor.pendingImages).toHaveLength(1);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///old.png"]);
	});

	for (const [command, handler] of [
		["/plan blocked [Image #1]", "handlePlanModeCommand"],
		["/vibe blocked [Image #1]", "handleVibeModeCommand"],
		["/guided-goal blocked [Image #1]", "handleGuidedGoalCommand"],
	] as const) {
		it(`keeps ${command} rejected text only when a stash exists`, async () => {
			const attemptedImage: ImageContent = { type: "image", data: "bmV3", mimeType: "image/png" };
			for (const withStash of [false, true]) {
				const harness = createHarness({});
				const stashedImage = harness.editor.pendingImages[0];
				if (withStash) {
					harness.editor.setText("original draft [Image #1]");
					harness.controller.handleStash();
				}
				harness.editor.setText(command);
				harness.editor.pendingImages = [attemptedImage];
				harness.editor.pendingImageLinks = ["file:///attempted.png"];
				harness[handler].mockResolvedValueOnce(false);

				await harness.editor.onSubmit?.(command);

				expect(harness.editor.getText()).toBe(withStash ? command : "");
				expect(harness.editor.pendingImages).toEqual([attemptedImage]);
				expect(harness.editor.pendingImageLinks).toEqual(["file:///attempted.png"]);
				if (withStash) {
					harness.editor.clearDraft();
					harness.controller.handleStash();
					expect(harness.editor.getText()).toBe("original draft [Image #1]");
					expect(harness.editor.pendingImages).toEqual([stashedImage]);
					expect(harness.editor.pendingImageLinks).toEqual(["file:///old.png"]);
				}
			}
		});
	}

	for (const [command, handler] of [
		["/goal pause", "handleGoalModeCommand"],
		["/goal show", "handleGoalModeCommand"],
		["/goal resume", "handleGoalModeCommand"],
		["/goal drop", "handleGoalModeCommand"],
		["/goal budget 120", "handleGoalModeCommand"],
		["/plan exit", "handlePlanModeCommand"],
		["/vibe exit", "handleVibeModeCommand"],
	] as const) {
		it(`consumes ${command} without reviving the slash text or detached images`, async () => {
			const harness = createHarness({});
			harness[handler].mockResolvedValueOnce("consumed");
			await harness.editor.onSubmit?.(`${command} [Image #1]`);
			expect(harness.editor.getText()).toBe("");
			expect(harness.editor.pendingImages).toEqual([]);
			expect(harness.editor.pendingImageLinks).toEqual([]);
		});
	}

	it("detaches submitted images before awaiting input extensions", async () => {
		const inputResult = Promise.withResolvers<{ images?: ImageContent[] }>();
		const harness = createHarness(inputResult.promise);
		const submission = harness.editor.onSubmit?.("/plan inspect this [Image #1]");
		if (!submission) throw new Error("expected editor submit handler");

		const laterImage: ImageContent = { type: "image", data: "bmV3", mimeType: "image/png" };
		harness.editor.setText("later draft");
		harness.editor.pendingImages.push(laterImage);
		harness.editor.pendingImageLinks.push("file:///later.png");
		inputResult.resolve({});
		await submission;

		expect(harness.handlePlanModeCommand.mock.calls[0]?.[1]?.images).toHaveLength(1);
		expect(harness.editor.getText()).toBe("later draft");
		expect(harness.editor.pendingImages).toEqual([laterImage]);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///later.png"]);
	});
	it("preserves later images when an extension rewrites input into a mode command", async () => {
		const inputResult = Promise.withResolvers<{ images?: ImageContent[]; text?: string }>();
		const harness = createHarness(inputResult.promise);
		const submission = harness.editor.onSubmit?.("inspect this");
		if (!submission) throw new Error("expected editor submit handler");

		const laterImage: ImageContent = { type: "image", data: "bmV3", mimeType: "image/png" };
		harness.editor.setText("later draft");
		harness.editor.pendingImages.push(laterImage);
		harness.editor.pendingImageLinks.push("file:///later.png");
		inputResult.resolve({ text: "/plan inspect this" });
		await submission;

		expect(harness.handlePlanModeCommand).toHaveBeenCalled();
		expect(harness.editor.getText()).toBe("later draft");
		expect(harness.editor.pendingImages).toEqual([laterImage]);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///later.png"]);
	});

	it("restores a failed mode command into an empty editor", async () => {
		const failedPlan = createHarness({});
		failedPlan.handlePlanModeCommand.mockRejectedValueOnce(new Error("plan setup failed"));
		const planSubmission = failedPlan.editor.onSubmit?.("/plan inspect this [Image #1]");
		if (!planSubmission) throw new Error("expected editor submit handler");

		await planSubmission;
		expect(failedPlan.editor.getText()).toBe("/plan inspect this [Image #1]");
		expect(failedPlan.editor.pendingImages).toHaveLength(1);
		expect(failedPlan.editor.pendingImageLinks).toEqual(["file:///old.png"]);
		expect(failedPlan.showError).toHaveBeenCalledWith("plan setup failed");
	});

	it.each([
		["/plan", "handlePlanModeCommand"],
		["/vibe", "handleVibeModeCommand"],
		["/goal", "handleGoalModeCommand"],
		["/guided-goal", "handleGuidedGoalCommand"],
	] as const)("restores a failed %s beside a later draft, remapping its image markers", async (command, handler) => {
		const harness = createHarness({});
		const laterImage: ImageContent = { type: "image", data: "bmV3", mimeType: "image/png" };
		harness[handler].mockImplementationOnce(async () => {
			harness.editor.setText("later [Image #1]");
			harness.editor.pendingImages = [laterImage];
			harness.editor.pendingImageLinks = ["file:///later.png"];
			throw new Error("setup failed");
		});
		const submission = harness.editor.onSubmit?.(`${command} inspect this [Image #1]`);
		if (!submission) throw new Error("expected editor submit handler");

		await submission;
		expect(harness.editor.getText()).toBe(`${command} inspect this [Image #2]\n\nlater [Image #1]`);
		expect(harness.editor.pendingImages).toHaveLength(2);
		expect(harness.editor.pendingImages[0]).toBe(laterImage);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///later.png", "file:///old.png"]);
		expect(harness.showError).toHaveBeenCalledWith("setup failed");
	});
});
