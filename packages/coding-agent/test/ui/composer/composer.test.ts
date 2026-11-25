/**
 * Composer behaviour beyond the corpus: submission (atoms expanded, the
 * submit transform), extension hooks, the shape registry, undo and Vim.
 */
import { describe, expect, test } from "bun:test";
import { createRoot, signal } from "@oh-my-pi/pi-tui";
import { bubbleEvent, pathTo } from "@oh-my-pi/pi-tui/dispatch";
import { corpusEnvironment } from "@oh-my-pi/pi-tui/testing/corpus";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { plainRows } from "@oh-my-pi/pi-tui/testing/cells";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { getKeybindings, KeybindingsManager, setKeybindings } from "../../../src/config/keybindings/keybindings";
import {
	Composer,
	type ComposerOptions,
	chipLabel,
	composerShape,
	registerComposerShape,
} from "../../../src/ui/composer";
import { composerShapePreviewRows } from "../../../src/ui/styles/overlays/composer-shape-preview";
import { key, sendKey, sendPaste } from "./harness";

function make(options: ComposerOptions = {}): { composer: Composer; type(...keys: string[]): void } {
	return createRoot(() => {
		const composer = new Composer(options);
		// Paint once so rows-based keys (history, up/down) see a layout.
		paintNode(corpusEnvironment("dark"), composer.node, 80);
		return {
			composer,
			type(...keys: string[]) {
				for (const k of keys) {
					if (k.length > 1 && !k.startsWith("\x1b") && k !== "\r")
						for (const ch of k) sendKey(composer.node, composer.field, key(ch));
					else sendKey(composer.node, composer.field, key(k));
				}
			},
		};
	});
}

describe("submission", () => {
	test("expands pastes and chips, applies the transform, keeps history", () => {
		const sent: string[] = [];
		const { composer, type } = make({ onSubmit: text => sent.push(text) });
		type("see ");
		sendPaste(composer.node, composer.field, Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n"));
		// The paste collapses into a text chip, staged with the space after it.
		expect(composer.text()).toBe(`see ${chipLabel("paste", 1)} `);
		composer.setSubmitTransform(text => text.toUpperCase());
		type("\r");
		expect(sent).toEqual([`SEE ${Array.from({ length: 12 }, (_, i) => `L${i}`).join("\n")} `]);
		expect(composer.text()).toBe("");
		type("\x1b[A");
		expect(composer.text()).toBe(`see ${chipLabel("paste", 1)} `);
	});
	test("a transform returning undefined keeps the draft", () => {
		const { composer, type } = make({ onSubmit: () => {} });
		composer.setSubmitTransform(() => undefined);
		type("draft", "\r");
		expect(composer.text()).toBe("draft");
	});
});

describe("editing chords", () => {
	test("character jumps skip the current character, cross lines, and consume the target rather than typing it", () => {
		const { composer, type } = make({ text: "a b\nab" });
		type("\x01", "\x1b[93;7u", "a"); // Home on the last line; jump backward to the earlier 'a'.
		expect(composer.cursor()).toBe(0);
		type("\x1d", "a");
		expect(composer.cursor()).toBe(4);
		type("\x1d", "z"); // Not found: consume z, stay put.
		expect(composer.text()).toBe("a b\nab");
		expect(composer.cursor()).toBe(4);
		type("\x1d", "\x1d", "x"); // Repeating the chord disarms it.
		expect(composer.text()).toBe("a b\nxab");
	});

	test("rebound jump takes a space as a target, even with space bound to dictation", () => {
		const previous = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory({ "tui.editor.jumpForward": "f2" }));
		try {
			const { composer, type } = make({ text: "one two" });
			composer.setSpaceHold(["space"], { enabled: () => true, onStart() {}, onEnd() {} });
			type("\x01", "\x1bOQ", " ");
			expect(composer.cursor()).toBe(3);
			expect(composer.text()).toBe("one two");
		} finally {
			setKeybindings(previous);
		}
	});

	test("a dictation in progress keeps the draft through user submits, but its own submit trigger still works", () => {
		const busy = signal(true);
		const sent: string[] = [];
		const { composer, type } = make({ text: "speaking", dictating: busy, onSubmit: text => sent.push(text) });
		type("\r");
		composer.field.handlers.onSend?.("other", { type: "send", key: "input", text: "other" });
		expect(composer.text()).toBe("speaking");
		expect(sent).toEqual([]);
		composer.submit();
		expect(sent).toEqual(["speaking"]);
		busy.set(false);
		type("ready", "\r");
		expect(sent).toEqual(["speaking", "ready"]);
	});

	test("when Enter makes new lines and Shift+Enter sends, backslash + Enter sends without the backslash", () => {
		const previous = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory({ "tui.input.newLine": "enter", "tui.input.submit": "shift+enter" }));
		try {
			const sent: string[] = [];
			const { composer, type } = make({ onSubmit: text => sent.push(text) });
			type("one", "\r", "two\\", "\r");
			expect(sent).toEqual(["one\ntwo"]);
			expect(composer.text()).toBe("");
		} finally {
			setKeybindings(previous);
		}
	});
});

