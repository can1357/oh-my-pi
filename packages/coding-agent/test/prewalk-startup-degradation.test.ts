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

// Regression for #6064: prewalk is an optional, off-by-default optimization.
// A missing key (or unresolvable target) for the prewalk hand-off model must
// leave prewalk unarmed with a warning, never abort startup and lock the user
// out of the app.
describe("prewalk startup degradation", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `pi-prewalk-repro-${Snowflake.next()}`);
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

	test("leaves prewalk unarmed instead of crashing when the target has no configured auth", async () => {
		const settings = Settings.isolated();
		settings.set("prewalk.enabled", true);
		settings.setModelRole("smol", "cerebras/zai-glm-4.7");
		// Force the no-auth condition: hasAuth() also consults $HOME/.env via
		// getEnvApiKey (packages/utils/src/env.ts), so a CEREBRAS_API_KEY in the
		// runner's home .env would otherwise legitimately arm prewalk and make
		// this test environment-dependent.
		vi.spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValue(false);

		const options = await buildSessionOptions(parseArgs([]), [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.prewalk).toBeUndefined();
	});

	test("arms prewalk when the target resolves and has configured auth", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");
		const settings = Settings.isolated();
		settings.set("prewalk.enabled", true);
		settings.setModelRole("smol", `${model.provider}/${model.id}`);
		authStorage.setRuntimeApiKey(model.provider, "test-key");

		const options = await buildSessionOptions(parseArgs([]), [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.prewalk?.target.provider).toBe(model.provider);
		expect(options.prewalk?.target.id).toBe(model.id);
	});

	test("does not implicitly re-arm configured prewalk while restoring a session", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");
		const settings = Settings.isolated();
		settings.set("prewalk.enabled", true);
		settings.setModelRole("smol", `${model.provider}/${model.id}`);
		authStorage.setRuntimeApiKey(model.provider, "test-key");

		for (const args of [parseArgs(["--continue"]), parseArgs(["--resume=session.jsonl"])]) {
			const options = await buildSessionOptions(args, [], SessionManager.inMemory(), modelRegistry, settings);
			expect(options.prewalk).toBeUndefined();
		}
	});

	test("honors an explicit prewalk flag while restoring a session", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");
		const settings = Settings.isolated();
		settings.setModelRole("smol", `${model.provider}/${model.id}`);
		authStorage.setRuntimeApiKey(model.provider, "test-key");

		const options = await buildSessionOptions(
			parseArgs(["--continue", "--prewalk"]),
			[],
			SessionManager.inMemory(),
			modelRegistry,
			settings,
		);

		expect(options.prewalk?.target.provider).toBe(model.provider);
		expect(options.prewalk?.target.id).toBe(model.id);
	});
});
