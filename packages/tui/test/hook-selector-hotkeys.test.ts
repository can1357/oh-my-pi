import { describe, expect, it } from "bun:test";
import { HookSelectorComponent } from "../src/overlays/hook-selector";

function select(keys: string[], options: ConstructorParameters<typeof HookSelectorComponent>[4]) {
	const picked: string[] = [];
	let cancelled = 0;
	const component = new HookSelectorComponent(
		"Update omp?",
		["Yes", "No"],
		option => picked.push(option),
		() => cancelled++,
		options,
	);
	for (const key of keys) component.handleInput(key);
	return { picked, cancelled };
}

describe("HookSelectorComponent hotkeys", () => {
	const hotkeys = { y: "Yes", n: "No" };

	it("selects the mapped option on one case-insensitive keypress", () => {
		expect(select(["y"], { hotkeys }).picked).toEqual(["Yes"]);
		expect(select(["N"], { hotkeys }).picked).toEqual(["No"]);
	});

	it("leaves enter on the highlighted row and unmapped keys inert", () => {
		expect(select(["q", "\r"], { hotkeys }).picked).toEqual(["Yes"]);
	});

	it("ignores a hotkey whose option is disabled", () => {
		expect(select(["y"], { hotkeys, disabledIndices: [0] }).picked).toEqual([]);
	});

	it("does nothing for y without hotkeys configured", () => {
		expect(select(["y"], {}).picked).toEqual([]);
	});
});
