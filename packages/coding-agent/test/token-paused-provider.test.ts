import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as compatAuth from "@oh-my-pi/pi-catalog/compat/auth";
import Token from "@oh-my-pi/pi-coding-agent/commands/token";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
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

	it("allows --list to inspect retained OAuth accounts without failing on pause", async () => {
		vi.spyOn(compatAuth, "providerDisabledReason").mockImplementation(provider =>
			provider === PROVIDER ? REASON : undefined,
		);
		const stdout: string[] = [];
		const stderr: string[] = [];
		spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		const fakeAuthStorage = {
			oauth: {
				accounts: (provider: string) =>
					provider === PROVIDER
						? [
								{
									credentialId: 42,
									position: 0,
									email: "user@example.test",
								},
							]
						: [],
			},
			close: vi.fn(),
		};
		vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(fakeAuthStorage as unknown as AuthStorage);

		await new Token([PROVIDER, "--list"], TEST_CONFIG).run();

		expect(stderr.join("")).toBe("");
		expect(stdout.join("")).toContain("1. user@example.test");
		expect(process.exitCode).toBe(0);
		expect(fakeAuthStorage.close).toHaveBeenCalledTimes(1);
	});

	it("blocks --account on a paused provider before resolving a credential", async () => {
		vi.spyOn(compatAuth, "providerDisabledReason").mockImplementation(provider =>
			provider === PROVIDER ? REASON : undefined,
		);
		const stderr: string[] = [];
		spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		spyOn(process.stdout, "write").mockImplementation(() => true);
		const discoverSpy = vi.spyOn(sdkModule, "discoverAuthStorage");

		await new Token([PROVIDER, "--account", "1"], TEST_CONFIG).run();

		const output = stderr.join("");
		expect(output).toContain(`${PROVIDER} is paused: ${REASON}`);
		expect(process.exitCode).toBe(1);
		expect(discoverSpy).not.toHaveBeenCalled();
	});
});
