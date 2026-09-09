import { describe, expect, it } from "bun:test";
import { cmuxSnapshotToObservation, mapWaitUntil, serializeEval } from "@oh-my-pi/pi-coding-agent/tools/browser";

describe("cmux browser observation mapping", () => {
	it("maps refs in numeric order with viewport, scroll, url, and title", () => {
		const observation = cmuxSnapshotToObservation(
			{
				refs: {
					e2: { role: "link", name: "Home" },
					e1: { role: "button" },
					bad: { role: "ignored", name: "Ignored" },
				},
				page: { url: "https://x/", title: "X" },
			},
			{ width: 800, height: 600, deviceScaleFactor: 2 },
			{
				innerWidth: 800,
				innerHeight: 600,
				dpr: 2,
				scrollX: 10,
				scrollY: 20,
				scrollWidth: 1200,
				scrollHeight: 1800,
			},
		);

		expect(observation.url).toBe("https://x/");
		expect(observation.title).toBe("X");
		expect(observation.viewport).toEqual({ width: 800, height: 600, deviceScaleFactor: 2 });
		expect(observation.scroll).toEqual({
			x: 10,
			y: 20,
			width: 800,
			height: 600,
			scrollWidth: 1200,
			scrollHeight: 1800,
		});
		expect(observation.elements).toEqual([
			{ id: 1, role: "button", name: undefined, states: [] },
			{ id: 2, role: "link", name: "Home", states: [] },
		]);
	});

	it("prefers top-level url and title when present", () => {
		const observation = cmuxSnapshotToObservation(
			{
				url: "https://top/",
				title: "Top",
				page: { url: "https://page/", title: "Page" },
			},
			{ width: 1, height: 2, deviceScaleFactor: 1 },
			{
				innerWidth: 1,
				innerHeight: 2,
				dpr: 1,
				scrollX: 0,
				scrollY: 0,
				scrollWidth: 1,
				scrollHeight: 2,
			},
		);

		expect(observation.url).toBe("https://top/");
		expect(observation.title).toBe("Top");
	});
});

describe("cmux browser RPC helpers", () => {
	it("serializes eval strings and functions", () => {
		const makePair: (a: unknown, b: unknown) => unknown[] = (a, b) => [a, b];

		expect(serializeEval("document.title", [])).toBe("document.title");
		expect(serializeEval(makePair, [1, 2])).toBe("((a, b) => [a, b])(1,2)");
	});

	it("maps waitUntil values to cmux load states", () => {
		expect(mapWaitUntil("domcontentloaded")).toBe("interactive");
		expect(mapWaitUntil("load")).toBe("complete");
		expect(mapWaitUntil("networkidle0")).toBe("complete");
		expect(mapWaitUntil("networkidle2")).toBe("complete");
		expect(mapWaitUntil(undefined)).toBe("complete");
	});
});
