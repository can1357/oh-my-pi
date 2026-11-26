/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import { createRoot, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { TerminalImages } from "@oh-my-pi/pi-tui/driver/images/store";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { driverImages } from "@oh-my-pi/pi-tui/term/backend";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import "../../../../src/ui/styles/messages";
import { KITTY } from "./harness";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const theme = loadThemeSync("dark");

test("assistant images draw through the terminal's images, else as `[Image: mime]`", () => {
	createRoot(dispose => {
		const blob = registerBlob(Buffer.from(PNG_1PX, "base64"), "image/png");
		const node = (
			<col role="omp.assistant">
				<image key="i0" blob={blob} w={16} h={32} alt="image/png" />
			</col>
		) as UiNode;
		const caps = signal(KITTY);
		const kitty = staticEnvironment(theme, {
			images: driverImages(new TerminalImages({ capabilities: caps }), caps),
		});
		const rows = paintNode(kitty, node, 40).rows;
		// 16×32 px on 8×16 cells: 2×2 cells, one cell in.
		expect(rows).toHaveLength(2);
		expect(rows.every(row => row.startsWith(" \x1b_Ga=p"))).toBe(true);
		expect(paintNode(staticEnvironment(theme), node, 40).rows.map(stripEscapes)).toEqual([" [Image: image/png]"]);
		dispose();
	});
});
