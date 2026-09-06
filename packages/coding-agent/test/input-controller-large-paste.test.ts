import { removeWithRetries } from "@oh-my-pi/pi-utils";
/**
 * Large-paste menu: when a paste reaches the configured `paste.largeMenuThreshold` line count,
 * the editor's `onLargePaste` hook routes through `InputController.handleLargePaste`, which offers
 * to attach the text as an `<attachment>` block, save it to a `local://` file, or paste it inline.
 * Below the threshold (or when disabled) the editor keeps its default collapse-to-`[Paste]`-marker behavior.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createContext(options?: { threshold?: number; choice?: string; artifactsDir?: string }) {
	const insertTextAttachment = vi.fn();
	const insertText = vi.fn();
	const pasteText = vi.fn();
	const requestRender = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const showHookSelector = vi.fn(async (_title: string, _options: unknown, _dialog?: unknown) => options?.choice);
	const ctx = {
		editor: { insertTextAttachment, insertText, pasteText } as unknown as InteractiveModeContext["editor"],
		ui: { requestRender } as unknown as InteractiveModeContext["ui"],
		settings: { get: () => options?.threshold ?? 100 } as unknown as InteractiveModeContext["settings"],
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
		controller,
		spies: { insertTextAttachment, insertText, pasteText, requestRender, showStatus, showError, showHookSelector },
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("InputController.handleLargePaste gate", () => {
	it("declines and skips the menu below the threshold", () => {
		const { controller, spies } = createContext({ threshold: 100 });
		const menu = vi.spyOn(controller, "presentLargePasteMenu").mockResolvedValue();

		expect(controller.handleLargePaste("x", 50)).toBe(true);
		expect(menu).not.toHaveBeenCalled();
		expect(spies.insertTextAttachment).toHaveBeenCalledWith("x");
	});

	it("declines when disabled (threshold 0), even for a huge paste", () => {
		const { controller, spies } = createContext({ threshold: 0 });
		const menu = vi.spyOn(controller, "presentLargePasteMenu").mockResolvedValue();

		expect(controller.handleLargePaste("x", 5000)).toBe(true);
		expect(menu).not.toHaveBeenCalled();
		expect(spies.insertTextAttachment).toHaveBeenCalledWith("x");
	});

	it("intercepts and presents the menu at the threshold", () => {
		const { controller, spies } = createContext({ threshold: 100 });
		const menu = vi.spyOn(controller, "presentLargePasteMenu").mockResolvedValue();

		expect(controller.handleLargePaste("payload", 100)).toBe(true);
		expect(menu).toHaveBeenCalledWith("payload", 100);
		expect(spies.insertTextAttachment).not.toHaveBeenCalled();
	});
});

describe("InputController.presentLargePasteMenu actions", () => {
	it("offers the requested actions in order", async () => {
		const { controller, spies } = createContext({ choice: undefined });

		await controller.presentLargePasteMenu("payload", 1);

		const options = spies.showHookSelector.mock.calls[0][1] as Array<{ label: string }>;
		expect(options.map(option => option.label)).toEqual([
			"Attach as a wrapped block",
			"Attach as local file",
			"Paste inline",
		]);
	});

	it("wraps the paste in attachment XML collapsed to a marker", async () => {
		const { controller, spies } = createContext({ choice: "Attach as a wrapped block" });

		await controller.presentLargePasteMenu("payload", 1);

		expect(spies.insertTextAttachment).toHaveBeenCalledWith("payload", "<attachment>\npayload\n</attachment>");
	});

	it("pastes inline when explicitly selected", async () => {
		const { controller, spies } = createContext({ choice: "Paste inline" });

		await controller.presentLargePasteMenu("payload", 1);

		expect(spies.insertTextAttachment).toHaveBeenCalledWith("payload");
	});

	it("pastes inline when the menu is cancelled, so the content is not lost", async () => {
		const { controller, spies } = createContext({ choice: undefined });

		await controller.presentLargePasteMenu("payload", 1);

		expect(spies.insertTextAttachment).toHaveBeenCalledWith("payload");
	});

	it("titles the menu with the paste's line count", async () => {
		const { controller, spies } = createContext({ choice: undefined });

		await controller.presentLargePasteMenu("payload", 123);

		expect(spies.showHookSelector.mock.calls[0][0]).toBe("Pasted 123 lines");
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
