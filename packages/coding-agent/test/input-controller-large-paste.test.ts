/**
 * Large-paste menu: once a paste big enough to collapse reaches the configured
 * `paste.largeMenuThreshold` line count, the menu offers to attach the text as an `<attachment>`
 * block, save it to a `local://` file, or paste it inline. Below the threshold (or when disabled)
 * the paste is staged as a text-attachment chip.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
} from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { Composer } from "../src/ui/composer/composer";
import { createInputHarness } from "./helpers/input-harness";

function createContext(options?: { threshold?: number; choice?: string; artifactsDir?: string }) {
	const composer = new Composer();
	const insertTextAttachment = vi.spyOn(composer, "insertTextAttachment");
	const insertText = vi.spyOn(composer, "insertText");
	const showStatus = vi.fn();
	const showError = vi.fn();
	const showHookSelector = vi.fn(async (_title: string, _options: unknown, _dialog?: unknown) => options?.choice);
	const input = createInputHarness();
	const ctx = {
		composer,
		...input.context,
		settings: Settings.isolated({ "paste.largeMenuThreshold": options?.threshold ?? 100 }),
		sessionManager: {
			getCwd: () => process.cwd(),
			getArtifactsDir: () => options?.artifactsDir ?? null,
			getSessionId: () => "test-session",
		} as unknown as InteractiveModeContext["sessionManager"],
		showHookSelector: showHookSelector as unknown as InteractiveModeContext["showHookSelector"],
		showStatus,
		showError,
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	return {
		ctx,
		input,
		composer,
		controller,
		spies: { insertTextAttachment, insertText, showStatus, showError, showHookSelector },
	};
}

/** Install the controller's input hooks with the composer focused. */
function wireInput(ctx: InteractiveModeContext, controller: InputController, composer: Composer): void {
	Object.assign(ctx, {
		shell: { focused: () => composer.field, host: undefined },
		keybindings: KeybindingsManager.inMemory(),
		session: { extensionRunner: undefined, prewarmModelConnection: () => {} },
		dictationSpaceHold: () => undefined,
		syncIdleMaintenanceView: () => {},
		updateEditorBorderColor: () => {},
	});
	controller.setupKeyHandlers();
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("InputController.handleLargePaste gate", () => {
	it("stages a chip and skips the menu below the threshold", () => {
		const { controller, spies } = createContext({ threshold: 100 });
		const menu = vi.spyOn(controller, "presentLargePasteMenu").mockResolvedValue();

		controller.handleLargePaste("x", 50);
		expect(menu).not.toHaveBeenCalled();
		expect(spies.insertTextAttachment).toHaveBeenCalledWith("x");
	});

	it("stages a chip when disabled (threshold 0), even for a huge paste", () => {
		const { controller, spies } = createContext({ threshold: 0 });
		const menu = vi.spyOn(controller, "presentLargePasteMenu").mockResolvedValue();

		controller.handleLargePaste("x", 5000);
		expect(menu).not.toHaveBeenCalled();
		expect(spies.insertTextAttachment).toHaveBeenCalledWith("x");
	});

	it("presents the menu at the threshold", () => {
		const { controller, spies } = createContext({ threshold: 100 });
		const menu = vi.spyOn(controller, "presentLargePasteMenu").mockResolvedValue();

		controller.handleLargePaste("payload", 100);
		expect(menu).toHaveBeenCalledWith("payload", 100);
		expect(spies.insertTextAttachment).not.toHaveBeenCalled();
	});

	it("routes a threshold-sized paste into the composer through the menu once its read is in", async () => {
		const { ctx, input, controller, composer, spies } = createContext({ threshold: 100 });
		const menu = vi.spyOn(controller, "presentLargePasteMenu").mockResolvedValue();
		wireInput(ctx, controller, composer);
		const payload = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");

		input.paste(ctx, payload);
		expect(menu).not.toHaveBeenCalled();
		await Promise.resolve();

		expect(menu).toHaveBeenCalledWith(payload, 100);
		expect(spies.insertTextAttachment).not.toHaveBeenCalled();
		expect(composer.text()).toBe("");
	});

	it("a remapped submit delivered with a large paste sends the pasted text instead of opening its menu", async () => {
		const previous = getKeybindings();
		const { ctx, input, controller, composer, spies } = createContext({ threshold: 12 });
		wireInput(ctx, controller, composer);
		ctx.keybindings.setUserBindings({ "tui.input.submit": "f4" });
		setKeybindings(ctx.keybindings);
		try {
			const sent: string[] = [];
			composer.onSubmit = text => sent.push(text);
			const text = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
			input.paste(ctx, text);
			input.press(ctx, "f4", { afterPaste: true });
			await Promise.resolve();
			expect(sent.map(draft => draft.trimEnd())).toEqual([text]);
			expect(spies.showHookSelector).not.toHaveBeenCalled();
		} finally {
			setKeybindings(previous);
		}
	});

	it("leaves a short paste to the composer", () => {
		const { ctx, input, controller, composer, spies } = createContext({ threshold: 100 });
		const menu = vi.spyOn(controller, "presentLargePasteMenu").mockResolvedValue();
		wireInput(ctx, controller, composer);

		expect(input.paste(ctx, "short")).toBe("composer");

		expect(menu).not.toHaveBeenCalled();
		expect(spies.showHookSelector).not.toHaveBeenCalled();
		expect(composer.text()).toBe("short");
	});
});

describe("InputController.presentLargePasteMenu actions", () => {
	it("wraps the paste in attachment XML collapsed to a chip", async () => {
		const { controller, spies } = createContext({ choice: "Attach as a wrapped block" });

		await controller.presentLargePasteMenu("payload", 1);

		expect(spies.insertTextAttachment).toHaveBeenCalledWith("payload", "<attachment>\npayload\n</attachment>");
	});

	it("submits the wrapped expansion rather than only the chip preview", async () => {
		const { controller, composer } = createContext({ choice: "Attach as a wrapped block" });
		await controller.presentLargePasteMenu("line one\nline two", 2);
		const submitted = vi.fn();
		composer.onSubmit = submitted;
		composer.submit();
		expect(submitted.mock.calls[0]?.[0].trim()).toBe("<attachment>\nline one\nline two\n</attachment>");
	});

	it("pastes inline when explicitly selected", async () => {
		const { controller, spies } = createContext({ choice: "Paste inline" });

		await controller.presentLargePasteMenu("payload", 1);

		expect(spies.insertTextAttachment).toHaveBeenCalledWith("payload");
	});

	it("inserts the raw text as editable text when selected", async () => {
		const { controller, spies } = createContext({ choice: "Insert as editable text" });

		await controller.presentLargePasteMenu("line one\nline two", 2);

		expect(spies.insertText).toHaveBeenCalledWith("line one\nline two");
		expect(spies.insertTextAttachment).not.toHaveBeenCalled();
	});

	it("pastes inline when the menu is cancelled, so the content is not lost", async () => {
		const { controller, spies } = createContext({ choice: undefined });

		await controller.presentLargePasteMenu("payload", 1);

		expect(spies.insertTextAttachment).toHaveBeenCalledWith("payload");
	});
});

describe("InputController.presentLargePasteMenu file attachment", () => {
	let dir: string | undefined;

	afterEach(async () => {
		if (dir) await removeWithRetries(dir);
		dir = undefined;
	});

	it("saves the paste to local:// and inserts a clean local://paste reference", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-paste-test-"));
		const { controller, spies } = createContext({ choice: "Attach as local file", artifactsDir: dir });

		await controller.presentLargePasteMenu("line one\nline two", 2);

		expect(spies.insertText).toHaveBeenCalledWith("local://paste-1.md ");
		expect(spies.insertTextAttachment).not.toHaveBeenCalled();
		// resolveLocalRoot maps an artifacts dir to "<dir>/local"; the reference resolves there.
		const saved = await Bun.file(path.join(dir, "local", "paste-1.md")).text();
		expect(saved).toBe("line one\nline two");
	});

	it("does not overwrite an existing paste file", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-paste-test-"));
		await Bun.write(path.join(dir, "local", "paste-1.md"), "previous");
		const { controller, spies } = createContext({ choice: "Attach as local file", artifactsDir: dir });

		await controller.presentLargePasteMenu("fresh", 1);

		expect(spies.insertText).toHaveBeenCalledWith("local://paste-2.md ");
		expect(await Bun.file(path.join(dir, "local", "paste-1.md")).text()).toBe("previous");
		expect(await Bun.file(path.join(dir, "local", "paste-2.md")).text()).toBe("fresh");
	});
});