describe("raw field selection", () => {
	test("Cmd+A replaces the multiline draft even when the composer intercepts a large paste", () => {
		const { composer, type } = make({ text: "one\ntwo" });
		type("\x01"); // Ctrl+A is still line start, not select all.
		expect(composer.cursor()).toBe(4);
		type("\x1b[97;9u");
		const pasted = Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\n");
		sendPaste(composer.node, composer.field, pasted);
		expect(composer.expandedText()).toBe(`${pasted} `);
		type("!");
		expect(composer.expandedText()).toBe(`${pasted} !`);
	});
	test("a push-to-talk candidate types over the selection before a hold is recognized", () => {
		const { composer, type } = make({ text: "draft" });
		composer.setSpaceHold(["space"], { enabled: () => true, onStart() {}, onEnd() {} });
		type("\x1b[97;9u", " ", "x");
		expect(composer.text()).toBe(" x");
	});
	test("an outside draft change does not revive a previous selection on undo", () => {
		const { composer, type } = make({ text: "draft" });
		type("\x1b[97;9u");
		composer.setText("changed");
		composer.undo();
		type("!");
		expect(composer.text()).toBe("draft!");
	});
});

describe("extension hooks", () => {
	test("key handlers run before the composer's bindings", () => {
		const { composer, type } = make();
		const remove = composer.addKeyHandler(k => k.id === "x");
		type("axb");
		expect(composer.text()).toBe("ab");
		remove();
		type("x");
		expect(composer.text()).toBe("abx");
	});
	test("decorations style the draft natively and in the terminal", () => {
		const { composer, type } = make();
		composer.addDecorator(text => (text.startsWith("ultra") ? [{ from: 0, to: 5, s: "accent", fx: "shimmer" }] : []));
		type("ultra");
		const editor = composer.field.props() as { decor?: unknown };
		expect(editor.decor).toEqual([{ from: 0, to: 5, s: "accent", fx: "shimmer" }]);
	});
	test("shapes: registered ids draw, unknown ids fall back to box", () => {
		registerComposerShape({
			id: "test-bracket",
			sideBorders: false,
			paddingX: 0,
			sideWidth: () => 1,
			row: cx => [`[${cx.text}${cx.pad}]`],
		});
		expect(composerShape("nope").id).toBe("box");
		const { composer, type } = make({ shape: "test-bracket" });
		type("hi");
		expect(plainRows([...paintNode(corpusEnvironment("dark"), composer.node, 10).rows])).toEqual(["[hi▏     ]"]);
	});
	test("a custom shape keeps the hardware caret on its text row after leading padding", () => {
		const remove = registerComposerShape({
			id: "test-padded",
			sideBorders: true,
			paddingX: 1,
			sideWidth: paddingX => paddingX + 1,
			top: ({ width }) => `╭${"─".repeat(width - 2)}╮`,
			row: ({ first, last, width, text, pad }) => {
				const blank = `│${" ".repeat(width - 2)}│`;
				return {
					rows: [...(first ? [blank] : []), `│ ${text}${pad} │`, ...(last ? [blank] : [])],
					textRow: first ? 1 : 0,
				};
			},
			bottom: ({ width }) => `╰${"─".repeat(width - 2)}╯`,
		});
		const { composer } = make({ shape: "test-padded", caret: "terminal" });
		const theme = loadThemeSync("dark");
		const term = createTestTerminal(() => ({ dock: composer.node }), { columns: 24, rows: 8, theme });
		try {
			term.focus(composer.field);
			term.type("hello");
			const blank = `│${" ".repeat(22)}│`;
			const top = `╭${"─".repeat(22)}╮`;
			const bottom = `╰${"─".repeat(22)}╯`;
			const screen = term.screen();
			expect(screen.slice(-5)).toEqual([top, blank, `│ hello${" ".repeat(16)}│`, blank, bottom]);
			expect(term.cursor()).toEqual({ row: screen.length - 3, col: 7 });

			const preview = plainRows(composerShapePreviewRows(theme, "test-padded", 24));
			expect(preview).toEqual([top, blank, expect.stringContaining("Ask anything"), blank, bottom]);
		} finally {
			term.dispose();
			remove();
		}
	});
});

