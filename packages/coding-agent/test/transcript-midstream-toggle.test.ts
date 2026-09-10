import { describe, expect, it } from "bun:test";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { CombinedAutocompleteProvider, type Component, Container } from "@oh-my-pi/pi-tui";
import { assistantMsg, createTestSession } from "./utilities";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

it.each([9, 10])("restores a %i-row transcript after a temporary dialog replaces the editor", async rowCount => {
	createTestSession();
	const terminal = new VirtualTerminal(80, 12);
	const composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	const slot = new Container();
	slot.addChild(composer.editor);
	transcript.addChild({ render: () => Array.from({ length: rowCount }, (_, index) => `HISTORY_${index + 1}`) });
	composer.setRuntimeChildren([transcript, slot]);
	composer.start();
	composer.ui.setFocus(composer.editor);
	try {
		composer.ui.renderNow();
		await terminal.waitForRender();
		const before = terminal.getViewport().map(row => row.trimEnd());
		const position = terminal.getBufferPosition();
		const dialog = { render: () => Array.from({ length: 8 }, (_, index) => `QUESTION_${index}`) };
		slot.clear();
		slot.addChild(dialog);
		composer.ui.setFocus(dialog);
		composer.ui.renderNow();
		await terminal.waitForRender();
		slot.clear();
		slot.addChild(composer.editor);
		composer.ui.setFocus(composer.editor);
		composer.ui.renderNow();
		await terminal.waitForRender();
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(before);
		expect(terminal.getBufferPosition()).toEqual(position);
	} finally {
		composer.stop();
	}
});

it("reconciles a shrinking mutable tool against the rows actually written to history", async () => {
	createTestSession();
	const terminal = new VirtualTerminal(60, 5);
	const composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	let finalized = false;
	let rows = Array.from({ length: 10 }, (_, index) => `TOOL_${index + 1}`);
	const tool = {
		render: () => rows,
		isTranscriptBlockFinalized: () => finalized,
	};
	transcript.addChild(tool);
	composer.setRuntimeChildren([transcript, { render: () => ["INPUT"] }]);
	composer.start();
	try {
		composer.ui.renderNow();
		rows = ["Tool failed", "Reason"];
		composer.ui.renderNow();
		await terminal.waitForRender();
		expect(
			terminal
				.getViewport()
				.slice(-3)
				.map(row => row.trimEnd()),
		).toEqual(["Tool failed", "Reason", "INPUT"]);
		finalized = true;
		composer.ui.renderNow();
		await terminal.waitForRender();
		composer.ui.renderNow();
		composer.stop();
		const tape = terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(Boolean);
		expect(tape).toEqual(["Tool failed", "Reason", "INPUT"]);
	} finally {
		composer.stop();
	}
});

it("restores the transcript after a temporary job wait is removed", async () => {
	createTestSession();
	const terminal = new VirtualTerminal(80, 20, 1000);
	const composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	const history = {
		render: () => Array.from({ length: 40 }, (_, index) => `HISTORY_${index + 1}`),
		isTranscriptBlockFinalized: () => true,
	};
	const wait = {
		render: () => Array.from({ length: 7 }, (_, index) => `WAIT_${index + 1}`),
		isTranscriptBlockFinalized: () => false,
		isTranscriptBlockTransient: () => true,
	};
	transcript.addChild(history);
	composer.setRuntimeChildren([transcript, { render: () => ["INPUT"] }]);
	composer.start();
	try {
		composer.ui.renderNow();
		await terminal.waitForRender();
		composer.ui.renderNow();
		await terminal.waitForRender();
		const before = terminal.getViewport().map(row => row.trimEnd());
		const tape = terminal.getScrollBuffer().map(row => row.trimEnd());
		transcript.addChild(wait);
		composer.ui.renderNow();
		await terminal.waitForRender();
		transcript.removeChild(wait);
		composer.ui.renderNow();
		await terminal.waitForRender();
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(before);
		expect(terminal.getScrollBuffer().map(row => row.trimEnd())).toEqual(tape);
	} finally {
		composer.stop();
	}
});

