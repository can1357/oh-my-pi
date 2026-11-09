import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { setKeybindings, type TerminalFrameProvider } from "@oh-my-pi/pi-tui";
import { defaultFormData, fieldError, formAnswers } from "@oh-my-pi/pi-tui/html-form/data";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Input } from "@oh-my-pi/pi-tui/components/input";
import { loadFormImage } from "@oh-my-pi/pi-tui/html-form/media";
import { getNativeBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { HtmlFormDialog } from "@oh-my-pi/pi-tui/html-form/dialog";
import { BreakRank, type PageAtom, paginate } from "@oh-my-pi/pi-tui/html-form/paginate";
import { parseHtmlForm, spansText } from "@oh-my-pi/pi-tui/html-form/parse";
import type { DescribeContext, NativeChild, NativeNode, NativeSurfaceProvider } from "@oh-my-pi/pi-tui/native/node";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { TspHarness } from "./native/tsp-harness";

const ENTER = "\r";
const SPACE = " ";
const TAB = "\t";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const ESC = "\x1b";

const CX: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child && typeof child.k === "string";
}

/** The `Input` components a description mounts as children (the form's live text controls). */
function liveInputs(root: NativeNode): Input[] {
	return (root.c ?? []).flatMap(child => (isNode(child) ? liveInputs(child) : child instanceof Input ? [child] : []));
}

function findPath(root: NativeNode, predicate: (node: NativeNode) => boolean, path = ""): string | undefined {
	for (const [index, child] of (root.c ?? []).entries()) {
		if (!isNode(child)) continue;
		const childPath = path ? `${path}/${child.key ?? index}` : `${child.key ?? index}`;
		if (predicate(child)) return childPath;
		const found = findPath(child, predicate, childPath);
		if (found) return found;
	}
	return undefined;
}

const DB_FORM = `<form>
<fieldset><legend>Database</legend>
<p>Which store should <code>ledger</code> use?</p>
<label><input type="radio" name="db" value="sqlite" checked> SQLite</label><br>
<label><input type="radio" name="db" value="pg"> Postgres</label>
</fieldset>
<fieldset><legend>Extras</legend>
<label><input type="checkbox" name="extras" value="ci" checked> CI</label>
<label><input type="checkbox" name="extras" value="docker"> Docker</label>
<label>Region <select name="region"><option value="us">US</option><option value="eu">EU</option><option value="ap">AP</option></select></label>
<label>Workers <input type="number" name="workers" value="4" min="1" max="8" required></label>
<label>Notes<textarea name="notes" placeholder="anything else"></textarea></label>
</fieldset>
</form>`;

function dialog(html: string, overrides: Partial<ConstructorParameters<typeof HtmlFormDialog>[1]> = {}) {
	const onSubmit = vi.fn();
	const onCancel = vi.fn();
	const form = new HtmlFormDialog(parseHtmlForm(html), { onSubmit, onCancel, ...overrides });
	form.focused = true;
	form.render(100);
	return { form, onSubmit, onCancel };
}

