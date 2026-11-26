import { afterEach, expect, test } from "bun:test";
import { createRoot, isUiNode, signal, type UiNode } from "@oh-my-pi/pi-tui";
import type { TerminalCapabilities } from "@oh-my-pi/pi-tui/driver/contract";
import { TerminalImages } from "@oh-my-pi/pi-tui/driver/images/store";
import { driverImages } from "@oh-my-pi/pi-tui/term/backend";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import "../../../src/ui/styles/messages/user";
import { UserMessage, type UserMessageModel } from "../../../src/ui/transcript/messages/user-message";

const RED_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const ZONE_CLOSE = "\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07";
const INLINE = "File=inline=1;";
const caps: TerminalCapabilities = {
	truecolor: true,
	colors: 16_777_216,
	synchronizedOutput: true,
	hyperlinks: false,
	images: "iterm",
	kittyKeyboard: true,
	bracketedPaste: true,
	background: null,
	dark: true,
	cell: { w: 10, h: 20 },
	multiplexer: null,
	textSizing: false,
	tsp: false,
};

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
});

async function picture() {
	const data = await new Bun.Image(Buffer.from(RED_PNG, "base64")).resize(200, 100).png().toBase64();
	return { type: "image" as const, data, mimeType: "image/png" };
}

/** The bubble for `model`, painted by a terminal that draws images (`images: false`: one that draws none). */
function paint(model: UserMessageModel, options: { images?: boolean } = {}): () => readonly string[] {
	let node: UiNode | undefined;
	createRoot(d => {
		dispose = d;
		const built = UserMessage({ model });
		if (!isUiNode(built)) throw new Error("expected a ui node");
		node = built;
	});
	const capabilities = () => caps;
	const images = new TerminalImages({ capabilities, placeholders: () => false });
	const env = staticEnvironment(currentTheme(), {
		images: options.images === false ? undefined : driverImages(images, capabilities),
	});
	return () => paintNode(env, node!, 80).rows;
}

test("a sent prompt's attached images draw under the bubble, outside its prompt zone", async () => {
	const image = await picture();
	const rows = paint({ text: "see shot", images: [image, image], promptZones: true })();
	const close = rows.findIndex(row => row.endsWith(ZONE_CLOSE));
	const drawn = rows.findIndex(row => row.includes(INLINE));
	expect(close).toBeGreaterThan(0);
	expect(drawn).toBeGreaterThan(close);
	expect(rows.slice(0, close + 1).join("\n")).toContain("see shot");
	expect(rows.filter(row => row.includes(INLINE))).toHaveLength(2);
});

test("the images follow terminal.showImages and leave a terminal without images unchanged", async () => {
	const image = await picture();
	const show = signal(true);
	const rows = paint({ text: "see shot", images: [image], showImages: show });
	expect(rows().join("\n")).toContain(INLINE);

	show.set(false);
	const hidden = rows();
	dispose?.();
	expect(hidden).toEqual(paint({ text: "see shot" })());

	const plain = paint({ text: "see shot", images: [image] }, { images: false })();
	dispose?.();
	expect(plain).toEqual(paint({ text: "see shot" }, { images: false })());
});