describe("undo", () => {
	test("typing is one step per word and its blanks; ctrl+- undoes it", () => {
		const { composer, type } = make();
		type("one two");
		type("\x1f");
		expect(composer.text()).toBe("one ");
		type("\x1f");
		expect(composer.text()).toBe("");
	});
});

describe("vim", () => {
	const vim = (text: string, keys: string): Composer => {
		const { composer, type } = make({ vim: true, text });
		type("\x1b");
		for (const ch of keys) type(ch);
		return composer;
	};
	test("operators over motions and text objects", () => {
		expect(vim("one two three", "0dw").text()).toBe("two three");
		expect(vim("one two three", "0wciwX\x1b").text()).toBe("one X three");
		expect(vim("call(a, b)", "0f(di(").text()).toBe("call()");
		expect(vim('say "hi there"', '0fhda"').text()).toBe("say");
		expect(vim("a b c d", "0d2w").text()).toBe("c d");
	});
	test("lines: dd, yy/P, J, counts", () => {
		expect(vim("a\nb\nc", "ggdd").text()).toBe("b\nc");
		expect(vim("a\nb", "ggyyP").text()).toBe("a\na\nb");
		expect(vim("a\n  b", "ggJ").text()).toBe("a b");
		expect(vim("a\nb\nc\nd", "gg2dd").text()).toBe("c\nd");
	});
	test("dot repeats the last change, u undoes it", () => {
		expect(vim("aaaa", "0x..").text()).toBe("a");
		const c = vim("abc", "0xu");
		expect(c.text()).toBe("abc");
	});
	test("visual: o swaps ends, d deletes the inclusive selection", () => {
		expect(vim("abcdef", "0lvlld").text()).toBe("aef");
		expect(vim("abcdef", "0llvlohd").text()).toBe("aef");
		const { composer, type } = make({ vim: true, text: "abcd" });
		type("\x1b", "0vl", "\x1b[97;9u", "d");
		expect(composer.text()).toBe("cd");
	});
	test("% jumps to the matching bracket", () => {
		const c = vim("(a [b] c)", "0%");
		expect(c.cursor()).toBe(8);
	});
});

