import { describe, expect, it } from "bun:test";
import { Shell } from "../native/index.js";

describe("Shell.close", () => {
	it("rejects future runs after close", async () => {
		const shell = new Shell();

		await shell.close();

		await expect(
			shell.run({
				command: "printf 'should not run'",
				cwd: process.cwd(),
			}),
		).rejects.toThrow("Shell is closed");
	});

	it("is idempotent when close is called multiple times", async () => {
		const shell = new Shell();

		await shell.close();
		await shell.close();

		const jobCount = await shell.liveBackgroundJobCount();
		expect(jobCount).toBe(0);
	});

	it("runs commands before close and rejects after close", async () => {
		const shell = new Shell();

		const result = await shell.run({
			command: "printf 'before-close'",
			cwd: process.cwd(),
		});

		expect(result.exitCode).toBe(0);

		await shell.close();

		await expect(
			shell.run({
				command: "printf 'after-close'",
				cwd: process.cwd(),
			}),
		).rejects.toThrow("Shell is closed");
	});

	it("reports zero background jobs after close", async () => {
		const shell = new Shell();

		await shell.close();

		const jobCount = await shell.liveBackgroundJobCount();
		expect(jobCount).toBe(0);
	});
});