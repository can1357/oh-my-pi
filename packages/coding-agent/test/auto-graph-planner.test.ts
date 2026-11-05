import { describe, expect, it } from "bun:test";
import type { Answer } from "@oh-my-pi/pi-ai";
import { judgeRequest, planFromAnswers } from "@oh-my-pi/pi-coding-agent/auto-graph/planner";
import { planChart } from "@oh-my-pi/pi-tui/charts/chart-plan";
import { analyzeTable } from "@oh-my-pi/pi-tui/charts/table-data";
import type { TableChartRequest } from "@oh-my-pi/pi-tui/chat/table-chart";

/** A smart-mode request for a table given as rows of cells, header first. */
function request(rows: string[][]): TableChartRequest {
	const [header, ...body] = rows;
	const table = analyzeTable(header!, body);
	const guess = planChart(table);
	if (!guess) throw new Error("fixture draws no chart");
	const markdown = [header!, header!.map(() => "---"), ...body].map(cells => `| ${cells.join(" | ")} |`).join("\n");
	return { markdown, table, guess };
}

function choice(label: string, odds: number): Answer {
	return { type: "choice", choice: label, probabilities: { [label]: odds }, confidence: odds };
}

const ARMS = request([
	["arm", "pass", "latency", "$/task"],
	["opus48", "87%", "10.4 s", "$2.82"],
	["n12", "71%", "6.4 s", "$1.30"],
	["n8", "66%", "5.8 s", "$1.24"],
	["haiku", "37%", "8.5 s", "$0.72"],
]);

describe("judgeRequest", () => {
	it("stops adding meaning questions once a wide table reaches 25", () => {
		const header = ["Repo", "Model", "Status", ...Array.from({ length: 12 }, (_, at) => `metric ${at + 1}`)];
		const rows = Array.from({ length: 9 }, (_, row) => [
			`repo-${Math.floor(row / 3)}`,
			`model-${row % 3}`,
			row % 2 ? "landed" : "pending",
			...Array.from({ length: 12 }, (_, at) => String((row + 1) * (at + 2))),
		]);
		const { questions } = judgeRequest(request([header, ...rows]));
		expect(Object.keys(questions).length).toBeLessThanOrEqual(25);
		expect(questions.kind?.type).toBe("choice");
	});

	it("offers a kind only where the table's data can draw it", () => {
		const kinds = (req: TableChartRequest) => {
			const { kind } = judgeRequest(req).questions;
			return kind?.type === "choice" ? Object.keys(kind.criteria) : [];
		};
		const budgets = request([
			["Measure", "Result", "Budget"],
			["First paint", "11.0 ms", "≤ 120 ms"],
			["Scroll frame", "0.13 ms", "≤ 4 ms"],
			["Keystroke", "0.12 ms", "≤ 2 ms"],
			["Allocations", "7,246", "≤ 0"],
		]);
		expect(kinds(budgets)).toContain("bullet");
		expect(kinds(ARMS)).not.toContain("bullet");
		expect(kinds(ARMS)).toContain("bar");
	});
});

describe("planFromAnswers", () => {
	it("draws no chart when the judge picks none", () => {
		expect(planFromAnswers(ARMS, { kind: choice("none", 0.9) })).toBeNull();
	});

	it("takes a measure's polarity from the judge only when it is sure, else from the header", () => {
		const latency = ARMS.table.columns.findIndex(column => column.header === "latency");
		const unsure = planFromAnswers(ARMS, { [`p${latency}`]: choice("higher", 0.6) });
		expect(unsure?.polarity?.[latency]).toBe("lower");
		const sure = planFromAnswers(ARMS, { [`p${latency}`]: choice("higher", 0.9) });
		expect(sure?.polarity?.[latency]).toBe("higher");
	});

	it("drops the chart when the judge names rows by the only number in the table", () => {
		const threads = request([
			["Thread", "State", "Owner"],
			["32", "open", "ana"],
			["1", "closed", "bo"],
			["40", "open", "cy"],
			["33", "merged", "di"],
		]);
		expect(planFromAnswers(threads, { label: choice("State", 0.9) })).not.toBeNull();
		expect(planFromAnswers(threads, { label: choice("Thread", 0.9) })).toBeNull();
	});
});
