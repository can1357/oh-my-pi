import { afterEach, describe, expect, it } from "bun:test";
import { type DownloadActivity, onDownloadActivity, trackStep } from "@oh-my-pi/pi-coding-agent/downloads/activity";

describe("trackStep", () => {
	let stop: (() => void) | undefined;
	afterEach(() => stop?.());

	function record(): DownloadActivity[] {
		const activities: DownloadActivity[] = [];
		stop = onDownloadActivity(activity => activities.push(activity));
		return activities;
	}

	it("shares one row between steps begun while it is open and reports every count", () => {
		const seen = record();
		const settle = [trackStep("Indexing"), trackStep("Indexing"), trackStep("Indexing")];
		// Begun within one tick: a coalesced count would leave the row at 0/1 until a step settles.
		expect(seen.at(-1)).toMatchObject({ label: "Indexing", unit: "steps", loaded: 0, total: 3, state: "running" });

		settle[0]();
		expect(seen.at(-1)).toMatchObject({ loaded: 1, total: 3, state: "running" });
		settle[1]();
		settle[2]();

		expect(seen.at(-1)).toMatchObject({ state: "done" });
		expect(new Set(seen.map(activity => activity.id)).size).toBe(1);
	});

	it("opens a new row, without a count while it holds one step, after the previous row ended", () => {
		const seen = record();
		trackStep("Reindexing")();
		const ended = seen.at(-1);

		const settle = trackStep("Reindexing");
		const reopened = seen.at(-1);
		expect(ended).toMatchObject({ state: "done" });
		expect(reopened).toMatchObject({ unit: "steps", state: "running" });
		expect(reopened?.total).toBeUndefined();
		expect(reopened?.id).not.toBe(ended?.id);
		settle();
	});

	it.each([
		["every step", ["connection reset", "timed out"], "connection reset"],
		["some steps", [undefined, "connection reset", "timed out"], "2 of 3: connection reset"],
	])("fails the row with the first reason when %s failed", (_case, outcomes, error) => {
		const seen = record();
		const settle = outcomes.map(() => trackStep("Compiling"));
		for (const [index, failure] of outcomes.entries()) settle[index](failure);

		expect(seen.at(-1)).toMatchObject({ state: "failed", error });
	});
});
