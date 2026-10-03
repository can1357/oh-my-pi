import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ContextBreakdown } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession, discoverAuthStorage, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { computeSessionContextBreakdown } from "@oh-my-pi/pi-coding-agent/session/context-usage-runtime";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("ExtensionContext.getContextBreakdown", () => {
	let tempDir: string;
	let modelRegistry!: ModelRegistry;

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `pi-ext-context-breakdown-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(tempDir));
	});

	afterAll(() => {
		removeSyncWithRetries(tempDir);
	});

	it("gives an extension the same per-category breakdown that /context renders", async () => {
		let seen: ContextBreakdown | undefined;
		const probe: ExtensionFactory = pi => {
			pi.on("session_start", (_event, ctx) => {
				seen = ctx.getContextBreakdown();
			});
		};

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: [probe],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});

		try {
			await initializeExtensions(session, { reportSendError: vi.fn(), reportRuntimeError: vi.fn() });
			if (!seen) throw new Error("expected the extension to receive a breakdown");

			const shown = computeSessionContextBreakdown(session);
			expect(seen.categories.map(c => [c.id, c.tokens])).toEqual(shown.categories.map(c => [c.id, c.tokens]));
			expect(seen.categories.find(c => c.id === "systemPrompt")?.tokens).toBeGreaterThan(0);
			expect(seen.categories.find(c => c.id === "systemTools")?.tokens).toBeGreaterThan(0);
			expect(seen.usedTokens + seen.autoCompactBufferTokens + seen.freeTokens).toBe(seen.contextWindow);
		} finally {
			await session.dispose();
		}
	});
});
