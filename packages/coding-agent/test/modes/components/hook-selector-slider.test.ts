import { beforeAll, describe, expect, it } from "bun:test";
import {
	HookSelectorComponent,
	type HookSelectorSlider,
} from "@oh-my-pi/pi-coding-agent/modes/components/hook-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const KITTY_H = "\x1b[104;1u";
const KITTY_J = "\x1b[106;1u";
const KITTY_K = "\x1b[107;1u";
const KITTY_L = "\x1b[108;1u";

beforeAll(async () => {
	await initTheme();
});

interface Harness {
	component: HookSelectorComponent;
	changes: number[];
	selected: string[];
	cancelled: number;
	render(): string;
}

function makeHarness(slider?: HookSelectorSlider, opts?: { onLeft?: () => void; onRight?: () => void }): Harness {
	const changes: number[] = [];
	const selected: string[] = [];
	let cancelled = 0;
	if (slider) slider.onChange = index => changes.push(index);
	const component = new HookSelectorComponent(
		"Plan mode - next step",
		["Approve and execute", "Refine plan"],
		option => selected.push(option),
		() => {
			cancelled++;
		},
		{ slider, onLeft: opts?.onLeft, onRight: opts?.onRight },
	);
	return {
		component,
		changes,
		selected,
		get cancelled() {
			return cancelled;
		},
		render: () =>
			component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n"),
	};
}

function modelSlider(index: number): HookSelectorSlider {
	return {
		caption: "continue with",
		index,
		segments: [
			{ label: "smol", detail: "gpt-5-mini" },
			{ label: "default", detail: "claude-sonnet" },
			{ label: "slow", detail: "claude-opus" },
		],
	};
}

describe("HookSelectorComponent model slider", () => {
	it("renders every tier label plus the active tier's resolved model name", () => {
		const h = makeHarness(modelSlider(1));
		const text = h.render();
		expect(text).toContain("smol");
		expect(text).toContain("default");
		expect(text).toContain("slow");
		// Only the active tier's detail is shown beneath the track.
		expect(text).toContain("claude-sonnet");
		expect(text).not.toContain("gpt-5-mini");
		expect(text).not.toContain("claude-opus");
	});

	it("advances on right arrow, updating selection and the displayed model name", () => {
		const h = makeHarness(modelSlider(1));
		h.component.handleInput(RIGHT);
		expect(h.changes).toEqual([2]);
		const text = h.render();
		expect(text).toContain("claude-opus");
		expect(text).not.toContain("claude-sonnet");
	});

	it("moves left and right from any list position without selecting an option", () => {
		const h = makeHarness(modelSlider(2));
		h.component.handleInput(LEFT); // 2 -> 1
		h.component.handleInput(LEFT); // 1 -> 0
		expect(h.changes).toEqual([1, 0]);
		expect(h.render()).toContain("gpt-5-mini");
		// The slider never triggers option selection or cancellation.
		expect(h.selected).toEqual([]);
		expect(h.cancelled).toBe(0);
	});

	it("supports vim navigation encoded with the Kitty keyboard protocol", () => {
		const down = makeHarness();
		down.component.handleInput(KITTY_J);
		down.component.handleInput("\n");
		expect(down.selected).toEqual(["Refine plan"]);

		const up = makeHarness();
		up.component.handleInput("\x1b[B");
		up.component.handleInput(KITTY_K);
		up.component.handleInput("\n");
		expect(up.selected).toEqual(["Approve and execute"]);

		const left = makeHarness(modelSlider(1));
		left.component.handleInput(KITTY_H);
		expect(left.changes).toEqual([0]);

		const right = makeHarness(modelSlider(1));
		right.component.handleInput(KITTY_L);
		expect(right.changes).toEqual([2]);
	});

	it("clamps at both edges and only fires onChange on real movement", () => {
		const h = makeHarness(modelSlider(0));
		h.component.handleInput(LEFT); // already at first segment -> no-op
		expect(h.changes).toEqual([]);
		h.component.handleInput(RIGHT); // 0 -> 1
		h.component.handleInput(RIGHT); // 1 -> 2
		h.component.handleInput(RIGHT); // already last -> no-op
		expect(h.changes).toEqual([1, 2]);
	});

	it("clamps a constructor index beyond the segment range", () => {
		const h = makeHarness(modelSlider(99));
		// Active segment is the last one; right is a no-op, left advances toward 1.
		h.component.handleInput(RIGHT);
		expect(h.changes).toEqual([]);
		h.component.handleInput(LEFT);
		expect(h.changes).toEqual([1]);
	});

	it("falls back to onLeft/onRight navigation when no slider is configured", () => {
		let left = 0;
		let right = 0;
		const h = makeHarness(undefined, {
			onLeft: () => {
				left++;
			},
			onRight: () => {
				right++;
			},
		});
		h.component.handleInput(LEFT);
		h.component.handleInput(RIGHT);
		expect([left, right]).toEqual([1, 1]);
	});

	it("fuzzy-filters overflowing option lists from typed input", () => {
		const selected: string[] = [];
		const component = new HookSelectorComponent(
			"Choose provider",
			["Ollama", "Kagi", "OpenCode Go", "Tavily"],
			option => selected.push(option),
			() => {},
			{ maxVisible: 3 },
		);

		component.handleInput("o");
		component.handleInput("g");
		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");

		expect(rendered).toContain("OpenCode Go");
		expect(rendered).not.toContain("Ollama");
		expect(rendered).toContain("Search: og");

		component.handleInput("\n");
		expect(selected).toEqual(["OpenCode Go"]);
	});
});
