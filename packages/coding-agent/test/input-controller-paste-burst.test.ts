/**
 * Input that arrives with or right after a paste:
 * - a menu-sized paste whose stdin read also carries Enter (the driver marks that key
 *   `afterPaste`) is staged as a chip and submitted instead of opening the large-paste menu;
 * - keys typed while an image paste is still landing wait for it and replay in order, so an
 *   Enter right after Ctrl+V submits with the image attached.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { isSettingsInitialized, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { initTheme } from "../src/ui/theme/service";
import { attachTerminal, createInteractiveModeContext } from "./helpers/interactive-mode-context";

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

const restoreTheme = currentTheme();

afterAll(() => {
	setCurrentTheme(restoreTheme);
});

beforeAll(async () => {
	initTheme();
	if (!isSettingsInitialized()) await Settings.init({ inMemory: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

function setup(readImage: () => Promise<{ data: Uint8Array; mimeType: string } | null> = async () => null) {
	const ctx = createInteractiveModeContext({
		settings: Settings.isolated({ "paste.largeMenuThreshold": 20, "images.autoResize": false }),
		session: { prewarmModelConnection: () => {} },
	});
	const submitted: string[] = [];
	const controller = new InputController(ctx, {
		readImage: readImage as never,
		readText: async () => "",
		readMacFileUrls: async () => [],
		isTerminalLocal: () => true,
	});
	controller.setupKeyHandlers();
	ctx.composer.onSubmit = text => {
		submitted.push(text);
	};
	const term = attachTerminal(ctx);
	return { ctx, term, controller, submitted };
}

const LARGE = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");

function enter(ctx: InteractiveModeContext, afterPaste: boolean): void {
	ctx.shell.input({
		type: "key",
		key: { id: "enter", kind: "press", raw: "\r", ...(afterPaste ? { afterPaste } : {}) },
	});
}

describe("paste then Enter in one read", () => {
	it("stages the paste and submits it without the large-paste menu", async () => {
		const { ctx, term, submitted } = setup();
		term.paste(LARGE);
		enter(ctx, true);
		await Promise.resolve();
		expect(ctx.showHookSelector).not.toHaveBeenCalled();
		// The chip is staged with the space after it, as a typed chip is.
		expect(submitted).toEqual([`${LARGE} `]);
	});

	it("opens the menu when Enter comes in a later read", async () => {
		const { ctx, term, submitted } = setup();
		term.paste(LARGE);
		await Promise.resolve();
		expect(ctx.showHookSelector).toHaveBeenCalledTimes(1);
		enter(ctx, false);
		expect(submitted).toEqual([]);
	});
});

describe("keys typed during an image paste", () => {
	it("wait for the image and replay in order", async () => {
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const { ctx, term, submitted } = setup(async () => {
			await gate;
			return { data: new Uint8Array(PNG_1X1), mimeType: "image/png" };
		});
		term.paste("");
		term.type("hi");
		enter(ctx, false);
		expect(ctx.composer.text()).toBe("");
		expect(submitted).toEqual([]);

		release();
		for (let i = 0; i < 200 && submitted.length === 0; i++) await Bun.sleep(5);
		expect(submitted[0]).toMatch(/^\[Image #1[^\]]*\] hi$/);
		// The submission carries the image the paste attached.
		expect(ctx.composer.pendingImages).toHaveLength(1);
		expect(ctx.composer.text()).toBe("");
	});
});