describe("history recall with attachments", () => {
	const IMAGE = { type: "image", data: "aGk=", mimeType: "image/png" } as const;
	const lines = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n");

	test("native send submits only its own prompt and keeps the displaced image draft for recall", () => {
		const { composer, type } = make();
		const persisted: string[] = [];
		composer.setHistory([], text => persisted.push(text));
		composer.insertAtom("[Image #1]", "[Image #1]", { kind: "image", image: IMAGE, link: "/tmp/shot.png" });
		composer.insertTextAttachment("draft attachment");
		const draft = composer.expandedText();
		composer.onSubmit = text => {
			expect(composer.pendingImages).toEqual([]);
			expect(composer.pendingImageLinks).toEqual([]);
			expect(composer.chips()).toEqual([]);
			composer.addToHistory(text);
		};
		bubbleEvent(pathTo([composer.node], composer.field), { type: "send", key: "composer", text: "independent" });
		expect(persisted).toEqual(["independent"]);
		expect(composer.text()).toBe("");
		type("\x1b[A");
		expect(composer.expandedText()).toBe("independent");
		expect(composer.pendingImages).toEqual([]);
		type("\x1b[A");
		expect(composer.expandedText()).toBe(draft);
		expect(composer.pendingImages).toEqual([IMAGE]);
		expect(composer.pendingImageLinks).toEqual(["/tmp/shot.png"]);
	});

	test("a submission the app recorded recalls with its chips, pastes and images", () => {
		const { composer, type } = make();
		const sent: string[] = [];
		composer.onSubmit = text => {
			sent.push(text);
			composer.pendingImages.length = 0;
			composer.pendingImageLinks.length = 0;
			composer.addToHistory(text);
		};
		composer.insertAtom("[Image #1]", "[Image #1]", { kind: "image", image: IMAGE, link: "/tmp/shot.png" });
		composer.insertTextAttachment("attached text");
		sendPaste(composer.node, composer.field, lines);
		type("\r");
		expect(composer.text()).toBe("");
		expect(composer.pendingImages).toHaveLength(0);

		type("\x1b[A");
		expect(composer.text()).toStartWith("[Image #1] ");
		expect(composer.pendingImages).toEqual([IMAGE]);
		expect(composer.pendingImageLinks).toEqual(["/tmp/shot.png"]);
		expect(composer.chips().map(chip => chip.kind)).toEqual(["image", "paste", "paste"]);
		type("\r");
		expect(sent[1]).toBe(sent[0]);
		expect(sent[1]).toContain("attached text");
		expect(sent[1]).toContain("l11");
	});

	test("a cleared draft recalls with its attachments; Down returns to the empty draft", () => {
		const { composer, type } = make();
		composer.insertAtom("[Image #1]", "[Image #1]", { kind: "image", image: IMAGE });
		type("look");
		composer.clearDraft();
		expect(composer.pendingImages).toHaveLength(0);
		type("\x1b[A");
		expect(composer.text()).toBe("[Image #1] look");
		expect(composer.pendingImages).toEqual([IMAGE]);
		expect(composer.chips()).toHaveLength(1);
		type("\x1b[B");
		expect(composer.text()).toBe("");
		expect(composer.pendingImages).toHaveLength(0);
	});

	test("a restored draft's images get their chip links back", async () => {
		const { composer } = make();
		const resolved: number[] = [];
		composer.setImageLinkResolver(async images => {
			resolved.push(images.length);
			return images.map((_, i) => `/blobs/${i}.png`);
		});
		composer.setDraft("see [Image #1]", [IMAGE]);
		await Promise.resolve();
		await Promise.resolve();
		expect(resolved).toEqual([1]);
		expect(composer.pendingImageLinks).toEqual(["/blobs/0.png"]);
		const [chip] = composer.chips();
		expect(chip && composer.imageLink(chip)).toBe("/blobs/0.png");
	});
});

