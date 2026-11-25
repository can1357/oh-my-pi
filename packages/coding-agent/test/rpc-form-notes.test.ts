import { expect, test } from "bun:test";
import { parseRpcFormNotes } from "../src/modes/rpc/rpc-form-notes";
import type { HtmlFormData, HtmlFormValue, OptionNote } from "../src/tools/html-form/data";
import { type ChoiceField, parseHtmlForm } from "../src/tools/html-form/parse";
const form = parseHtmlForm(
	'<form><p>Deployment</p><label><input name="env" type="radio" value="staging">Staging</label><label><input name="env" type="radio" value="prod" disabled>Production</label></form>',
);
function selections(data: HtmlFormData) {
	const selected = new Map<ChoiceField, HtmlFormValue | undefined>();
	for (const field of form.fields) if (field.kind === "choice") selected.set(field, data[field.name]);
	return selected;
}
const note: OptionNote = {
	name: "env",
	value: "staging",
	question: "spoofed",
	option: "spoofed",
	text: "Reviewed [Image #1]",
	images: [{ type: "image", mimeType: "image/png", data: "aGk=" }],
};

test("remote notes use form labels and keep ordered image blocks separate from form values", () => {
	expect(parseRpcFormNotes(form, selections({ env: "staging" }), [note], true)).toEqual([
		{ ...note, question: "Deployment", option: "Staging" },
	]);
});
test.each([
	["unselected", {}, [note]],
	["disabled", { env: "prod" }, [{ ...note, value: "prod" }]],
	["unknown", { env: "staging" }, [{ ...note, name: "unknown" }]],
	["duplicate", { env: "staging" }, [note, note]],
	[
		"invalid image",
		{ env: "staging" },
		[{ ...note, images: [{ type: "image", mimeType: "image/png", data: "!!!" }] }],
	],
	[
		"unsupported MIME",
		{ env: "staging" },
		[{ ...note, images: [{ type: "image", mimeType: "text/html", data: "aGk=" }] }],
	],
])("rejects %s notes instead of forwarding a different answer", (_label, data, notes) => {
	expect(() => parseRpcFormNotes(form, selections(data), notes, true)).toThrow();
});
