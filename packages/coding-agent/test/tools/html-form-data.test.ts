import { describe, expect, it } from "bun:test";
import { defaultFormData, formSubmission, type HtmlFormData, type OptionNote } from "../../src/tools/html-form/data";
import { parseHtmlForm } from "../../src/tools/html-form/parse";

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

describe("form submission", () => {
	it("normalizes external answers into the dialog's field order, shapes and option notes", () => {
		const html = `${DB_FORM.replace("</form>", "")}
			<input type="hidden" name="kind" value="deploy">
			<label><input type="checkbox" name="confirm" value="yes"> Confirm</label>
			<label>Title <input name="title"></label>
			<label><input type="radio" name="engine" value="a"> A</label>
			<label><input type="radio" name="engine" value="b"> B</label></form>`;
		const result = formSubmission(
			parseHtmlForm(html),
			{
				engine: "  custom engine  ",
				confirm: "yes",
				workers: "3",
				region: "eu",
				extras: ["terraform", "docker", "ci"],
				db: "pg",
			},
			[{ name: "db", value: "pg", question: "forged", option: "forged", text: "  preferred  " }],
		);
		expect(result).toEqual({
			data: {
				kind: "deploy",
				db: "pg",
				extras: ["ci", "docker", "terraform"],
				region: "eu",
				workers: 3,
				notes: "",
				confirm: "yes",
				title: "",
				engine: "custom engine",
			},
			notes: [
				{
					name: "db",
					value: "pg",
					question: "Which store should ledger use?",
					option: "Postgres",
					text: "preferred",
				},
			],
		});
		if ("data" in result) {
			expect(Object.keys(result.data)).toEqual([
				"kind",
				"db",
				"extras",
				"region",
				"workers",
				"notes",
				"confirm",
				"title",
				"engine",
			]);
		}
	});

	it("collects unknown keys, changed hidden inputs, field constraints and unchecked-note errors together", () => {
		const form = parseHtmlForm(`<form><input type="hidden" name="kind" value="deploy">
			<input name="title" required><input name="workers" type="number" min="2">
			<select name="region"><option value="us">US</option><option value="eu">EU</option></select></form>`);
		expect(
			formSubmission(form, { extra: "x", kind: "changed", workers: 1, region: "us" }, [
				{ name: "region", value: "eu", question: "", option: "", text: "not checked" },
			]),
		).toEqual({
			errors: [
				{ name: "extra", message: "Unknown field" },
				{ name: "kind", message: "Hidden input cannot be changed" },
				{ name: "title", message: "Required" },
				{ name: "workers", message: "Must be at least 2" },
				{ name: "region", message: "Note option must be enabled and checked" },
			],
		});
	});

	it.each([
		["radio array", { db: ["pg"] }],
		["checkbox scalar", { extras: "ci" }],
		["duplicate choices", { extras: ["ci", "ci"] }],
		["non-string choice", { extras: [1] }],
		["multiple Other answers", { extras: ["terraform", "ansible"] }],
		["numeric text field", { notes: 3 }],
		["disabled option", { region: "Unavailable" }],
		["unknown option without Other", { region: "moon" }],
	])("refuses an impossible submission: %s", (_name, invalid) => {
		const form = parseHtmlForm(
			DB_FORM.replace(
				'<option value="us">US</option>',
				'<option value="us">US</option><option disabled>Unavailable</option>',
			),
		);
		const result = formSubmission(form, { ...defaultFormData(form), ...invalid } as HtmlFormData);
		expect("errors" in result && result.errors.length > 0).toBe(true);
	});

	it("refuses blank and duplicate notes, and notes on text, unknown or disabled options", () => {
		const form = parseHtmlForm(SELECT_FORM);
		const note: OptionNote = { name: "region", value: "us", question: "", option: "", text: "why" };
		const result = formSubmission(form, { region: "us" }, [
			{ ...note, text: " " },
			note,
			{ ...note, name: "unknown" },
			{ ...note, value: "Unavailable" },
		]);
		expect("errors" in result && result.errors.map(error => error.message)).toEqual([
			"Note text is required",
			"Only one note per option is allowed",
			"Notes need a choice field",
			"Note option must be enabled and checked",
		]);
		const text = parseHtmlForm('<form><input name="region"></form>');
		expect(formSubmission(text, { region: "us" }, [note])).toEqual({
			errors: [{ name: "region", message: "Notes need a choice field" }],
		});
	});

	it("takes data as the whole answer: a field left out is unanswered, not the form's default", () => {
		const form = parseHtmlForm(
			'<form><label>Title<input name="title" value="draft"></label>' +
				'<label><input type="radio" name="db" value="pg" checked>Postgres</label>' +
				'<label><input type="radio" name="db" value="sqlite">SQLite</label>' +
				'<label><input type="checkbox" name="extras" value="ci" checked>CI</label>' +
				'<label><input type="checkbox" name="extras" value="docker">Docker</label>' +
				'<label>Note<input name="note"></label></form>',
		);
		expect(defaultFormData(form)).toEqual({ title: "draft", db: "pg", extras: ["ci"], note: "" });
		// Left out: the prefilled text is blank, the preselected radio is not chosen, the group is empty.
		expect(formSubmission(form, { note: "x" })).toEqual({
			data: { title: "", extras: [], note: "x" },
			notes: [],
		});
		// A caller that wants the form's defaults starts from them.
		expect(formSubmission(form, { ...defaultFormData(form), note: "x" })).toEqual({
			data: { title: "draft", db: "pg", extras: ["ci"], note: "x" },
			notes: [],
		});
	});
});
