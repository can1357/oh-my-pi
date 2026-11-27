/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { parseHtmlForm } from "../../../src/tools/html-form/parse";
import { HtmlFormDialog, HtmlFormModel } from "../../../src/ui/forms/html-form";
import "../../../src/ui/styles/dock/covering";
import "../../../src/ui/styles/panels/ask-dialog";

function long(id: string): string {
	const paragraph = "Keep this context readable while moving between the questions. ".repeat(20);
	return `${id}-START ${paragraph}\n\n${paragraph}${id}-END`;
}

function paragraphs(id: string): string {
	return long(id)
		.split("\n\n")
		.map(text => `<p>${text}</p>`)
		.join("");
}

function question(
	n: number,
	opts: {
		legend?: string;
		before?: string;
		betweenOptions?: string;
		after?: string;
		kind?: "radio" | "checkbox" | "select" | "text" | "textarea";
	} = {},
): string {
	const kind = opts.kind ?? "radio";
	let controls: string;
	if (kind === "select") {
		controls = `<label>Q${n} answer <select name="q${n}">${["A", "B", "C"]
			.map((option, i) => `<option value="${option}"${i === 0 ? " selected" : ""}>Q${n} option ${option}</option>`)
			.join("")}</select></label>`;
	} else if (kind === "text") {
		controls = `<label>Q${n} answer <input type="text" name="q${n}" value="Initial answer"></label>`;
	} else if (kind === "textarea") {
		controls = `<label>Q${n} answer <textarea name="q${n}" rows="3">First line\nSecond line\nThird line</textarea></label>`;
	} else {
		controls = ["A", "B", "C"]
			.map(
				(option, i) =>
					`<label><input type="${kind}" name="q${n}" value="${option}"${i === 0 ? " checked" : ""}> Q${n} option ${option}</label>${i === 1 ? (opts.betweenOptions ?? "") : ""}`,
			)
			.join("");
	}
	return `<fieldset><legend>${opts.legend ?? `Question ${n}`}</legend>${opts.before ?? ""}${controls}${opts.after ?? ""}</fieldset>`;
}

function between(kind: "radio" | "checkbox" | "select" | "text" | "textarea" = "radio"): string {
	return `<form>${question(1)}${question(2)}${paragraphs("MID")}${question(3, { kind })}${question(4)}${question(5)}</form>`;
}

const LAYOUTS: Record<string, string> = {
	intro: `<form>${paragraphs("INTRO")}${question(1)}${question(2)}${question(3)}</form>`,
	between: between(),
	"inside-before": `<form>${question(1)}${question(2, { before: paragraphs("Q2CTX") })}${question(3)}</form>`,
	"long-legend": `<form>${question(1)}${question(2)}${question(3, { legend: long("Q3LEG") })}${question(4)}${question(5)}</form>`,
	"between-options": `<form>${question(1)}${question(2, { betweenOptions: `<p>${long("Q2MID")}</p>` })}${question(3)}</form>`,
	"inside-after": `<form>${question(1)}${question(2, { after: paragraphs("Q2AFTER") })}${question(3)}</form>`,
	trailing: `<form>${question(1)}${question(2)}${question(3)}${paragraphs("TAIL")}</form>`,
	"checkbox-first": between("checkbox"),
	"select-first": between("select"),
	"text-first": between("text"),
	"textarea-first": between("textarea"),
};

const SIZES = [
	{ columns: 40, rows: 16 },
	{ columns: 60, rows: 24 },
	{ columns: 100, rows: 40 },
	{ columns: 160, rows: 60 },
];
const DOCKS = ["bare", "widgets"] as const;
const CASES = Object.entries(LAYOUTS).flatMap(([layout, html]) =>
	SIZES.flatMap(size => DOCKS.map(dock => ({ layout, html, ...size, dock }))),
);

function markers(text: string): string[] {
	return text.match(/\b[A-Z0-9]+-(?:START|END)\b/g) ?? [];
}

test.each(CASES)(
	"arrow-key reachability: $layout ($columns x $rows, $dock)",
	({ layout, html, columns, rows, dock }) => {
		const model = new HtmlFormModel(parseHtmlForm(html), { onSubmit: () => {}, onCancel: () => {} });
		const initialData = JSON.stringify(model.data());
		const dataStates = new Set([initialData]);
		const expected = [...new Set(markers(html))];
		const seen = new Set<string>();
		const term = createTestTerminal(
			() => ({
				dock:
					dock === "bare" ? (
						<HtmlFormDialog model={model} terminalRows={() => rows} />
					) : (
						[
							<col key="ask" role="omp.dock.covering">
								<HtmlFormDialog model={model} terminalRows={() => rows} />
							</col>,
							<col key="widgets">
								{Array.from({ length: 10 }, (_, i) => (
									<text key={`w${i}`} spans={[{ t: `widget ${i + 1}` }]} />
								))}
							</col>,
						]
					),
			}),
			{ columns, rows },
		);
		const capture = () => {
			// Taller frames scroll their top away; only the terminal's last rows are visible.
			const visible = term.screen().slice(-rows);
			for (const marker of markers(visible.join("\n"))) seen.add(marker);
			dataStates.add(JSON.stringify(model.data()));
			return JSON.stringify([visible, model.active(), model.row(), model.dropdown()]);
		};
		try {
			const root = term.surface.dock()[0]!;
			term.focus(dock === "widgets" ? root.children()[0]! : root);
			capture();
			for (let presses = 0; presses < 400 && model.active() !== "submit"; presses++) {
				term.press("down");
				capture();
			}
			let previous = capture();
			let unchanged = 0;
			for (let presses = 0; presses < 400 && unchanged < 5; presses++) {
				term.press("up");
				const current = capture();
				unchanged = current === previous ? unchanged + 1 : 0;
				previous = current;
			}
			const missing = expected.filter(marker => !seen.has(marker));
			const detail = `${layout}, ${columns}×${rows}, ${dock}; missing markers: ${JSON.stringify(missing)}`;
			expect(missing, detail).toEqual([]);
			expect([...dataStates], detail).toEqual([initialData]);
		} finally {
			term.dispose();
		}
	},
);
