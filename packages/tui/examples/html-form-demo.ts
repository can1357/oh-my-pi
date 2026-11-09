/**
 * Try the HTML form dialog on a form file, or on an `ask` call from a JSONL
 * transcript of `{ model, scenario, calls: [{ name, args: { html } }] }` rows.
 *
 *   bun examples/html-form-demo.ts form.html
 *   bun examples/html-form-demo.ts runs.jsonl claude-opus perf
 *
 * Prints the submitted form data as JSON, or `cancelled`.
 */
import { HtmlFormDialog } from "../src/html-form/dialog";
import { parseHtmlForm } from "../src/html-form/parse";
import { initTheme } from "../src/theme/theme";
import { matchesKey, ProcessTerminal, TUI } from "../src";

interface CorpusRow {
	model: string;
	scenario: string;
	calls: { name: string; args: { html?: string } }[];
}

const [path, model = "", scenario = ""] = process.argv.slice(2);
if (!path) {
	console.error("usage: html-form-demo.ts <form.html> | <runs.jsonl> <model-substring> <scenario>");
	process.exit(2);
}
let html: string | undefined;
if (path.endsWith(".jsonl")) {
	const rows = Bun.JSONL.parse(await Bun.file(path).text()) as CorpusRow[];
	const row = rows.find(entry => entry.model.includes(model) && entry.scenario === scenario);
	html = row?.calls.find(call => call.name === "ask")?.args.html;
} else {
	html = await Bun.file(path).text();
}
if (!html) {
	console.error(`no form found in ${path} for ${model} ${scenario}`);
	process.exit(2);
}

await initTheme();
const tui = new TUI(new ProcessTerminal());
const finish = (output: string, code: number): never => {
	tui.stop();
	console.log(output);
	process.exit(code);
};
const dialog = new HtmlFormDialog(parseHtmlForm(html), {
	tui,
	onSubmit: data => finish(JSON.stringify(data, null, 2), 0),
	onCancel: () => finish("cancelled", 1),
});
tui.addChild(dialog);
tui.setFocus(dialog);
tui.addInputListener(data => {
	if (!matchesKey(data, "ctrl+c")) return undefined;
	finish("cancelled", 1);
});
tui.start();
