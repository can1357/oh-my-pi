/**
 * An env-redirected built-in provider (`OLLAMA_BASE_URL`) that fails discovery
 * must reach the interactive header. Startup drains registry warnings before
 * background discovery runs, so the session itself has to pick the warning up
 * once the initial refresh settles.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("env-redirected implicit provider discovery warning", () => {
	let tempDir: string;
	let authStorage: AuthStorage | undefined;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-env-endpoint-warning-"));
		for (const key of ["OLLAMA_BASE_URL", "OLLAMA_HOST"] as const) {
			savedEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
	});

	afterEach(() => {
		authStorage?.close();
		authStorage = undefined;
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("surfaces the failure in session.configWarnings after background discovery", async () => {
		Bun.env.OLLAMA_BASE_URL = "http://ollama.typo:11434";
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.keys.setRuntime("openai", "test-openai-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), {
			fetch: async () => {
				throw new Error("EHOSTUNREACH: connect failed");
			},
		});
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		try {
			const changed = Promise.withResolvers<void>();
			session.subscribe(event => {
				if (event.type === "config_warnings_changed") changed.resolve();
			});
			// Mirrors main.ts: background discovery starts after the session is built.
			modelRegistry.refreshInBackground();
			await changed.promise;

			const warning = session.configWarnings.find(entry => entry.includes("OLLAMA_BASE_URL"));
			expect(warning).toContain("http://ollama.typo:11434");
			expect(warning).toContain("EHOSTUNREACH");
		} finally {
			await session.dispose();
		}
	});
});
