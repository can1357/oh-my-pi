import { describe, expect, it } from "bun:test";
import { OrderedPastes } from "@oh-my-pi/pi-tui/prompt/ordered-pastes";

function queue() {
	const delivered: string[] = [];
	let runs = 0;
	const pastes = new OrderedPastes({
		deliver: text => delivered.push(text),
		run: () => runs++,
		live: () => true,
	});
	return { pastes, delivered, runs: () => runs };
}

describe("OrderedPastes", () => {
	it("refuses a late completion after clear without delivering or running the held action", () => {
		const { pastes, delivered, runs } = queue();
		const settle = pastes.begin();
		expect(pastes.holdAction()).toBe(true);
		pastes.clear();
		expect(settle("late")).toBe(false);
		expect(delivered).toEqual([]);
		expect(runs()).toBe(0);
	});

	it("delivers completions and later pastes in reservation order and runs the held action once after the last", () => {
		const { pastes, delivered, runs } = queue();
		const first = pastes.begin();
		const second = pastes.begin();
		pastes.paste("C");
		pastes.holdAction();
		second("B");
		expect(delivered).toEqual([]);
		first("A");
		expect(delivered).toEqual(["A", "B", "C"]);
		expect(runs()).toBe(1);
	});
});
