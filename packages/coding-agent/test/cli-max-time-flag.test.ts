import { describe, expect, it, vi } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { runCli } from "../src/cli";

describe("parseArgs — --max-time flag", () => {
	it("parses --max-time seconds as maxTime", () => {
		const result = parseArgs(["--max-time", "3", "--print", "hello"]);

		expect(result.maxTime).toBe(3);
		expect(result.print).toBe(true);
		expect(result.messages).toEqual(["hello"]);
	});

	it("parses --max-time duration suffixes as seconds", () => {
		const cases = [
			{ value: "5s", expected: 5 },
			{ value: "10m", expected: 600 },
			{ value: "1h", expected: 3_600 },
		];

		for (const { value, expected } of cases) {
			const result = parseArgs(["--max-time", value, "--print", "hello"]);

			expect(result.maxTime).toBe(expected);
			expect(result.print).toBe(true);
			expect(result.messages).toEqual(["hello"]);
		}
	});

	it("throws a visible parse error for invalid --max-time values", () => {
		const invalidValues = ["5d", "0", "-1", "Infinity", "NaN"];

		for (const value of invalidValues) {
			let thrown: unknown;

			try {
				parseArgs(["--max-time", value, "--print", "hello"]);
			} catch (error) {
				thrown = error;
			}

			if (!(thrown instanceof Error)) {
				throw new Error(`--max-time ${value} did not throw a visible parse error`);
			}
			expect(thrown.message).toContain("--max-time");
		}
	});

	it("reports invalid --max-time values as CLI usage errors", async () => {
		const previousExitCode = process.exitCode;
		let observedExitCode: string | number | null | undefined;
		const captured: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		try {
			await runCli(["--max-time", "5d", "--print", "hello"]);
			observedExitCode = process.exitCode;
		} finally {
			vi.restoreAllMocks();
			process.exitCode = previousExitCode ?? 0;
		}

		const stderr = captured.join("");
		expect(observedExitCode).toBe(2);
		expect(stderr).toContain("Error: Invalid --max-time value");
		expect(stderr).toContain("Run `omp --help` for available flags.");
		expect(stderr).not.toContain("parseMaxTimeSeconds");
		expect(stderr).not.toContain("CliUsageError");
	});

	it("converts maxTime to an absolute session deadline", async () => {
		using tempDir = TempDir.createSync("@omp-max-time-");
		const authStorage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		let observedOptions: CreateAgentSessionOptions | undefined;
		const parsed = parseArgs(["--max-time", "3", "--print", "hello"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();

		const beforeRun = Date.now();
		try {
			await runRootCommand(parsed, ["--max-time", "3", "--print", "hello"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					observedOptions = options;
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") {
				throw error;
			}
		} finally {
			authStorage.close();
		}
		const afterRun = Date.now();

		expect(observedOptions?.deadline).toBeGreaterThanOrEqual(beforeRun + 3_000);
		expect(observedOptions?.deadline).toBeLessThanOrEqual(afterRun + 3_000);
	});
});
