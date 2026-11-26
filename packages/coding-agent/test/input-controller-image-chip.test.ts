/**
 * Contract: an image attached to the draft becomes one chip token in the composer's own
 * glyphs (the symbol preset's `chip.*`), like the chips the composer makes itself for pastes
 * and restored drafts.
 *
 * Failure mode: the token falls back to the unicode preset's camera emoji, so a Nerd Font
 * session (every Tern session is one) shows an emoji chip in the draft and on its card.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { presetSymbols } from "@oh-my-pi/pi-tui/theme/symbols";
import { Composer } from "../src/ui/composer/composer";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";

const ONE_PX_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

describe("attached image chip token", () => {
	let dir: string;

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "images.autoResize": false } });
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-image-chip-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
		resetSettingsForTest();
	});

	it("labels a pasted image with the composer's chip glyph, and its card with the same token", async () => {
		const nerd = presetSymbols("nerd");
		const composer = new Composer({ symbol: key => nerd[key] ?? "" });
		const ctx = {
			composer,
			shell: { focused: () => composer.field },
			sessionManager: {
				getCwd: () => dir,
				putBlob: async () => ({ hash: "h", path: "/tmp/h.png", displayPath: "/tmp/h.png" }),
			},
			showStatus: () => {},
			session: { urlRouter: InternalUrlRouter.builtins() },
		} as unknown as InteractiveModeContext;
		const file = path.join(dir, "shot.png");
		await Bun.write(file, ONE_PX_PNG);

		await new InputController(ctx).handleImagePathPaste(file);

		const token = `${nerd["chip.image"]} #1`;
		expect(composer.text()).toBe(`${token} `);
		expect(composer.chips().map(chip => chip.label)).toEqual([token]);
		// The marker the model reads is unchanged by the glyph.
		expect(composer.expandedText()).toBe("[Image #1, 1x1] ");
	});
});
