import { beforeAll, describe, expect, it } from "bun:test";
import { ShowImagesSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/show-images-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SgrMouseEvent } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme();
});

function leftClick(line: number): SgrMouseEvent {
	return { button: 0, col: 0, row: line, release: false, wheel: null, motion: false, leftClick: true };
}

/**
 * The wrapper mounts a single-line top DynamicBorder before its SelectList, so
 * routed component-local lines are offset by one. Regression guard for the
 * off-by-one that would let a top-border click select the first row.
 */
describe("ShowImagesSelectorComponent.routeMouse offset", () => {
	it("ignores a click on the top border row (line 0)", () => {
		let selected: boolean | undefined;
		const component = new ShowImagesSelectorComponent(
			true,
			value => {
				selected = value;
			},
			() => {},
		);
		component.render(80);

		component.routeMouse(leftClick(0), 0, 0);

		expect(selected).toBeUndefined();
	});

	it("selects the first item when the row below the border is clicked (line 1)", () => {
		let selected: boolean | undefined;
		const component = new ShowImagesSelectorComponent(
			true,
			value => {
				selected = value;
			},
			() => {},
		);
		component.render(80);

		component.routeMouse(leftClick(1), 1, 0);

		// First SelectList row is "Yes" → true.
		expect(selected).toBe(true);
	});
});
