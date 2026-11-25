import { expect, test } from "bun:test";
import { parseRpcFormNotes } from "../src/modes/rpc/rpc-form-notes";
import type { OptionNote } from "../src/tools/html-form/data";
import { parseHtmlForm } from "../src/tools/html-form/parse";
const form = parseHtmlForm(
	'<form><p>Deployment</p><label><input name="env" type="radio" value="staging">Staging</label><label><input name="env" type="radio" value="prod" disabled>Production</label></form>',
);
const note: OptionNote = {
	name: "env",
	value: "staging",
	question: "spoofed",
	option: "spoofed",
	text: "Reviewed [Image #1]",
	images: [{ type: "image", mimeType: "image/png", data: "aGk=" }],
};

test("remote notes use form labels and keep ordered image blocks separate from form values", () => {
	expect(parseRpcFormNotes(form, { env: "staging" }, [note])).toEqual([
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
	expect(() => parseRpcFormNotes(form, data, notes)).toThrow();
});