it("retains the visible transcript tail when a five-row frame finalizes behind temporary UI", async () => {
	createTestSession();
	const terminal = new VirtualTerminal(80, 5);
	const composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	const message = new AssistantMessageComponent(undefined, false);
	composer.editor.setAutocompleteProvider(
		new CombinedAutocompleteProvider(Array.from({ length: 12 }, (_, index) => ({ name: `command${index}` }))),
	);
	transcript.addChild(message);
	composer.setRuntimeChildren([transcript, composer.editor]);
	composer.start();
	let text = "";
	try {
		for (let index = 1; index <= 10; index++) {
			text += `ROW_${String(index).padStart(2, "0")}\n`;
			message.updateContent(assistantMsg(text), { transient: true });
			composer.ui.renderNow();
		}
		composer.editor.handleInput("/");
		await terminal.waitForRender();
		composer.ui.renderNow();
		message.updateContent(assistantMsg(text), { transient: false });
		message.markTranscriptBlockFinalized();
		composer.ui.renderNow();
		await terminal.waitForRender();
		composer.editor.handleInput("\x7f");
		composer.ui.renderNow();
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("ROW_10");
		expect(terminal.getCursor().row).toBe(4);
		expect(
			Array.from(
				terminal
					.getScrollBuffer()
					.join("\n")
					.match(/ROW_\d{2}/g) ?? [],
			),
		).toEqual(Array.from({ length: 10 }, (_, index) => `ROW_${String(index + 1).padStart(2, "0")}`));
		composer.editor.handleInput("/");
		await terminal.waitForRender();
		composer.ui.renderNow();
		composer.stop();
		const stoppedTape = terminal.getScrollBuffer().join("\n");
		expect(Array.from(stoppedTape.match(/ROW_\d{2}/g) ?? [])).toEqual(
			Array.from({ length: 10 }, (_, index) => `ROW_${String(index + 1).padStart(2, "0")}`),
		);
	} finally {
		composer.stop();
		message.dispose();
	}
});

describe("midstream toggle", () => {
	it("no black bar when command panel opens then closes mid-stream", async () => {
		createTestSession();
		const terminal = new VirtualTerminal(60, 12);
		const composer = new Composer({ preferences: { quiet: true }, terminal });
		const transcript = new TranscriptContainer();
		const message = new AssistantMessageComponent(undefined, false);
		composer.editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(Array.from({ length: 12 }, (_, index) => ({ name: `command${index}` }))),
		);
		transcript.addChild(message);
		composer.setRuntimeChildren([transcript, composer.editor]);
		composer.start();
		let text = "";
		for (let i = 1; i <= 30; i++) {
			text += `ROW_${String(i).padStart(2, "0")} ${"x".repeat(42)}\n`;
			message.updateContent(assistantMsg(text), { transient: true });
			composer.ui.renderNow();
			if (i === 20) {
				const before = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
				const position = terminal.getBufferPosition();
				composer.editor.handleInput("/");
				await terminal.waitForRender();
				composer.ui.renderNow();
				await terminal.waitForRender();
				composer.editor.handleInput("\x7f");
				composer.ui.renderNow();
				await terminal.waitForRender();
				expect(terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd())).toEqual(before);
				expect(terminal.getBufferPosition()).toEqual(position);
			}
		}
		const tape = terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row))
			.join("\n");
		expect(Array.from(tape.match(/ROW_\d{2}/g) ?? [])).toEqual(
			Array.from({ length: 30 }, (_, index) => `ROW_${String(index + 1).padStart(2, "0")}`),
		);
		composer.stop();
		message.dispose();
	});

	it("keeps every streamed row when ordinary non-dropdown chrome grows and shrinks", async () => {
		createTestSession();
		const terminal = new VirtualTerminal(60, 12);
		const composer = new Composer({ preferences: { quiet: true }, terminal });
		const transcript = new TranscriptContainer();
		const message = new AssistantMessageComponent(undefined, false);
		let extra = 0;
		const input: Component = {
			render: () => [...Array.from({ length: extra }, (_, index) => `EXTRA ${index}`), "INPUT"],
		};
		transcript.addChild(message);
		composer.setRuntimeChildren([transcript, input]);
		composer.start();
		let text = "";
		try {
			for (let i = 1; i <= 30; i++) {
				text += `ROW_${String(i).padStart(2, "0")} ${"x".repeat(42)}\n`;
				message.updateContent(assistantMsg(text), { transient: true });
				composer.ui.renderNow();
				if (i === 15) {
					extra = 4;
					composer.ui.renderNow();
				}
				if (i === 20) {
					extra = 0;
					composer.ui.renderNow();
					await terminal.waitForRender();
				}
				{
					const tape = terminal
						.getScrollBuffer()
						.map(row => Bun.stripANSI(row))
						.join("\n");
					const visible = Array.from(tape.match(/ROW_\d{2}/g) ?? []);
					const incoming = Array.from({ length: i }, (_, index) => `ROW_${String(index + 1).padStart(2, "0")}`);
					expect(visible).toEqual(incoming);
					if (i >= 15) expect(terminal.getViewport().at(-1)?.trimEnd()).toBe("INPUT");
				}
			}
		} finally {
			composer.stop();
			message.dispose();
		}
	});
});
