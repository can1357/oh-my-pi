import { describe, expect, test } from "bun:test";
import { type ComposerKey, composeMessage, decideComposerKey } from "../src/components/composer/keymap";

function press(key: string, mods: Partial<ComposerKey> = {}): ComposerKey {
	return { key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...mods };
}

const INLINE = { variant: "inline", slashOpen: false } as const;
const MODAL = { variant: "modal", slashOpen: false } as const;
const INLINE_SLASH = { variant: "inline", slashOpen: true } as const;
const MODAL_SLASH = { variant: "modal", slashOpen: true } as const;

describe("slash completion only accepts unmodified keys", () => {
	// The regression: accepting replaces the draft with `/name `, so a modified
	// key landing here destroys whatever the user had written.
	test("plain Tab and plain Enter accept", () => {
		expect(decideComposerKey(press("Tab"), INLINE_SLASH)).toEqual({ type: "slashAccept" });
		expect(decideComposerKey(press("Enter"), INLINE_SLASH)).toEqual({ type: "slashAccept" });
	});

	test("Shift+Enter does not accept — it is a newline", () => {
		expect(decideComposerKey(press("Enter", { shiftKey: true }), MODAL_SLASH)).toEqual({ type: "none" });
		expect(decideComposerKey(press("Enter", { shiftKey: true }), INLINE_SLASH)).toEqual({ type: "none" });
	});

	test("⌘↵ does not accept — in the modal it sends", () => {
		expect(decideComposerKey(press("Enter", { metaKey: true }), MODAL_SLASH)).toEqual({ type: "submit" });
	});

	test("Shift+Tab does not accept — it moves focus", () => {
		expect(decideComposerKey(press("Tab", { shiftKey: true }), MODAL_SLASH)).toEqual({ type: "none" });
	});

	test("an IME candidate commit never accepts", () => {
		expect(decideComposerKey(press("Enter", { isComposing: true }), INLINE_SLASH)).toEqual({ type: "none" });
	});
});

describe("Enter", () => {
	test("sends inline, adds a line in the modal", () => {
		expect(decideComposerKey(press("Enter"), INLINE)).toEqual({ type: "submit" });
		expect(decideComposerKey(press("Enter"), MODAL)).toEqual({ type: "none" });
	});

	test("⌘↵ sends in the modal", () => {
		expect(decideComposerKey(press("Enter", { metaKey: true }), MODAL)).toEqual({ type: "submit" });
		expect(decideComposerKey(press("Enter", { ctrlKey: true }), MODAL)).toEqual({ type: "submit" });
	});

	test("an IME candidate commit never sends", () => {
		// Without this the Enter that confirms a Chinese/Japanese/Korean candidate
		// sends the half-composed message.
		expect(decideComposerKey(press("Enter", { isComposing: true }), INLINE)).toEqual({ type: "none" });
		expect(decideComposerKey(press("Enter", { metaKey: true, isComposing: true }), MODAL)).toEqual({ type: "none" });
	});

	test("Shift+Enter is a newline inline too", () => {
		expect(decideComposerKey(press("Enter", { shiftKey: true }), INLINE)).toEqual({ type: "none" });
	});
});

describe("Escape dismisses one thing at a time", () => {
	test("the slash menu first, the modal second", () => {
		expect(decideComposerKey(press("Escape"), MODAL_SLASH)).toEqual({ type: "slashDismiss" });
		expect(decideComposerKey(press("Escape"), MODAL)).toEqual({ type: "collapse" });
	});

	test("inline with no menu it is not ours — the turn-abort listener gets it", () => {
		expect(decideComposerKey(press("Escape"), INLINE)).toEqual({ type: "none" });
	});
});

describe("⌘E", () => {
	test("toggles from either surface, and outranks the slash menu", () => {
		expect(decideComposerKey(press("e", { metaKey: true }), INLINE)).toEqual({ type: "toggleExpand" });
		expect(decideComposerKey(press("e", { metaKey: true }), MODAL_SLASH)).toEqual({ type: "toggleExpand" });
		expect(decideComposerKey(press("E", { metaKey: true }), MODAL)).toEqual({ type: "toggleExpand" });
	});

	test("a bare e is just a letter", () => {
		expect(decideComposerKey(press("e"), MODAL)).toEqual({ type: "none" });
	});
});

describe("arrows move the highlight only while the menu is open", () => {
	test("open", () => {
		expect(decideComposerKey(press("ArrowDown"), INLINE_SLASH)).toEqual({ type: "slashMove", delta: 1 });
		expect(decideComposerKey(press("ArrowUp"), INLINE_SLASH)).toEqual({ type: "slashMove", delta: -1 });
	});

	test("closed — the caret needs them", () => {
		expect(decideComposerKey(press("ArrowDown"), MODAL)).toEqual({ type: "none" });
		expect(decideComposerKey(press("ArrowUp"), INLINE)).toEqual({ type: "none" });
	});
});

describe("composeMessage", () => {
	test("quotes every path — macOS paths have spaces", () => {
		expect(composeMessage("", ["/Users/x/Mobile Documents/a b.pdf"])).toBe('@"/Users/x/Mobile Documents/a b.pdf"');
	});

	test("the draft comes first, mentions after a blank line", () => {
		expect(composeMessage("revisa esto", ["/tmp/a.pdf"])).toBe('revisa esto\n\n@"/tmp/a.pdf"');
	});

	test("no references leaves the draft untouched, trimmed", () => {
		expect(composeMessage("  hola  ", [])).toBe("hola");
	});

	test("references with no draft still send", () => {
		// Dropping a file and pressing send with nothing typed is a real thing to do.
		expect(composeMessage("   ", ["/tmp/a.pdf", "/tmp/b.docx"])).toBe('@"/tmp/a.pdf" @"/tmp/b.docx"');
	});

	test("nothing at all is empty, so submit can bail", () => {
		expect(composeMessage("", [])).toBe("");
	});
});
