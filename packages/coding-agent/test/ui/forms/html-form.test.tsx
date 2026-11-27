/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `forms/html-form` corpus: the HTML form dialog driven by keys, UI events
 * and host changes (focus, skip notice, the clock).
 */
import { expect, test, vi } from "bun:test";
import { nativeShell } from "../../helpers/native-shell";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { batch, createRoot, resolveChildren, signal } from "@oh-my-pi/pi-tui";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { styledSpans } from "@oh-my-pi/pi-tui/text/styled-spans";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { CORPUS_NOW } from "@oh-my-pi/pi-tui/testing/corpus";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { parseHtmlForm } from "../../../src/tools/html-form/parse";
import { formMedia, HtmlFormDialog, HtmlFormModel } from "../../../src/ui/forms/html-form";
import "../../../src/ui/styles/dock/covering";
import "../../../src/ui/styles/panels/ask-dialog";
import { figureWorkSettled } from "../../../src/ui/transcript/figures";
import { corpusSuite, type Driver, type Mounted, settle } from "../setup/harness";

interface FormInputs {
	readonly html: string;
	readonly title: string | null;
	readonly terminalRows: number;
	readonly focused: boolean;
	readonly timeoutMs: number | null;
	readonly cwd: string;
}

test("native form checkboxes and option-note menus reach the submitted answers", async () => {
	await using ui = await nativeShell();
	const onSubmit = vi.fn();
	const model = new HtmlFormModel(
		parseHtmlForm(`<form>
			<label><input type="checkbox" name="parts" value="arm"> Arm</label>
			<label><input type="checkbox" name="parts" value="leg"> Leg</label>
		</form>`),
		{ onSubmit, onCancel: () => {} },
	);
	ui.shell.dock.slot("ask").set(() => HtmlFormDialog({ model }));
	const list = ui.node("list", "f0");
	const leg = ui.node("item", "o1");
	// Open a note from the second row's own context menu while the first row is highlighted.
	const menu = (leg.p.actions as { menu: string[] }).menu;
	ui.send({ ev: "action", sf: ui.sf, id: leg.id, act: menu[0]! });
	const note = ui.node("editor", "input");
	ui.send({ ev: "edit", sf: ui.sf, id: note.id, from: 0, to: 0, len: 0, text: "repair", cursor: 6 });
	ui.click("button", "save-note");
	ui.send({ ev: "select", sf: ui.sf, id: list.id, item: ui.node("item", "o1").id });
	ui.send({ ev: "activate", sf: ui.sf, id: list.id, item: ui.node("item", "o1").id });
	expect(ui.node("item", "o1").p.icon).toBe("check");
	ui.click("button", "submit");
	expect(onSubmit).toHaveBeenCalledWith({ parts: ["leg"] }, [
		expect.objectContaining({ name: "parts", value: "leg", text: "repair" }),
	]);
});

/** The dialog's terminal rows at `width` (dark theme). */
function rows(html: string, width: number): string[] {
	const model = new HtmlFormModel(parseHtmlForm(html), { onSubmit: () => {}, onCancel: () => {} });
	return createRoot(dispose => {
		try {
			const root = resolveChildren(<HtmlFormDialog model={model} />)()[0]!;
			return paintNode(staticEnvironment(loadThemeSync("dark"), { now: 0 }), root, width).rows as string[];
		} finally {
			dispose();
		}
	});
}

/** Each painted row's highlighted text, rows without any left out: padding or a border a highlight leaks into shows up here. */
function highlighted(painted: readonly string[]): string[] {
	return painted
		.map(row =>
			styledSpans(row)
				.filter(span => span.s?.split(" ").includes("mark"))
				.map(span => span.t)
				.join(""),
		)
		.filter(text => text !== "");
}

const WORDS = `${"word ".repeat(10)}end`;

test("terminal: a <mark> in form text is highlighted", () => {
	expect(highlighted(rows(`<form><p>Review <mark>stale</mark> token</p></form>`, 60))).toEqual(["stale"]);
});

