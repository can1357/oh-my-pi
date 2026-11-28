import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type {
	InteractiveModeContext,
	ModeCommandResult,
	SubmittedUserInput,
} from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { Composer } from "../../src/ui/composer/composer";
import { draftComposer } from "../helpers/input-harness";

type Attachments = Pick<SubmittedUserInput, "images" | "imageLinks">;

function replaceImages(
	composer: Composer,
	images: readonly ImageContent[],
	links: readonly (string | undefined)[],
): void {
	composer.pendingImages.splice(0, composer.pendingImages.length, ...images);
	composer.pendingImageLinks.splice(0, composer.pendingImageLinks.length, ...links);
}

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
	const handleGuidedGoalCommand = vi.fn(
		async (_prompt?: string, _input?: Attachments): Promise<ModeCommandResult> => true,
	);
	const editor = draftComposer([oldImage], ["file:///old.png"]);
	vi.spyOn(editor, "addToHistory");
	const showError = vi.fn();
	const ctx = {
		composer: editor,
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
	const submit = editor.onSubmit;
	editor.onSubmit = text => {
		// Enter removes the submitted text before invoking its handler, but
		// leaves images for the controller to claim.
		editor.setText("");
		return submit?.(text);
	};
	return {
		ctx,
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
	for (const withImages of [false, true]) {
		it(`restores a rejected non-detached side command once with a stash (images=${withImages})`, async () => {
			const harness = createHarness({});
			harness.editor.setText("saved draft [Image #1]");
			harness.controller.handleStash();
			const images: ImageContent[] = withImages ? [{ type: "image", data: "bmV3", mimeType: "image/png" }] : [];
			const imageLinks = images.map(() => "file:///attempted.png");
			const command = withImages ? "/tan inspect [Image #1]" : "/tan";
			harness.editor.setText(command);
			replaceImages(harness.editor, images, imageLinks);
			const onAccepted = vi.fn();
			harness.ctx.handleTanCommand = vi.fn(async () => false);

			// Bare-word normalization can route to /tan after Enter has already
			// decided that this submission is non-detached.
			await executeBuiltinSlashCommand(command, {
				ctx: harness.ctx,
				input: { images, imageLinks, onAccepted },
				draftDetached: false,
			});

			expect(harness.editor.expandedText()).toBe(command);
			expect(harness.editor.pendingImages).toEqual(images);
			expect(harness.editor.pendingImageLinks).toEqual(imageLinks);
			expect(onAccepted).not.toHaveBeenCalled();
			harness.editor.clearDraft({ recall: false });
			harness.controller.handleStash();
			expect(harness.editor.expandedText()).toBe("saved draft [Image #1]");
			expect(harness.editor.pendingImages).toEqual([{ type: "image", data: "b2xk", mimeType: "image/png" }]);
		});
	}
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

		await harness.editor.onSubmit?.("/goal blocked [Image #1]");

		expect(harness.editor.expandedText()).toBe("/goal blocked [Image #1]");
		expect(harness.editor.pendingImages).toHaveLength(1);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///old.png"]);
	});

	for (const [command, handler] of [
		["/plan blocked [Image #1]", "handlePlanModeCommand"],
		["/vibe blocked [Image #1]", "handleVibeModeCommand"],
		["/guided-goal blocked [Image #1]", "handleGuidedGoalCommand"],
	] as const) {
		it(`keeps ${command} and its images when rejected, without consuming an existing stash`, async () => {
			const attemptedImage: ImageContent = { type: "image", data: "bmV3", mimeType: "image/png" };
			for (const withStash of [false, true]) {
				const harness = createHarness({});
				const stashedImage = harness.editor.pendingImages[0];
				if (withStash) {
					harness.editor.setText("original draft [Image #1]");
					harness.controller.handleStash();
				}
				harness.editor.setText(command);
				replaceImages(harness.editor, [attemptedImage], ["file:///attempted.png"]);
				harness[handler].mockResolvedValueOnce(false);

				await harness.editor.onSubmit?.(command);

				expect(harness.editor.expandedText()).toBe(command);
				expect(harness.editor.pendingImages).toEqual([attemptedImage]);
				expect(harness.editor.pendingImageLinks).toEqual(["file:///attempted.png"]);
				if (withStash) {
					harness.editor.clearDraft({ recall: false });
					harness.controller.handleStash();
					expect(harness.editor.expandedText()).toBe("original draft [Image #1]");
					expect(harness.editor.pendingImages).toEqual([stashedImage]);
					expect(harness.editor.pendingImageLinks).toEqual(["file:///old.png"]);
				}
			}
		});
	}

	it("consumes a rejected text-only mode command when no stash exists", async () => {
		const harness = createHarness({});
		replaceImages(harness.editor, [], []);
		harness.editor.setText("/plan blocked");
		harness.handlePlanModeCommand.mockResolvedValueOnce(false);

		await harness.editor.onSubmit?.("/plan blocked");

		expect(harness.editor.expandedText()).toBe("");
		expect(harness.editor.pendingImages).toEqual([]);
	});

	for (const [command, handler] of [
		["/goal pause", "handleGoalModeCommand"],
		["/goal show", "handleGoalModeCommand"],
		["/goal resume", "handleGoalModeCommand"],
		["/goal drop", "handleGoalModeCommand"],
		["/goal budget 120", "handleGoalModeCommand"],
		["/plan exit", "handlePlanModeCommand"],
		["/vibe exit", "handleVibeModeCommand"],
	] as const) {
		it(`restores ${command} and its detached image when the mode command starts no turn`, async () => {
			const harness = createHarness({});
			harness[handler].mockResolvedValueOnce("consumed");
			await harness.editor.onSubmit?.(`${command} [Image #1]`);
			expect(harness.editor.expandedText()).toBe(`${command} [Image #1]`);
			expect(harness.editor.pendingImages).toEqual([{ type: "image", data: "b2xk", mimeType: "image/png" }]);
			expect(harness.editor.pendingImageLinks).toEqual(["file:///old.png"]);
		});
	}

	it("consumes a text-only mode toggle without reviving its command", async () => {
		const harness = createHarness({});
		replaceImages(harness.editor, [], []);
		harness.editor.setText("/plan exit");
		harness.handlePlanModeCommand.mockResolvedValueOnce("consumed");

		await harness.editor.onSubmit?.("/plan exit");

		expect(harness.editor.expandedText()).toBe("");
		expect(harness.editor.pendingImages).toEqual([]);
	});

	it("returns a consumed mode command and its image beside typing added during dispatch", async () => {
		const harness = createHarness({});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.handlePlanModeCommand.mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			return "consumed";
		});
		const submitting = harness.editor.onSubmit?.("/plan inspect [Image #1]");
		await entered.promise;
		const newerImage: ImageContent = { type: "image", data: "bmV3", mimeType: "image/jpeg" };
		harness.editor.setText("newer [Image #1]");
		replaceImages(harness.editor, [newerImage], ["file:///newer.jpeg"]);
		release.resolve();
		await submitting;

		expect(harness.editor.expandedText()).toBe("/plan inspect [Image #2]\n\nnewer [Image #1]");
		expect(harness.editor.pendingImages).toEqual([
			newerImage,
			{ type: "image", data: "b2xk", mimeType: "image/png" },
		]);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///newer.jpeg", "file:///old.png"]);
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
		expect(harness.editor.expandedText()).toBe("later draft");
		expect(harness.editor.pendingImages).toEqual([laterImage]);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///later.png"]);
	});

	it("keeps an identical mode draft retyped while its input hook awaited", async () => {
		const inputResult = Promise.withResolvers<{ images?: ImageContent[]; text?: string }>();
		const harness = createHarness(inputResult.promise);
		const command = "/plan inspect [Image #1]";
		const submitting = harness.editor.onSubmit?.(command);
		const newerImage: ImageContent = { type: "image", data: "bmV3", mimeType: "image/png" };
		harness.editor.setText(command);
		harness.editor.pendingImages.push(newerImage);
		harness.editor.pendingImageLinks.push("file:///newer.png");
		inputResult.resolve({});
		await submitting;

		expect(harness.handlePlanModeCommand).toHaveBeenCalled();
		expect(harness.editor.expandedText()).toBe(command);
		expect(harness.editor.pendingImages).toEqual([newerImage]);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///newer.png"]);
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
		expect(harness.editor.expandedText()).toBe("later draft");
		expect(harness.editor.pendingImages).toEqual([laterImage]);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///later.png"]);
	});

	it("restores a failed mode command into an empty editor", async () => {
		const failedPlan = createHarness({});
		failedPlan.handlePlanModeCommand.mockRejectedValueOnce(new Error("plan setup failed"));
		const planSubmission = failedPlan.editor.onSubmit?.("/plan inspect this [Image #1]");
		if (!planSubmission) throw new Error("expected editor submit handler");

		await planSubmission;
		expect(failedPlan.editor.expandedText()).toBe("/plan inspect this [Image #1]");
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
			harness.editor.pendingImages.splice(0, Infinity, laterImage);
			harness.editor.pendingImageLinks.splice(0, Infinity, "file:///later.png");
			throw new Error("setup failed");
		});
		const submission = harness.editor.onSubmit?.(`${command} inspect this [Image #1]`);
		if (!submission) throw new Error("expected editor submit handler");

		await submission;
		expect(harness.editor.expandedText()).toBe(`${command} inspect this [Image #2]\n\nlater [Image #1]`);
		expect(harness.editor.pendingImages).toHaveLength(2);
		expect(harness.editor.pendingImages[0]).toBe(laterImage);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///later.png", "file:///old.png"]);
		expect(harness.showError).toHaveBeenCalledWith("setup failed");
	});
});
