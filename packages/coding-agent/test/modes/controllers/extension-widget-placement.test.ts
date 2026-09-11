import { beforeAll, describe, expect, it } from "bun:test";
import { Container } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../src/config/settings";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import { getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Failed to load dark theme");
	setThemeInstance(dark);
});

function makeWidgetHarness() {
	const above = new Container();
	const below = new Container();
	const belowStatusline = new Container();
	const requestRender = () => {};
	const ctx = {
		hookWidgetContainerAbove: above,
		hookWidgetContainerBelow: below,
		hookWidgetContainerBelowStatusline: belowStatusline,
		ui: { requestRender },
	} as unknown as InteractiveModeContext;
	const controller = new ExtensionUiController(ctx);
	return { above, below, belowStatusline, controller };
}

function renderedText(container: Container, width = 80): string {
	return container.render(width).join("\n");
}

describe("ExtensionUiController belowStatusline widgets (issue #11100)", () => {
	it("routes belowStatusline widgets to the below-statusline container, not above the editor", () => {
		const { above, below, belowStatusline, controller } = makeWidgetHarness();
		controller.setHookWidget("status-companion", ["spend $1.23"], { placement: "belowStatusline" });
		expect(renderedText(belowStatusline)).toContain("spend $1.23");
		expect(renderedText(above)).not.toContain("spend $1.23");
		expect(renderedText(below)).not.toContain("spend $1.23");
	});

	it("keeps belowEditor and aboveEditor routing unchanged", () => {
		const { above, below, belowStatusline, controller } = makeWidgetHarness();
		controller.setHookWidget("mid", ["mid-line"], { placement: "belowEditor" });
		controller.setHookWidget("top", ["top-line"], { placement: "aboveEditor" });
		expect(renderedText(below)).toContain("mid-line");
		expect(renderedText(above)).toContain("top-line");
		expect(renderedText(belowStatusline)).not.toContain("mid-line");
		expect(renderedText(belowStatusline)).not.toContain("top-line");
	});

	it("moving a widget key across placements removes it from the old surface", () => {
		const { above, belowStatusline, controller } = makeWidgetHarness();
		controller.setHookWidget("mover", ["v1"], { placement: "aboveEditor" });
		expect(renderedText(above)).toContain("v1");
		controller.setHookWidget("mover", ["v2"], { placement: "belowStatusline" });
		expect(renderedText(above)).not.toContain("v1");
		expect(renderedText(belowStatusline)).toContain("v2");
	});

	it("clearing a belowStatusline widget empties only its own container", () => {
		const { below, belowStatusline, controller } = makeWidgetHarness();
		controller.setHookWidget("gone", ["bye"], { placement: "belowStatusline" });
		controller.setHookWidget("stays", ["hi"], { placement: "belowEditor" });
		controller.setHookWidget("gone", undefined, { placement: "belowStatusline" });
		expect(renderedText(belowStatusline)).not.toContain("bye");
		expect(renderedText(below)).toContain("hi");
	});

	it("caps string-array widget content at the shared 10-line limit", () => {
		const { belowStatusline, controller } = makeWidgetHarness();
		const lines = Array.from({ length: 12 }, (_, i) => `line-${i}`);
		controller.setHookWidget("long", lines, { placement: "belowStatusline" });
		const rendered = renderedText(belowStatusline);
		expect(rendered).toContain("line-9");
		expect(rendered).not.toContain("line-10");
		expect(rendered).toContain("widget truncated");
	});
});
