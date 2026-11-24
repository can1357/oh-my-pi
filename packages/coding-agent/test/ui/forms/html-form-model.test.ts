/**
 * The HTML form dialog's model driven by keys and pastes: clipboard text into
 * its text boxes, the submit held behind a pending paste, and Vim mode in its
 * text boxes and rows.
 */
import { describe, expect, it, vi } from "bun:test";
import type { HtmlFormData, OptionNote } from "../../../src/tools/html-form/data";
import { parseHtmlForm } from "../../../src/tools/html-form/parse";
import type { DialogVim } from "../../../src/ui/composer/vim-editor";
import { type HtmlFormCallbacks, HtmlFormModel } from "../../../src/ui/forms/html-form";
import { keyEvent } from "../../helpers/input-harness";

const DB_FORM = `<form>
<fieldset><legend>Database</legend>
<label><input type="radio" name="db" value="sqlite" checked> SQLite</label><br>
<label><input type="radio" name="db" value="pg"> Postgres</label>
</fieldset>
</form>`;

const ONE_FIELD = `<form><label>Answer <input name="answer"></label></form>`;

function dialog(html: string, callbacks: Partial<HtmlFormCallbacks> = {}, vim?: DialogVim) {
	const onSubmit = vi.fn<(data: HtmlFormData, notes: OptionNote[]) => void>();
	const onCancel = vi.fn();
	const model = new HtmlFormModel(parseHtmlForm(html), { onSubmit, onCancel, ...callbacks }, vim ? { vim } : {});
	/** Press keys by id (`enter`, `ctrl+v`), or type each character of a `"text"`. */
	const press = (...keys: string[]): void => {
		for (const key of keys) {
			if (key.startsWith('"')) for (const ch of key.slice(1, -1)) model.key(keyEvent(ch));
			else model.key(keyEvent(key));
		}
	};
	return { model, press, onSubmit, onCancel };
}

/** A host clipboard read the test settles: `true` once its text was pasted. */
function clipboardRead() {
	const reads: PromiseWithResolvers<boolean>[] = [];
	const onPasteClipboard = vi.fn(() => {
		const read = Promise.withResolvers<boolean>();
		reads.push(read);
		return read.promise;
	});
	return { onPasteClipboard, reads };
}

