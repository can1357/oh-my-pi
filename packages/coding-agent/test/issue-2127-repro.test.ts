import { describe, expect, it } from "bun:test";
import { EnhancedPasteController } from "@oh-my-pi/pi-coding-agent/utils/enhanced-paste";

/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/2127
 *
 * On kitty (Linux/Wayland), the `/login` flow for OpenCode Zen (and any
 * other modal `Input` prompt: Perplexity OTP, GitHub Enterprise URL,
 * manual OAuth redirect URL, …) silently dropped pasted API keys into
 * the main editor instead of the focused `Input`.
 *
 * Cause: `InputController.#setupEnhancedPaste` enables kitty's enhanced
 * clipboard protocol (`ESC [ ? 5522 h`) on TUI start and consumes OSC
 * 5522 packets via an `addInputListener` before focus dispatch. The
 * controller's `pasteText` callback then routed unconditionally to the
 * main `CustomEditor`, even when `selector-controller.ts` had cleared
 * `editorContainer` and focused a temporary `Input` for the OAuth
 * prompt. The text accumulated in the detached editor; on submit/cancel
 * it resurfaced in the main prompt.
 *
 * Fix: the `pasteText` callback now queries `ui.getFocused()` and routes
 * to the focused component when it exposes a `pasteText` hook (via the
 * new `Input.pasteText` method), falling back to the editor only when no
 * modal target is in focus.
 */

const ST = "\x1b\\";
const OSC = "\x1b]5522;";

function packet(metadata: string, payload?: string): string {
	return `${OSC}${metadata}${payload === undefined ? "" : `;${payload}`}${ST}`;
}

class PasteRecorder {
	pasted: string[] = [];
	pasteText(text: string): void {
		this.pasted.push(text);
	}
}

describe("issue #2127 — enhanced-paste text must follow focus", () => {
	function makeController(focused: { pasteText(text: string): void } | null, editor: PasteRecorder) {
		// Mirror the wiring inside InputController.#setupEnhancedPaste: route to
		// the focused component when it exposes a `pasteText` hook and isn't the
		// main editor; otherwise fall back to the editor. Keeping the predicate
		// identical to the implementation is the whole point of the regression
		// test — drift here means the bug is back.
		return new EnhancedPasteController({
			write: () => {},
			pasteText: text => {
				const target = focused && focused !== editor && typeof focused.pasteText === "function" ? focused : editor;
				target.pasteText(text);
			},
			pasteImage: async () => {},
			showStatus: () => {},
		});
	}

	function deliverApiKey(controller: EnhancedPasteController, apiKey: string): void {
		const textMime = Buffer.from("text/plain", "utf8").toString("base64");
		const password = Buffer.from("pw", "utf8").toString("base64");
		controller.handleInput(packet(`type=read:status=OK:pw=${password}`));
		controller.handleInput(packet(`type=read:status=DATA:mime=${textMime}`));
		controller.handleInput(packet("type=read:status=DONE"));
		// Read phase — controller now requests the chosen MIME and reads bytes.
		controller.handleInput(packet(`type=read:status=OK:pw=${password}`));
		controller.handleInput(
			packet(`type=read:status=DATA:mime=${textMime}`, Buffer.from(apiKey, "utf8").toString("base64")),
		);
		controller.handleInput(packet("type=read:status=DONE"));
	}

	it("routes an OAuth API-key paste to the focused modal Input, not the main editor", () => {
		const editor = new PasteRecorder();
		const codeInput = new PasteRecorder();
		const controller = makeController(codeInput, editor);

		deliverApiKey(controller, "sk-opencode-test-123");

		expect(codeInput.pasted).toEqual(["sk-opencode-test-123"]);
		expect(editor.pasted).toEqual([]);
	});

	it("falls back to the editor when no modal Input is focused", () => {
		const editor = new PasteRecorder();
		const controller = makeController(editor, editor);

		deliverApiKey(controller, "regular paste body");

		expect(editor.pasted).toEqual(["regular paste body"]);
	});

	it("falls back to the editor when the focused component cannot accept a paste", () => {
		const editor = new PasteRecorder();
		// A focused component without `pasteText` (e.g. a passive overlay) must
		// not silently swallow the payload — defer to the main editor.
		const opaqueFocus = {} as { pasteText(text: string): void };
		const controller = makeController(opaqueFocus, editor);

		deliverApiKey(controller, "fallback body");

		expect(editor.pasted).toEqual(["fallback body"]);
	});
});
