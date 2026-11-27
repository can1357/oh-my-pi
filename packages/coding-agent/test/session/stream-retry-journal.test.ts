import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function sse(events: Array<Record<string, unknown>>): Response {
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** A Copilot Messages reply: `text` (empty for an empty completion) billed `nano` nano-AIU. */
function copilotReply(text: string, nano: number): Response {
	const blocks = text
		? [
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
				{ type: "content_block_stop", index: 0 },
			]
		: [];
	return sse([
		{
			type: "message_start",
			message: {
				id: `msg_${nano}`,
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4.5",
				content: [],
				stop_reason: null,
				usage: { input_tokens: 1_000, output_tokens: 0 },
			},
		},
		...blocks,
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: text ? 20 : 0 },
			copilot_usage: { total_nano_aiu: nano },
		},
		{ type: "message_stop" },
	]);
}

describe("discarded retry attempts", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	async function createSession(): Promise<AgentSession> {
		const dir = TempDir.createSync("@omp-stream-retry-journal-");
		cleanups.push(() => dir.removeSync());
		// The fake Copilot token must not reach github.com through the background billing probe.
		const authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"), { copilotBillingProbe: false });
		cleanups.push(() => authStorage.close());
		authStorage.keys.setRuntime("github-copilot", "ghu_test");
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			sessionManager: SessionManager.inMemory(),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(dir.path(), "models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: getBundledModel("github-copilot", "claude-sonnet-4.5"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			cacheWarming: "off",
			workspaceTree: { rootPath: dir.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		cleanups.push(() => session.dispose());
		return session;
	}

	it("journals an empty completion the retry replaced, counting it and the delivered reply once each", async () => {
		const replies = [copilotReply("", 100_000_000), copilotReply("done", 400_000_000)];
		const fetchMock = async (input: string | URL | Request): Promise<Response> => {
			const url = input instanceof Request ? input.url : String(input);
			if (!url.endsWith("/v1/messages")) return new Response("not found", { status: 404 });
			const next = replies.shift();
			if (!next) throw new Error("unexpected extra request");
			return next;
		};
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
		const session = await createSession();

		await session.prompt("hi");

		expect(replies).toEqual([]);
		const entries = session.sessionManager.getEntries();
		const journaled = entries.filter(entry => entry.type === "model_usage");
		expect(journaled.map(entry => entry.purpose)).toEqual(["stream-retry:empty-completion"]);
		const assistants = entries.flatMap(entry =>
			entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
		);
		expect(assistants.map(message => message.usage.aiu?.nano)).toEqual([400_000_000]);

		const discarded = journaled[0]!;
		const delivered = assistants[0]!;
		expect(discarded.usage.totalTokens).toBe(1_000);
		const usage = session.sessionManager.getUsageStatistics();
		expect(usage.cost).toBeCloseTo(discarded.usage.cost.total + delivered.usage.cost.total, 10);
		expect(usage.cost).toBeGreaterThan(delivered.usage.cost.total);
		expect(session.getSessionStats().aiu).toEqual({ nano: 500_000_000, unknownCalls: 0 });
	});
});
