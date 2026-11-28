/**
 * Extension word completion on the native composer: the ghost text a provider adds renders at
 * the caret's line end, Tab/Right accept it with feedback, removing the provider restores the
 * native spelling source, and `observe` reports the draft state extensions gate on (caret,
 * focus, the popup, the inline hint, Vim mode, chips).
 */
import { describe, expect, test } from "bun:test";
import { createRoot, signal } from "@oh-my-pi/pi-tui";
import { corpusEnvironment } from "@oh-my-pi/pi-tui/testing/corpus";
import { plainRows } from "@oh-my-pi/pi-tui/testing/cells";
import { paintNode } from "@oh-my-pi/pi-tui/term/paint";
import {
	Composer,
	type ComposerSnapshot,
	type ComposerWordCompletion,
	type ComposerWordCompletionProvider,
} from "../../../src/ui/composer";
import { key, sendKey } from "./harness";

function make(text = "") {
	return createRoot(() => {
		const composer = new Composer({ text });
		// Paint once so the ghost (and rows-based keys) see a layout.
		paintNode(corpusEnvironment("dark"), composer.node, 80);
		return {
			composer,
			type: (...keys: string[]) => {
				for (const k of keys) {
					if (k.length > 1 && !k.startsWith("\x1b") && k !== "\r")
						for (const ch of k) sendKey(composer.node, composer.field, key(ch));
					else sendKey(composer.node, composer.field, key(k));
				}
			},
			/** The composer as the terminal paints it now, styles stripped. */
			rows: () => plainRows([...paintNode(corpusEnvironment("dark"), composer.node, 80).rows]).join(""),
		};
	});
}

/** A static word-completion source like the app's spelling engine. */
function nativeSource(word: string): ComposerWordCompletion {
	return {
		revision: () => 0,
		getWordCompletion: () => word,
		wordCompletionFeedback: () => {},
	};
}

describe("extension word completion", () => {
	test("renders the provider's ghost at the line end; Tab accepts it with a space and feedback", () => {
		const { composer, type, rows } = make("hello wor");
		const feedback: Parameters<ComposerWordCompletionProvider["wordCompletionFeedback"]>[] = [];
		const queries: { lines: string[]; line: number; col: number }[] = [];
		let suggestion: string | null = "ld";
		const handle = composer.addWordCompletionProvider({
			getWordCompletion: (lines, line, col) => {
				queries.push({ lines: [...lines], line, col });
				return suggestion;
			},
			wordCompletionFeedback: (...args) => {
				suggestion = null;
				feedback.push(args);
			},
		});

		expect(rows()).toContain("wor▏ld");
		// The provider answers the draft as lines and the caret's line/column at its line end.
		expect(queries).toEqual([{ lines: ["hello wor"], line: 0, col: 9 }]);

		type("\t");
		expect(composer.text()).toBe("hello world ");
		expect(feedback).toEqual([[["hello wor"], 0, 9, "ld", true]]);
		// The accepted suggestion no longer ghosts (the provider re-answers over the new draft).
		expect(rows()).not.toContain("▏ld");
		expect(queries[1]).toEqual({ lines: ["hello world "], line: 0, col: 12 });
		handle.dispose();
	});

	test("an extension can restore the draft before Escape reaches the app shortcut", () => {
		const { composer, type } = make("Rewritten draft");
		composer.addKeyHandler(key => {
			if (key.id !== "escape") return false;
			composer.setText("");
			return true;
		});
		const remove = composer.addKeyHandler(
			key => {
				if (key.id !== "escape") return false;
				composer.setText("Original draft");
				return true;
			},
			{ prepend: true },
		);
		type("\x1b");
		expect(composer.text()).toBe("Original draft");
		remove();
		type("\x1b");
		expect(composer.text()).toBe("");
	});

	test("Right accepts the ghost without the trailing space", () => {
		const { composer, type } = make("hello wor");
		const feedback: Parameters<ComposerWordCompletionProvider["wordCompletionFeedback"]>[] = [];
		composer.addWordCompletionProvider({
			getWordCompletion: () => "ld",
			wordCompletionFeedback: (...args) => feedback.push(args),
		});

		type("\x1b[C");
		expect(composer.text()).toBe("hello world");
		expect(feedback).toEqual([[["hello wor"], 0, 9, "ld", true]]);
	});

	test("disposing the provider restores the native spelling ghost (and an earlier extension's)", () => {
		const { composer, rows } = make("we at");
		composer.setWordCompletion(nativeSource("work"));
		expect(rows()).toContain("at▏work");

		const lower = composer.addWordCompletionProvider({
			getWordCompletion: () => "home",
			wordCompletionFeedback: () => {},
		});
		expect(rows()).toContain("at▏home");
		expect(rows()).not.toContain("at▏work");

		const upper = composer.addWordCompletionProvider({
			getWordCompletion: () => "peace",
			wordCompletionFeedback: () => {},
		});
		expect(rows()).toContain("at▏peace");
		expect(rows()).not.toContain("at▏home");

		upper.dispose();
		expect(rows()).toContain("at▏home");
		lower.dispose();
		expect(rows()).toContain("at▏work");
	});

	test("invalidate re-queries the provider without a draft change", () => {
		const { composer, rows } = make("the ans");
		let suggestion = "wer";
		const handle = composer.addWordCompletionProvider({
			getWordCompletion: () => suggestion,
			wordCompletionFeedback: () => {},
		});

		expect(rows()).toContain("ans▏wer");
		suggestion = "wering";
		// The host caches the answer until the provider asks for a re-query.
		expect(rows()).toContain("ans▏wer");
		handle.invalidate();
		expect(rows()).toContain("ans▏wering");
	});

	test("no extension ghost draws while the completion popup is open", () => {
		const { composer, rows } = make("fix bu");
		composer.addWordCompletionProvider({
			getWordCompletion: () => "g",
			wordCompletionFeedback: () => {},
		});
		expect(rows()).toContain("bu▏g");

		composer.showReplacements(0, 3, ["repair"]);
		expect(composer.completing()).toBe(true);
		expect(rows()).not.toContain("bu▏g");
	});
});