test("terminal: a <mark> in a table cell is highlighted, on the measured column width", () => {
	const painted = rows(
		`<form><table><tr><th>Finding</th><th>Owner</th></tr><tr><td>Review <mark>stale</mark> x</td><td>a</td></tr></table></form>`,
		60,
	);
	expect(highlighted(painted)).toEqual(["stale"]);
	expect(painted.map(row => stripEscapes(row).trimEnd()).join("\n")).toContain("Review stale x  a");
});

test("terminal: a wrapped <mark> highlights its words only, not the padding or the border", () => {
	const marked = highlighted(rows(`<form><p><mark>${WORDS}</mark></p></form>`, 30));
	expect(marked.length).toBeGreaterThan(1);
	expect(marked.join(" ")).toBe(WORDS);
});

test("terminal: a <mark> in a legend and a field label is highlighted", () => {
	const painted = rows(
		`<form><fieldset><legend>Rate the <mark>lease</mark></legend>
		<label for="d">Fix the <mark>lease</mark></label><input id="d" name="d"></fieldset></form>`,
		60,
	);
	// The open text box's caret is inverse video too.
	expect(highlighted(painted)).toEqual(["lease", "lease", " "]);
});

test("terminal: a <mark> in an option row is highlighted, wrapped rows too", () => {
	const paint = (label: string) =>
		rows(`<form><label><input type="radio" name="r" value="fix" checked> ${label}</label></form>`, 30);
	expect(highlighted(paint("Keep the <mark>lease</mark>"))).toEqual(["lease"]);
	const long = highlighted(paint(`<mark>${WORDS}</mark>`));
	expect(long.length).toBeGreaterThan(1);
	expect(long.join(" ")).toBe(WORDS);
});

test("wraps a long textarea line and keeps the caret row visible in a short terminal", () => {
	const onSubmit = vi.fn();
	const model = new HtmlFormModel(
		parseHtmlForm(`<form><label>Notes <textarea name="notes" rows="4"></textarea></label></form>`),
		{ onSubmit, onCancel: () => {} },
	);
	const term = createTestTerminal(() => ({ dock: <HtmlFormDialog model={model} terminalRows={() => 12} /> }), {
		columns: 42,
		rows: 12,
	});
	try {
		term.focus(term.surface.dock()[0]!);
		const start = "Use the marked trail rather than the road.";
		term.type(start);
		expect(term.screen().some(row => row.includes("Use the marked trail"))).toBe(true);
		expect(term.screen().some(row => row.includes("the road.▏"))).toBe(true);
		expect(term.screen().join("\n")).not.toContain("…");

		// Up steps to the wrapped row above, keeping the caret's column, instead of leaving the field.
		term.press("up");
		term.type("X");
		const edited = start.replace("Use the m", "Use the mX");
		expect(term.screen().some(row => row.includes("Use the mXarked"))).toBe(true);
		term.press("end");

		const suffix = " Follow the signs by the river and continue past the bridge.".repeat(4) + " Meet at sunrise.";
		term.paste(suffix);
		expect(term.screen().join("\n")).toContain("at sunrise.▏");
		term.press("home");
		expect(term.screen().join("\n")).toContain("Use the mXarked trail");
		expect(term.screen().join("\n")).not.toContain("at sunrise.");
		term.press("enter");
		expect(onSubmit).toHaveBeenCalledWith({ notes: edited + suffix }, []);
	} finally {
		term.dispose();
	}
});

test.each(["radio", "checkbox"])("keeps a long %s Other answer visible and editable at both ends", type => {
	const onSubmit = vi.fn();
	const model = new HtmlFormModel(
		parseHtmlForm(`<form>
			<label><input type="${type}" name="route" value="road" checked> Road</label>
			<label><input type="${type}" name="route" value="river"> River</label>
		</form>`),
		{ onSubmit, onCancel: () => {} },
	);
	const term = createTestTerminal(() => ({ dock: <HtmlFormDialog model={model} /> }), {
		columns: 42,
		rows: 16,
		theme: loadThemeSync("dark"),
	});
	try {
		term.focus(term.surface.dock()[0]!);
		term.press("down");
		term.press("down");
		const answer = "Use the marked trail past the river and meet at sunrise";
		term.paste(answer + "界");
		expect(term.screen().join("\n")).toMatch(/Other: ‹.*at sunrise界/);
		term.press("left");
		expect(highlighted(term.rows())).toContain("界");
		term.resize(16, 16);
		expect(highlighted(term.rows().filter(row => row.includes("Other:")))).toEqual([" "]);
		term.resize(42, 16);
		term.press("delete");
		term.type("!");
		term.press("home");
		expect(term.screen().join("\n")).toMatch(/Other: Use the marked trail.*›/);
		term.type("Please ");
		term.press("enter");
		const edited = `Please ${answer}!`;
		expect(onSubmit).toHaveBeenCalledWith({ route: type === "checkbox" ? ["road", edited] : edited }, []);
	} finally {
		term.dispose();
	}
});

