import { afterEach, expect, it } from "bun:test";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { Composer } from "../src/modes/composer";
import { ModelPickerComponent } from "../src/modes/components/model-picker";
import { TranscriptContainer } from "../src/modes/components/transcript-container";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

let composer: Composer | undefined;
afterEach(() => composer?.stop());

it("keeps the statusline, extension content and draft while searching and selecting inline", async () => {
	const terminal = new VirtualTerminal(100, 24);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const editor = composer.editor;
	editor.setText("draft to preserve");
	editor.setTopBorder({ content: "MODEL STATUS", width: 12 });
	const transcript = new TranscriptContainer();
	const block = {
		render: () => Array.from({ length: 40 }, (_, i) => `CHAT_${i}`),
		isTranscriptBlockFinalized: () => true,
	};
	transcript.addChild(block);
	const slot = new Container();
	slot.addChild(editor);
	composer.setRuntimeChildren([transcript, slot, new Text("EXTENSION BELOW INPUT", 0, 0)]);
	composer.start();
	composer.ui.setFocus(editor);
	const paint = async () => {
		await Bun.sleep(40);
		composer!.ui.requestRender();
		await terminal.waitForRender();
	};
	await paint();
	await paint();
	const history = terminal.getScrollBuffer().slice(0, -terminal.rows);
	const screen = terminal.getViewport().map(Bun.stripANSI);
	const models = ["alpha", "beta"].map(id =>
		buildModel({
			id,
			name: id,
			provider: "demo",
			api: "ollama-chat",
			baseUrl: "https://example.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}),
	);
	const registry = {
		getAvailable: () => models,
		getAll: () => models,
		getError: () => undefined,
		refresh: async () => {},
	} as unknown as ModelRegistry;
	let selected: string | undefined;
	const close = () => {
		slot.removeChild(picker);
		slot.addChild(editor);
		composer!.ui.setFocus(editor);
	};
	const picker = new ModelPickerComponent(
		composer.ui,
		Settings.isolated(),
		registry,
		[],
		{
			onPick: (_model, id) => {
				selected = id;
				close();
			},
			onCancel: close,
		},
		{ editorRows: editor.render(100).length, renderEditorRows: width => editor.render(width) },
	);
	const writes: string[] = [];
	const write = terminal.write.bind(terminal);
	terminal.write = data => {
		writes.push(data);
		write(data);
	};
	slot.removeChild(editor);
	slot.addChild(picker);
	composer.ui.setFocus(picker);
	await paint();
	expect(terminal.getViewport().join("\n")).toContain("MODEL STATUS");
	expect(terminal.getViewport().at(-1)).toContain("EXTENSION BELOW INPUT");
	picker.handleInput("beta");
	await paint();
	expect(terminal.getScrollBuffer().slice(0, -terminal.rows)).toEqual(history);
	picker.handleInput("\r");
	await paint();
	expect(selected).toBe("demo/beta");
	expect(editor.getText()).toBe("draft to preserve");
	expect(terminal.getViewport().map(Bun.stripANSI)).toEqual(screen);
	expect(writes.join("")).not.toMatch(/\x1b\[(?:2|3)J|\x1b\[\?1049h|\x1b\[\?1003h/);
});
