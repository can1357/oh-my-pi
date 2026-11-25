import { expect, test } from "bun:test";
import { JobQueue } from "../src/queue";

test("never exceeds its concurrency limit", async () => {
	const queue = new JobQueue(2);
	let active = 0;
	let peak = 0;
	const job = async () => {
		active++;
		peak = Math.max(peak, active);
		await Bun.sleep(1_000);
		active--;
	};
	await Promise.all(Array.from({ length: 6 }, () => queue.run(job)));
	expect(peak).toBe(2);
}, 10_000);
