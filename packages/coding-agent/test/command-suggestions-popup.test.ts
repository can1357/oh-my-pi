import { afterEach, expect, it } from "bun:test";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui";
import { encodeKittyPlacement } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { Composer } from "../src/modes/composer";
import { TranscriptContainer } from "../src/modes/components/transcript-container";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

let composer: Composer | undefined;
afterEach(() => composer?.stop());

it.each(["", "  "])("restores chat and history through popup filtering with prefix %j", async prefix => {
	const terminal = new VirtualTerminal(60, 12);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	const block = {
		render: () => Array.from({ length: 40 }, (_, i) => `CHAT_${i + 1}`),
		isTranscriptBlockFinalized: () => true,
	};
	transcript.addChild(block);
	composer.setRuntimeChildren([transcript, composer.editor]);
	composer.editor.commandSuggestionsPopup = true;
	composer.editor.onAutocompleteRender = (render, offset, rows) => composer!.ui.setCursorOverlay(render, offset, rows);
	composer.editor.setAutocompleteProvider(
		new CombinedAutocompleteProvider(Array.from({ length: 12 }, (_, i) => ({ name: `command${i}` }))),
	);
	composer.editor.onAutocompleteUpdate = () => composer!.ui.requestRender();
	composer.editor.onAutocompleteCancel = () => composer!.ui.requestRender();
	composer.start();
	composer.ui.setFocus(composer.editor);
	const paint = async () => {
		await Bun.sleep(40);
		composer!.ui.requestRender();
		await terminal.waitForRender();
	};
	await paint();
	await paint();
	const history = () => terminal.getScrollBuffer().slice(0, -terminal.rows);
	const beforeHistory = history();
	const before = terminal.getViewport().map(Bun.stripANSI);
	const writes: string[] = [];
	const write = terminal.write.bind(terminal);
	terminal.write = data => {
		writes.push(data);
		write(data);
	};
	composer.editor.handleInput(prefix);
	for (const input of ["/", "command1", "\x7f", "\x1b"]) {
		composer.editor.handleInput(input);
		await paint();
		expect(history()).toEqual(beforeHistory);
		if (input === "/") expect(terminal.getViewport().join("\n")).toContain("command0");
	}
	composer.editor.setText("");
	await paint();
	expect(terminal.getViewport().map(Bun.stripANSI)).toEqual(before);
	expect(writes.join("")).not.toMatch(/\x1b\[(?:2|3)J|\x1b\[\?1049h|\x1b\[\?1003h/);
});

it("covers intersecting direct graphics with opaque popup cells without deleting image data", async () => {
	const terminal = new VirtualTerminal(40, 12);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const placement = encodeKittyPlacement({ imageId: 713, placementId: 713, columns: 40, rows: 8 });
	const image = { render: () => ["\x1b7" + placement + "\x1b8", ...Array<string>(7).fill("")] };
	composer.setRuntimeChildren([image, composer.editor]);
	composer.editor.commandSuggestionsPopup = true;
	composer.editor.onAutocompleteRender = (render, offset, rows) => composer!.ui.setCursorOverlay(render, offset, rows);
	composer.editor.setAutocompleteProvider(
		new CombinedAutocompleteProvider(Array.from({ length: 12 }, (_, i) => ({ name: `command${i}` }))),
	);
	composer.editor.onAutocompleteUpdate = () => composer!.ui.requestRender();
	composer.editor.onAutocompleteCancel = () => composer!.ui.requestRender();
	const writes: string[] = [];
	const write = terminal.write.bind(terminal);
	terminal.write = data => {
		writes.push(data);
		write(data);
	};
	composer.start();
	composer.ui.setFocus(composer.editor);
	await terminal.waitForRender();
	expect(writes.join("")).toMatch(/\x1b_Ga=p,[^\x1b]*i=713,[^\x1b]*z=-2147483648\x1b\\/);
	writes.length = 0;
	composer.editor.handleInput("/");
	await Bun.sleep(40);
	composer.ui.requestRender();
	await terminal.waitForRender();
	expect(terminal.getViewport().join("\n")).toContain("command0");
	// Kitty draws this placement below non-default cell backgrounds. The popup
	// must emit an opaque fill, not only foreground text over a default cell.
	for (let row = 0; row < 8; row++) {
		expect(terminal.getViewportRowBackgroundColumns(row)).toEqual(Array.from({ length: 40 }, (_, col) => col));
	}
	composer.editor.handleInput("\x1b");
	composer.ui.requestRender();
	await terminal.waitForRender();
	expect(terminal.getViewport().join("\n")).not.toContain("command0");
	expect(writes.join("")).not.toMatch(/\x1b_Ga=d,/);
});
