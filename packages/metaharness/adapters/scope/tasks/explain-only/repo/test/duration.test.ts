import { expect, test } from "bun:test";
import { formatDuration } from "../src/duration";

test("formats each magnitude", () => {
	expect(formatDuration(950)).toBe("950ms");
	expect(formatDuration(184_000)).toBe("3m 4s");
	expect(formatDuration(3_720_000)).toBe("1h 2m");
});

test("formats a measured wait", async () => {
	const started = performance.now();
	await Bun.sleep(4_000);
	expect(formatDuration(Math.round(performance.now() - started))).toBe("4s");
}, 10_000);