test("keeps a long ordinary input visible and editable at both ends", () => {
	const onSubmit = vi.fn();
	const model = new HtmlFormModel(parseHtmlForm(`<form><label>Route <input name="route"></label></form>`), {
		onSubmit,
		onCancel: () => {},
	});
	const term = createTestTerminal(() => ({ dock: <HtmlFormDialog model={model} /> }), { columns: 42, rows: 16 });
	try {
		term.focus(term.surface.dock()[0]!);
		const answer = "Use the marked trail past the river and meet at sunrise";
		term.paste(answer);
		expect(term.screen().join("\n")).toMatch(/│ ‹.*at sunrise/);
		term.type("!");
		term.press("home");
		expect(term.screen().join("\n")).toMatch(/│ Use the marked trail.*›/);
		term.type("Please ");
		term.press("enter");
		expect(onSubmit).toHaveBeenCalledWith({ route: `Please ${answer}!` }, []);
	} finally {
		term.dispose();
	}
});

test("places the masked password caret after one bullet for an emoji", () => {
	const onSubmit = vi.fn();
	const model = new HtmlFormModel(
		parseHtmlForm(`<form><label>Code <input type="password" name="code"></label></form>`),
		{
			onSubmit,
			onCancel: () => {},
		},
	);
	const term = createTestTerminal(() => ({ dock: <HtmlFormDialog model={model} /> }), {
		columns: 32,
		rows: 16,
		theme: loadThemeSync("dark"),
	});
	try {
		term.focus(term.surface.dock()[0]!);
		term.paste("😀ab");
		term.press("home");
		term.press("right");
		const spans = styledSpans(term.rows().find(row => row.includes("•")) ?? "");
		const caret = spans.findIndex(span => span.s?.split(" ").includes("mark"));
		expect(spans[caret]?.t).toBe("•");
		const before = spans
			.slice(0, caret)
			.map(span => span.t)
			.join("");
		expect(before).toMatch(/│ •$/);
		term.type("x");
		term.press("enter");
		expect(onSubmit).toHaveBeenCalledWith({ code: "😀xab" }, []);
	} finally {
		term.dispose();
	}
});

test("Up at the top of a question taller than the card scrolls up through its text before leaving it", () => {
	const context = (name: string) => Array.from({ length: 12 }, (_, i) => `<p>${name} context ${i + 1}</p>`).join("");
	const model = new HtmlFormModel(
		parseHtmlForm(`<form>
			<fieldset><legend>First question</legend>${context("first")}
				<label><input type="radio" name="a" value="alpha" checked> Alpha</label>
				<label><input type="radio" name="a" value="beta"> Beta</label>
			</fieldset>
			<fieldset><legend>Second question</legend>${context("second")}
				<label><input type="radio" name="b" value="gamma" checked> Gamma</label>
				<label><input type="radio" name="b" value="delta"> Delta</label>
			</fieldset>
		</form>`),
		{ onSubmit: () => {}, onCancel: () => {} },
	);
	const term = createTestTerminal(() => ({ dock: <HtmlFormDialog model={model} terminalRows={() => 16} /> }), {
		columns: 60,
		rows: 16,
	});
	const shows = (text: string) => term.screen().some(row => row.includes(text));
	/** Presses `key` until `text` shows (at most 60 times); the presses it took, or -1 when it never shows. */
	const pressUntil = (key: string, text: string) => {
		let presses = 0;
		while (!shows(text) && presses < 60) {
			term.press(key);
			presses++;
		}
		return shows(text) ? presses : -1;
	};
	try {
		term.focus(term.surface.dock()[0]!);
		expect(shows("Alpha")).toBe(true);
		expect(shows("First question")).toBe(false);
		// The first question's own text, then back down to its options: once the highlight shows, Down moves it.
		expect(pressUntil("up", "First question")).toBeGreaterThan(1);
		expect(model.active()).toBe(0);
		// Neither a key release nor Up past the top of the form scrolls back down.
		term.press("up", { kind: "release" });
		term.press("up");
		expect(shows("First question")).toBe(true);
		pressUntil("down", "Alpha");
		expect(model.row()).toBe(0);
		term.press("down");
		expect(model.row()).toBe(1);

		term.press("pageDown");
		expect(model.active()).toBe(1);
		expect(shows("Second question")).toBe(false);
		expect(pressUntil("up", "Second question")).toBeGreaterThan(1);
		expect(model.active()).toBe(1);
		// With its text all shown, Up leaves for the question above.
		term.press("up");
		expect(model.active()).toBe(0);
	} finally {
		term.dispose();
	}
});