describe("html form", () => {
	beforeAll(async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("dark theme unavailable");
		setThemeInstance(dark);
	});

	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "escape" }));
	});

	afterEach(() => {
		vi.useRealTimers();
		setKeybindings(KeybindingsManager.inMemory());
	});

	describe("parsing", () => {
		it("joins radios split across a decision table into one field labeled by column headers", () => {
			const form = parseHtmlForm(`<form><table>
				<tr><th>Test</th><th>Fix</th><th>Skip</th></tr>
				<tr><td>session refresh</td><td><input type="radio" name="t1" value="fix" checked></td><td><input type="radio" name="t1" value="skip"></td></tr>
			</table></form>`);
			expect(form.fields).toHaveLength(1);
			const field = form.fields[0]!;
			expect(
				field.kind === "choice" && field.options.map(option => [option.value, spansText(option.label)]),
			).toEqual([
				["fix", "Fix"],
				["skip", "Skip"],
			]);
			expect(form.sections[0]!.blocks[0]).toEqual({
				kind: "text",
				spans: [{ text: "session refresh" }],
				heading: false,
			});
		});

		it("offers Other on radio and checkbox groups, but not on selects, lone checkboxes or groups with their own", () => {
			const form = parseHtmlForm(`<form>
				<label><input type="radio" name="a" value="1"> One</label><label><input type="radio" name="a" value="2"> Two</label>
				<label><input type="radio" name="b" value="1"> One</label><label><input type="radio" name="b" value="x"> Other (say which)</label>
				<label><input type="checkbox" name="c" value="on"> Lone</label>
				<select name="d"><option>One</option><option>Two</option></select></form>`);
			expect(form.fields.map(field => [field.name, field.kind === "choice" && field.other])).toEqual([
				["a", true],
				["b", false],
				["c", false],
				["d", false],
			]);
		});

		it("keeps pictures as blocks; a picture inside a label is its alt text", () => {
			const form = parseHtmlForm(`<form><p>Before <img src="a.png" alt="flow"> after</p>
				<svg viewBox="0 0 10 10"><title>Box</title><rect width="10" height="10"/></svg>
				<label><input type="radio" name="logo" value="new"> <img src="new.png" alt="New logo"></label>
				<label><input type="radio" name="logo" value="old"> Old</label></form>`);
			const blocks = form.sections[0]!.blocks;
			expect(blocks.map(block => block.kind)).toEqual(["text", "image", "text", "svg", "field"]);
			expect(blocks[1]).toEqual({ kind: "image", src: "a.png", alt: "flow" });
			expect(blocks[3]).toMatchObject({ kind: "svg", alt: "Box" });
			const logo = form.fields[0]!;
			expect(logo.kind === "choice" && spansText(logo.options[0]!.label)).toBe("New logo");
		});

		it("drops buttons and layout markup, keeps hidden inputs as data, and labels by `for`", () => {
			const form = parseHtmlForm(`<p>intro</p><form><input type="hidden" name="kind" value="deploy">
				<label for="d">Domain</label><input id="d" name="domain" placeholder="app.example.com">
				<button type="submit">Go</button></form>`);
			expect(form.fields.map(field => [field.name, spansText(field.label)])).toEqual([["domain", "Domain"]]);
			expect(defaultFormData(form)).toEqual({ kind: "deploy", domain: "" });
		});
	});

	describe("form data", () => {
		it("reports defaults with HTML semantics: groups as arrays, numbers as numbers, single select's first option", () => {
			const form = parseHtmlForm(DB_FORM);
			expect(defaultFormData(form)).toEqual({ db: "sqlite", extras: ["ci"], region: "us", workers: 4, notes: "" });
			expect(formAnswers(form, { db: "pg", extras: [], region: "eu", workers: 2, notes: "" })).toEqual([
				{ name: "db", question: "Which store should ledger use?", answer: "Postgres" },
				{ name: "extras", question: "Extras", answer: "" },
				{ name: "region", question: "Region", answer: "EU" },
				{ name: "workers", question: "Workers", answer: "2" },
				{ name: "notes", question: "Notes", answer: "" },
			]);
		});

		it("validates required, numeric bounds and anchored patterns; ignores an invalid pattern", () => {
			const form = parseHtmlForm(`<form>
				<input name="n" type="number" min="1" max="8" required>
				<input name="code" pattern="[A-Z]{3}">
				<input name="bad" pattern="[">
				<label><input type="checkbox" name="pick" value="a" required> A</label>
				<label><input type="checkbox" name="pick" value="b"> B</label></form>`);
			const [n, code, bad, pick] = form.fields;
			expect(fieldError(n!, "")).toBe("Required");
			expect(fieldError(n!, "9")).toBe("Must be at most 8");
			expect(fieldError(n!, "x")).toBe("Enter a number");
			expect(fieldError(code!, "ABCD")).toStartWith("Must match");
			expect(fieldError(code!, "ABC")).toBeUndefined();
			expect(fieldError(bad!, "anything")).toBeUndefined();
			expect(fieldError(pick!, [])).toBe("Select at least one");
		});
	});

	describe("pictures", () => {
		const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

		it("loads data: URIs, files relative to cwd and sniffs the type; refuses non-images", async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "html-form-"));
			try {
				await Bun.write(path.join(dir, "dot.png"), Uint8Array.fromBase64(PNG_1PX));
				await Bun.write(path.join(dir, "notes.txt"), "not a picture");
				expect((await loadFormImage("dot.png", { cwd: dir })).mime).toBe("image/png");
				expect((await loadFormImage(`data:image/png;base64,${PNG_1PX}`, { cwd: dir })).mime).toBe("image/png");
				const svg = await loadFormImage("data:image/svg+xml;utf8,%3Csvg viewBox='0 0 4 2'%3E%3C/svg%3E", {
					cwd: dir,
				});
				// An svg sized only by its viewBox gets the size and namespace a standalone drawing needs.
				expect(new TextDecoder().decode(svg.bytes)).toStartWith(
					`<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"`,
				);
				await expect(loadFormImage("notes.txt", { cwd: dir })).rejects.toThrow("not a PNG");
				await expect(loadFormImage("missing.png", { cwd: dir })).rejects.toThrow();
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		});

		it("natively: an inline svg is a vector image blob; an image that fails says so", async () => {
			// The failed load asks the host for a frame; that request is the signal to look.
			const settled = Promise.withResolvers<void>();
			const form = new HtmlFormDialog(
				parseHtmlForm(`<form><svg viewBox="0 0 8 8"><rect width="8" height="8"/></svg>
					<img src="nowhere.png" alt="old logo"><label><input type="checkbox" name="ok"> OK</label></form>`),
				{
					onSubmit: vi.fn(),
					onCancel: vi.fn(),
					cwd: os.tmpdir(),
					tui: { terminal: { rows: 40 }, requestRender: () => settled.resolve() },
				},
			);
			try {
				await settled.promise;
				const root = form.describe(CX);
				const images: NativeNode[] = [];
				const texts: string[] = [];
				const visit = (node: NativeNode): void => {
					if (node.k === "image") images.push(node);
					if (node.k === "text" && node.p && "spans" in node.p)
						texts.push((node.p.spans ?? []).map(part => part.t).join(""));
					for (const child of node.c ?? []) if (isNode(child)) visit(child);
				};
				visit(root);
				expect(images).toHaveLength(1);
				expect(getNativeBlob(String(images[0]!.p && "blob" in images[0]!.p ? images[0]!.p.blob : ""))?.mime).toBe(
					"image/svg+xml",
				);
				expect(texts.some(line => line.startsWith("▣ old logo — couldn't load"))).toBe(true);
			} finally {
				form.dispose();
			}
		});
	});

	describe("pagination", () => {
		const atom = (rows: number, breakRank: BreakRank): PageAtom => ({
			lines: Array.from({ length: rows }, () => "x"),
			gap: 0,
			breakRank,
		});

		it("ends a page at a section boundary unless that strands most of the page", () => {
			// The section break after 3 rows would leave 7/10 empty, so the page fills to a block break instead.
			const atoms = [
				atom(3, BreakRank.Section),
				atom(1, BreakRank.Section),
				...Array.from({ length: 9 }, () => atom(1, BreakRank.Block)),
			];
			expect(paginate(atoms, 10)[0]).toEqual({ start: 0, end: 8 });
			// With the section break at 6 rows (40% empty), it wins over a full page.
			const later = [
				atom(6, BreakRank.Section),
				atom(1, BreakRank.Section),
				...Array.from({ length: 9 }, () => atom(1, BreakRank.Inside)),
			];
			expect(paginate(later, 10)[0]).toEqual({ start: 0, end: 1 });
		});

		it("never breaks before a keep-with-previous atom when another break fits, and gives an oversized atom its own page", () => {
			const atoms = [atom(4, BreakRank.Section), atom(4, BreakRank.Block), atom(4, BreakRank.Never)];
			expect(paginate(atoms, 10)).toEqual([
				{ start: 0, end: 1 },
				{ start: 1, end: 3 },
			]);
			expect(paginate([atom(25, BreakRank.Section), atom(1, BreakRank.Block)], 10)).toEqual([
				{ start: 0, end: 1 },
				{ start: 1, end: 2 },
			]);
		});
	});

	describe("dialog", () => {
		it("submits what the keys chose: Enter picks a radio and moves on, Space toggles, ←/→ change a dropdown", () => {
			const { form, onSubmit } = dialog(DB_FORM);
			form.handleInput(DOWN); // Postgres
			form.handleInput(ENTER); // pick it, jump to Extras
			form.handleInput(DOWN); // Docker
			form.handleInput(SPACE);
			form.handleInput(TAB); // Region dropdown
			form.handleInput(RIGHT); // EU
			form.handleInput(SPACE); // open
			form.handleInput(DOWN); // AP
			form.handleInput(ENTER); // pick, close
			form.handleInput(TAB); // workers
			form.handleInput(TAB); // notes
			form.handleInput(TAB); // Submit
			form.handleInput(ENTER);
			expect(onSubmit).toHaveBeenCalledWith({
				db: "pg",
				extras: ["ci", "docker"],
				region: "ap",
				workers: 4,
				notes: "",
			});
		});

		it("opens a long prefilled input at its start, and End reveals the tail", () => {
			const value = "Colorful Markdown: per-role theme tokens and calmer defaults";
			const { form } = dialog(`<form><label>Title <input name="title" value="${value}"></label>
				<label>Other <input name="other"></label></form>`);
			const titleRow = () =>
				form
					.render(42)
					.map(row => Bun.stripANSI(row))
					.find(row => row.includes("│   │")) ?? "";

			expect(titleRow()).toContain("Colorful Markdown");
			form.handleInput(TAB);
			expect(titleRow()).toContain("Colorful Markdown");
			form.handleInput("\x1b[Z"); // Shift+Tab
			expect(titleRow()).toContain("Colorful Markdown");
			form.handleInput("\x05"); // End
			expect(titleRow()).toContain("calmer defaults");
			expect(titleRow()).not.toContain("Colorful Markdown");
		});

		it("Other: typed text becomes a radio's value or joins a checkbox group; picking an option sets it aside", () => {
			const { form } = dialog(DB_FORM);
			form.handleInput(DOWN); // Postgres
			form.handleInput(DOWN); // Other
			for (const key of "MySQL 8") form.handleInput(key);
			expect(form.data()).toMatchObject({ db: "MySQL 8" });
			form.handleInput("\x1b[A"); // back to Postgres
			form.handleInput(SPACE);
			expect(form.data()).toMatchObject({ db: "pg" });
			form.handleInput(DOWN); // Other again: Enter brings the kept text back and moves on
			form.handleInput(ENTER);
			expect(form.data()).toMatchObject({ db: "MySQL 8" });
			form.handleInput(DOWN); // Docker
			form.handleInput(DOWN); // extras' Other
			for (const key of "terraform") form.handleInput(key);
			expect(form.data()).toMatchObject({ extras: ["ci", "terraform"] });
		});

		it("refuses to submit an invalid form and moves focus to the first problem; Esc cancels", () => {
			const { form, onSubmit, onCancel } = dialog(
				`<form><label>Domain <input name="domain" required></label><label>N <input name="n"></label></form>`,
			);
			form.handleInput(TAB);
			form.handleInput(TAB);
			form.handleInput(ENTER);
			expect(onSubmit).not.toHaveBeenCalled();
			expect(form.debugState()).toMatchObject({ focus: "domain", errors: { domain: "Required" } });
			form.handleInput("a");
			form.handleInput(TAB);
			form.handleInput(TAB);
			form.handleInput(ENTER);
			expect(onSubmit).toHaveBeenCalledWith({ domain: "a", n: "" });
			form.handleInput(ESC);
			expect(onCancel).toHaveBeenCalledTimes(1);
		});

		it("submits the current values when the inactivity timeout elapses; input restarts it", () => {
			vi.useFakeTimers();
			const onTimeout = vi.fn();
			const { form } = dialog(DB_FORM, { timeout: 5000, onTimeout });
			vi.advanceTimersByTime(4000);
			form.handleInput(DOWN);
			form.handleInput(ENTER);
			vi.advanceTimersByTime(4000);
			expect(onTimeout).not.toHaveBeenCalled();
			vi.advanceTimersByTime(2000);
			expect(onTimeout).toHaveBeenCalledWith({ db: "pg", extras: ["ci"], region: "us", workers: 4, notes: "" });
			form.dispose();
		});

		it("natively: one tab per question with Next, and Submit on the Review tab sends the answers", () => {
			const { form, onSubmit } = dialog(DB_FORM);
			let root = form.describe(CX);
			expect(root.p).toMatchObject({ role: "omp.editor.ask" });
			const tabs = findPath(root, node => node.k === "tabs")!;
			// The Database tab shows only its own question.
			expect(findPath(root, node => node.k === "list" && node.key === "f1")).toBeUndefined();
			const radios = findPath(root, node => node.k === "list" && node.key === "f0")!;
			form.handleNativeEvent({ type: "select", key: radios, item: "o1" });
			form.handleNativeEvent({ type: "action", key: "actions/next", act: "next", mods: [] });
			root = form.describe(CX);
			const checks = findPath(root, node => node.k === "list" && node.key === "f1")!;
			form.handleNativeEvent({ type: "select", key: checks, item: "o0" }); // un-check CI
			form.handleNativeEvent({ type: "select", key: tabs, item: "review" });
			expect(findPath(form.describe(CX), node => node.k === "kv")).toBeDefined();
			form.handleNativeEvent({ type: "action", key: "actions/submit", act: "submit", mods: [] });
			expect(onSubmit).toHaveBeenCalledWith({ db: "pg", extras: [], region: "us", workers: 4, notes: "" });
		});

		it("natively: a tab is checked only after the user leaves it with valid answers, not for preselected ones", () => {
			const { form } = dialog(DB_FORM);
			const checked = () => {
				const root = form.describe(CX);
				const path = findPath(root, node => node.k === "tabs")!;
				let tabs: NativeNode = root;
				for (const key of path.split("/")) tabs = (tabs.c ?? []).filter(isNode).find(child => child.key === key)!;
				const items = (tabs.p && "items" in tabs.p ? tabs.p.items : undefined) ?? [];
				return items.flatMap(tab =>
					"id" in tab && typeof tab.label !== "string" && tab.label[0]?.t === "✓ " ? [tab.id] : [],
				);
			};
			// Both questions start with valid preselected answers, yet neither has been visited.
			expect(checked()).toEqual([]);
			form.handleInput(TAB); // Database → Extras
			expect(checked()).toEqual(["t0"]);
		});

		it("natively: ↑/↓ cross into the next tab past its last stop; ←/→ turn tabs", () => {
			const { form } = dialog(DB_FORM);
			const activeTab = () => {
				const root = form.describe(CX);
				const path = findPath(root, node => node.k === "tabs")!;
				let tabs: NativeNode = root;
				for (const key of path.split("/")) tabs = (tabs.c ?? []).filter(isNode).find(child => child.key === key)!;
				return tabs.p && "active" in tabs.p ? tabs.p.active : undefined;
			};
			setNativeRendering(true);
			try {
				expect(activeTab()).toBe("t0");
				for (let press = 0; press < 3; press++) form.handleInput(DOWN); // Postgres, Other, then CI
				expect(activeTab()).toBe("t1");
				form.handleInput("\x1b[D"); // ←
				expect(activeTab()).toBe("t0");
				form.handleInput(RIGHT);
				form.handleInput(RIGHT);
				expect(activeTab()).toBe("review");
				form.handleInput("\x1b[D");
				expect(activeTab()).toBe("t1");
			} finally {
				setNativeRendering(false);
			}
		});

		it("natively: the form sits in the card's shrinking, scrolling list and the action bar stays outside it", () => {
			const options = Array.from({ length: 40 }, (_, index) => `<option value="${index}">Option ${index}</option>`);
			const { form } = dialog(
				`<form><p>Context</p><select name="pick" multiple>${options.join("")}</select><textarea name="notes"></textarea></form>`,
			);
			const root = form.describe(CX);
			const children = (root.c ?? []).filter(isNode);
			expect(children.some(child => child.k === "tabs" || child.key === "head")).toBe(false);
			// Tern's stylesheet lets an `omp.ask.options` list shrink and scroll inside the 60vh card;
			// a capped `col` would only clip.
			const scroller = children.find(child => child.k === "list" && child.p?.role === "omp.ask.options");
			expect((scroller?.c ?? []).filter(isNode).map(child => child.p?.role)).toEqual(["omp.ask.form"]);
			expect(children.at(-1)?.p).toMatchObject({ role: "omp.actions" });
		});

		it("hides to one row and back, by key in rows and by Hide/Show natively; answers survive", () => {
			const { form, onCancel } = dialog(DB_FORM);
			form.handleInput("\x1bh"); // Alt+H
			expect(form.render(100)).toHaveLength(1);
			form.handleInput(DOWN); // ignored while hidden
			form.handleInput(ENTER); // shows it again
			expect(form.render(100).length).toBeGreaterThan(1);
			expect(form.data()).toMatchObject({ db: "sqlite" });
			form.handleNativeEvent({ type: "action", key: "actions/hide", act: "hide", mods: [] });
			expect(form.describe(CX).p).toMatchObject({ role: "omp.editor.ask.hidden" });
			form.handleNativeEvent({ type: "action", key: "actions/show", act: "show", mods: [] });
			expect(form.describe(CX).p).toMatchObject({ role: "omp.editor.ask" });
			form.handleInput(ESC);
			expect(onCancel).toHaveBeenCalled();
		});

		it("natively: docks in the composer's place, and only the focused text field is a live editor", async () => {
			const form = new HtmlFormDialog(
				parseHtmlForm(
					`${DB_FORM.replace("</form>", "")}<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><pre>x = 1</pre><ul><li>one</li></ul></form>`,
				),
				{ onSubmit: vi.fn(), onCancel: vi.fn() },
			);
			const provider: TerminalFrameProvider & NativeSurfaceProvider = {
				renderFrame: () => ({ viewport: [] }),
				acknowledgeHistory: () => {},
				describeSurface: () => ({ main: [], dock: [form] }),
			};
			const harness = await TspHarness.start(tui => {
				tui.setFrameProvider(provider);
				tui.setFocus(form);
			});
			try {
				expect(harness.errors).toEqual([]);
				const root = harness.region("dock")!.c?.find(node => node.p?.role === "omp.editor.ask");
				expect(root).toBeDefined();
				// The tab's scroller and the Database radios inside it.
				expect(harness.findAll(node => node.k === "list" && node.p?.role === "omp.ask.options")).toHaveLength(2);
				// Focus is on a radio: no editor node, so the terminal keeps sending keys to the form.
				expect(harness.findAll(node => node.k === "input" || node.k === "editor")).toEqual([]);
				expect(harness.findAll(node => node.p?.role === "omp.ask.well")).toEqual([]);
				// Clicking the workers well (field 3) focuses it: its tab opens and it becomes the one live input.
				form.handleNativeEvent({ type: "action", key: "x", act: "edit:3", mods: [] });
				await harness.render();
				const inputs = harness.findAll(node => node.k === "input");
				expect(inputs.map(node => (node.p && "text" in node.p ? node.p.text : undefined))).toEqual(["4"]);
				expect(harness.findAll(node => node.k === "editor")).toEqual([]);
			} finally {
				harness.stop();
			}
		});

		it("natively: clicking Other mounts its input, and text the terminal types there becomes the radio's answer", () => {
			const { form } = dialog(DB_FORM);
			const radios = findPath(form.describe(CX), node => node.k === "list" && node.key === "f0")!;
			expect(liveInputs(form.describe(CX))).toEqual([]);
			form.handleNativeEvent({ type: "select", key: radios, item: "other" });
			const [other] = liveInputs(form.describe(CX));
			expect(other).toBeInstanceOf(Input);
			other!.handleNativeEvent({
				type: "edit",
				key: "",
				from: 0,
				to: 0,
				text: "Fly Postgres HA",
				cursor: 15,
				len: 0,
			});
			expect(form.data()).toMatchObject({ db: "Fly Postgres HA" });
		});

		it("natively: keys act immediately even though rows were never rendered", () => {
			const form = new HtmlFormDialog(parseHtmlForm(DB_FORM), { onSubmit: vi.fn(), onCancel: vi.fn() });
			form.focused = true;
			form.describe(CX);
			form.handleInput(DOWN);
			form.handleInput(ENTER);
			expect(form.data()).toMatchObject({ db: "pg" });
		});
	});
});
