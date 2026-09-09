/**
 * Regression (issue #8096): a configured-but-unreachable auth broker must not
 * crash startup with a raw uncaught `AuthBrokerError` stack trace. Startup auth
 * discovery is wrapped so the failure surfaces as an actionable stderr message
 * and a clean `process.exit(1)`, mirroring the other startup error paths
 * (session resolution, model resolution, export).
 *
 * The broker deliberately replaces the local credential store when configured,
 * so an unreachable broker stays fatal — the fix is the recovery guidance, not
 * a silent fallback to local credentials.
 */
import { describe, expect, it, vi } from "bun:test";
import { AuthBrokerError } from "@oh-my-pi/pi-ai/auth-broker";
import { MissingApiKeyError } from "@oh-my-pi/pi-ai/error";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { describeAuthBrokerStartupError } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { setInteractiveHost } from "@oh-my-pi/pi-utils";

class ProcessExitSignal extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
		this.name = "ProcessExitSignal";
	}
}

describe("describeAuthBrokerStartupError", () => {
	it("turns a broker connection failure into recovery guidance", async () => {
		const message = await describeAuthBrokerStartupError(
			new AuthBrokerError("Auth broker request failed after 2 attempt(s)"),
		);
		expect(message).not.toBeNull();
		expect(message).toContain("Auth broker request failed after 2 attempt(s)");
		// Both recovery routes the reporter asked for: start it, or disable it.
		expect(message).toContain("omp auth-broker serve");
		expect(message).toContain("omp config reset auth.broker.url");
		expect(message).toContain("OMP_AUTH_BROKER_URL");
	});

	it("names the configured broker URL when it can be resolved", async () => {
		const prevUrl = process.env.OMP_AUTH_BROKER_URL;
		const prevToken = process.env.OMP_AUTH_BROKER_TOKEN;
		process.env.OMP_AUTH_BROKER_URL = "http://127.0.0.1:8765";
		process.env.OMP_AUTH_BROKER_TOKEN = "test-token";
		try {
			const message = await describeAuthBrokerStartupError(new AuthBrokerError("connection refused"));
			expect(message).toContain("http://127.0.0.1:8765");
		} finally {
			if (prevUrl === undefined) delete process.env.OMP_AUTH_BROKER_URL;
			else process.env.OMP_AUTH_BROKER_URL = prevUrl;
			if (prevToken === undefined) delete process.env.OMP_AUTH_BROKER_TOKEN;
			else process.env.OMP_AUTH_BROKER_TOKEN = prevToken;
		}
	});

	it("passes through a missing-token message unchanged", async () => {
		const err = new MissingApiKeyError(undefined, "OMP_AUTH_BROKER_URL is set but no bearer token is available.");
		expect(await describeAuthBrokerStartupError(err)).toBe(err.message);
	});

	it("returns null for unrelated errors so the caller rethrows them", async () => {
		expect(await describeAuthBrokerStartupError(new Error("boom"))).toBeNull();
		expect(await describeAuthBrokerStartupError(new TypeError("nope"))).toBeNull();
	});
});

describe("runRootCommand — unreachable auth broker at startup", () => {
	it("exits 1 with an actionable message instead of an uncaught AuthBrokerError", async () => {
		const previous = setInteractiveHost(false);
		const parsed = parseArgs([]);
		parsed.noExtensions = true;

		const exitCodes: number[] = [];
		let stderr = "";
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
			throw new ProcessExitSignal(code ?? 0);
		}) as typeof process.exit);
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderr += String(chunk);
			return true;
		});

		let thrown: unknown;
		try {
			await runRootCommand(parsed, [], {
				discoverAuthStorage: async () => {
					throw new AuthBrokerError("Auth broker request failed after 2 attempt(s)");
				},
			});
		} catch (err) {
			thrown = err;
		} finally {
			vi.restoreAllMocks();
			setInteractiveHost(previous);
		}

		expect(thrown).toBeInstanceOf(ProcessExitSignal);
		expect(exitCodes).toEqual([1]);
		expect(stderr).toContain("Auth broker request failed after 2 attempt(s)");
		expect(stderr).toContain("omp auth-broker serve");
	}, 15_000);
});