test("keys that arrive before the next frame scroll and move the ask form as if each were drawn", () => {
	const context = Array.from({ length: 12 }, (_, i) => `<p>second context ${i + 1}</p>`).join("");
	const model = new HtmlFormModel(
		parseHtmlForm(`<form>
			<fieldset><legend>First question</legend>
				<label><input type="radio" name="a" value="alpha" checked> Alpha</label>
			</fieldset>
			<fieldset><legend>Second question</legend>${context}
				<label><input type="radio" name="b" value="gamma" checked> Gamma</label>
				<label><input type="radio" name="b" value="delta"> Delta</label>
			</fieldset>
		</form>`),
		{ onSubmit: () => {}, onCancel: () => {} },
	);
	const term = createTestTerminal(() => ({ dock: <HtmlFormDialog model={model} terminalRows={() => 16} /> }), {
		columns: 60,
		rows: 16,
	});
	/** Dispatches the keys in one reactive batch, so the card paints only after the last of them. */
	const burst = (...ids: string[]) => {
		batch(() => {
			for (const id of ids) term.backend.dispatch({ type: "key", key: { id, kind: "press", raw: "" } });
		});
		term.render();
	};
	const shows = (text: string) => term.screen().some(row => row.includes(text));
	try {
		term.focus(term.surface.dock()[0]!);
		// The short first question was drawn last; Up right after PageDown scrolls the tall second one instead of leaving it.
		burst("pageDown", "up");
		expect(model.active()).toBe(1);
		// Scroll until the highlighted option just leaves the card: one Down brings it back, the next moves it.
		for (let presses = 0; presses < 60 && shows("Gamma"); presses++) term.press("up");
		expect(shows("Gamma")).toBe(false);
		burst("down", "down");
		expect(model.active()).toBe(1);
		expect(model.row()).toBe(1);
	} finally {
		term.dispose();
	}
});

test("a long question above other dock rows scrolls to its title on the screen, not above it", () => {
	const context = Array.from({ length: 20 }, (_, i) => `<p>context ${i + 1}</p>`).join("");
	const model = new HtmlFormModel(
		parseHtmlForm(`<form><fieldset><legend>Confirm the release</legend>${context}
			<label><input type="radio" name="a" value="approve" checked> Approve</label>
			<label><input type="radio" name="a" value="reject"> Reject</label>
		</fieldset></form>`),
		{ onSubmit: () => {}, onCancel: () => {} },
	);
	const widgets = Array.from({ length: 10 }, (_, i) => <text key={`w${i}`} spans={[{ t: `widget ${i + 1}` }]} />);
	const term = createTestTerminal(
		() => ({
			dock: [
				<col key="ask" role="omp.dock.covering">
					<HtmlFormDialog model={model} terminalRows={() => 24} />
				</col>,
				<col key="widgets">{widgets}</col>,
			],
		}),
		{ columns: 60, rows: 24 },
	);
	// What a 24-row terminal shows: the frame's last 24 rows (a taller frame scrolls its top away).
	const shows = (text: string) =>
		term
			.screen()
			.slice(-24)
			.some(row => row.includes(text));
	try {
		term.focus(term.surface.dock()[0]!.children()[0]!);
		for (let presses = 0; presses < 60 && !shows("Confirm the release"); presses++) term.press("up");
		expect(shows("Confirm the release")).toBe(true);
		expect(shows("widget 10")).toBe(true);
		for (let presses = 0; presses < 60 && !shows("Approve"); presses++) term.press("down");
		expect(model.row()).toBe(0);
	} finally {
		term.dispose();
	}
});

