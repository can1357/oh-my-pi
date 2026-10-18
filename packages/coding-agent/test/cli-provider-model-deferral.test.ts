import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// An id the startup catalog lacks may still come from an extension or account
// discovery, so `--provider p --model id` defers like `--model p/id` instead of
// exiting before either has run.
describe("--provider with a model the startup catalog lacks", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `pi-cli-provider-deferral-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function deferredPattern(cliArgs: string[]): Promise<string | string[] | undefined> {
		authStorage.keys.setRuntime("anthropic", "test-key");
		vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions exited with ${code}`);
		});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const options = await buildSessionOptions(
			parseArgs(cliArgs),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			Settings.isolated(),
		);
		return options.modelPattern;
	}

	test("defers the provider-qualified selector to post-extension resolution", async () => {
		expect(await deferredPattern(["--provider", "anthropic", "--model", "claude-unreleased-9"])).toBe(
			"anthropic/claude-unreleased-9",
		);
	});

	test("does not double the provider prefix", async () => {
		expect(await deferredPattern(["--provider", "anthropic", "--model", "anthropic/claude-unreleased-9"])).toBe(
			"anthropic/claude-unreleased-9",
		);
	});
});
