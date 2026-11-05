import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { OAuthCredential, UsageReport } from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { credentialPinHash, recordCredentialPin } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
};

function oauthCredential(suffix: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

function claudeUsage(accountId: string, usedFraction: number): UsageReport {
	const used = usedFraction * 100;
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		metadata: { accountId },
		limits: [
			{
				id: "anthropic:5h",
				label: "Claude 5 Hour",
				scope: { provider: "anthropic", windowId: "5h", shared: true },
				window: {
					id: "5h",
					label: "Claude 5 Hour",
					durationMs: 5 * 60 * 60_000,
					resetsAt: Date.now() + 60 * 60_000,
				},
				amount: {
					unit: "percent",
					used,
					limit: 100,
					remaining: 100 - used,
					usedFraction,
					remainingFraction: 1 - usedFraction,
				},
				status: "ok",
			},
		],
	};
}

/** Account B is 70% used and inside its 50% reserve; A is 20% used, so only an explicit pin keeps B. */
function reserveAuthStorage(): AuthStorage {
	const usedFractionByAccount: Record<string, number> = { "account-a": 0.2, "account-b": 0.7 };
	return new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
		usageProviderResolver: provider =>
			provider === "anthropic"
				? {
						id: "anthropic",
						async fetchUsage({ credential }) {
							const accountId = credential.accountId;
							const usedFraction = accountId ? usedFractionByAccount[accountId] : undefined;
							return accountId && usedFraction !== undefined ? claudeUsage(accountId, usedFraction) : null;
						},
					}
				: undefined,
		accountPolicies: [{ provider: "anthropic", account: { accountId: "account-b" }, reservePct: 50 }],
	});
}

function metadataUserId(metadata: Record<string, unknown> | undefined): {
	session_id: unknown;
	account_uuid: unknown;
} {
	const encoded = metadata?.user_id;
	if (typeof encoded !== "string") throw new Error("Expected encoded user metadata");
	const decoded: unknown = JSON.parse(encoded);
	if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new Error("Expected user metadata object");
	}
	return {
		session_id: "session_id" in decoded ? decoded.session_id : undefined,
		account_uuid: "account_uuid" in decoded ? decoded.account_uuid : undefined,
	};
}

function subprocessResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "Inspect the target.",
		assignment: "Inspect the target.",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("task subagent OAuth pin inheritance", () => {
	it("keeps inherited credentials and metadata on the parent's account affinity", async () => {
		const tempDir = TempDir.createSync("@pi-subagent-auth-pin-");
		const authStorage = createInMemoryAuthStorage();
		const sessions: AgentSession[] = [];
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			const otherProviderModel = getBundledModel("openai", "gpt-5-mini");
			if (!model || !otherProviderModel) throw new Error("Expected bundled test models");
			await authStorage.credentials.set("anthropic", [oauthCredential("a"), oauthCredential("b")]);
			authStorage.keys.setRuntime("openai", "openai-key");
			const parentProviderSessionId = "parent-provider-session";
			const accountB = authStorage.oauth
				.accounts("anthropic", parentProviderSessionId)
				.find(account => account.accountId === "account-b");
			if (!accountB) throw new Error("Expected account B");
			expect(authStorage.sessions.pin("anthropic", parentProviderSessionId, accountB.credentialId)).toBe(true);

			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
			const settings = Settings.isolated({
				"async.enabled": false,
				"compaction.enabled": false,
				"task.batch": true,
				"task.isolation.enabled": false,
				"todo.enabled": false,
			});
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
			const dispatched: executorModule.ExecutorOptions[] = [];
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				dispatched.push(options);
				return subprocessResult(options.id ?? "task");
			});

			const { session: parent } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry,
				settings,
				model,
				providerSessionId: parentProviderSessionId,
				toolNames: ["task"],
				disableExtensionDiscovery: true,
			});
			sessions.push(parent);
			const parentTask = parent.getToolByName("task");
			if (!parentTask) throw new Error("Expected parent task tool");
			await parentTask.execute("parallel-task-call", {
				context: "Check both targets.",
				tasks: [
					{ agent: "task", name: "ChildA", task: "Inspect target A." },
					{ agent: "task", name: "ChildB", task: "Inspect target B." },
				],
			});

			expect(dispatched).toHaveLength(2);
			for (const childOptions of dispatched) {
				expect(childOptions.getApiKey).toBeUndefined();
				expect(childOptions.credentialSourceSessionId).toBe(parentProviderSessionId);
			}

			// The spawn captured the old affinity. A later parent `/fresh` cannot
			// change which sticky credential is copied into either child.
			parent.agent.sessionId = "rotated-parent-session";
			const children: AgentSession[] = [];
			for (const [index, childOptions] of dispatched.entries()) {
				const providerSessionId = `child-provider-session-${index + 1}`;
				const { session: child } = await createAgentSession({
					cwd: tempDir.path(),
					agentDir: tempDir.path(),
					sessionManager: SessionManager.inMemory(tempDir.path()),
					authStorage,
					modelRegistry,
					settings,
					model,
					providerSessionId,
					getApiKey: childOptions.getApiKey,
					credentialSourceSessionId: childOptions.credentialSourceSessionId,
					toolNames: ["task"],
					disableExtensionDiscovery: true,
				});
				sessions.push(child);
				children.push(child);
				const childGetApiKey = child.agent.getApiKey;
				if (!childGetApiKey) throw new Error("Expected child credential resolver");
				expect(await resolveApiKeyOnce(await childGetApiKey(model))).toBe("access-b");
				expect(metadataUserId(child.agent.metadataForProvider("anthropic"))).toMatchObject({
					session_id: providerSessionId,
					account_uuid: "account-b",
				});
			}
			const child = children[0];
			if (!child) throw new Error("Expected first child session");
			const childGetApiKey = child.agent.getApiKey;
			if (!childGetApiKey) throw new Error("Expected first child credential resolver");
			expect(await resolveApiKeyOnce(await childGetApiKey(otherProviderModel))).toBe("openai-key");

			const childTask = child.getToolByName("task");
			if (!childTask) throw new Error("Expected child task tool");
			await childTask.execute("nested-task-call", {
				context: "Check the nested target.",
				tasks: [{ agent: "task", name: "Grandchild", task: "Inspect the nested target." }],
			});

			expect(dispatched).toHaveLength(3);
			const nestedOptions = dispatched[2];
			if (!nestedOptions) throw new Error("Expected nested child options");
			expect(nestedOptions.getApiKey).toBeUndefined();
			expect(nestedOptions.credentialSourceSessionId).toBe("child-provider-session-1");
			const { session: grandchild } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry,
				settings,
				model,
				providerSessionId: "grandchild-provider-session",
				getApiKey: nestedOptions.getApiKey,
				credentialSourceSessionId: nestedOptions.credentialSourceSessionId,
				toolNames: ["task"],
				disableExtensionDiscovery: true,
			});
			sessions.push(grandchild);
			const grandchildGetApiKey = grandchild.agent.getApiKey;
			if (!grandchildGetApiKey) throw new Error("Expected grandchild credential resolver");
			expect(await resolveApiKeyOnce(await grandchildGetApiKey(model))).toBe("access-b");
			expect(metadataUserId(grandchild.agent.metadataForProvider("anthropic"))).toMatchObject({
				session_id: "grandchild-provider-session",
				account_uuid: "account-b",
			});
		} finally {
			for (const session of sessions.reverse()) await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	});

	// A parked subagent is revived by re-running createAgentSession with its spawn options
	// (credentialSourceSessionId included) over its reopened transcript. The child's earlier
	// run pinned `childAccount` there; the parent was pinned to `parentAccount` after.
	async function reviveChildKey(
		authStorage: AuthStorage,
		childAccount: string,
		parentAccount: string,
		parentPinOptions?: { restoredAtMs: number },
		oauthAccountPools?: Record<string, string[]>,
	): Promise<string | undefined> {
		const tempDir = TempDir.createSync("@pi-subagent-revive-pin-");
		let child: AgentSession | undefined;
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled test model");
			await authStorage.credentials.set("anthropic", [oauthCredential("a"), oauthCredential("b")]);
			const childTranscript = SessionManager.inMemory(tempDir.path());
			const childHash = credentialPinHash("anthropic", {
				accountId: `account-${childAccount}`,
				email: `${childAccount}@example.com`,
			});
			if (!childHash) throw new Error("Expected a pin hash");
			childTranscript.appendCredentialPin("anthropic", childHash);

			const parentProviderSessionId = "parent-provider-session";
			const parentCredential = authStorage.oauth
				.accounts("anthropic", parentProviderSessionId)
				.find(account => account.accountId === `account-${parentAccount}`);
			if (!parentCredential) throw new Error("Expected the parent's account");
			expect(
				authStorage.sessions.pin(
					"anthropic",
					parentProviderSessionId,
					parentCredential.credentialId,
					parentPinOptions,
				),
			).toBe(true);

			({ session: child } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: childTranscript,
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
				settings: Settings.isolated({ "async.enabled": false, "compaction.enabled": false }),
				model,
				credentialSourceSessionId: parentProviderSessionId,
				oauthAccountPools,
				toolNames: ["read"],
				disableExtensionDiscovery: true,
			}));
			const childGetApiKey = child.agent.getApiKey;
			if (!childGetApiKey) throw new Error("Expected child credential resolver");
			return await resolveApiKeyOnce(await childGetApiKey(model));
		} finally {
			await child?.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	}

	it("keeps a revived child's own warm transcript pin over the parent's automatic affinity", async () => {
		const key = await reviveChildKey(createInMemoryAuthStorage(), "b", "a", { restoredAtMs: Date.now() });
		expect(key).toBe("access-b");
	});

	it("moves a revived child onto the parent's explicit pin over its transcript pin", async () => {
		expect(await reviveChildKey(createInMemoryAuthStorage(), "b", "a")).toBe("access-a");
	});

	it("keeps the parent's explicit pin explicit in a revived child pinned to the same account", async () => {
		expect(await reviveChildKey(reserveAuthStorage(), "b", "b")).toBe("access-b");
	});

	it("keeps a revived child inside its account pool over the parent's explicit pin", async () => {
		const key = await reviveChildKey(createInMemoryAuthStorage(), "b", "a", undefined, {
			anthropic: ["email:b@example.com"],
		});
		expect(key).toBe("access-b");
	});

	it("keeps a child explicit through revival when the parent's pin predates its first run", async () => {
		const tempDir = TempDir.createSync("@pi-subagent-revive-pin-");
		const authStorage = reserveAuthStorage();
		let child: AgentSession | undefined;
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled test model");
			await authStorage.credentials.set("anthropic", [oauthCredential("a"), oauthCredential("b")]);
			const parentProviderSessionId = "parent-provider-session";
			const accountB = authStorage.oauth.accounts("anthropic").find(account => account.accountId === "account-b");
			if (!accountB) throw new Error("Expected account B");
			expect(authStorage.sessions.pin("anthropic", parentProviderSessionId, accountB.credentialId)).toBe(true);

			const childTranscript = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
			const childOptions = {
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
				settings: Settings.isolated({ "async.enabled": false, "compaction.enabled": false }),
				model,
				credentialSourceSessionId: parentProviderSessionId,
				toolNames: ["read"],
				disableExtensionDiscovery: true,
			};
			// The child's first run records B in its transcript, then a later turn.
			({ session: child } = await createAgentSession({ ...childOptions, sessionManager: childTranscript }));
			const firstRunGetApiKey = child.agent.getApiKey;
			if (!firstRunGetApiKey) throw new Error("Expected child credential resolver");
			expect(await resolveApiKeyOnce(await firstRunGetApiKey(model))).toBe("access-b");
			const childSessionId = childTranscript.getSessionId();
			recordCredentialPin(authStorage, childTranscript, childSessionId, "anthropic");
			const laterTurn = createAssistantMessage("earlier child turn");
			laterTurn.timestamp = Date.now() + 1000;
			childTranscript.appendMessage(laterTurn);
			const sessionFile = childTranscript.getSessionFile();
			if (!sessionFile) throw new Error("Expected a session file");
			await child.dispose();
			child = undefined;
			authStorage.sessions.release("anthropic", childSessionId);

			// Its reopened transcript pin is newer than the inherited explicit pin; restoring it
			// must not downgrade B to an automatic pin that reserve ranks away to A.
			const reopened = await SessionManager.open(sessionFile);
			expect(reopened.getCredentialPins().has("anthropic")).toBe(true);
			({ session: child } = await createAgentSession({ ...childOptions, sessionManager: reopened }));
			const childGetApiKey = child.agent.getApiKey;
			if (!childGetApiKey) throw new Error("Expected child credential resolver");
			expect(await resolveApiKeyOnce(await childGetApiKey(model))).toBe("access-b");
		} finally {
			await child?.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	});

	it("restricts a spawned agent to its task.agentAccountPools entry over the parent's pin", async () => {
		const tempDir = TempDir.createSync("@pi-subagent-account-pool-");
		const authStorage = createInMemoryAuthStorage();
		const sessions: AgentSession[] = [];
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled test model");
			const accountA = { ...oauthCredential("a"), orgId: "org-a" };
			const accountB = { ...oauthCredential("b"), orgId: "org-b" };
			await authStorage.credentials.set("anthropic", [
				accountA,
				accountB,
				{ ...oauthCredential("c"), orgId: "org-c" },
			]);
			const parentProviderSessionId = "parent-provider-session";
			const storedB = authStorage.oauth.accounts("anthropic").find(account => account.accountId === "account-b");
			if (!storedB) throw new Error("Expected account B");
			expect(authStorage.sessions.pin("anthropic", parentProviderSessionId, storedB.credentialId)).toBe(true);

			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
			const settings = Settings.isolated({
				"async.enabled": false,
				"compaction.enabled": false,
				"task.batch": true,
				"task.isolation.enabled": false,
				"todo.enabled": false,
				"task.agentAccountPools": { task: { anthropic: ["email:c@example.com|org:org-c"] } },
			});
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
			const dispatched: executorModule.ExecutorOptions[] = [];
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				dispatched.push(options);
				return subprocessResult(options.id ?? "task");
			});

			const { session: parent } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry,
				settings,
				model,
				providerSessionId: parentProviderSessionId,
				toolNames: ["task"],
				disableExtensionDiscovery: true,
			});
			sessions.push(parent);
			const parentTask = parent.getToolByName("task");
			if (!parentTask) throw new Error("Expected parent task tool");
			await parentTask.execute("pooled-task-call", {
				context: "Check the target.",
				tasks: [{ agent: "task", name: "Child", task: "Inspect the target." }],
			});

			expect(dispatched).toHaveLength(1);
			const childOptions = dispatched[0];
			if (!childOptions) throw new Error("Expected child options");
			expect(childOptions.oauthAccountPools).toEqual({ anthropic: ["email:c@example.com|org:org-c"] });
			const { session: child } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry,
				settings,
				model,
				providerSessionId: "child-provider-session",
				credentialSourceSessionId: childOptions.credentialSourceSessionId,
				oauthAccountPools: childOptions.oauthAccountPools,
				toolNames: ["read"],
				disableExtensionDiscovery: true,
			});
			sessions.push(child);
			const childGetApiKey = child.agent.getApiKey;
			if (!childGetApiKey) throw new Error("Expected child credential resolver");
			expect(metadataUserId(child.agent.metadataForProvider("anthropic")).account_uuid).toBe("account-c");
			expect(await resolveApiKeyOnce(await childGetApiKey(model))).toBe("access-c");

			// A fresh provider session id starts inside the pool too.
			expect(child.freshSession()).toBeDefined();
			expect(child.agent.sessionId).not.toBe("child-provider-session");
			expect(metadataUserId(child.agent.metadataForProvider("anthropic")).account_uuid).toBe("account-c");
			expect(await resolveApiKeyOnce(await childGetApiKey(model))).toBe("access-c");

			// Without its pooled account the child fails instead of borrowing another.
			await authStorage.credentials.set("anthropic", [accountA, accountB]);
			await expect(resolveApiKeyOnce(await childGetApiKey(model))).rejects.toThrow(
				"restricted to its OAuth account pool",
			);
		} finally {
			for (const session of sessions.reverse()) await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	});

	it("keeps every key lookup of a pooled session in its pool, whatever session id it carries", async () => {
		const tempDir = TempDir.createSync("@pi-subagent-account-pool-scope-");
		const authStorage = createInMemoryAuthStorage();
		const sessions: AgentSession[] = [];
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled test model");
			await authStorage.credentials.set("anthropic", [
				{ ...oauthCredential("a"), orgId: "org-a" },
				{ ...oauthCredential("c"), orgId: "org-c" },
			]);
			// An unrestricted lookup takes the runtime key first.
			authStorage.keys.setRuntime("anthropic", "runtime-key");
			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
			const settings = Settings.isolated({
				"async.enabled": false,
				"compaction.enabled": false,
				"task.batch": true,
				"task.isolation.enabled": false,
				"todo.enabled": false,
			});
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
			const dispatched: executorModule.ExecutorOptions[] = [];
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				dispatched.push(options);
				return subprocessResult(options.id ?? "task");
			});

			const { session: pooled } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry,
				settings,
				model,
				providerSessionId: "pooled-provider-session",
				oauthAccountPools: { anthropic: ["email:c@example.com|org:org-c"] },
				toolNames: ["task"],
				disableExtensionDiscovery: true,
			});
			sessions.push(pooled);
			// Side requests (title generation, skill compression) mint their own
			// provider session ids or pass none; both stay in the pool.
			expect(await pooled.modelRegistry.getApiKey(model, "title-provider-session")).toBe("access-c");
			expect(await pooled.modelRegistry.getApiKey(model)).toBe("access-c");
			expect(await resolveApiKeyOnce(pooled.modelRegistry.resolver(model, "side-provider-session"))).toBe(
				"access-c",
			);
			// The shared registry the session was handed stays unrestricted.
			expect(await modelRegistry.getApiKey(model, "unpooled-provider-session")).toBe("runtime-key");

			// A subagent it spawns without its own pool entry resolves through the same pool.
			const task = pooled.getToolByName("task");
			if (!task) throw new Error("Expected task tool");
			await task.execute("nested-task-call", {
				context: "Check the target.",
				tasks: [{ agent: "task", name: "Child", task: "Inspect the target." }],
			});
			const childRegistry = dispatched[0]?.modelRegistry;
			if (!childRegistry) throw new Error("Expected the dispatched registry");
			expect(await childRegistry.getApiKey(model, "nested-provider-session")).toBe("access-c");

			// A config key (a models.yml apiKey, often for a proxy) fails the pool
			// closed instead of sending a pooled OAuth token past it.
			authStorage.keys.setConfig("anthropic", "proxy-key");
			await expect(pooled.modelRegistry.getApiKey(model, "title-provider-session")).rejects.toThrow(
				"pooled OAuth tokens are never sent past it",
			);
		} finally {
			for (const session of sessions.reverse()) await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	});
});
