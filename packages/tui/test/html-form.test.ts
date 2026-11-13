import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { setKeybindings, type TerminalFrameProvider, TUI } from "@oh-my-pi/pi-tui";
import { defaultFormData, fieldError, formAnswers } from "@oh-my-pi/pi-tui/html-form/data";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Input } from "@oh-my-pi/pi-tui/components/input";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { loadFormImage } from "@oh-my-pi/pi-tui/html-form/media";
import { getNativeBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { HtmlFormDialog } from "@oh-my-pi/pi-tui/html-form/dialog";
import { BreakRank, type PageAtom, paginate } from "@oh-my-pi/pi-tui/html-form/paginate";
import { parseHtmlForm, spansText } from "@oh-my-pi/pi-tui/html-form/parse";
import type { DescribeContext, NativeChild, NativeNode, NativeSurfaceProvider } from "@oh-my-pi/pi-tui/native/node";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { TspHarness } from "./native/tsp-harness";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import {
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	setTerminalImageProtocol,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

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

/** The components of one kind a description mounts as children (the form's live text controls). */
function liveControls<T>(root: NativeNode, kind: abstract new (...args: never[]) => T): T[] {
	return (root.c ?? []).flatMap(child =>
		isNode(child) ? liveControls(child, kind) : child instanceof kind ? [child] : [],
	);
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

/** The text of every `text` node under `root`, in order. */
function textsOf(root: NativeNode): string[] {
	const spans = root.k === "text" && root.p && "spans" in root.p ? root.p.spans : undefined;
	const own = spans ? [spans.map(item => item.t).join("")] : [];
	return [...own, ...(root.c ?? []).flatMap(child => (isNode(child) ? textsOf(child) : []))];
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

const SELECT_FORM = `<form><label>Region<select name="region">
	<option value="us">US</option><option disabled>Unavailable</option>
	<option value="eu">EU</option><option value="ap">AP</option>
	<option value="nl">Netherlands</option>
	</select></label><p>Choose a deployment region.</p></form>`;

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

	describe("option notes", () => {
		it("notes the highlighted dropdown option without selecting it and restores the open menu", () => {
			const { form, onSubmit, onCancel } = dialog(SELECT_FORM);
			form.handleInput(SPACE);
			form.handleInput(DOWN);
			form.handleInput("\x1bn");
			expect(form.debugState().noteEdit).toBe("region=eu");
			form.handleInput("data residency");
			form.handleInput(ENTER);
			expect(form.data()).toEqual({ region: "us" });
			expect(form.debugState().open).toBe("region");
			expect(form.render(100).join("\n")).toContain("✎ draft");
			form.handleInput("\x1bn");
			form.handleInput(" changed");
			form.handleInput(ESC);
			expect(form.debugState().notes).toMatchObject({ region: { 2: "data residency" } });
			expect(form.optionNotes()).toEqual([]);
			form.handleInput(ENTER);
			expect(form.data()).toEqual({ region: "eu" });
			expect(form.render(100).join("\n")).toContain("✎ note");
			expect(form.render(100).join("\n")).not.toContain("✎ draft");
			form.handleInput("\x1bn");
			expect(form.debugState().noteEdit).toBe("region=eu");
			form.handleInput(" edited");
			form.handleInput(ENTER);
			expect(form.optionNotes()).toEqual([
				{ name: "region", question: "Region", option: "EU", value: "eu", text: "data residency edited" },
			]);
			expect(onSubmit).not.toHaveBeenCalled();
			expect(onCancel).not.toHaveBeenCalled();
			form.dispose();
		});

		it("preserves n type-ahead in closed and open dropdowns", () => {
			const { form } = dialog(SELECT_FORM);
			form.handleInput("n");
			expect(form.data()).toEqual({ region: "nl" });
			expect(form.debugState().noteEdit).toBeUndefined();
			form.handleInput("u");
			form.handleInput(SPACE);
			form.handleInput("n");
			expect(form.data()).toEqual({ region: "us" });
			expect(form.debugState().noteEdit).toBeUndefined();
			form.handleInput(ENTER);
			expect(form.data()).toEqual({ region: "nl" });
			form.dispose();
		});

		it("keeps notes tied to option indexes when submitted values are identical", () => {
			const { form } = dialog(`<form><label><input type="radio" name="pick" value="same" checked>First</label>
				<label><input type="radio" name="pick" value="same">Second</label></form>`);
			form.handleInput(DOWN);
			form.handleInput("n");
			form.handleInput("second option only");
			form.handleInput(ENTER);
			expect(form.optionNotes()).toEqual([]);
			form.handleInput(SPACE);
			expect(form.data()).toEqual({ pick: "same" });
			expect(form.optionNotes()).toEqual([
				{ name: "pick", question: "pick", option: "Second", value: "same", text: "second option only" },
			]);
			form.handleInput(DOWN);
			form.handleInput("same");
			expect(form.optionNotes()).toEqual([]);
			expect(form.data()).toEqual({ pick: "same" });
			form.dispose();
		});

		it("opens native dropdown row notes without choosing the row or accepting disabled targets", () => {
			const { form } = dialog(SELECT_FORM);
			form.handleNativeEvent({ type: "action", key: "body0/f0/o1", act: "note", mods: [] });
			expect(form.debugState().noteEdit).toBeUndefined();
			form.handleNativeEvent({ type: "action", key: "body0/f0/o2", act: "note", mods: [] });
			expect(form.debugState().noteEdit).toBe("region=eu");
			form.handleInput("residency");
			form.handleInput(ENTER);
			expect(form.data()).toEqual({ region: "us" });
			expect(JSON.stringify(form.describe(CX))).toContain("residency");
			form.dispose();
		});

		it("edits and removes a focused radio note without changing answers or submitting", () => {
			const { form, onSubmit, onCancel } = dialog(DB_FORM);
			const before = form.data();
			const pages = form.debugState().pages;
			form.handleInput(DOWN);
			form.handleInput("n");
			expect(form.debugState().noteEdit).toBe("db=pg");
			expect(form.render(100).join("\n")).toContain("Note for Postgres");
			expect(form.debugState().pages).toBe(pages);
			form.handleInput("why postgres");
			form.handleInput(ENTER);
			expect(form.data()).toEqual(before);
			const rows = form.render(100);
			expect(rows.find(row => row.includes("Postgres"))).toContain("✎ draft");
			expect(rows.find(row => row.includes("SQLite"))).not.toContain("✎");
			expect(form.debugState().notes).toMatchObject({ db: { 1: "why postgres" } });
			form.handleInput("n");
			form.handleInput("!");
			form.handleInput(ESC);
			expect(form.debugState().notes).toMatchObject({ db: { 1: "why postgres" } });
			form.handleInput("n");
			form.handleInput("\x01");
			form.handleInput("\x0b");
			form.handleInput(ENTER);
			expect(form.debugState().notes).toEqual({ db: {}, extras: {}, region: {} });
			expect(onSubmit).not.toHaveBeenCalled();
			expect(onCancel).not.toHaveBeenCalled();
			form.dispose();
		});

		it("follows a remapped note key, keeping text keys out of dropdown notes", () => {
			setKeybindings(
				KeybindingsManager.inMemory({ "tui.select.cancel": "escape", "app.ask.note": ["x", "ctrl+e"] }),
			);
			const { form } = dialog(DB_FORM);
			form.handleInput("n");
			expect(form.debugState().noteEdit).toBeUndefined();
			form.handleInput("x");
			expect(form.debugState().noteEdit).toBe("db=sqlite");
			form.dispose();

			const select = dialog(SELECT_FORM).form;
			select.handleInput("x");
			expect(select.debugState().noteEdit).toBeUndefined();
			select.handleInput("\x05");
			expect(select.debugState().noteEdit).toBe("region=us");
			select.dispose();
		});

		it("counts a host edit in the note editor as activity", () => {
			vi.useFakeTimers();
			const onTimeout = vi.fn();
			const { form } = dialog(DB_FORM, { timeout: 1000, onTimeout });
			form.handleInput("n");
			const [editor] = liveControls(form.describe(CX), Editor);
			vi.advanceTimersByTime(900);
			editor!.handleNativeEvent({ type: "edit", key: "", from: 0, to: 0, text: "pasted", cursor: 6, len: 0 });
			vi.advanceTimersByTime(900);
			expect(onTimeout).not.toHaveBeenCalled();
			vi.advanceTimersByTime(200);
			expect(onTimeout).toHaveBeenCalledWith(form.data(), [
				{
					name: "db",
					question: "Which store should ledger use?",
					option: "SQLite",
					value: "sqlite",
					text: "pasted",
				},
			]);
			form.dispose();
		});

		it("does not expand a later note's literal paste marker to an earlier note's paste", () => {
			const { form } = dialog(DB_FORM);
			const paste = Array.from({ length: 12 }, (_, line) => `line ${line}`).join("\n");
			form.handleInput("n");
			form.handleInput(`\x1b[200~${paste}\x1b[201~`);
			form.handleInput(ENTER);
			form.handleInput(DOWN);
			form.handleInput("n");
			form.handleInput("see [Paste #1]");
			form.handleInput(ENTER);
			expect(form.debugState().notes).toMatchObject({ db: { 0: paste, 1: "see [Paste #1]" } });
			form.dispose();
		});

		it("hides and restores the form with a note draft still open", () => {
			const { form } = dialog(DB_FORM);
			form.handleInput("n");
			form.handleInput("draft");
			form.handleInput("\x1bh");
			expect(form.render(100).join("\n")).not.toContain("Note for");
			form.handleInput(ENTER);
			expect(form.render(100).join("\n")).toContain("Note for SQLite");
			form.handleInput(" kept");
			form.handleInput(ENTER);
			expect(form.debugState().notes).toMatchObject({ db: { 0: "draft kept" } });
			form.dispose();
		});

		it("keeps checkbox drafts across navigation and projects only finally selected options", () => {
			const { form } = dialog(DB_FORM);
			form.handleInput("n");
			form.handleInput("sqlite draft");
			form.handleInput(ENTER);
			form.handleInput(DOWN);
			form.handleInput(SPACE);
			form.handleInput(TAB);
			form.handleInput(DOWN);
			form.handleInput("n");
			form.handleInput("docker reason");
			form.handleInput(ENTER);
			expect(form.data().extras).toEqual(["ci"]);
			form.handleInput(SPACE);
			form.handleInput("\x1b[Z");
			form.handleInput("n");
			form.handleInput("\x05");
			form.handleInput(" edited");
			form.handleInput(ENTER);
			expect(form.debugState().notes).toMatchObject({ db: { 0: "sqlite draft edited" } });
			expect(form.optionNotes()).toEqual([
				{ name: "extras", question: "Extras", option: "Docker", value: "docker", text: "docker reason" },
			]);
			form.dispose();
		});

		it("opens native menu notes on the exact shown row and ignores stale tabs", () => {
			const { form } = dialog(DB_FORM);
			form.handleNativeEvent({ type: "action", key: "body0/f0/o1", act: "note", mods: [] });
			expect(form.debugState().noteEdit).toBe("db=pg");
			form.handleInput("native reason");
			form.handleInput(ENTER);
			expect(form.data().db).toBe("sqlite");
			form.handleNativeEvent({ type: "select", key: "head/tabs", item: "t1" });
			form.handleNativeEvent({ type: "action", key: "body0/f0/o0", act: "note", mods: [] });
			expect(form.debugState().noteEdit).toBeUndefined();
			expect(form.debugState().focus).toBe("extras=ci");
			form.dispose();
		});

		it("saves a note draft and submits once when inactivity expires during editing", () => {
			vi.useFakeTimers();
			const onTimeout = vi.fn();
			const { form, onCancel } = dialog(DB_FORM, { timeout: 1000, onTimeout });
			form.handleInput("n");
			vi.advanceTimersByTime(500);
			form.handleInput("draft");
			vi.advanceTimersByTime(999);
			expect(onTimeout).not.toHaveBeenCalled();
			vi.advanceTimersByTime(501);
			expect(onTimeout).toHaveBeenCalledTimes(1);
			expect(onTimeout).toHaveBeenCalledWith(form.data(), [
				{
					name: "db",
					question: "Which store should ledger use?",
					option: "SQLite",
					value: "sqlite",
					text: "draft",
				},
			]);
			expect(form.debugState().noteEdit).toBeUndefined();
			expect(onCancel).not.toHaveBeenCalled();
			vi.advanceTimersByTime(2000);
			expect(onTimeout).toHaveBeenCalledTimes(1);
			form.dispose();
		});
		it("mounts one native note editor and preserves its menu target through host edits", async () => {
			const { form, onCancel } = dialog(DB_FORM);
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
				const target = harness.find(node => node.k === "item" && node.id.endsWith("/f0/o1"))!;
				expect(target.p).toMatchObject({ actions: { menu: ["note"] } });
				harness.event({ ev: "action", sf: harness.terminal.surface!, id: target.id, act: "note" });
				await harness.render();
				const editor = harness.find(node => node.k === "editor")!;
				harness.event({
					ev: "edit",
					sf: harness.terminal.surface!,
					id: editor.id,
					from: 0,
					to: 0,
					text: "host reason",
					cursor: 11,
					len: 0,
				});
				form.handleNativeEvent({ type: "action", key: "", act: "save-note", mods: [] });
				await harness.render();
				expect(form.data().db).toBe("sqlite");
				expect(form.debugState().notes).toMatchObject({ db: { 1: "host reason" } });
				expect(harness.findAll(node => node.k === "editor")).toEqual([]);
				expect(
					JSON.stringify(harness.findAll(node => node.k === "item" && node.p?.detail !== undefined)),
				).toContain("host reason");
				harness.event({ ev: "action", sf: harness.terminal.surface!, id: target.id, act: "note" });
				form.handleInput(" discarded");
				form.handleNativeEvent({ type: "action", key: "", act: "cancel", mods: [] });
				expect(form.debugState().noteEdit).toBeUndefined();
				expect(form.debugState().notes).toMatchObject({ db: { 1: "host reason" } });
				expect(onCancel).not.toHaveBeenCalled();
				expect(harness.errors).toEqual([]);
			} finally {
				harness.stop();
				form.dispose();
			}
		});
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

		describe("on a Kitty terminal", () => {
			// 10x200 px: 16 rows at 10 px cells, so two of them cannot share a page of a 30-row terminal.
			const TALL_PNG =
				"iVBORw0KGgoAAAANSUhEUgAAAAoAAADICAAAAAD0eS/eAAAAIElEQVR42mNsYIABJoZR5ihzlDnKHGWOMkeZo8wBZAIAC30CEMb50JQAAAAASUVORK5CYII=";
			const OK = `<label><input type="checkbox" name="ok"> OK</label>`;
			const TWO_PAGES = `<form><img src="data:image/png;base64,${TALL_PNG}" alt="first">
				<img src="data:image/png;base64,${TALL_PNG}" alt="second">${OK}</form>`;
			const PAGE_DOWN = "\x1b[6~";
			const PAGE_UP = "\x1b[5~";
			const cleanups: (() => void)[] = [];

			afterEach(() => {
				for (const cleanup of cleanups.splice(0)) cleanup();
			});

			/**
			 * A 60x30 Kitty terminal (direct placements, 10 px cells) showing `html` as a form,
			 * settled once `pictures` of them have landed. `landed()` waits for the next one.
			 */
			async function kittyForm(html: string, options: { liveImages?: number; pictures?: number } = {}) {
				// `id` has no setter; a non-Ghostty id lets the test TUI paint its frames.
				const terminalId = TERMINAL as unknown as { id: string };
				const original = {
					id: terminalId.id,
					protocol: TERMINAL.imageProtocol,
					graphics: { ...getKittyGraphics() },
					cells: { ...getCellDimensions() },
				};
				terminalId.id = "xterm";
				setTerminalImageProtocol(ImageProtocol.Kitty);
				setKittyGraphics({ unicodePlaceholders: false });
				setCellDimensions({ widthPx: 10, heightPx: 10 });
				const term = new VirtualTerminal(60, 30);
				const writes: string[] = [];
				const realWrite = term.write.bind(term);
				vi.spyOn(term, "write").mockImplementation((data: string) => {
					writes.push(data);
					realWrite(data);
				});
				const scheduler = new VirtualRenderScheduler();
				const tui = new TUI(term, undefined, { renderScheduler: scheduler });
				if (options.liveImages !== undefined) tui.setMaxInlineImages(options.liveImages);
				let waiting = options.pictures ?? 1;
				let next = Promise.withResolvers<void>();
				const form = new HtmlFormDialog(parseHtmlForm(html), {
					onSubmit: vi.fn(),
					onCancel: vi.fn(),
					tui: {
						terminal: tui.terminal,
						imageBudget: tui.imageBudget,
						requestRender: () => {
							tui.requestRender();
							if (--waiting <= 0) next.resolve();
						},
					},
				});
				let closed = false;
				cleanups.push(() => {
					tui.stop();
					if (!closed) form.dispose();
					vi.restoreAllMocks();
					terminalId.id = original.id;
					setTerminalImageProtocol(original.protocol);
					setKittyGraphics(original.graphics);
					setCellDimensions(original.cells);
				});
				const frame = async (): Promise<void> => {
					tui.requestRender();
					await scheduler.settle(term);
				};
				// A drawing rasterizes from a render, and renders run only while the scheduler settles:
				// render first, then wait for the picture to ask for its frame.
				const landed = async (): Promise<void> => {
					await scheduler.settle(term);
					await next.promise;
					await scheduler.settle(term);
				};
				tui.addChild(form);
				tui.start();
				await landed();
				return {
					term,
					form,
					writes,
					frame,
					/** Render a frame, then wait for the next picture to land, e.g. a drawing's redraw. */
					landed: (): Promise<void> => {
						waiting = 1;
						next = Promise.withResolvers<void>();
						tui.requestRender();
						return landed();
					},
					close: async (): Promise<void> => {
						closed = true;
						tui.removeChild(form);
						form.dispose();
						await frame();
					},
				};
			}

			it("places a picture under its own id and deletes it when the form closes", async () => {
				// An id-less `a=T` placement survives the rows that drew it being repainted,
				// so a closed form would leave its picture painted over whatever comes next.
				const view = await kittyForm(`<form><img src="data:image/png;base64,${PNG_1PX}" alt="dot">${OK}</form>`);
				expect(view.writes.join("")).not.toContain("\x1b_Ga=T");
				expect(view.term.graphicsPlacements()).toHaveLength(1);
				await view.close();
				expect(view.term.graphicsPlacements()).toEqual([]);
			});

			it("spends image slots only on the pictures of the page shown", async () => {
				// One live image: a picture on a later page must not take it from the one shown.
				const view = await kittyForm(TWO_PAGES, { liveImages: 1, pictures: 2 });
				view.form.handleInput(PAGE_UP);
				await view.frame();
				expect(view.form.debugState()).toMatchObject({ page: 1, pages: 2 });
				const screen = view.term.getViewport().join("\n");
				expect(screen).not.toContain("[Image: first");
				expect(screen).not.toContain("second");
			});

			it("deletes a picture the budget evicted and sent again when the form closes", async () => {
				const view = await kittyForm(TWO_PAGES, { liveImages: 1, pictures: 2 });
				// Page 2 takes the one live slot and evicts page 1's picture; back on page 1 it is sent again.
				for (const key of [PAGE_UP, PAGE_DOWN, PAGE_UP]) {
					view.form.handleInput(key);
					await view.frame();
				}
				expect(view.form.debugState()).toMatchObject({ page: 1 });
				expect(view.term.graphicsPlacements()).toHaveLength(1);
				await view.close();
				expect(view.term.graphicsPlacements()).toEqual([]);
			});

			it("deletes every raster of a drawing redrawn while the form is open", async () => {
				const view = await kittyForm(
					`<form><svg viewBox="0 0 838 200"><rect width="838" height="200" fill="#f0f"/></svg>${OK}</form>`,
				);
				// New cell metrics redraw the drawing under a new image id.
				setCellDimensions({ widthPx: 10, heightPx: 12 });
				await view.landed();
				expect(view.term.graphicsPlacements()).toHaveLength(1);
				await view.close();
				expect(view.term.graphicsPlacements()).toEqual([]);
			});
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
			expect(onSubmit).toHaveBeenCalledWith(
				{
					db: "pg",
					extras: ["ci", "docker"],
					region: "ap",
					workers: 4,
					notes: "",
				},
				[],
			);
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
			expect(onSubmit).toHaveBeenCalledWith({ domain: "a", n: "" }, []);
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
			expect(onTimeout).toHaveBeenCalledWith({ db: "pg", extras: ["ci"], region: "us", workers: 4, notes: "" }, []);
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
			expect(onSubmit).toHaveBeenCalledWith({ db: "pg", extras: [], region: "us", workers: 4, notes: "" }, []);
		});

		it("natively: Submit shows only on the last question tab (and Review) and sends from there", () => {
			const { form, onSubmit } = dialog(DB_FORM);
			// First question tab: Next only.
			expect(findPath(form.describe(CX), node => node.key === "submit")).toBeUndefined();
			form.handleNativeEvent({ type: "action", key: "actions/next", act: "next", mods: [] });
			const root = form.describe(CX);
			expect(findPath(root, node => node.k === "kv")).toBeUndefined(); // last question tab, not Review
			expect(findPath(root, node => node.key === "submit")).toBeDefined();
			form.handleNativeEvent({ type: "action", key: "actions/submit", act: "submit", mods: [] });
			expect(onSubmit).toHaveBeenCalledWith(
				{ db: "sqlite", extras: ["ci"], region: "us", workers: 4, notes: "" },
				[],
			);
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

		it("natively: each question after the fieldsets gets its own tab, with the context before it", () => {
			const { form } = dialog(`<form>
				<fieldset><legend>Length</legend><label><input type="radio" name="length" value="short" checked> Short</label><label><input type="radio" name="length" value="long"> Long</label></fieldset>
				<fieldset><legend>Languages</legend><label><input type="checkbox" name="languages" value="ts"> TypeScript</label><label><input type="checkbox" name="languages" value="py"> Python</label></fieldset>
				<label>Editor <select name="editor"><option value="vscode">VS Code</option><option value="zed">Zed</option></select></label>
				<p>How urgent is it?</p>
				<label>Priority <input type="number" name="priority" value="3"></label>
			</form>`);
			const root = form.describe(CX);
			const tabs = findPath(root, node => node.k === "tabs")!;
			let strip: NativeNode = root;
			for (const key of tabs.split("/")) strip = (strip.c ?? []).filter(isNode).find(child => child.key === key)!;
			const items = (strip.p && "items" in strip.p ? strip.p.items : undefined) ?? [];
			expect(items.map(item => ("id" in item ? item.id : ""))).toEqual(["t0", "t1", "t2", "t3", "review"]);
			form.handleNativeEvent({ type: "select", key: tabs, item: "t2" });
			const editorTab = form.describe(CX);
			expect(textsOf(editorTab)).toContain("Editor");
			expect(textsOf(editorTab)).not.toContain("How urgent is it?");
			// The Priority input's well, clickable while another field has focus.
			expect(
				findPath(editorTab, node => !!node.p && "actions" in node.p && node.p.actions?.click === "edit:3"),
			).toBeUndefined();
			form.handleNativeEvent({ type: "select", key: tabs, item: "t3" });
			const priorityTab = textsOf(form.describe(CX));
			expect(priorityTab).toEqual(expect.arrayContaining(["How urgent is it?", "Priority"]));
			expect(priorityTab).not.toContain("Editor");
		});

		it("natively: text between a loose group's options stays on the group's tab", () => {
			const { form } = dialog(`<form>
				<fieldset><legend>Length</legend><label><input type="radio" name="length" value="short" checked> Short</label></fieldset>
				<label><input type="radio" name="plan" value="basic" checked> Basic</label>
				<p>Premium includes backups</p>
				<label><input type="radio" name="plan" value="premium"> Premium</label>
				<label>Notes <input name="notes"></label>
			</form>`);
			const tabs = findPath(form.describe(CX), node => node.k === "tabs")!;
			form.handleNativeEvent({ type: "select", key: tabs, item: "t1" });
			expect(textsOf(form.describe(CX))).toContain("Premium includes backups");
			form.handleNativeEvent({ type: "select", key: tabs, item: "t2" });
			expect(textsOf(form.describe(CX))).toEqual(expect.arrayContaining(["Notes"]));
			expect(textsOf(form.describe(CX))).not.toContain("Premium includes backups");
		});

		it("natively: a field between a loose group's options keeps the context before it", () => {
			const { form } = dialog(`<form>
				<fieldset><legend>Length</legend><label><input type="radio" name="length" value="short" checked> Short</label></fieldset>
				<label><input type="radio" name="plan" value="basic" checked> Basic</label>
				<p>Choose a compliant region</p>
				<label>Region <select name="region"><option value="us">US</option><option value="eu">EU</option></select></label>
				<label><input type="radio" name="plan" value="premium"> Premium</label>
			</form>`);
			const tabs = findPath(form.describe(CX), node => node.k === "tabs")!;
			form.handleNativeEvent({ type: "select", key: tabs, item: "t1" });
			expect(textsOf(form.describe(CX))).not.toContain("Choose a compliant region");
			form.handleNativeEvent({ type: "select", key: tabs, item: "t2" });
			expect(textsOf(form.describe(CX))).toEqual(expect.arrayContaining(["Choose a compliant region", "Region"]));
		});

		it("natively: a loose field with only disabled options shares the next tab, so the focused field stays shown", () => {
			const { form } = dialog(`<form>
				<label><input type="checkbox" name="locked" disabled> Locked</label>
				<label>Name <input name="name"></label>
				<fieldset><legend>Length</legend><label><input type="radio" name="length" value="short" checked> Short</label></fieldset>
			</form>`);
			const root = form.describe(CX);
			const path = findPath(root, node => node.k === "tabs")!;
			let strip: NativeNode = root;
			for (const key of path.split("/")) strip = (strip.c ?? []).filter(isNode).find(child => child.key === key)!;
			const items = (strip.p && "items" in strip.p ? strip.p.items : undefined) ?? [];
			expect(items.map(item => ("id" in item ? item.id : ""))).toEqual(["t0", "t1", "review"]);
			// The shared tab is named after Name, the question the keyboard reaches.
			const first = items[0];
			expect(first && "label" in first && typeof first.label !== "string" ? first.label[0]?.t : "").toBe("Name");
			// Focus opens on Name, the first control the keyboard reaches; the shown tab holds it.
			expect(textsOf(root)).toContain("Name");
		});

		it("natively: a fieldset without a legend stays one tab", () => {
			const { form } = dialog(`<form>
				<fieldset><legend>Length</legend><label><input type="radio" name="length" value="short" checked> Short</label></fieldset>
				<fieldset><label>Name <input name="name"></label><label>Email <input name="email"></label></fieldset>
			</form>`);
			const root = form.describe(CX);
			const path = findPath(root, node => node.k === "tabs")!;
			let strip: NativeNode = root;
			for (const key of path.split("/")) strip = (strip.c ?? []).filter(isNode).find(child => child.key === key)!;
			const items = (strip.p && "items" in strip.p ? strip.p.items : undefined) ?? [];
			expect(items.map(item => ("id" in item ? item.id : ""))).toEqual(["t0", "t1", "review"]);
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
			expect(liveControls(form.describe(CX), Input)).toEqual([]);
			form.handleNativeEvent({ type: "select", key: radios, item: "other" });
			const [other] = liveControls(form.describe(CX), Input);
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

		it("natively: clicking Other hands the keys over even while a composer draft owns typing", () => {
			const typed: string[] = [];
			const { form } = dialog(DB_FORM, {
				inputGuard: {
					isBlocked: () => true,
					handleInput: (data: string) => typed.push(data),
					hint: "typing edits your prompt",
				},
			});
			const radios = findPath(form.describe(CX), node => node.k === "list" && node.key === "f0")!;
			form.handleNativeEvent({ type: "select", key: radios, item: "other" });
			for (const key of ["F", "l", "y"]) form.handleInput(key);
			expect(form.data()).toMatchObject({ db: "Fly" });
			expect(typed).toEqual([]);
		});

		it("natively: clicking a text well hands the keys over even while a composer draft owns typing", () => {
			const typed: string[] = [];
			const { form } = dialog(DB_FORM, {
				inputGuard: {
					isBlocked: () => true,
					handleInput: (data: string) => typed.push(data),
					hint: "typing edits your prompt",
				},
			});
			form.handleNativeEvent({ type: "action", key: "x", act: "edit:3", mods: [] });
			form.handleInput("5");
			expect(form.data()).toMatchObject({ workers: 54 });
			expect(typed).toEqual([]);
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
