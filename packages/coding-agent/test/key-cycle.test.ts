import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import KeyCycle from "@oh-my-pi/pi-coding-agent/commands/key-cycle";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

const TEST_CONFIG: CliConfig = {
	bin: "omp",
	version: "0.0.0-test",
	commands: new Map(),
};

describe("key-cycle command", () => {
	let tempDir = "";
	let authStorage: AuthStorage;
	let stdout = "";
	let stderr = "";
	let savedExitCode: typeof process.exitCode;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-key-cycle-test-"));
		fs.writeFileSync(
			path.join(tempDir, "models.yml"),
			[
				"providers:",
				"  custom-proxy:",
				"    baseUrl: https://custom-proxy.example.com/v1",
				"    api: openai-completions",
				"    apiKey:",
				"      - sk-first-AAA",
				"      - sk-second-BBB",
				"      - sk-third-CCC",
				"    models:",
				"      - id: custom-model",
				"        name: Custom Model",
				"",
			].join("\n"),
		);
		setAgentDir(tempDir);
		authStorage = await AuthStorage.create(":memory:");
		vi.spyOn(sdk, "discoverAuthStorage").mockResolvedValue(authStorage);
		stdout = "";
		stderr = "";
		vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			...rest: unknown[]
		) => {
			stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			const done = rest.find(argument => typeof argument === "function");
			if (typeof done === "function") (done as (error?: Error | null) => void)(null);
			return true;
		}) as typeof process.stdout.write);
		vi.spyOn(process.stderr, "write").mockImplementation(((
			chunk: string | Uint8Array,
			...rest: unknown[]
		) => {
			stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			const done = rest.find(argument => typeof argument === "function");
			if (typeof done === "function") (done as (error?: Error | null) => void)(null);
			return true;
		}) as typeof process.stderr.write);
		savedExitCode = process.exitCode;
		process.exitCode = undefined;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage.close();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		process.exitCode = savedExitCode;
		if (!tempDir || !fs.existsSync(tempDir)) return;
		try {
			removeSyncWithRetries(tempDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
		}
	});

	test("user can cycle a provider key from the CLI and sees the active key position without the secret", async () => {
		const cycleSpy = vi.spyOn(ModelRegistry.prototype, "cycleProviderApiKey");
		await new KeyCycle(["CUSTOM-PROXY"], TEST_CONFIG).run();
		expect(cycleSpy).toHaveBeenCalledWith("custom-proxy");
		const clean = Bun.stripANSI(stdout);
		expect(clean).toContain("key 2/3");
		expect(stdout).not.toContain("sk-first-AAA");
		expect(stdout).not.toContain("sk-second-BBB");
		expect(stdout).not.toContain("sk-third-CCC");
		expect(stderr).toBe("");
		expect(process.exitCode).not.toBe(1);
	});
});
