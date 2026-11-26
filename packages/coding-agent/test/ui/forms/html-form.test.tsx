/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `forms/html-form` corpus: the HTML form dialog driven by keys, UI events
 * and host changes (focus, skip notice, the clock).
 */
import { expect, test, vi } from "bun:test";
import { nativeShell } from "../../helpers/native-shell";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { createRoot, resolveChildren, signal } from "@oh-my-pi/pi-tui";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { CORPUS_NOW } from "@oh-my-pi/pi-tui/testing/corpus";
import { parseHtmlForm } from "../../../src/tools/html-form/parse";
import { formMedia, HtmlFormDialog, HtmlFormModel, tspSpans } from "../../../src/ui/forms/html-form";
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

test("terminal: a <mark> in form text is inverted", () => {
	expect(rows(`<form><p>Review <mark>stale</mark> token</p></form>`, 60).join("\n")).toMatch(
		/\x1b\[7m\x1b\[[0-9;]*mstale/,
	);
});

test("terminal: a <mark> in a table cell is inverted, on the measured column width", () => {
	const painted = rows(
		`<form><table><tr><th>Finding</th><th>Owner</th></tr><tr><td>Review <mark>stale</mark> x</td><td>a</td></tr></table></form>`,
		60,
	);
	expect(painted.join("\n")).toMatch(/\x1b\[7m\x1b\[[0-9;]*mstale/);
	expect(painted.map(row => stripEscapes(row).trimEnd()).join("\n")).toContain("Review stale x  a");
});

test("terminal: a wrapped <mark> closes before the padding and the border", () => {
	const marked = rows(`<form><p><mark>${"word ".repeat(10)}end</mark></p></form>`, 30);
	// The mark spans three rows, each closing its inverse video before the box padding.
	expect(marked.filter(line => /\x1b\[7(;|m)/.test(line))).toHaveLength(3);
	for (const line of marked) {
		const closed = [...line.matchAll(/\x1b\[[0-9;]*\b27m/g)].at(-1)?.index ?? -1;
		expect(closed).toBeGreaterThanOrEqual(line.search(/\x1b\[7(;|m)/));
	}
});

test("terminal: a <mark> in a legend and a field label is inverted", () => {
	const painted = rows(
		`<form><fieldset><legend>Rate the <mark>lease</mark></legend>
		<label for="d">Fix the <mark>lease</mark></label><input id="d" name="d"></fieldset></form>`,
		60,
	).join("\n");
	expect(painted.match(/\x1b\[7m\x1b\[[0-9;]*mlease/g)).toHaveLength(2);
});

test("terminal: a <mark> in an option row is inverted, wrapped rows too", () => {
	const paint = (label: string) =>
		rows(`<form><label><input type="radio" name="r" value="fix" checked> ${label}</label></form>`, 30);
	const one = paint("Keep the <mark>lease</mark>").join("\n");
	expect(one.match(/\x1b\[7m\x1b\[[0-9;]*mlease/g)).toHaveLength(1);
	const long = paint(`<mark>${"word ".repeat(10)}end</mark>`).filter(line => /\x1b\[7(;|m)/.test(line));
	expect(long.length).toBeGreaterThan(1);
	for (const line of long) {
		const closed = [...line.matchAll(/\x1b\[[0-9;]*\b27m/g)].at(-1)?.index ?? -1;
		expect(closed).toBeGreaterThanOrEqual(line.search(/\x1b\[7(;|m)/));
	}
});

test("Tern: tspSpans emits the mark token", () => {
	expect(tspSpans([{ text: "a " }, { text: "stale", style: "mark" }])).toEqual([
		{ t: "a " },
		{ s: "mark", t: "stale" },
	]);
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
