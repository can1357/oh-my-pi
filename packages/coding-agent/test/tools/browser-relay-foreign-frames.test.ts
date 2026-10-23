import { afterEach, describe, expect, it } from "bun:test";
import { pastForeignFrames } from "../../../browser-relay/extension/foreign-frames";
import { rejectionOf } from "../helpers/rejection";

const REFUSAL = new Error("Cannot access a chrome-extension:// URL of different extension");

/**
 * Install a `chrome` global whose `scripting.executeScript` reports `emptied` frames changed, or throws when the
 * page cannot be scripted (`null`); returns the sweeps it ran. The real sweep runs in Chrome in
 * `browser-relay-tab-isolation.test.ts`.
 */
function sweepsEmptying(emptied: number | null): number[] {
	const sweeps: number[] = [];
	Reflect.set(globalThis, "chrome", {
		runtime: { id: "selfextensionid" },
		scripting: {
			executeScript: async (injection: { target: { tabId: number } }) => {
				sweeps.push(injection.target.tabId);
				if (emptied === null) throw new Error("Cannot access contents of the page");
				return [{ frameId: 0, result: emptied }];
			},
		},
	});
	return sweeps;
}

describe("pastForeignFrames", () => {
	const saved = Reflect.get(globalThis, "chrome");
	afterEach(() => {
		Reflect.set(globalThis, "chrome", saved);
	});

	it("shares one sweep among the commands of a refused burst, then retries each", async () => {
		const sweeps = sweepsEmptying(1);
		const refusedOnce = () => {
			let attempts = 0;
			return async () => {
				if (attempts++ === 0) throw REFUSAL;
				return attempts;
			};
		};
		expect(await Promise.all([pastForeignFrames(1, refusedOnce()), pastForeignFrames(1, refusedOnce())])).toEqual([
			2, 2,
		]);
		expect(sweeps).toEqual([1]);
	});

	it("rethrows Chrome's refusal when the tab has no foreign frame to empty", async () => {
		const sweeps = sweepsEmptying(0);
		let attempts = 0;
		const failure = await rejectionOf(
			pastForeignFrames(1, async () => {
				attempts++;
				throw REFUSAL;
			}),
		);
		expect(failure).toBe(REFUSAL);
		expect(attempts).toBe(1);
		expect(sweeps).toEqual([1]);
	});

	it("rethrows the refusal when the page cannot be scripted", async () => {
		sweepsEmptying(null);
		expect(await rejectionOf(pastForeignFrames(1, () => Promise.reject(REFUSAL)))).toBe(REFUSAL);
	});

	it("never sweeps for other errors", async () => {
		const sweeps = sweepsEmptying(1);
		const other = new Error("No tab with given id 1.");
		expect(await rejectionOf(pastForeignFrames(1, () => Promise.reject(other)))).toBe(other);
		expect(sweeps).toEqual([]);
	});
});
