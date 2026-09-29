import { beforeAll, describe, expect, it } from "bun:test";
import type { TspKind } from "@oh-my-pi/pi-wire";
import { BashExecutionComponent } from "../src/chat/bash-execution";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { bashToolRenderer, formatExitCodeNotice, formatWallTimeNotice } from "../src/tools/bash";
import { evalToolRenderer } from "../src/tools/eval";
import type { RenderResultOptions } from "../src/tools/renderer";
import { getThemeByName, setThemeInstance } from "../src/theme";
import type { TUI } from "../src/tui";

const done: RenderResultOptions = { expanded: false, isPartial: false };

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child;
}

function collect(children: readonly NativeChild[] | undefined, kind: string): NativeNode[] {
	const out: NativeNode[] = [];
	for (const child of children ?? []) {
		if (!isNode(child)) continue;
		if (child.k === kind) out.push(child);
		out.push(...collect(child.c, kind));
	}
	return out;
}

function props(n: NativeNode | undefined): Record<string, unknown> {
	return (n?.p ?? {}) as Record<string, unknown>;
}

function cx(kinds: readonly TspKind[]): DescribeContext {
	return { cols: 100, reduceMotion: false, dark: true, supports: kind => kinds.includes(kind), feature: () => true };
}

describe("bash native view", () => {
	it("puts a failure's exit in the head and leaves only the output in the body", () => {
		const view = bashToolRenderer.describeResult(
			{
				content: [{ type: "text", text: `boom\n\n${formatExitCodeNotice(2)}\n${formatWallTimeNotice(1500)}` }],
				details: { exitCode: 2, wallTimeMs: 1500, timeoutSeconds: 300 },
				isError: true,
			},
			done,
			{ command: "make" },
		);
		expect(view.tool?.exit).toBe(2);
		expect(view.tool?.note).toBeUndefined();
		expect(view.preview).toEqual({ tail: 10 });
		expect(view.body?.map(child => (isNode(child) ? child.k : "component"))).toEqual(["ansi"]);
		expect(String(props(collect(view.body, "ansi")[0]).text)).toBe("boom");
	});

	it("notes a timeout only when the deadline hit", () => {
		const view = bashToolRenderer.describeResult(
			{
				content: [{ type: "text", text: "partial" }],
				details: { timedOut: true, timeoutSeconds: 5 },
				isError: true,
			},
			done,
			{ command: "sleep 60" },
		);
		expect(view.tool?.note).toBe("timed out");
		expect(view.tool?.exit).toBeUndefined();
	});
});

describe("eval native view", () => {
	it("titles the head with the cell title and renders console.table output as a table", () => {
		const table = [
			"┌─────────┬────┬─────┐",
			"│ (index) │ a  │  b  │",
			"├─────────┼────┼─────┤",
			"│    0    │ 1  │ 'x' │",
			"│    1    │ 22 │     │",
			"└─────────┴────┴─────┘",
		].join("\n");
		const view = evalToolRenderer.describeResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					cells: [
						{
							index: 0,
							title: "Sum rows",
							code: "console.table(rows)",
							language: "js",
							output: `before\n${table}\nafter`,
							status: "complete",
						},
					],
				},
			},
			done,
		);
		expect(view.tool?.title).toBe("Sum rows");
		expect(view.tool?.badges).toEqual([{ text: "js" }]);
		const [cell] = collect(view.body, "section");
		// A single cell's title lives in the head only.
		expect(props(cell).head).toBeUndefined();
		expect(cell?.c?.map(child => (isNode(child) ? child.k : "component"))).toEqual(["code", "ansi", "table", "ansi"]);
		const tableProps = props(collect(view.body, "table")[0]) as {
			cols: { head: string }[];
			rows: { cells: Record<string, string> }[];
		};
		expect(tableProps.cols.map(col => col.head)).toEqual(["", "a", "b"]);
		expect(tableProps.rows.map(row => Object.values(row.cells))).toEqual([
			["0", "1", "'x'"],
			["1", "22", ""],
		]);
	});
});

describe("user shell runs", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	beforeAll(async () => {
		setThemeInstance((await getThemeByName("dark"))!);
	});

	it("describe the agent's bash tool frame with you / not-sent badges", () => {
		const run = new BashExecutionComponent("ls -la", ui, true);
		run.appendOutput("a\nb");
		run.setComplete(1, false);
		const described = run.describe(cx(["tool", "ansi"]));
		expect(described.k).toBe("tool");
		const p = props(described);
		expect(p.target).toBe("ls -la");
		expect(p.exit).toBe(1);
		expect(p.status).toBe("error");
		expect(p.preview).toEqual({ tail: 10 });
		expect((p.badges as { text: string }[]).map(badge => badge.text)).toEqual(["you", "not sent"]);
		expect(collect(described.c, "ansi")).toHaveLength(1);
		expect(run.describe(cx(["card", "ansi"])).k).toBe("card");
	});
});
