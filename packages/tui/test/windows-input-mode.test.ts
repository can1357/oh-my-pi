import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Editor, type Component } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { matchesAppFollowUp } from "@oh-my-pi/pi-tui/keybinding-matchers";
import { setKeybindings } from "@oh-my-pi/pi-tui/keybindings";
import { matchesKey } from "@oh-my-pi/pi-tui/keys";
import { Win32InputModeDecoder, Win32PasteMarkerNormalizer } from "@oh-my-pi/pi-tui/windows-input-mode";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";
import { defaultEditorTheme } from "./test-themes";

// Records as the Windows console host emits them: CSI Vk;Sc;Uc;Kd;Cs;Rc _
const SHIFT_ENTER = "\x1b[13;28;13;1;16;1_";
const CTRL_ENTER = "\x1b[13;28;10;1;8;1_";
const ENTER = "\x1b[13;28;13;1;0;1_";
const ENTER_UP = "\x1b[13;28;13;0;0;1_";

function pasteRecords(text: string): string {
	return [...text].map(char => `\x1b[231;0;${char.charCodeAt(0)};1;0;1_`).join("");
}

function decodeOne(data: string): string {
	const keys = new Win32InputModeDecoder().decode(data);
	expect(keys).toHaveLength(1);
	return keys![0]!;
}

