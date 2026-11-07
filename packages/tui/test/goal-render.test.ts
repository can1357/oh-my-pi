import { beforeAll, describe, expect, it } from "bun:test";
import { TRUNCATE_LENGTHS } from "../src/render/render-utils";
import { getThemeByName, setThemeInstance, type Theme } from "../src/theme";
import { goalToolRenderer } from "../src/tools/goal";

let theme: Theme;

beforeAll(async () => {
	theme = (await getThemeByName("dark"))!;
	setThemeInstance(theme);
});

describe("goal objective update previews", () => {
	const objective = `Fix\t\x1b[31mparser\x1b[0m\x07\n${"界".repeat(TRUNCATE_LENGTHS.LONG)}`;

	it("shows the updated objective without terminal controls or overflowing narrow call rows", () => {
		const width = 42;

		const component = goalToolRenderer.renderCall(
			{ op: "update", objective },
			{ expanded: false, isPartial: true },
			theme,
		);

		const rows = component.render(width).map(row => Bun.stripANSI(row));
		const rendered = rows.join("\n");
		expect(rendered).toContain("update");
		expect(rendered).toMatch(/Fix +parser/);
		expect(rendered).not.toMatch(/[\t\x00-\x08\x0b-\x1f]/);

		for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
	});

	it("sanitizes and bounds the native objective preview after expanding tabs", () => {
		const view = goalToolRenderer.describeCall({ op: "update", objective });
		const head = view.head;

		if (!head || typeof head === "string") throw new Error("Expected styled call preview spans");
		const preview = head.at(-1)!.t;
		expect(head.map(part => part.t).join("")).toContain("update");
		expect(preview).toMatch(/Fix +parser/);
		expect(preview).not.toMatch(/[\x00-\x1f]/);
		expect(Bun.stringWidth(preview)).toBeLessThanOrEqual(TRUNCATE_LENGTHS.TITLE + 2);
		expect(preview).not.toContain("界".repeat(TRUNCATE_LENGTHS.TITLE));
	});
});
