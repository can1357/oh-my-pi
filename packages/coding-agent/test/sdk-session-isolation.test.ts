import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@pk-nerdsaver-ai/pi-ai";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import type { Rule } from "@pk-nerdsaver-ai/pi-coding-agent/capability/rule";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { createAgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import { SecretObfuscator } from "@pk-nerdsaver-ai/pi-coding-agent/secrets";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { getSessionsDir, removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";

function createTtsrRule(name: string): Rule {
	return {
		name,
		path: `/tmp/${name}.md`,
		content: "Avoid forbidden output",
		condition: ["forbidden"],
		scope: ["text"],
		_source: {
			provider: "test",
			providerName: "test",
			path: `/tmp/${name}.md`,
			level: "project",
		},
	};
}

const SECRET_ENV_PATTERNS = /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(?:_|$)/i;

async function withClearedSecretEnv<T>(run: () => Promise<T>): Promise<T> {
	const removed: Array<[string, string]> = [];
	for (const [name, value] of Object.entries(process.env)) {
		if (!value || value.length < 8) continue;
		if (!SECRET_ENV_PATTERNS.test(name)) continue;
		removed.push([name, value]);
		delete process.env[name];
	}
	try {
		return await run();
	} finally {
		for (const [name, value] of removed) {
			process.env[name] = value;
		}
	}
}

function getAssistantText(message: AssistantMessage | undefined): string {
	if (!message) throw new Error("Expected assistant message");
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join(" ");
}

describe("createAgentSession session storage isolation", () => {
	const tempDirs: string[] = [];
	// One shared, fully-populated (bundled models load synchronously in the
	// constructor) registry for every case. Passing it via options skips the
	// per-call discoverAuthStorage() SQLite open and the refreshInBackground()
	// network model probe inside createAgentSession — the two real wall-clock
	// sinks here. None of these cases assert on model discovery, so an
	// ambient-credential-free in-memory auth store keeps them deterministic.
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedAuthStorage = await AuthStorage.create(":memory:");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage);
	});

	afterAll(() => {
		sharedAuthStorage.close();
	});

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("uses the provided agentDir for the default persistent session root", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-session-isolation-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			const sessionFile = session.sessionFile;
			if (!sessionFile) {
				throw new Error("Expected session file path");
			}

			expect(sessionFile.startsWith(path.join(agentDir, "sessions"))).toBe(true);
			expect(sessionFile.startsWith(getSessionsDir())).toBe(false);
		} finally {
			await session.dispose();
		}
	});
	it("wires the discovered TTSR manager into the created session", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-ttsr-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		const rule = createTtsrRule("sdk-ttsr-rule");
		fs.mkdirSync(cwd, { recursive: true });

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			rules: [rule],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			expect(session.ttsrManager).toBeDefined();
			expect(session.ttsrManager?.checkDelta("forbidden", { source: "text" }).map(match => match.name)).toEqual([
				rule.name,
			]);
		} finally {
			await session.dispose();
		}
	});
	it("loads obfuscator only when secrets exist", async () => {
		await withClearedSecretEnv(async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-secrets-${Snowflake.next()}-`));
			tempDirs.push(tempDir);
			const cwd = path.join(tempDir, "project");
			const agentDir = path.join(tempDir, "agent");
			fs.mkdirSync(cwd, { recursive: true });

			const commonOptions = {
				cwd,
				agentDir,
				modelRegistry: sharedModelRegistry,
				settings: Settings.isolated({ "secrets.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			};

			const withoutSecrets = await createAgentSession(commonOptions);
			try {
				expect(withoutSecrets.session.obfuscator?.hasSecrets()).toBeFalsy();
			} finally {
				await withoutSecrets.session.dispose();
			}

			fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".omp", "secrets.yml"), "- type: plain\n  content: sdk-secret-token-123456\n");

			const withSecrets = await createAgentSession(commonOptions);
			try {
				expect(withSecrets.session.obfuscator?.hasSecrets()).toBe(true);
			} finally {
				await withSecrets.session.dispose();
			}
		});
	});

	it("keeps restored assistant messages deobfuscated across reloads", async () => {
		await withClearedSecretEnv(async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-session-secrets-${Snowflake.next()}-`));
			tempDirs.push(tempDir);
			const cwd = path.join(tempDir, "project");
			const agentDir = path.join(tempDir, "agent");
			fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".omp", "secrets.yml"), "- type: plain\n  content: sdk-secret-token-123456\n");

			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected anthropic model");

			const obfuscator = new SecretObfuscator([{ type: "plain", content: "sdk-secret-token-123456" }]);
			const initialManager = SessionManager.create(cwd, path.join(agentDir, "sessions"));
			initialManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: obfuscator.obfuscate("token sdk-secret-token-123456") }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			await initialManager.flush();
			const sessionFile = initialManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session file");
			await initialManager.close();

			const resumedManager = await SessionManager.open(sessionFile, path.dirname(sessionFile));
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				modelRegistry: sharedModelRegistry,
				sessionManager: resumedManager,
				model,
				settings: Settings.isolated({ "secrets.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			try {
				expect(getAssistantText(session.messages.at(-1) as AssistantMessage | undefined)).toContain(
					"sdk-secret-token-123456",
				);
				await session.reload();
				expect(getAssistantText(session.messages.at(-1) as AssistantMessage | undefined)).toContain(
					"sdk-secret-token-123456",
				);
			} finally {
				await session.dispose();
			}
		});
	});
});