describe("Enter on a command completion", () => {
	const provider = (items: { value: string; descriptionMatch?: boolean }[]) => ({
		getSuggestions: (lines: string[], _line: number, col: number) => {
			const before = lines[0]!.slice(0, col);
			return before.startsWith("/") ? { items, prefix: before } : null;
		},
		applyCompletion: (lines: string[], _line: number, _col: number, item: { value: string }, prefix: string) => {
			const inserted = item.value.startsWith("/") ? item.value : `/${item.value} `;
			const text = `${lines[0]!.slice(0, lines[0]!.length - prefix.length)}${inserted}`;
			return { lines: [text], cursorLine: 0, cursorCol: text.length };
		},
	});
	const settle = async () => {
		for (let i = 0; i < 4; i++) await Promise.resolve();
	};

	test("runs the picked command in one keypress", async () => {
		const sent: string[] = [];
		const { composer, type } = make({
			onSubmit: text => sent.push(text),
			autocomplete: provider([{ value: "settings" }]),
		});
		type("/sett");
		await settle();
		expect(composer.completing()).toBe(true);
		type("\r");
		expect(sent).toEqual(["/settings "]);
		expect(composer.text()).toBe("");
	});

	test("sends the typed text over an untouched description-only hit", async () => {
		const sent: string[] = [];
		const { composer, type } = make({
			onSubmit: text => sent.push(text),
			autocomplete: provider([{ value: "model", descriptionMatch: true }]),
		});
		type("/xyz");
		await settle();
		expect(composer.completing()).toBe(true);
		type("\r");
		expect(sent).toEqual(["/xyz"]);
	});

	test("paged and remapped keys choose a completion without sending the draft", async () => {
		const previous = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory({ "tui.input.tab": "f2", "tui.select.pageDown": "f3" }));
		try {
			const sent: string[] = [];
			const { composer, type } = make({
				autocomplete: provider(["one", "two", "three", "four"].map(value => ({ value }))),
				autocompleteMaxVisible: 2,
				onSubmit: text => sent.push(text),
			});
			type("/");
			await settle();
			type("\x1bOR", "\x1bOQ"); // F3, F2.
			expect(composer.text()).toBe("/three ");
			expect(sent).toEqual([]);
		} finally {
			setKeybindings(previous);
		}
	});

	test("Tab never replaces text with a result from before the latest edit", async () => {
		const { promise, resolve } = Promise.withResolvers<null>();
		const source = provider([{ value: "settings" }]);
		const { composer, type } = make({
			autocomplete: {
				...source,
				getSuggestions: (lines, line, col) => (col > 2 ? promise : source.getSuggestions(lines, line, col)),
			},
		});
		type("/s");
		await settle();
		type("x", "\t");
		expect(composer.text()).toBe("/sx");
		resolve(null);
		await settle();
		expect(composer.completing()).toBe(false);
	});
	test("only completes an absolute path", async () => {
		const sent: string[] = [];
		const { composer, type } = make({
			onSubmit: text => sent.push(text),
			autocomplete: provider([{ value: "/usr/" }]),
		});
		type("/us");
		await settle();
		type("\r");
		expect(sent).toEqual([]);
		expect(composer.text()).toBe("/usr/");
	});
});

