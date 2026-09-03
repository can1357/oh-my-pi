import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	recallToolRenderer,
	reflectToolRenderer,
	retainToolRenderer,
} from "@oh-my-pi/pi-coding-agent/tools/memory-render";
import { sanitizeText } from "@oh-my-pi/pi-utils";

const themePromise = getThemeByName("dark");

async function theme() {
	const t = await themePromise;
	expect(t).toBeDefined();
	return t!;
}

const lines = (component: { render: (w: number) => readonly string[] }, width = 200) =>
	sanitizeText(component.render(width).join("\n")).split("\n");

describe("retainToolRenderer", () => {
	const args = {
		items: [
			{ content: "First fact to remember", context: "ctx-a" },
			{ content: "Second fact to remember", context: "ctx-b" },
			{ content: "Third fact to remember" },
		],
	};

	it("renders one inline bullet line per item with a count summary", async () => {
		const uiTheme = await theme();
		const bullet = uiTheme.format.bullet;
		const result = { content: [{ type: "text", text: "3 memories stored." }], details: { count: 3 } };
		const rendered = lines(
			retainToolRenderer.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, args),
		);

		expect(rendered[0]).toContain("Retain");
		expect(rendered[0]).toContain("3 memories stored");
		const items = rendered.filter(line => line.includes(bullet));
		expect(items).toHaveLength(3);
		expect(items[0]).toContain("First fact to remember");
		expect(items[2]).toContain("Third fact to remember");
		// No "Remember:" prefix and no raw JSON arg tree leaks into the output.
		expect(rendered.some(line => line.includes("Remember:"))).toBe(false);
		expect(rendered.some(line => line.includes("context") || line.includes("[0]"))).toBe(false);
	});

	it("truncates long memory content to one line", async () => {
		const uiTheme = await theme();
		const bullet = uiTheme.format.bullet;
		const long = "x".repeat(400);
		const result = { content: [{ type: "text", text: "1 memory stored." }], details: { count: 1 } };
		const rendered = lines(
			retainToolRenderer.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, {
				items: [{ content: long }],
			}),
			80,
		);
		const item = rendered.find(line => line.includes(bullet));
		expect(item!.length).toBeLessThanOrEqual(80);
		expect(item).toContain("…");
	});

	it("shows pending bullet lines while the call streams", async () => {
		const uiTheme = await theme();
		const bullet = uiTheme.format.bullet;
		const rendered = lines(retainToolRenderer.renderCall(args, { expanded: false, isPartial: true }, uiTheme));
		expect(rendered.filter(line => line.includes(bullet))).toHaveLength(3);
	});

	it("ignores transient non-array items while the call streams", async () => {
		const uiTheme = await theme();
		const bullet = uiTheme.format.bullet;
		const rendered = lines(
			retainToolRenderer.renderCall({ items: "[" }, { expanded: false, isPartial: true }, uiTheme),
		);

		expect(rendered[0]).toContain("Retain");
		expect(rendered.some(line => line.includes(bullet))).toBe(false);
	});
});

describe("recallToolRenderer", () => {
	it("summarizes the match count and hides memories until expanded", async () => {
		const uiTheme = await theme();
		const result = {
			content: [
				{
					type: "text",
					text: "Found 2 relevant memories (as of 2026-05-30 UTC):\n\n- alpha memory\n- beta memory",
				},
			],
		};
		const collapsed = lines(
			recallToolRenderer.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, {
				query: "find stuff",
			}),
		);
		expect(collapsed[0]).toContain("Recall");
		expect(collapsed[0]).toContain("find stuff");
		expect(collapsed[0]).toContain("2 found");
		expect(collapsed.some(line => line.includes("alpha memory"))).toBe(false);

		const expanded = lines(
			recallToolRenderer.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, {
				query: "find stuff",
			}),
		);
		expect(expanded.some(line => line.includes("alpha memory"))).toBe(true);
		expect(expanded.some(line => line.includes("beta memory"))).toBe(true);
	});

	it("flags an empty recall as a single warning line", async () => {
		const uiTheme = await theme();
		const result = { content: [{ type: "text", text: "No relevant memories found." }] };
		const rendered = lines(
			recallToolRenderer.renderResult(result as never, { expanded: false, isPartial: false }, uiTheme, {
				query: "q",
			}),
		);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toContain("no matches");
	});
});

describe("reflectToolRenderer", () => {
	it("renders the synthesized answer under a concise header", async () => {
		const uiTheme = await theme();
		const result = { content: [{ type: "text", text: "Line one.\nLine two.\nLine three." }] };
		const rendered = lines(
			reflectToolRenderer.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, {
				query: "what do you know",
			}),
		);
		expect(rendered[0]).toContain("Reflect");
		expect(rendered[0]).toContain("what do you know");
		expect(rendered.some(line => line.includes("Line one."))).toBe(true);
		expect(rendered.some(line => line.includes("Line three."))).toBe(true);
	});
});
