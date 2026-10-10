import { beforeAll, describe, expect, it } from "bun:test";
import { HookSelectorComponent, type HookSelectorOptions } from "@oh-my-pi/pi-tui/overlays/hook-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Failed to load dark theme for tests");
	setThemeInstance(theme);
});

function select(keys: string[], options: HookSelectorOptions) {
	const picked: string[] = [];
	const component = new HookSelectorComponent(
		"Update omp?",
		["Yes", "No"],
		option => picked.push(option),
		() => {},
		options,
	);
	for (const key of keys) component.handleInput(key);
	return picked;
}

describe("HookSelectorComponent hotkeys", () => {
	const hotkeys = { y: "Yes", n: "No" };

	it("selects the mapped option on one case-insensitive keypress", () => {
		expect(select(["y"], { hotkeys })).toEqual(["Yes"]);
		expect(select(["N"], { hotkeys })).toEqual(["No"]);
	});

	it("leaves enter on the highlighted row and unmapped keys inert", () => {
		expect(select(["q", "\r"], { hotkeys })).toEqual(["Yes"]);
	});

	it("ignores a hotkey whose option is disabled", () => {
		expect(select(["y"], { hotkeys, disabledIndices: [0] })).toEqual([]);
	});

	it("does nothing for y without hotkeys configured", () => {
		expect(select(["y"], {})).toEqual([]);
	});
});
