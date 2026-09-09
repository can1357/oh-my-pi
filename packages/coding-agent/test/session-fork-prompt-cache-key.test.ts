import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { type Args, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { ScopedModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const OPENAI_TEST_MODEL = getBundledModel("openai", "gpt-4o-mini");

interface ArgsWithPromptCacheKey extends Args {
	providerPromptCacheKey?: string;
}

interface SourceSessionFixture {
	cwd: string;
	sourceFile: string;
	sourceHeader: SessionHeader;
	forkSessionDir: string;
}

async function createSourceSessionFixture(tempDir: TempDir, parentId: string): Promise<SourceSessionFixture> {
	const cwd = tempDir.join("project");
	const sourceDir = tempDir.join("source-sessions");
	const forkSessionDir = tempDir.join("forked-sessions");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(sourceDir, { recursive: true });
	await fs.mkdir(forkSessionDir, { recursive: true });
	const sourceFile = path.join(sourceDir, `${parentId}.jsonl`);
	const sourceHeader: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: parentId,
		timestamp: new Date().toISOString(),
		cwd,
	};
	await Bun.write(sourceFile, `${JSON.stringify(sourceHeader)}\n`);
	return { cwd, sourceFile, sourceHeader, forkSessionDir };
}

async function createMinimalSession(
	tempDir: TempDir,
	options: CreateAgentSessionOptions,
): Promise<{ session: AgentSession; authStorage: AuthStorage }> {
	const authStorage = await AuthStorage.create(tempDir.join("sdk-auth.db"));
	authStorage.setRuntimeApiKey("openai", "test-key");
	const shouldSupplyModel = options.sessionManager?.getHeader()?.parentSession === undefined;
	const result = await createAgentSession({
		...options,
		cwd: options.cwd ?? tempDir.path(),
		agentDir: tempDir.path(),
		authStorage,
		modelRegistry: undefined,
		model: shouldSupplyModel ? (options.model ?? OPENAI_TEST_MODEL) : options.model,
		settings: Settings.isolated({
			"async.enabled": false,
			"marketplace.autoUpdate": "off",
		}),
		disableExtensionDiscovery: true,
		preloadedExtensions: undefined,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: {
			rootPath: options.cwd ?? tempDir.path(),
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		enableMCP: false,
		enableLsp: false,
		...(options.toolNames !== undefined ? { toolNames: options.toolNames } : {}),
	});
	return { session: result.session, authStorage };
}

describe("provider prompt-cache key session affinity", () => {
	it("parses --prompt-cache-key without folding it into provider session id or prompt text", () => {
		const parsed = parseArgs([
			"--provider-session-id",
			"provider-lineage",
			"--prompt-cache-key",
			"cache-affinity",
			"hello",
		]);
		const promptCacheArgs: ArgsWithPromptCacheKey = parsed;

		expect(parsed.providerSessionId).toBe("provider-lineage");
		expect(promptCacheArgs.providerPromptCacheKey).toBe("cache-affinity");
		expect(parsed.messages).toEqual(["hello"]);
		expect(parsed.unrecognizedFlags).toEqual([]);
	});

	it("creates an agent whose prompt-cache key can differ from provider request lineage", async () => {
		using tempDir = TempDir.createSync("@omp-prompt-cache-sdk-");
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		try {
			const created = await createMinimalSession(tempDir, {
				providerSessionId: "provider-lineage",
				providerPromptCacheKey: "cache-affinity",
				sessionManager: SessionManager.inMemory(tempDir.path()),
			});
			session = created.session;
			authStorage = created.authStorage;

			expect(session.agent.sessionId).toBe("provider-lineage");
			expect(session.agent.promptCacheKey).toBe("cache-affinity");
			expect(session.agent.promptCacheKey).not.toBe(session.agent.sessionId);
		} finally {
			await session?.dispose();
			authStorage?.close();
		}
	});

	it("initializes a full fork with child request lineage and parent prompt-cache affinity", async () => {
		using tempDir = TempDir.createSync("@omp-prompt-cache-fork-");
		const source = await createSourceSessionFixture(tempDir, "parent-cache-session");
		const forkedManager = await SessionManager.forkFrom(source.sourceFile, source.cwd, source.forkSessionDir);
		let session: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		try {
			const created = await createMinimalSession(tempDir, {
				cwd: source.cwd,
				sessionManager: forkedManager,
			});
			session = created.session;
			authStorage = created.authStorage;
			const childSessionId = forkedManager.getSessionId();

			expect(forkedManager.getHeader()?.parentSession).toBe(source.sourceHeader.id);
			expect(childSessionId).toBeString();
			expect(childSessionId).not.toBe(source.sourceHeader.id);
			expect(session.agent.sessionId).toBe(childSessionId);
			expect(session.agent.promptCacheKey).toBe(source.sourceHeader.id);
			expect(session.agent.promptCacheKey).not.toBe(session.agent.sessionId);
		} finally {
			await session?.dispose();
			authStorage?.close();
		}
	});

	it("does not auto-inherit parent prompt-cache affinity when fork startup changes request-shaping inputs", async () => {
		const cases: Array<{ name: string; options: CreateAgentSessionOptions }> = [
			{
				name: "model",
				options: { model: OPENAI_TEST_MODEL },
			},
			{
				name: "thinking",
				options: { thinkingLevel: ThinkingLevel.High },
			},
			{
				name: "system",
				options: { customSystemPrompt: "Use a different provider prompt." },
			},
			{
				name: "tools",
				options: { toolNames: ["read"] },
			},
		];

		for (const entry of cases) {
			using tempDir = TempDir.createSync(`@omp-prompt-cache-fork-${entry.name}-`);
			const source = await createSourceSessionFixture(tempDir, `parent-cache-session-${entry.name}`);
			const forkedManager = await SessionManager.forkFrom(source.sourceFile, source.cwd, source.forkSessionDir);
			let session: AgentSession | undefined;
			let authStorage: AuthStorage | undefined;
			try {
				const created = await createMinimalSession(tempDir, {
					...entry.options,
					cwd: source.cwd,
					sessionManager: forkedManager,
				});
				session = created.session;
				authStorage = created.authStorage;

				expect(forkedManager.getHeader()?.parentSession).toBe(source.sourceHeader.id);
				expect(session.agent.promptCacheKey, entry.name).toBeUndefined();
			} finally {
				await session?.dispose();
				authStorage?.close();
			}
		}
	});

	it("does not pre-pin parent prompt-cache affinity when a scoped model selects the startup route", async () => {
		using tempDir = TempDir.createSync("@omp-prompt-cache-scoped-model-");
		const source = await createSourceSessionFixture(tempDir, "parent-cache-session-scoped");
		const forkedManager = await SessionManager.forkFrom(source.sourceFile, source.cwd, source.forkSessionDir);
		const authStorage = await AuthStorage.create(tempDir.join("scoped-auth.db"));
		authStorage.setRuntimeApiKey(OPENAI_TEST_MODEL.provider, "test-key");
		try {
			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
			const parsed = parseArgs([
				"--cwd",
				source.cwd,
				"--models",
				`${OPENAI_TEST_MODEL.provider}/${OPENAI_TEST_MODEL.id}`,
			]);
			const scopedModels: ScopedModel[] = [
				{
					model: OPENAI_TEST_MODEL,
					explicitThinkingLevel: false,
				},
			];

			const options = await buildSessionOptions(
				parsed,
				scopedModels,
				forkedManager,
				modelRegistry,
				Settings.isolated({ "marketplace.autoUpdate": "off" }),
			);

			expect(options.model).toBe(OPENAI_TEST_MODEL);
			expect(options.providerPromptCacheKey).toBeUndefined();
		} finally {
			authStorage.close();
		}
	});
});
