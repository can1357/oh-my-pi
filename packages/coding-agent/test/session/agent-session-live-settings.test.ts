import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { setCfgApprovalHost } from "@oh-my-pi/pi-coding-agent/internal-urls/cfg-protocol";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

import {
	cfgIncludeWorkspaceTree,
	cfgOmitThinking,
	cfgPersonality,
	cfgTemperature,
	cfgTierOpenai,
	cfgTopP,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgTtsrEnabled } from "@oh-my-pi/pi-coding-agent/export/ttsr-settings";
import { cfgToolsFormat } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { cfgInterruptMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgSteeringMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgFetchEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

describe("AgentSession live settings", () => {
	const tempDirs: string[] = [];
	let modelRegistry!: ModelRegistry;
	let authDir: string;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		authDir = path.join(os.tmpdir(), `pi-live-settings-auth-${Snowflake.next()}`);
		fs.mkdirSync(authDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(authDir));
		// The mock provider never calls out, but the session refuses a turn
		// without a credential for the model.
		modelRegistry.authStorage.keys.setRuntime("openai", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
	});

	afterAll(() => {
		// The discovered auth DB lives in authDir; Windows cannot delete it while open.
		modelRegistry.authStorage.close();
		removeSyncWithRetries(authDir);
	});

	const start = async (
		settings: Settings,
		extra?: Pick<CreateAgentSessionOptions, "systemPrompt" | "settingsApproval">,
	): Promise<AgentSession> => {
		const cwd = path.join(os.tmpdir(), `pi-live-settings-${Snowflake.next()}`);
		tempDirs.push(cwd);
		fs.mkdirSync(cwd, { recursive: true });
		const created = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			getApiKey: () => "test-key",
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: {
				rootPath: cwd,
				rendered: "live-settings-tree-marker/",
				truncated: false,
				totalLines: 1,
				agentsMdFiles: [],
			},
			...extra,
		});
		session = created.session;
		return created.session;
	};

	it("applies settings changed through code to the running agent without a UI", async () => {
		const settings = Settings.isolated();
		const live = await start(settings);

		cfgTemperature.set(settings, 0.2);
		cfgTopP.set(settings, -1);
		cfgSteeringMode.set(settings, "all");
		cfgInterruptMode.set(settings, "wait");
		cfgOmitThinking.set(settings, true);
		cfgTierOpenai.set(settings, "priority");
		await Promise.resolve();

		expect(live.agent.temperature).toBe(0.2);
		expect(live.agent.topP).toBeUndefined();
		expect(live.steeringMode).toBe("all");
		expect(live.interruptMode).toBe("wait");
		expect(live.agent.hideThinkingSummary).toBe(true);
		expect(live.serviceTierByFamily.openai).toBe("priority");
		// Exactly one transcript entry: the watch applies the tier once.
		const tierEntries = live.sessionManager.getBranch().filter(entry => entry.type === "service_tier_change");
		expect(tierEntries).toHaveLength(1);
	});

	it("rebuilds the system prompt when prompt-affecting settings change", async () => {
		// Inline descriptors put a tool's description in the prompt (and strip it
		// from the provider schema), so the `read` tool's URL guidance is prompt
		// content: a live toggle must republish the prompt, or the model keeps
		// seeing copy for a URL read the runtime now refuses.
		const settings = Settings.isolated({ inlineToolDescriptors: "on" });
		const live = await start(settings);
		expect(live.systemPrompt.join("\n")).not.toContain("live-settings-tree-marker/");

		cfgIncludeWorkspaceTree.set(settings, true);
		// The watch queues its rebuild on the next microtask; an explicit refresh
		// serializes behind it on the tool-registry mutation queue.
		await Promise.resolve();
		await live.refreshBaseSystemPrompt();
		expect(live.systemPrompt.join("\n")).toContain("live-settings-tree-marker/");

		const beforePersonality = live.systemPrompt.join("\n");
		cfgPersonality.set(settings, "none");
		await Promise.resolve();
		await live.refreshBaseSystemPrompt();
		expect(live.systemPrompt.join("\n")).not.toBe(beforePersonality);

		// `fetch.enabled` gates the `read` tool's URL guidance, so turning it off
		// must republish the prompt without an unrelated settings change.
		expect(live.systemPrompt.join("\n")).toContain("reader text/markdown");
		cfgFetchEnabled.set(settings, false);
		await Promise.resolve();
		await live.runToolRegistryMutation(async () => {});
		expect(live.systemPrompt.join("\n")).not.toContain("reader text/markdown");
		expect(live.systemPrompt.join("\n")).not.toContain("bare host:port");
	});

	it("rebuilds the system prompt once for a bulk change across several prompt inputs", async () => {
		const settings = Settings.isolated();
		let builds = 0;
		const live = await start(settings, {
			systemPrompt: defaultPrompt => {
				builds++;
				return defaultPrompt;
			},
		});

		// Let startup-queued rebuilds drain before counting.
		await live.runToolRegistryMutation(async () => {});
		const before = live.systemPrompt.join("\n");
		builds = 0;

		cfgPersonality.set(settings, "none");
		cfgIncludeWorkspaceTree.set(settings, true);
		cfgTtsrEnabled.set(settings, false);
		cfgToolsFormat.set(settings, "glm");
		await Promise.resolve();
		await live.runToolRegistryMutation(async () => {});

		expect(builds).toBe(1);
		expect(live.systemPrompt.join("\n")).not.toBe(before);
		expect(live.systemPrompt.join("\n")).toContain("live-settings-tree-marker/");
	});

	it("republishes the prompt before an approved cfg:// write returns", async () => {
		// Inline descriptors put the `read` tool's URL guidance in the prompt, so
		// turning `fetch.enabled` off has to republish it. An approved `cfg://`
		// write applies the setting and returns; the turn then continues with the
		// next request, and that request must not carry the prompt the change
		// replaced.
		const settings = Settings.isolated({ inlineToolDescriptors: "on" });
		const live = await start(settings, { settingsApproval: true });
		expect(live.systemPrompt.join("\n")).toContain("reader text/markdown");

		const writeTool = live.agent.state.tools.find(tool => tool.name === "write");
		expect(writeTool).toBeDefined();
		setCfgApprovalHost({
			approve: async () => "once",
			applied: () => {},
			persistentSettings: settings,
		});
		try {
			await writeTool!.execute("cfg-1", { path: "cfg://fetch/enabled", content: "false" });
		} finally {
			setCfgApprovalHost(null);
		}

		expect(cfgFetchEnabled.get(settings)).toBe(false);
		expect(live.systemPrompt.join("\n")).not.toContain("reader text/markdown");
		expect(live.systemPrompt.join("\n")).not.toContain("bare host:port");
	});

	it("republishes the prompt before a side request builds its provider context", async () => {
		// Side requests (ephemeral turns, compaction, handoff) build their own
		// provider context and never reach the main loop's pre-model-call hook, so
		// the pending rebuild has to be awaited at their boundary too.
		const settings = Settings.isolated({ inlineToolDescriptors: "on" });
		const live = await start(settings);
		expect(live.systemPrompt.join("\n")).toContain("reader text/markdown");

		// A settings change that did not come through a `cfg://` write: the side
		// request still has to wait for the rebuild it queued.
		cfgFetchEnabled.set(settings, false);
		const context = await live.agent.buildSideRequestContext([]);

		expect(context.systemPrompt?.join("\n")).not.toContain("reader text/markdown");
	});

	it("drains every queued prompt rebuild before the write returns", async () => {
		// A change that lands while a rebuild is in flight queues a second
		// rebuild. The write must wait for both: returning after the first would
		// hand the next request a prompt that still contradicts the newest setting.
		const settings = Settings.isolated({ inlineToolDescriptors: "on" });
		const live = await start(settings, { settingsApproval: true });
		expect(live.systemPrompt.join("\n")).toContain("reader text/markdown");

		// Hold the first rebuild's completion so a second change can queue a
		// second rebuild behind it while the write is still waiting.
		const firstPublished = Promise.withResolvers<void>();
		const secondRequested = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const originalRefresh = live.refreshBaseSystemPrompt.bind(live);
		let requests = 0;
		live.refreshBaseSystemPrompt = async (commitIf?: () => boolean) => {
			requests++;
			if (requests === 2) {
				secondRequested.resolve();
				return originalRefresh(commitIf);
			}
			const result = await originalRefresh(commitIf);
			firstPublished.resolve();
			await releaseFirst.promise;
			return result;
		};

		const writeTool = live.agent.state.tools.find(tool => tool.name === "write");
		expect(writeTool).toBeDefined();
		setCfgApprovalHost({
			approve: async () => "once",
			applied: () => {},
			persistentSettings: settings,
		});
		try {
			const write = writeTool!.execute("cfg-1", { path: "cfg://fetch/enabled", content: "false" });
			// The first rebuild is published and held; the write is still waiting
			// for it. A second change now queues a second rebuild behind it.
			await firstPublished.promise;
			cfgIncludeWorkspaceTree.set(settings, true);
			await secondRequested.promise;
			releaseFirst.resolve();
			await write;
		} finally {
			setCfgApprovalHost(null);
		}

		expect(live.systemPrompt.join("\n")).not.toContain("reader text/markdown");
		// The second rebuild ran too, so the newest setting is in the prompt.
		expect(live.systemPrompt.join("\n")).toContain("live-settings-tree-marker/");
	});
});
