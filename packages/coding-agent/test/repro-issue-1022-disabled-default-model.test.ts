import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/**
 * Issue #1022: when path-scoped `enabledModels`/`disabledProviders` are
 * configured, the default-model fallback ignores the path-scoped allow-list and
 * picks any provider with stored credentials. In the user's report a Haiku
 * model (anthropic) is selected even though the path enables only
 * `openai-codex`.
 */

function emptyWorkspaceTree(cwd: string) {
	return { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] };
}

describe("issue #1022 — path-scoped enabledModels respected by default fallback", () => {
	let testDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		resetSettingsForTest();
		testDir = path.join(os.tmpdir(), `pi-issue-1022-${Snowflake.next()}`);
		agentDir = path.join(testDir, "agent");
		cwd = path.join(testDir, "private", "sub");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		resetSettingsForTest();
		if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
	});

	test("does not pick a disallowed provider when enabledModels excludes it", async () => {
		const privatePath = path.join(testDir, "private");
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				enabledModels: [{ path: privatePath, models: ["openai-codex"] }],
				disabledProviders: [{ path: privatePath, providers: ["github-copilot"] }],
				modelRoles: { default: "github-copilot/gpt-5.5" },
			}),
		);

		const settings = await Settings.init({ cwd, agentDir });
		// Sanity-check the path-scoped values resolved correctly for this cwd.
		expect(settings.get("enabledModels")).toEqual(["openai-codex"]);
		expect(settings.get("disabledProviders")).toEqual(["github-copilot"]);

		const authStorage = await AuthStorage.create(":memory:");
		// Only anthropic has credentials. Per `enabledModels` the path allows
		// only openai-codex, so no anthropic model should be selected.
		authStorage.setRuntimeApiKey("anthropic", "test-anthropic-key");

		const modelRegistry = new ModelRegistry(authStorage, path.join(testDir, "models.yml"));

		try {
			const { session, modelFallbackMessage } = await createAgentSession({
				cwd,
				agentDir,
				authStorage,
				modelRegistry,
				settings,
				sessionManager: SessionManager.inMemory(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				workspaceTree: emptyWorkspaceTree(cwd),
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});

			try {
				// Bug: omp falls back to anthropic Haiku here, ignoring the
				// path-scoped enabledModels allow-list.
				expect(session.model?.provider).not.toBe("anthropic");
				expect(session.model?.provider).not.toBe("github-copilot");
				// No openai-codex creds set → nothing in the allow-list is
				// usable. Expect no model and a fallback message.
				expect(session.model).toBeUndefined();
				expect(modelFallbackMessage).toBeDefined();
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
		}
	});
});
