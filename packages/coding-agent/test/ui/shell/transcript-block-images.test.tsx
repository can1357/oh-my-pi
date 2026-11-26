/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A transcript block in terminal rows drops its blank edge rows. The rows of an inline image hold
 * no text, only what draws it; a block that ends in an image still shows the whole image.
 */
import { describe, expect, it } from "bun:test";
import { createRoot, signal } from "@oh-my-pi/pi-tui";
import type { TerminalCapabilities } from "@oh-my-pi/pi-tui/driver/contract";
import { TerminalImages } from "@oh-my-pi/pi-tui/driver/images/store";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { driverImages } from "@oh-my-pi/pi-tui/term/backend";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { Transcript } from "../../../src/ui/shell/transcript";
import { KITTY } from "../transcript/figures/harness";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const BLOB = registerBlob(Buffer.from(PNG_1PX, "base64"), "image/png");

/** The rows of a block holding a caption and then an image, and the rows of that content on its own. */
function captionThenImage(protocol: TerminalCapabilities["images"]): {
	block: readonly string[];
	content: readonly string[];
} {
	const caps = signal({ ...KITTY, images: protocol });
	const env = staticEnvironment(loadThemeSync("dark"), {
		images: driverImages(new TerminalImages({ capabilities: caps }), caps),
	});
	return createRoot(dispose => {
		const transcript = new Transcript();
		const block = transcript.append(() => (
			<col>
				<text text="caption" />
				<image blob={BLOB} w={100} h={100} alt="[Image]" max={{ w: "4ch", h: "2lines" }} />
			</col>
		));
		const rows = {
			block: paintNode(env, block.node, 40).rows,
			content: paintNode(env, block.native()[0]!, 40).rows,
		};
		dispose();
		return rows;
	});
}

describe("a transcript block ending in an inline image", () => {
	it("keeps the kitty placement rows, which hold no text", () => {
		const { block, content } = captionThenImage("kitty");

		expect(content.slice(1).every(row => row.includes("\x1b_Ga=p"))).toBe(true);
		expect(content).toHaveLength(3);
		expect(block).toEqual(content);
	});

	it("keeps the row an iTerm2 image is drawn from and the rows reserved above it", () => {
		const { block, content } = captionThenImage("iterm");

		expect(content.at(-1)).toContain("\x1b]1337;File=");
		expect(content).toHaveLength(3);
		expect(block).toEqual(content);
	});
});