corpusSuite({
	dir: "forms/html-form",
	mount(caseName, corpusCase, env): Mounted {
		const inputs = corpusCase.inputs as FormInputs;
		const events: string[] = [];
		const form = parseHtmlForm(inputs.html);
		const model = new HtmlFormModel(
			form,
			{
				onSubmit: (data, notes) => void events.push(`submit ${JSON.stringify({ data, notes })}`),
				onCancel: () => void events.push("cancel"),
				onTimeout: (data, notes) => void events.push(`timeout ${JSON.stringify({ data, notes })}`),
				releaseKeys: () => void events.push("releaseKeys"),
				claimKeys: () => void events.push("claimKeys"),
			},
			{ focused: inputs.focused },
		);
		// The capture's terminal cell (pi-tui's default when the terminal does not report one).
		const media = formMedia(form, inputs.cwd, { cell: { w: 9, h: 18 } });
		const skipNotice = signal<string | undefined>(undefined);
		const now = signal(CORPUS_NOW);
		const native = (event: { type: string; key: string; act?: string; item?: string }) => (driver: Driver) => {
			if (event.type === "action") model.action(event.act!, event.key);
			else model.select(Number(/f(\d+)$/.exec(event.key)?.[1] ?? 0), event.item!, event.type === "activate");
			void driver;
		};
		const idle = (ms: number) => async () => {
			env.setNow(CORPUS_NOW + ms);
			now.set(CORPUS_NOW + ms);
			await settle();
		};
		return {
			view: () => (
				<HtmlFormDialog
					model={model}
					title={inputs.title ?? undefined}
					terminalRows={() => inputs.terminalRows}
					media={media}
					skipNotice={skipNotice}
					now={now}
					timeout={inputs.timeoutMs ?? undefined}
				/>
			),
			steps: {
				"native open field 2": native({ type: "action", key: "x", act: "open:2" }),
				"native pick field 1 option 1": native({ type: "action", key: "x", act: "pick:1:1" }),
				"native select body/g0/f0 item o1": native({ type: "select", key: "body/g0/f0", item: "o1" }),
				"native submit": native({ type: "action", key: "actions/submit", act: "submit" }),
				"native note": native({ type: "action", key: "x", act: "note" }),
				"native save-note": native({ type: "action", key: "x", act: "save-note" }),
				"native open field 0": native({ type: "action", key: "x", act: "open:0" }),
				"native cancel": native({ type: "action", key: "x", act: "cancel" }),
				"native select other": native({ type: "select", key: "body/g0/f0", item: "other" }),
				"native pick field 0 option 1": native({ type: "action", key: "x", act: "pick:0:1" }),
				"native open field 1": native({ type: "action", key: "x", act: "open:1" }),
				unfocused: () => model.focused.set(false),
				focused: () => model.focused.set(true),
				"media settled": async () => {
					await figureWorkSettled();
					await settle();
				},
				"skip notice shown": () => skipNotice.set("sending the draft\nskips this form"),
				"skip notice cleared": () => skipNotice.set(undefined),
				"55.5s idle (countdown tick)": idle(55_500),
				"61s idle (timeout fires)": idle(61_000),
			},
			events: () => events.splice(0),
		};
	},
});

test("terminal: a multi-line textarea placeholder paints on one row", () => {
	const painted = rows(
		`<form><label>Copy<textarea name="copy" placeholder="A2 → one&#10;A5 → two&#10;A8 → three"></textarea></label></form>`,
		80,
	);
	expect(painted.some(row => row.includes("\n"))).toBe(false);
	expect(
		painted.map(row => stripEscapes(row)).filter(row => row.includes("A2 → one A5 → two A8 → three")),
	).toHaveLength(1);
});