describe("the completion popup's items", () => {
	const settle = async () => {
		for (let i = 0; i < 4; i++) await Promise.resolve();
	};
	const items = [
		{
			value: "/tmp/work/notes.md",
			label: "notes.md",
			description: "work/notes.md",
			nativeDetail: "/tmp/work",
			iconName: "file",
		},
		{
			value: "/tmp/work/notes.model",
			label: "notes.model",
			description: "Model: demo/demo",
			nativeDetail: "Switch model",
			state: "demo/demo",
		},
	];
	const autocomplete = {
		getSuggestions: (lines: string[], _line: number, col: number) => ({ items, prefix: lines[0]!.slice(0, col) }),
		applyCompletion: (lines: string[], line: number, col: number) => ({ lines, cursorLine: line, cursorCol: col }),
	};
	/** The popup's item nodes, in order. */
	const popupItems = (composer: Composer) => {
		const list = composer.node
			.children()
			.find(node => node.kind === "overlay")
			?.children()[0]
			?.children()[0];
		return list?.children().map(node => node.props()) ?? [];
	};

	test("mark the typed last path segment and carry the provider's native detail and state", async () => {
		const { composer, type } = make({ autocomplete });
		type("/tmp/work/Notes.m");
		await settle();
		expect(popupItems(composer)).toMatchObject([
			{
				icon: "file",
				label: [{ s: "mark", t: "notes.m" }, { t: "d" }],
				detail: [{ s: "muted", t: "/tmp/work" }],
			},
			{
				label: [{ s: "mark", t: "notes.m" }, { t: "odel" }],
				detail: [{ s: "muted", t: "Switch model" }],
				value: [{ s: "muted", t: "demo/demo" }],
			},
		]);
		type("d");
		await settle();
		// A label typed whole is one marked span, with no empty rest.
		expect(popupItems(composer)[0]).toMatchObject({ label: [{ s: "mark", t: "notes.md" }] });
	});

	test("draws the selected completion with the terminal preset's cursor", async () => {
		const { composer, type } = make({ autocomplete });
		type("/tmp/work/n");
		await settle();
		for (const preset of ["nerd", "ascii"] as const) {
			const theme = loadThemeSync("dark", { symbolPreset: preset });
			const popup = composer.node.children().find(node => node.kind === "overlay");
			if (!popup) throw new Error("Expected the completion popup");
			const [selected, unselected] = paintNode(staticEnvironment(theme), popup, 80).rows.map(row =>
				Bun.stripANSI(row),
			);
			expect(selected).toStartWith(`${theme.symbols.symbol("nav.cursor")} `);
			expect(selected).toContain("notes.md");
			expect(unselected).toStartWith("  ");
			expect(unselected).toContain("notes.model");
		}
	});

	test("keep the provider's description in terminal rows", async () => {
		const { composer, type } = make({ autocomplete });
		type("/tmp/work/n");
		await settle();
		const rows = plainRows([...paintNode(corpusEnvironment("dark"), composer.node, 80).rows]).join("\n");
		expect(rows).toContain("Model: demo/demo");
		expect(rows).toContain("work/notes.md");
		expect(rows).not.toContain("Switch model");
	});
});

describe("a composer talking to a /btw note", () => {
	test("says so in its role and leads the line with a chip that goes back to the chat", () => {
		const { composer } = make();
		composer.setState({ btw: true });
		expect(composer.node.props()).toMatchObject({ role: "omp.editor.btw" });
		const line = composer.node.children().find(node => node.key() === "line");
		const [chip, field] = line ? line.children() : [];
		expect(chip?.props()).toMatchObject({
			role: "omp.composer.mode",
			title: "Asking the side question · back to the chat  esc",
			actions: { click: "interrupt" },
		});
		expect(chip?.children()[0]?.props()).toMatchObject({ spans: [{ s: "accent", t: "btw" }] });
		expect(field?.kind).toBe("editor");
		composer.setState({});
		expect(composer.node.props()).toMatchObject({ role: "omp.editor" });
		expect(line?.children()).toHaveLength(1);
	});
});

describe("a `?` draft", () => {
	test("is a btw question: the composer's role says so, the chip stands in for the sigil, the text stays prose", () => {
		const { composer } = make({ text: "? what is this" });
		composer.setState({ shell: { kind: "btw", excluded: false } });
		expect(composer.node.props()).toMatchObject({ role: "omp.editor.btw-ask" });
		const line = composer.node.children().find(node => node.key() === "line");
		const [chip, field] = line ? line.children() : [];
		expect(chip?.props()).toMatchObject({ role: "omp.composer.mode", title: "Asks a /btw side question" });
		expect(chip?.children()[0]?.props()).toMatchObject({ spans: [{ s: "btwMode", t: "btw" }] });
		expect(field?.props()).toMatchObject({ decor: [{ from: 0, to: 2, s: "hide" }] });
		expect(field?.props()).not.toHaveProperty("lang", expect.anything());
	});
});