describe("html form model", () => {
	it("presses an action beside Submit without submitting, whatever the fields hold", () => {
		const onAction = vi.fn();
		const onSubmit = vi.fn<(data: HtmlFormData, notes: OptionNote[]) => void>();
		const actions = [
			{ id: "decline", label: "Decline" },
			{ id: "cancel", label: "Cancel" },
		];
		const model = new HtmlFormModel(
			parseHtmlForm(`<form><label>Name <input name="name" required></label></form>`),
			{ onSubmit, onCancel: vi.fn(), onAction },
			{ actions },
		);
		model.key(keyEvent("tab")); // the Submit row
		model.key(keyEvent("right")); // Decline
		expect(model.pressed()?.id).toBe("decline");
		model.key(keyEvent("enter"));
		// The required name is still empty: declining needs no valid answers.
		expect(onAction).toHaveBeenCalledWith("decline");
		model.key(keyEvent("left"));
		model.key(keyEvent("left")); // wraps past Submit to Cancel
		model.key(keyEvent("enter"));
		expect(onAction).toHaveBeenLastCalledWith("cancel");
		// A click on an action button in Tern.
		model.action("action:decline", "actions/action:decline");
		expect(onAction).toHaveBeenLastCalledWith("decline");
		expect(onSubmit).not.toHaveBeenCalled();
	});

	describe("text paste", () => {
		it("asks the host for clipboard text on the paste key and pastes it into a one-line answer without submitting", async () => {
			const { onPasteClipboard, reads } = clipboardRead();
			const { model, press, onSubmit } = dialog(ONE_FIELD, { onPasteClipboard });
			press("ctrl+v");
			expect(onPasteClipboard).toHaveBeenCalledTimes(1);
			model.paste("hello");
			reads[0]!.resolve(true);
			await reads[0]!.promise;
			expect(model.data()).toEqual({ answer: "hello" });
			expect(onSubmit).not.toHaveBeenCalled();
		});

		it("preserves newlines in a textarea", () => {
			const { model } = dialog(`<form><label>Notes <textarea name="notes"></textarea></label></form>`);
			model.paste("line1\r\nline2");
			expect(model.data()).toEqual({ notes: "line1\nline2" });
		});

		it("uses pasted Other text instead of the preselected radio answer", () => {
			const { model, press } = dialog(DB_FORM);
			press("down", "down");
			model.paste("duckdb");
			expect(model.data()).toMatchObject({ db: "duckdb" });
		});

		it("delivers a reserved paste once to the original field after Tab", async () => {
			const { onPasteClipboard, reads } = clipboardRead();
			const { model, press } = dialog(
				`<form><label>A <input name="a"></label><label>B <input name="b"></label></form>`,
				{
					onPasteClipboard,
				},
			);
			press("ctrl+v", "tab");
			model.paste("clip");
			reads[0]!.resolve(true);
			await reads[0]!.promise;
			model.paste("again");
			expect(model.data()).toEqual({ a: "clip", b: "again" });
		});

		it("pastes clipboard text into an open option note", () => {
			const { onPasteClipboard } = clipboardRead();
			const { model, press } = dialog(DB_FORM, { onPasteClipboard });
			model.startNote();
			press("ctrl+v");
			expect(onPasteClipboard).toHaveBeenCalledTimes(1);
			model.paste("why sqlite");
			press("enter");
			expect(model.notes()).toMatchObject([{ text: "why sqlite" }]);
		});

		it("leaves the paste key to the host's image paste in a note that takes images", () => {
			const onPasteImage = vi.fn();
			const { onPasteClipboard } = clipboardRead();
			const { model, press } = dialog(DB_FORM, { onPasteClipboard, onPasteImage });
			model.startNote();
			press("ctrl+v");
			expect(onPasteImage).toHaveBeenCalledTimes(1);
			expect(onPasteClipboard).not.toHaveBeenCalled();
		});

		it("asks for nothing on a row that takes no text", () => {
			const { onPasteClipboard } = clipboardRead();
			const { press } = dialog(DB_FORM, { onPasteClipboard });
			press("ctrl+v");
			expect(onPasteClipboard).not.toHaveBeenCalled();
		});

		it("holds a one-field submit until the reserved paste arrives", async () => {
			const { onPasteClipboard, reads } = clipboardRead();
			const { model, press, onSubmit } = dialog(ONE_FIELD, { onPasteClipboard });
			press("ctrl+v", "enter");
			expect(onSubmit).not.toHaveBeenCalled();
			model.paste("clipboard");
			reads[0]!.resolve(true);
			await reads[0]!.promise;
			expect(onSubmit).toHaveBeenCalledWith({ answer: "clipboard" }, []);
		});

		it("cancels the held submit when the reserved paste fails", async () => {
			const { onPasteClipboard, reads } = clipboardRead();
			const { press, onSubmit } = dialog(ONE_FIELD, { onPasteClipboard });
			press("ctrl+v", "enter");
			reads[0]!.resolve(false);
			await reads[0]!.promise;
			expect(onSubmit).not.toHaveBeenCalled();
			press("enter");
			expect(onSubmit).toHaveBeenCalledWith({ answer: "" }, []);
		});

		it("delivers a text paste reserved before hiding, while refusing new ones", async () => {
			const { onPasteClipboard, reads } = clipboardRead();
			const { model, press } = dialog(`<form><label>A <input name="a"></label></form>`, { onPasteClipboard });
			press("ctrl+v", "alt+h");
			expect(model.hidden.peek()).toBe(true);
			press("ctrl+v");
			expect(onPasteClipboard).toHaveBeenCalledTimes(1);
			model.paste("clipboard");
			reads[0]!.resolve(true);
			await reads[0]!.promise;
			expect(model.data()).toEqual({ a: "clipboard" });
			model.paste("later");
			expect(model.data()).toEqual({ a: "clipboard" });
		});
	});

	describe("Vim mode", () => {
		const VIM: DialogVim = {};
		const EXTRAS_FORM = `<form>
<fieldset><legend>Database</legend>
<label><input type="radio" name="db" value="sqlite" checked> SQLite</label>
<label><input type="radio" name="db" value="pg"> Postgres</label>
</fieldset>
<fieldset><legend>Extras</legend>
<label>Region <select name="region"><option value="us">US</option><option value="eu">EU</option></select></label>
<label>Notes<textarea name="notes"></textarea></label>
</fieldset>
</form>`;

		it("Esc in a textarea leaves Insert first; only a quiet Normal mode hands the keys back", () => {
			const releaseKeys = vi.fn();
			const { model, press } = dialog(
				`<form><label>Notes<textarea name="notes"></textarea></label></form>`,
				{ releaseKeys },
				VIM,
			);
			press('"draft"', "escape");
			expect(releaseKeys).not.toHaveBeenCalled();
			press('"x"');
			expect(model.data()).toEqual({ notes: "draf" });
			press("escape");
			expect(releaseKeys).toHaveBeenCalledTimes(1);
		});

		it("Esc in an option note leaves Insert, so Enter still saves it; a reopened note types again", () => {
			const { model, press } = dialog(DB_FORM, {}, VIM);
			press("down", "n", '"why postgres"', "escape");
			expect(model.note.peek()).toMatchObject({ field: 0, option: 1 });
			press("enter");
			expect(model.answer(0).notes.get(1)).toBe("why postgres");
			// Closed from Normal mode, the note still reopens in Insert mode.
			press("n", '"!"', "escape", "enter");
			expect(model.answer(0).notes.get(1)).toBe("why postgres!");
		});

		it("the Other answer takes Vim keys, and Esc leaves Insert before it hands the keys back", () => {
			const releaseKeys = vi.fn();
			const { model, press } = dialog(DB_FORM, { releaseKeys }, VIM);
			press("down", "down", '"my own answer"', "escape");
			expect(releaseKeys).not.toHaveBeenCalled();
			press('"bdw"');
			expect(model.data()).toEqual({ db: "my own" });
			press("escape");
			expect(releaseKeys).toHaveBeenCalledTimes(1);
		});

		it("a one-line text input takes Vim keys; a password stays a plain masked input", () => {
			const releaseKeys = vi.fn();
			const { model, press } = dialog(
				`<form><label>Name <input type="text" name="name"></label><label>Secret <input type="password" name="pw"></label></form>`,
				{ releaseKeys },
				VIM,
			);
			press('"hello world"', "escape");
			expect(releaseKeys).not.toHaveBeenCalled();
			press('"bD"');
			expect(model.data()).toMatchObject({ name: "hello " });
			press("tab", '"abc"');
			// No Vim mode in the password: Esc goes straight back to the composer.
			press("escape");
			expect(releaseKeys).toHaveBeenCalledTimes(1);
			expect(model.data()).toMatchObject({ pw: "abc" });
		});

		it("j/k step between option rows like ↓/↑, while text boxes and dropdowns keep the letters", () => {
			const { model, press } = dialog(EXTRAS_FORM, {}, VIM);
			press("j");
			expect(model.row.peek()).toBe(1);
			press("k");
			expect(model.row.peek()).toBe(0);
			// Without Vim mode `j` is no row key.
			const plain = dialog(EXTRAS_FORM);
			plain.press("j");
			expect(plain.model.row.peek()).toBe(0);
			// In a text box `j` is text again.
			const text = dialog(`<form><label>Name <input type="text" name="name"></label></form>`, {}, VIM);
			text.press("j");
			expect(text.model.data()).toEqual({ name: "j" });
			// A closed dropdown keeps its letter type-ahead: `k` picks Kotlin instead of moving.
			const select = dialog(
				`<form><label>Lang <select name="lang"><option value="json">JSON</option><option value="kotlin">Kotlin</option></select></label></form>`,
				{},
				VIM,
			);
			select.press("k");
			expect(select.model.data()).toEqual({ lang: "kotlin" });
			// On Submit `k` goes back up.
			const submit = dialog(EXTRAS_FORM, {}, VIM);
			submit.model.active.set("submit");
			submit.press("k");
			expect(submit.model.active.peek()).toBe(2);
		});

		it("text boxes starting in Normal mode: j/k on the box's edge line step to the next or previous field", () => {
			const { model, press } = dialog(
				`<form><label>First <input type="text" name="a"></label><label>Second <input type="text" name="b"></label></form>`,
				{},
				{ startMode: () => "normal" },
			);
			// Normal mode: the letters are commands, so nothing is typed, and `j` leaves the one-line box.
			press("j", "i", '"two"', "escape", "k", "a", '"one"');
			expect(model.data()).toEqual({ a: "one", b: "two" });
		});

		it("Ctrl+R redoes in Normal mode and is no redo in Insert mode", () => {
			const { model, press } = dialog(ONE_FIELD, {}, VIM);
			press('"abc"', "escape", "u");
			expect(model.data()).toEqual({ answer: "" });
			press("ctrl+r");
			expect(model.data()).toEqual({ answer: "abc" });
			press("u", "i", "ctrl+r");
			expect(model.data()).toEqual({ answer: "" });
		});

		it("undoes a paste in Normal mode as one step, and a paste in Insert mode with its session", () => {
			const { model, press } = dialog(ONE_FIELD, {}, VIM);
			press('"a"', "escape");
			model.paste("pasted");
			expect(model.data()).toEqual({ answer: "pasteda" });
			press("u");
			expect(model.data()).toEqual({ answer: "a" });
			press("A");
			model.paste("!");
			press('"?"', "escape", "u");
			expect(model.data()).toEqual({ answer: "a" });
		});
	});
});