describe("composer observation", () => {
	test("reports the draft, caret, focus, popup, inline hint and Vim mode as they change", () => {
		const { composer } = make("fix bu");
		composer.setAutocomplete({
			getSuggestions: async () => null,
			applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
			getInlineHint: () => " <hint>",
		});
		const focus = signal(true);
		const seen: ComposerSnapshot[] = [];
		const remove = composer.observe(
			state => seen.push(state),
			() => focus(),
		);

		expect(seen).toEqual([
			{
				text: "fix bu",
				cursor: 6,
				focused: true,
				completing: false,
				vimMode: null,
				inlineHint: " <hint>",
				protectedTokens: [],
			},
		]);

		composer.setText("fix bug");
		expect(seen.at(-1)).toMatchObject({ text: "fix bug", cursor: 7 });
		composer.setAutocomplete({
			getSuggestions: async () => null,
			applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
			getInlineHint: () => " <new hint>",
		});
		expect(seen.at(-1)!.inlineHint).toBe(" <new hint>");

		focus.set(false);
		expect(seen.at(-1)!.focused).toBe(false);

		composer.showReplacements(0, 3, ["repair"]);
		expect(seen.at(-1)!.completing).toBe(true);
		expect(seen.at(-1)!.inlineHint).toBeNull();

		composer.setVim(true);
		expect(seen.at(-1)!.vimMode).toBe("insert");
		composer.setVim(false);
		expect(seen.at(-1)!.vimMode).toBeNull();

		remove();
		const count = seen.length;
		composer.setText("nothing new");
		expect(seen.length).toBe(count);
	});

	test("protectedTokens follow the chips present in the draft through setText rewrites", () => {
		const { composer } = make("see ");
		const seen: ComposerSnapshot[] = [];
		composer.observe(state => seen.push(state));

		composer.insertAtom("ACME-TOKEN", "the expansion");
		expect(composer.text()).toBe("see ACME-TOKEN ");
		expect(seen.at(-1)!.protectedTokens).toEqual(["ACME-TOKEN"]);

		// A rewrite that keeps the chip's label keeps it protected (the atom survives setText).
		composer.setText(`keep ACME-TOKEN intact`);
		expect(seen.at(-1)!.protectedTokens).toEqual(["ACME-TOKEN"]);

		// A rewrite without the label drops it from the snapshot...
		composer.setText("dropped it");
		expect(seen.at(-1)!.protectedTokens).toEqual([]);

		// ...and the surviving atom shows up again once the text holds its label.
		composer.setText(`ACME-TOKEN again`);
		expect(seen.at(-1)!.protectedTokens).toEqual(["ACME-TOKEN"]);

		// Token chips (skills/models) and repeated labels must retain occurrence order too.
		composer.setAtomizer(text =>
			[...text.matchAll(/\^model/g)].map(match => ({
				from: match.index,
				to: match.index + match[0].length,
				label: "^model",
				expansion: "provider/model",
			})),
		);
		composer.setCollapsedText("^model ACME-TOKEN ^model");
		expect(seen.at(-1)!.protectedTokens).toEqual(["^model", "ACME-TOKEN", "^model"]);
	});
});
