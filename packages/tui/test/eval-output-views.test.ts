import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { type EvalView, type EvalViewEntry, evalToolRenderer, splitEvalOutput } from "@oh-my-pi/pi-tui/tools/eval";

const json = (value: unknown): EvalView => ({ kind: "json", value });

describe("splitEvalOutput", () => {
	it("keeps text around a view, newlines bordering the view trimmed", () => {
		const view = json({ a: 1 });
		expect(splitEvalOutput("before\n{'a': 1}\nafter\n", [{ text: "{'a': 1}", view }])).toEqual([
			{ kind: "text", text: "before" },
			{ kind: "view", view },
			{ kind: "text", text: "after" },
		]);
	});

	it("consumes duplicate texts in order", () => {
		const first = json([1]);
		const second = json([2]);
		const views: EvalViewEntry[] = [
			{ text: "X", view: first },
			{ text: "X", view: second },
		];
		expect(splitEvalOutput("X\nmid\nX", views)).toEqual([
			{ kind: "view", view: first },
			{ kind: "text", text: "mid" },
			{ kind: "view", view: second },
		]);
	});

	it("skips views whose text is not in the output (e.g. truncated)", () => {
		const kept = json({ b: 2 });
		const views: EvalViewEntry[] = [
			{ text: "gone", view: json({ a: 1 }) },
			{ text: "B", view: kept },
			{ text: "A", view: json({ late: true }) },
		];
		expect(splitEvalOutput("A\nB\n", views)).toEqual([
			{ kind: "text", text: "A" },
			{ kind: "view", view: kept },
		]);
		expect(splitEvalOutput("plain", undefined)).toEqual([{ kind: "text", text: "plain" }]);
	});
});

describe("eval terminal output views", () => {
	let theme: Theme;

	beforeAll(async () => {
		theme = (await getThemeByName("dark"))!;
		setThemeInstance(theme);
	});

	function render(output: string, views: EvalViewEntry[]): string[] {
		const component = evalToolRenderer.renderResult(
			{
				content: [{ type: "text", text: output }],
				details: {
					cells: [{ index: 0, code: "print(x)", language: "python", output, status: "complete", views }],
				},
			},
			{ expanded: true, isPartial: false },
			theme,
		);
		return Bun.stripANSI(component.render(120).join("\n")).split("\n");
	}

	it("keeps a table view's printed text between its neighbours, beside a json tree", () => {
		const dfText = "   n\n0  1\n1  2";
		const printed = "{'alpha': 1}";
		const lines = render(`rows:\n${dfText}\ndone\n${printed}\n`, [
			{
				// Stored trimmed, as the eval tool records view text.
				text: dfText.trim(),
				view: {
					kind: "table",
					columns: [{ head: "" }, { head: "n", numeric: true }],
					rows: [
						["0", "1"],
						["1", "2"],
					],
				},
			},
			{ text: printed, view: json({ alpha: 1 }) },
		]);
		const at = (needle: string) => lines.findIndex(line => line.includes(needle));
		expect(at("rows:")).toBeGreaterThanOrEqual(0);
		// The header keeps the indentation that aligns it with the rows.
		expect(at("   n")).toBe(at("rows:") + 1);
		expect(at("0  1")).toBeGreaterThan(at("rows:"));
		expect(at("1  2")).toBeGreaterThan(at("0  1"));
		expect(at("done")).toBeGreaterThan(at("1  2"));
		expect(at("alpha")).toBeGreaterThan(at("done"));
		expect(lines.join("\n")).not.toContain(printed);
	});

	it("renders a json view as a tree in place of its printed text", () => {
		const printed = "{'alpha': 1, 'beta': 'x'}";
		const lines = render(`${printed}\n`, [{ text: printed, view: json({ alpha: 1, beta: "x" }) }]);
		const body = lines.join("\n");
		expect(body).not.toContain(printed);
		expect(body).toContain("alpha");
		expect(body).toContain("beta");
	});
});