describe("Win32InputModeDecoder", () => {
	it("keeps Shift+Enter and Ctrl+Enter distinct from Enter", () => {
		expect(decodeOne(ENTER)).toBe("\r");
		expect(matchesKey(decodeOne(SHIFT_ENTER), "shift+enter")).toBe(true);
		expect(matchesKey(decodeOne(CTRL_ENTER), "ctrl+enter")).toBe(true);
		expect(matchesKey(decodeOne(CTRL_ENTER), "enter")).toBe(false);
	});

	it("drops key releases and bare modifier presses", () => {
		const decoder = new Win32InputModeDecoder();
		expect(decoder.decode(ENTER_UP)).toEqual([]);
		expect(decoder.decode("\x1b[16;42;0;1;16;1_")).toEqual([]);
		expect(decoder.decode("\x1b[17;29;0;1;8;1_")).toEqual([]);
	});

	it("passes non-record sequences through untouched", () => {
		const decoder = new Win32InputModeDecoder();
		expect(decoder.decode("\x1b[A")).toBeUndefined();
		expect(decoder.decode("\x1b[200~")).toBeUndefined();
		expect(decoder.decode("a")).toBeUndefined();
	});

	it("decodes text, control and Alt chords to the legacy bytes key matching expects", () => {
		expect(decodeOne("\x1b[65;30;97;1;0;1_")).toBe("a");
		expect(decodeOne("\x1b[65;30;65;1;16;1_")).toBe("A");
		expect(matchesKey(decodeOne("\x1b[67;46;3;1;8;1_"), "ctrl+c")).toBe(true);
		expect(matchesKey(decodeOne("\x1b[66;48;98;1;2;1_"), "alt+b")).toBe(true);
		expect(matchesKey(decodeOne("\x1b[9;15;9;1;16;1_"), "shift+tab")).toBe(true);
		expect(matchesKey(decodeOne("\x1b[8;14;8;1;2;1_"), "alt+backspace")).toBe(true);
		expect(matchesKey(decodeOne("\x1b[27;1;27;1;0;1_"), "escape")).toBe(true);
	});

	it("keeps Ctrl+Shift+letter distinct from Ctrl+letter", () => {
		const ctrlShiftP = decodeOne("\x1b[80;25;16;1;24;1_");
		expect(matchesKey(ctrlShiftP, "ctrl+shift+p")).toBe(true);
		expect(matchesKey(ctrlShiftP, "ctrl+p")).toBe(false);
	});

	it("encodes navigation keys with their modifiers", () => {
		expect(matchesKey(decodeOne("\x1b[38;72;0;1;256;1_"), "up")).toBe(true);
		expect(matchesKey(decodeOne("\x1b[38;72;0;1;264;1_"), "ctrl+up")).toBe(true);
		expect(matchesKey(decodeOne("\x1b[46;83;0;1;256;1_"), "delete")).toBe(true);
		expect(matchesKey(decodeOne("\x1b[116;63;0;1;0;1_"), "f5")).toBe(true);
	});

	it("emits AltGr-composed text instead of a Ctrl+Alt chord", () => {
		// German layout: AltGr+Q → "@" reported as Right Alt + Left Ctrl.
		expect(decodeOne("\x1b[81;16;64;1;9;1_")).toBe("@");
	});

	it("joins surrogate halves delivered as separate records", () => {
		const decoder = new Win32InputModeDecoder();
		expect(decoder.decode("\x1b[231;0;55357;1;0;1_")).toEqual([]);
		expect(decoder.decode("\x1b[231;0;56832;1;0;1_")).toEqual(["😀"]);
	});

	it("delivers Alt+Numpad composition on the Alt release", () => {
		expect(new Win32InputModeDecoder().decode("\x1b[18;56;233;0;32;1_")).toEqual(["é"]);
	});

	it("repeats auto-repeated keys", () => {
		expect(new Win32InputModeDecoder().decode("\x1b[65;30;97;1;0;3_")).toEqual(["a", "a", "a"]);
	});

	it("decodes key records inside a paste as typed text", () => {
		const decoder = new Win32InputModeDecoder();
		// Blank line: two Enter down/up pairs; emoji: surrogate halves as VK_PACKET records.
		const pasted = `a${ENTER}${ENTER_UP}${ENTER}${ENTER_UP}b\x1b[231;0;55357;1;0;1_\x1b[231;0;56832;1;0;1_`;
		expect(decoder.decodePaste(pasted)).toBe("a\r\rb😀");
		// Record-shaped text without ESC is ordinary pasted content.
		expect(decoder.decodePaste("see [13;28;13;1;0;1_ here")).toBe("see [13;28;13;1;0;1_ here");
	});

	it("reassembles escape sequences a VT host relays as one text record per byte", () => {
		// Captured from ConPTY when the host terminal writes `ESC [ 1 ; 3 A` (Alt+Up).
		const relay = (text: string) => [...text].map(ch => `\x1b[0;0;${ch.charCodeAt(0)};1;0;1_`);
		const decoder = new Win32InputModeDecoder();
		const keys = relay("\x1b[1;3A").flatMap(record => decoder.decode(record)!);
		expect(keys).toEqual(["\x1b[1;3A"]);
		expect(matchesKey(keys[0]!, "alt+up")).toBe(true);
		expect(relay("\x1b\x1b[A").flatMap(record => decoder.decode(record)!)).toEqual(["\x1b\x1b[A"]);
		expect(decoder.hasPendingSequence).toBe(false);

		// A lone relayed ESC is held, then released as Escape; plain text is not held.
		expect(decoder.decode(relay("\x1b")[0]!)).toEqual([]);
		expect(decoder.flushPendingSequence()).toEqual(["\x1b"]);
		expect(decoder.decode(relay("x")[0]!)).toEqual(["x"]);
		// A real key record ends a held ESC instead of being swallowed into it.
		decoder.decode(relay("\x1b")[0]!);
		expect(decoder.decode(ENTER)).toEqual(["\x1b", "\r"]);

		// Escape then Alt+d stays two keys; only `ESC ESC [` / `ESC ESC O` group as meta-CSI/SS3.
		const split = relay("\x1b\x1bd").flatMap(record => decoder.decode(record)!);
		expect(split).toEqual(["\x1b", "\x1bd"]);
		expect(matchesKey(split[0]!, "escape")).toBe(true);
		expect(matchesKey(split[1]!, "alt+d")).toBe(true);
		expect(decoder.hasPendingSequence).toBe(false);
	});
});

class InputRecorder implements Component {
	received: string[] = [];
	invalidate(): void {}
	render(): string[] {
		return [""];
	}
	handleInput(data: string): void {
		this.received.push(data);
	}
}

