import { afterEach, describe, expect, it, vi } from "bun:test";
import type { OAuthCredential } from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

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
			// Turn requests resolve through turnResolver, which a security scan session
			// calls on its host's registry under its own provider session id.
			expect(await resolveApiKeyOnce(pooled.modelRegistry.turnResolver(model, "turn-provider-session"))).toBe(
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
