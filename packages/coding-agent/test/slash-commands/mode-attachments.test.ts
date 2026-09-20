import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext, SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";

type Attachments = Pick<SubmittedUserInput, "images" | "imageLinks">;

function createHarness(
	inputResult: { images?: ImageContent[]; text?: string } | Promise<{ images?: ImageContent[]; text?: string }>,
) {
	const oldImage: ImageContent = { type: "image", data: "b2xk", mimeType: "image/png" };
	const handlePlanModeCommand = vi.fn(async (_prompt?: string, _input?: Attachments) => true);
	const handleVibeModeCommand = vi.fn(async (_prompt?: string, _input?: Attachments) => true);
	const handleGoalModeCommand = vi.fn(async (_prompt?: string, _input?: Attachments) => true);
	const handleGuidedGoalCommand = vi.fn(async (_prompt?: string, _input?: Attachments) => true);
	let editorText = "";
	const editor = {
		onSubmit: undefined as undefined | ((text: string) => Promise<void>),
		addToHistory: vi.fn(),
		getText: () => editorText,
		setText(text: string) {
			editorText = text;
		},
		// The stub skips chip collapsing so assertions read the wire-format text.
		setCollapsedText(text: string) {
			editorText = text;
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

		expect(harness.handleGoalModeCommand).toHaveBeenCalledWith("keep this private", undefined);
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

		await harness.editor.onSubmit?.("/goal show [Image #1]");

		expect(harness.editor.pendingImages).toHaveLength(1);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///old.png"]);
	});

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

	it("restores a failed mode command without overwriting a later draft", async () => {
		const failedPlan = createHarness({});
		failedPlan.handlePlanModeCommand.mockRejectedValueOnce(new Error("plan setup failed"));
		const planSubmission = failedPlan.editor.onSubmit?.("/plan inspect this [Image #1]");
		if (!planSubmission) throw new Error("expected editor submit handler");

		await planSubmission;
		expect(failedPlan.editor.getText()).toBe("/plan inspect this [Image #1]");
		expect(failedPlan.editor.pendingImages).toHaveLength(1);
		expect(failedPlan.editor.pendingImageLinks).toEqual(["file:///old.png"]);
		expect(failedPlan.showError).toHaveBeenCalledWith("plan setup failed");

		const failedVibe = createHarness({});
		const laterImage: ImageContent = { type: "image", data: "bmV3", mimeType: "image/png" };
		failedVibe.handleVibeModeCommand.mockImplementationOnce(async () => {
			failedVibe.editor.setText("later draft");
			failedVibe.editor.pendingImages = [laterImage];
			failedVibe.editor.pendingImageLinks = ["file:///later.png"];
			throw new Error("vibe setup failed");
		});
		const vibeSubmission = failedVibe.editor.onSubmit?.("/vibe inspect this [Image #1]");
		if (!vibeSubmission) throw new Error("expected editor submit handler");

		await vibeSubmission;
		expect(failedVibe.editor.getText()).toBe("later draft");
		expect(failedVibe.editor.pendingImages).toEqual([laterImage]);
		expect(failedVibe.editor.pendingImageLinks).toEqual(["file:///later.png"]);
		expect(failedVibe.showError).toHaveBeenCalledWith("vibe setup failed");
	});
});