const SSH_ENV_KEYS = ["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"] as const;
const originalSshEnv = SSH_ENV_KEYS.map(key => [key, Bun.env[key]] as const);

describe("ProcessTerminal win32-input-mode fallback", () => {
	let harness: ProcessTerminalRenderHarness | undefined;

	beforeEach(() => {
		for (const key of SSH_ENV_KEYS) delete Bun.env[key];
	});

	afterEach(() => {
		vi.useRealTimers();
		harness?.dispose();
		harness = undefined;
		for (const [key, value] of originalSshEnv) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	});

	it("enables win32-input-mode on a native console without kitty and decodes key records", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: true, nativeWindowsConsole: true });
		const recorder = new InputRecorder();
		harness.tui.addChild(recorder);
		harness.tui.setFocus(recorder);
		await harness.settle();
		harness.writes.length = 0;

		await harness.feed("\x1b[?61;4;6;7;14;21;22;23;24;28;32;42;52c");
		const out = harness.writes.join("");
		expect(out).toContain("\x1b[?9001h");
		expect(out).not.toContain("\x1b[>4;2m");

		await harness.feed(SHIFT_ENTER, ENTER_UP, CTRL_ENTER);
		expect(recorder.received).toHaveLength(2);
		expect(matchesKey(recorder.received[0]!, "shift+enter")).toBe(true);
		expect(matchesKey(recorder.received[1]!, "ctrl+enter")).toBe(true);

		harness.writes.length = 0;
		harness.tui.stop();
		expect(harness.writes.join("")).toContain("\x1b[?9001l");
	});

	it("prefers a late kitty reply and turns win32-input-mode back off", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: true, nativeWindowsConsole: true });
		await harness.settle();
		harness.writes.length = 0;

		await harness.feed("\x1b[?1;2c", "\x1b[?0u");

		const out = harness.writes.join("");
		expect(harness.terminal.kittyProtocolActive).toBe(true);
		expect(out.indexOf("\x1b[?9001l")).toBeGreaterThan(out.indexOf("\x1b[?9001h"));
		expect(out).toContain("\x1b[>1u");
	});

	it("keeps both relayed Escape keys actionable before the next real key", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: true, nativeWindowsConsole: true });
		const recorder = new InputRecorder();
		harness.tui.addChild(recorder);
		harness.tui.setFocus(recorder);
		await harness.settle();
		await harness.feed("\x1b[?1;2c");

		const escape = "\x1b[0;0;27;1;0;1_";
		process.stdin.emit("data", `${escape}${escape}\x1b[88;45;120;1;0;1_`);

		expect(recorder.received.map(key => (matchesKey(key, "escape") ? "interrupt" : key))).toEqual([
			"interrupt",
			"interrupt",
			"x",
		]);
	});

	it("releases a relayed lone Escape after a single wait window", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: true, nativeWindowsConsole: true });
		const recorder = new InputRecorder();
		harness.tui.addChild(recorder);
		harness.tui.setFocus(recorder);
		await harness.settle();
		await harness.feed("\x1b[?1;2c");
		vi.useFakeTimers();

		// The paste-marker normalizer and the decoder both hold a relayed ESC; their
		// 75 ms waits must not stack into ~150 ms.
		process.stdin.emit("data", "\x1b[0;0;27;1;0;1_");
		vi.advanceTimersByTime(74);
		expect(recorder.received).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(recorder.received).toEqual(["\x1b"]);
	});

	it("delivers a held relayed Escape when a late kitty reply turns the mode off", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: true, nativeWindowsConsole: true });
		const recorder = new InputRecorder();
		harness.tui.addChild(recorder);
		harness.tui.setFocus(recorder);
		await harness.settle();
		await harness.feed("\x1b[?1;2c");
		vi.useFakeTimers();

		process.stdin.emit("data", "\x1b[0;0;27;1;0;1_");
		process.stdin.emit("data", "\x1b[?0u");
		expect(harness.terminal.kittyProtocolActive).toBe(true);
		vi.runAllTimers();
		expect(recorder.received).toEqual(["\x1b"]);
	});

	it("pastes line breaks the console host sent as key records, then submits on a later Enter (#14065)", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: true, nativeWindowsConsole: true });
		const recorder = new InputRecorder();
		harness.tui.addChild(recorder);
		harness.tui.setFocus(recorder);
		await harness.settle();
		await harness.feed("\x1b[?61;4;6;7;14;21;22;23;24;28;32;42;52c");

		// Split mid-record across stdin reads.
		await harness.feed(`\x1b[200~first${ENTER.slice(0, 6)}`, `${ENTER.slice(6)}${ENTER_UP}second\x1b[201~`);
		await harness.feed(ENTER, ENTER_UP);
		expect(recorder.received).toEqual(["\x1b[200~first\rsecond\x1b[201~", "\r"]);
	});

	it("treats paste delimiters encoded as win32 key records as framing across stdin reads", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: true, nativeWindowsConsole: true });
		const editor = new Editor(defaultEditorTheme);
		harness.tui.addChild(editor);
		harness.tui.setFocus(editor);
		await harness.settle();
		await harness.feed("\x1b[?61;4;6;7;14;21;22;23;24;28;32;42;52c");

		const start = [..."\x1b[200~"].map(char => `${pasteRecords(char)}\x1b[231;0;0;0;0;1_`).join("");
		const end = pasteRecords("\x1b[201~");
		await harness.feed(start.slice(0, 17), start.slice(17), "https://example.com", end.slice(0, 31), end.slice(31));
		expect(editor.getText()).toBe("https://example.com");
		await harness.feed(end);
		expect(editor.getText()).toBe("https://example.com");
	});

	it("decodes record-encoded payload text and release events inside an encoded paste", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: true, nativeWindowsConsole: true });
		const editor = new Editor(defaultEditorTheme);
		harness.tui.addChild(editor);
		harness.tui.setFocus(editor);
		await harness.settle();
		await harness.feed("\x1b[?1;2c");

		await harness.feed(
			pasteRecords("\x1b[200~") +
				"\x1b[231;0;126;0;0;1_" +
				pasteRecords("first") +
				ENTER +
				ENTER_UP +
				pasteRecords("second") +
				pasteRecords("\x1b[201~"),
		);
		expect(editor.getText()).toBe("first\nsecond");
	});

	it("leaves non-marker key records unchanged when a prefix is interrupted", () => {
		const emitted: string[] = [];
		const normalizer = new Win32PasteMarkerNormalizer(data => emitted.push(data));
		const prefix = pasteRecords("\x1b[20");
		normalizer.process(prefix.slice(0, 8));
		normalizer.process(prefix.slice(8) + SHIFT_ENTER);
		normalizer.flush();
		expect(emitted.join("")).toBe(prefix + SHIFT_ENTER);
	});

	it("does not request win32-input-mode when the console is served by sshd (#14034)", async () => {
		// Over Windows OpenSSH the console host's input comes from the remote
		// terminal's VT stream; win32-input-mode re-encodes `ESC [ A` as three
		// separate key records (Escape, `[`, `A`), so arrow keys act as Escape.
		Bun.env.SSH_CONNECTION = "192.0.2.10 54321 192.0.2.20 22";
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: true, nativeWindowsConsole: true });
		await harness.settle();
		harness.writes.length = 0;

		await harness.feed("\x1b[?1;2c");
		expect(harness.writes.join("")).not.toContain("\x1b[?9001h");
	});
});

describe("decoded Enter chords under the default keybindings", () => {
	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	it("sends a follow-up on Ctrl+Enter and leaves Shift+Enter to the editor's newline", () => {
		setKeybindings(KeybindingsManager.inMemory());
		expect(matchesAppFollowUp(decodeOne(CTRL_ENTER))).toBe(true);
		expect(matchesAppFollowUp(decodeOne(SHIFT_ENTER))).toBe(false);
	});
});
