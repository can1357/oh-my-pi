import { afterEach, describe, expect, test, vi } from "bun:test";
import { OUTPUT_ACTIVE_LEVEL, OUTPUT_RELEASE_MS, OutputActivity } from "../../src/live/output-activity";

afterEach(() => {
	vi.useRealTimers();
});

describe("OutputActivity", () => {
	// Regression for #17114: the live phase flipped speaking/listening on every pause between words.
	test("stays active across pauses shorter than the release hold and releases once after it", () => {
		vi.useFakeTimers();
		const onRelease = vi.fn();
		const activity = new OutputActivity(onRelease);
		const loud = OUTPUT_ACTIVE_LEVEL * 4;

		activity.observe(OUTPUT_ACTIVE_LEVEL);
		expect(activity.active).toBe(false);

		activity.observe(loud);
		vi.advanceTimersByTime(OUTPUT_RELEASE_MS - 50);
		activity.observe(0);
		expect(activity.active).toBe(true);
		activity.observe(loud);
		vi.advanceTimersByTime(OUTPUT_RELEASE_MS - 1);
		expect(activity.active).toBe(true);
		expect(onRelease).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(activity.active).toBe(false);
		expect(onRelease).toHaveBeenCalledTimes(1);
	});
});
