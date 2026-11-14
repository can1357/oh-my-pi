import { describe, expect, it } from "bun:test";
import { type ForgeCliSpec, runForgeCli } from "@oh-my-pi/pi-coding-agent/utils/forge-cli";

const spec: ForgeCliSpec = {
	bin: process.execPath,
	displayName: "fixture forge",
	installMessage: "fixture runtime unavailable",
	env: { ...process.env },
	timeoutMs: 10_000,
};
const captureBytes = 8 * 1024 * 1024;

describe("forge stdout capture completeness", () => {
	it("reports truncated stdout even when the forge command succeeds", async () => {
		const result = await runForgeCli(
			spec,
			process.cwd(),
			["-e", `process.stdout.write("x".repeat(${captureBytes}) + "OMITTED_AFTER_CAP")`],
			undefined,
			false,
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdoutTruncated).toBe(true);
		expect(result.stdout).not.toContain("OMITTED_AFTER_CAP");
		expect(result.stdout).toContain("subprocess output truncated after 8 MiB");
		expect(Buffer.byteLength(result.stdout)).toBeLessThan(captureBytes + 1024);
	});

	it("keeps an exact-cap stdout capture complete", async () => {
		const result = await runForgeCli(
			spec,
			process.cwd(),
			["-e", `process.stdout.write("x".repeat(${captureBytes}))`],
			undefined,
			true,
		);

		expect(result.stdoutTruncated).not.toBe(true);
		expect(Buffer.byteLength(result.stdout)).toBe(captureBytes);
	});

	it("does not mistake literal marker text for a truncated capture", async () => {
		const marker = `[${spec.bin} subprocess output truncated after 8 MiB]`;
		const result = await runForgeCli(
			spec,
			process.cwd(),
			["-e", `process.stdout.write(${JSON.stringify(marker)})`],
			undefined,
			true,
		);

		expect(result.stdout).toBe(marker);
		expect(result.stdoutTruncated).not.toBe(true);
	});
});
