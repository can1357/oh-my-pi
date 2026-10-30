/**
 * Once a session has begun disposing, nothing reaches the provider that was not already on its
 * way there: a steer or follow-up queued on the session is not delivered, an extension's aside is
 * refused, and a side request (`runEphemeralTurn`) is refused or cancelled. Each of these used to
 * send a request from the closing session.
 *
 * The cases count requests at a local Anthropic endpoint, because what must not happen is a
 * request reaching the provider.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/** One Anthropic streaming response: a text reply, or a single call to `noop`. */
function anthropicResponse(reply: "text" | "tool"): Response {
	const block =
		reply === "tool"
			? [
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "toolu_1", name: "noop", input: {} },
					},
					{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
				]
			: [
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
				];
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_test",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		...block,
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: reply === "tool" ? "tool_use" : "end_turn", stop_sequence: null },
			usage: { output_tokens: 1 },
		},
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

describe("AgentSession provider requests at disposal", () => {
	let server: Bun.Server<undefined>;
	let authStorage: AuthStorage;
	let session: AgentSession;
	/** Every request the provider endpoint received: its last message, and whether the session was disposing. */
	let requests: Array<{ disposed: boolean; lastMessage: string }>;
	/** Whether the endpoint holds its first response until `releaseFirst`. */
	let holdFirst: boolean;
	/** Resolved when the first request arrives. */
	let firstRequest: PromiseWithResolvers<void>;
	let releaseFirst: PromiseWithResolvers<void>;
	let firstReply: "text" | "tool";
	let toolRuns: number;

	beforeEach(() => {
		requests = [];
		holdFirst = true;
		firstRequest = Promise.withResolvers<void>();
		releaseFirst = Promise.withResolvers<void>();
		firstReply = "text";
		toolRuns = 0;
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const body = (await request.json()) as { messages: unknown[] };
				requests.push({
					disposed: session.isDisposed,
					lastMessage: JSON.stringify(body.messages.at(-1)),
				});
				if (requests.length > 1 || !holdFirst) return anthropicResponse("text");
				firstRequest.resolve();
				await releaseFirst.promise;
				return anthropicResponse(firstReply);
			},
		});
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const noop: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Does nothing",
			parameters: type({}),
			execute: async () => {
				toolRuns++;
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		};
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: { ...getBundledModel("anthropic", "claude-sonnet-4-5")!, baseUrl: server.url.origin },
					systemPrompt: ["Test"],
					tools: [noop],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(authStorage),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		});
	});

	afterEach(async () => {
		releaseFirst.resolve();
		await session.dispose();
		authStorage.close();
		server.stop(true);
	});

	/** Start a turn and hold its provider response, so messages can be queued behind it. */
	async function startHeldTurn(): Promise<{ run: Promise<boolean> }> {
		const run = session.prompt("first");
		await firstRequest.promise;
		return { run };
	}

	describe("queued steering and follow-ups", () => {
		it.each(["followUp", "steer"] as const)("delivers a queued %s on a live session", async kind => {
			const { run } = await startHeldTurn();
			await session.prompt("queued message", { streamingBehavior: kind });

			releaseFirst.resolve();
			await run;
			await session.waitForIdle();

			expect(requests).toHaveLength(2);
			expect(requests[1].lastMessage).toContain("queued message");
		});

		it.each(["followUp", "steer"] as const)("sends no request for a %s queued before disposal began", async kind => {
			const { run } = await startHeldTurn();
			await session.prompt("queued message", { streamingBehavior: kind });

			session.beginDispose();
			releaseFirst.resolve();
			// The turn admitted before disposal still settles.
			await expect(run).resolves.toBe(true);
			await session.waitForIdle();

			expect(requests).toEqual([{ disposed: false, lastMessage: expect.stringContaining("first") }]);
		});

		it.each(["followUp", "steer"] as const)(
			"sends no request for an extension message queued as a %s while the session is disposing",
			async kind => {
				const { run } = await startHeldTurn();

				session.beginDispose();
				await session.sendCustomMessage(
					{ customType: "extension-note", content: "queued message", display: false },
					{ deliverAs: kind },
				);
				releaseFirst.resolve();
				await run;
				await session.waitForIdle();

				expect(requests).toEqual([{ disposed: false, lastMessage: expect.stringContaining("first") }]);
			},
		);

		it("takes a steer at the boundary after a tool call on a live session", async () => {
			firstReply = "tool";
			const { run } = await startHeldTurn();
			await session.prompt("queued message", { streamingBehavior: "steer" });

			releaseFirst.resolve();
			await run;
			await session.waitForIdle();

			expect(toolRuns).toBe(1);
			expect(requests).toHaveLength(2);
			expect(requests[1].lastMessage).toContain("queued message");
		});

		it("finishes the tool call it was making but does not take a steer at the next boundary", async () => {
			firstReply = "tool";
			const { run } = await startHeldTurn();
			await session.prompt("queued message", { streamingBehavior: "steer" });

			session.beginDispose();
			releaseFirst.resolve();
			await run;
			await session.waitForIdle();

			expect(toolRuns).toBe(1);
			expect(requests).toEqual([{ disposed: false, lastMessage: expect.stringContaining("first") }]);
		});
	});

	describe("extension asides", () => {
		it("starts a turn for an aside sent to a live idle session", async () => {
			holdFirst = false;
			await session.sendCustomMessage(
				{ customType: "extension-note", content: "late aside", display: true },
				{ deliverAs: "aside" },
			);
			await session.waitForIdle();

			expect(requests.map(request => request.disposed)).toEqual([false]);
		});

		it("refuses an aside sent after disposal began, and says why", async () => {
			holdFirst = false;
			session.beginDispose();

			await expect(
				session.sendCustomMessage(
					{ customType: "extension-note", content: "late aside", display: true },
					{ deliverAs: "aside" },
				),
			).rejects.toThrow("This session has begun disposing");
			await session.waitForIdle();

			expect(requests).toEqual([]);
		});
	});

	describe("side requests", () => {
		it("sends a side request for a live session", async () => {
			holdFirst = false;
			const { replyText } = await session.runEphemeralTurn({ promptText: "late side turn" });

			expect(replyText).toBe("done");
			expect(requests).toEqual([{ disposed: false, lastMessage: expect.stringContaining("late side turn") }]);
		});

		it("refuses a side request asked for after disposal began", async () => {
			holdFirst = false;
			session.beginDispose();

			await expect(session.runEphemeralTurn({ promptText: "late side turn" })).rejects.toThrow(
				"This session has begun disposing",
			);
			expect(requests).toEqual([]);
		});

		it("cancels a side request still streaming when disposal begins", async () => {
			const turn = session.runEphemeralTurn({ promptText: "side turn in flight" });
			await firstRequest.promise;

			session.beginDispose();

			// It settles without the provider ever answering.
			await expect(turn).rejects.toThrow();
			expect(requests).toEqual([{ disposed: false, lastMessage: expect.stringContaining("side turn in flight") }]);
		});
	});
});
