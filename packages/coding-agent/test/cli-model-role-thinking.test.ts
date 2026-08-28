import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Regression: `--model` used to record the `default` role without its effort,
// so cycling back into that role with ctrl+p ran at the previous role's effort.
describe("--model role override thinking suffix", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `pi-cli-role-thinking-${Snowflake.next()}`);
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

	async function overriddenDefaultRole(cliArgs: string[]): Promise<string | undefined> {
		const model = getBundledModel("anthropic", "claude-opus-4-5");
		if (!model) throw new Error("expected claude-opus-4-5 to be bundled");
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const settings = Settings.isolated();
		settings.setModelRole("default", `${model.provider}/${model.id}:high`);
		// Guards the test run: a resolution failure would exit the process.
		vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
			throw new Error(`buildSessionOptions unexpectedly exited with ${code}`);
		});

		await buildSessionOptions(parseArgs(cliArgs), [], SessionManager.inMemory(), modelRegistry, settings);

		return settings.getModelRole("default");
	}

	test("keeps the requested effort on the default role", async () => {
		expect(await overriddenDefaultRole(["--model", "anthropic/claude-opus-4-5:low"])).toBe(
			"anthropic/claude-opus-4-5:low",
		);
	});

	test("leaves the role effort unselected when the flag carries no suffix", async () => {
		expect(await overriddenDefaultRole(["--model", "anthropic/claude-opus-4-5"])).toBe("anthropic/claude-opus-4-5");
	});

	test("records the explicit --thinking effort over the --model suffix", async () => {
		expect(await overriddenDefaultRole(["--model", "anthropic/claude-opus-4-5:low", "--thinking", "high"])).toBe(
			"anthropic/claude-opus-4-5:high",
		);
	});

	test("records --thinking on the default role when --model carries no suffix", async () => {
		// The only case where the flag supplies the effort and the suffix does not.
		expect(await overriddenDefaultRole(["--model", "anthropic/claude-opus-4-5", "--thinking", "high"])).toBe(
			"anthropic/claude-opus-4-5:high",
		);
	});
});
