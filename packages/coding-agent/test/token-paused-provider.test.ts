import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as compatAuth from "@oh-my-pi/pi-catalog/compat/auth";
import Token from "@oh-my-pi/pi-coding-agent/commands/token";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

const TEST_CONFIG: CliConfig = { bin: "omp", version: "test", commands: new Map() };
const PROVIDER = "paused-provider";
const REASON = "paused for testing";

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

describe("`omp token` against a paused provider", () => {
	it("prints the auth rule's reason, exits 1, and never surfaces a stack trace", async () => {
		vi.spyOn(compatAuth, "providerDisabledReason").mockImplementation(provider =>
			provider === PROVIDER ? REASON : undefined,
		);
		const stderr: string[] = [];
		spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		spyOn(process.stdout, "write").mockImplementation(() => true);

		await new Token([PROVIDER], TEST_CONFIG).run();

		const output = stderr.join("");
		expect(output).toContain(`${PROVIDER} is paused: ${REASON}`);
		expect(output).not.toContain("ProviderDisabledError");
		expect(output).not.toMatch(/\n\s+at\s/);
		expect(process.exitCode).toBe(1);
	});
});
