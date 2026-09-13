import { describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { searchXAI } from "@oh-my-pi/pi-coding-agent/web/search/providers/xai";

const fakeAuthStorage = {
	resolver: vi.fn(() => async () => "test-key"),
	getCredentialOrigin: vi.fn(() => undefined),
	hasAuth: vi.fn(() => true),
} as unknown as AuthStorage;

function makeFetchMock(response: Record<string, unknown>): FetchImpl {
	return async () =>
		new Response(JSON.stringify(response), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
}

function makeParams(fetch: FetchImpl, extras: Record<string, unknown> = {}) {
	return {
		query: "Bun latest release",
		systemPrompt: "xAI integration test prompt",
		authStorage: fakeAuthStorage,
		fetch,
		...extras,
	};
}

describe("xAI Responses answer extraction from relay output items", () => {
	it("drops between-call narration and keeps the final substantive message", async () => {
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output_text: "I'll search for the latest Bun release.\nBun 1.3.12 is the latest release.",
			output: [
				{ type: "message", content: [{ type: "output_text", text: "I'll search for the latest Bun release." }] },
				{
					type: "web_search_call",
					action: { sources: [{ url: "https://bun.com/blog/bun-v1-3-12", title: "Bun v1.3.12" }] },
				},
				{ type: "message", content: [{ type: "output_text", text: "Bun 1.3.12 is the latest release." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};
		const fetch = makeFetchMock(relayResponse);

		const response = await searchXAI(makeParams(fetch));

		expect(response.answer).toBe("Bun 1.3.12 is the latest release.");
	});

	it("keeps an earlier message that carries citations and drops its narration", async () => {
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{ type: "message", content: [{ type: "output_text", text: "I'll check the changelog." }] },
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text: "The Bun changelog records the 1.3.12 patch.",
							annotations: [
								{
									type: "url_citation",
									url: "https://bun.com/blog/bun-v1-3-12",
									title: "Bun v1.3.12",
								},
							],
						},
					],
				},
				{ type: "message", content: [{ type: "output_text", text: "Summarizing now." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toContain("The Bun changelog records the 1.3.12 patch.");
		expect(response.answer).toContain("Summarizing now.");
		expect(response.answer).not.toContain("I'll check the changelog.");
	});

	it("keeps a long substantive earlier message and drops surrounding narration", async () => {
		const longText = "A".repeat(400);
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{ type: "message", content: [{ type: "output_text", text: "Let me search for this." }] },
				{ type: "message", content: [{ type: "output_text", text: longText }] },
				{ type: "message", content: [{ type: "output_text", text: "Done." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toContain(longText);
		expect(response.answer).toContain("Done.");
		expect(response.answer).not.toContain("Let me search for this.");
	});

	it("keeps an earlier message at exactly the narration threshold and drops one below it", async () => {
		const atThreshold = "B".repeat(300);
		const belowThreshold = "C".repeat(299);
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{ type: "message", content: [{ type: "output_text", text: atThreshold }] },
				{ type: "message", content: [{ type: "output_text", text: belowThreshold }] },
				{ type: "message", content: [{ type: "output_text", text: "Done." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toContain(atThreshold);
		expect(response.answer).not.toContain(belowThreshold);
		expect(response.answer).toContain("Done.");
	});

	it("measures the threshold on a message's combined parts without separators, not per part", async () => {
		const part1 = "D".repeat(160);
		const part2 = "E".repeat(140); // 160 + 140 = 300 exactly, no separator counted
		const below = "F".repeat(150); // 150 + 149 = 299, one short
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{ type: "message", content: [{ type: "output_text", text: "Searching the release notes." }] },
				{
					type: "message",
					content: [
						{ type: "output_text", text: part1 },
						{ type: "output_text", text: part2 },
					],
				},
				{
					type: "message",
					content: [
						{ type: "output_text", text: below },
						{ type: "output_text", text: "G".repeat(149) },
					],
				},
				{ type: "message", content: [{ type: "output_text", text: "Done." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toContain(part2);
		expect(response.answer).toContain("Done.");
		expect(response.answer).not.toContain("F".repeat(150));
		expect(response.answer).not.toContain("Searching the release notes.");
	});

	it("ignores text on non-message output items", async () => {
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{ type: "reasoning", content: [{ type: "output_text", text: "Considering what to search." }] },
				{ type: "message", content: [{ type: "output_text", text: "Bun 1.3.12 is the latest release." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toBe("Bun 1.3.12 is the latest release.");
	});

	it("treats an untyped output item as a message, not as ignorable", async () => {
		// Relays may omit the output item's `type`; a valid content array on
		// an untyped item still contributes to the answer (matches the
		// pre-filter fallback contract), while explicit non-message types
		// like `reasoning` stay ignored.
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{ type: "reasoning", content: [{ type: "output_text", text: "Considering what to search." }] },
				{ content: [{ type: "output_text", text: "Bun 1.3.12 is the latest release." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toBe("Bun 1.3.12 is the latest release.");
	});

	it("treats a null item type as a message, matching omitted types", async () => {
		// Non-strict relays represent an omitted `type` as null; the item is
		// still a message when it carries a valid content array, so null must
		// not be rejected the way named non-message types are.
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{ type: "reasoning", content: [{ type: "output_text", text: "Considering what to search." }] },
				{ type: null, content: [{ type: "output_text", text: "Bun 1.3.12 is the latest release." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toBe("Bun 1.3.12 is the latest release.");
	});

	it("uses aggregate text when untyped tool items have no content array", async () => {
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output_text: "Bun 1.3.12 is the latest release.",
			output: [
				{ action: { type: "search", query: "Bun latest release" } },
				{
					type: null,
					action: { type: "search", query: "Bun changelog" },
					content: { text: "Search metadata, not message content." },
				},
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toBe("Bun 1.3.12 is the latest release.");
	});

	it("ignores commentary phases on non-message output items", async () => {
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output_text: "Bun 1.3.12 is the latest release.",
			output: [
				{ type: "reasoning", phase: "commentary" },
				{ phase: "commentary", action: { type: "search", query: "Bun latest release" } },
				{ type: null, phase: "commentary", content: { text: "Tool metadata, not message content." } },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toBe("Bun 1.3.12 is the latest release.");
	});

	it("treats message-level url_citation annotations as substance", async () => {
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{
					type: "message",
					annotations: [
						{
							type: "url_citation",
							url: "https://bun.com/blog/bun-v1-3-12",
							title: "Bun v1.3.12",
						},
					],
					content: [{ type: "output_text", text: "The Bun changelog records the 1.3.12 patch." }],
				},
				{ type: "message", content: [{ type: "output_text", text: "Summarizing now." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toContain("The Bun changelog records the 1.3.12 patch.");
		expect(response.answer).toContain("Summarizing now.");
	});

	it.each([
		["content-part", ""],
		["message", " \t\n "],
	])("drops narration with a blank %s citation URL", async (location, url) => {
		const annotations = [{ type: "url_citation", url }];
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{
					type: "message",
					annotations: location === "message" ? annotations : undefined,
					content: [
						{
							type: "output_text",
							text: "Checking the changelog now.",
							annotations: location === "content-part" ? annotations : undefined,
						},
					],
				},
				{ type: "message", content: [{ type: "output_text", text: "Bun 1.3.12 is the latest release." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toBe("Bun 1.3.12 is the latest release.");
		expect(response.sources).toEqual([]);
	});

	it.each([
		["an explicitly empty message", { type: "message", content: [] }],
		["an explicit message without content", { type: "message" }],
		["an untyped empty message", { content: [] }],
	])("does not promote earlier text after %s", async (_label, lastMessage) => {
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output_text: "Earlier text that must not be restored after an empty final message.",
			output: [
				{ type: "message", content: [{ type: "output_text", text: "A".repeat(400) }] },
				{ type: "message", content: [{ type: "output_text", text: "I'll search for the latest release." }] },
				lastMessage,
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		await expect(searchXAI(makeParams(makeFetchMock(relayResponse)))).rejects.toMatchObject({
			provider: "xai",
			status: 502,
		});
	});

	it("keeps every part of the final message, not just its last part", async () => {
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{ type: "message", content: [{ type: "output_text", text: "I'll search for the latest Bun release." }] },
				{
					type: "message",
					content: [
						{ type: "output_text", text: "The answer is Bun 1.3.12." },
						{ type: "output_text", text: "See the blog post for details." },
					],
				},
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toContain("The answer is Bun 1.3.12.");
		expect(response.answer).toContain("See the blog post for details.");
		expect(response.answer).not.toContain("I'll search for the latest Bun release.");
	});

	it("does not treat non-citation annotations as evidence of substance", async () => {
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text: "Checking the changelog now.",
							annotations: [{ type: "other_metadata", payload: "relay-internal" }],
						},
					],
				},
				{ type: "message", content: [{ type: "output_text", text: "Bun 1.3.12 is the latest release." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toBe("Bun 1.3.12 is the latest release.");
	});
	it("honors explicit phases over citation, length, and last-message heuristics", async () => {
		const response = await searchXAI(
			makeParams(
				makeFetchMock({
					output: [
						{
							type: "message",
							phase: "commentary",
							content: [
								{
									text: "Searching the release notes. ".repeat(20),
									annotations: [{ type: "url_citation", url: "https://bun.sh" }],
								},
							],
						},
						{ type: "message", phase: "final_answer", content: [{ text: "First finding." }] },
						{ type: "message", phase: "final_answer", content: [{ text: "Second finding." }] },
						{ type: "message", phase: "commentary", content: [{ text: "Finishing the search." }] },
					],
				}),
			),
		);
		expect(response.answer).toBe("First finding.\nSecond finding.");
	});

	it("does not promote unphased narration when the last message is commentary", async () => {
		await expect(
			searchXAI(
				makeParams(
					makeFetchMock({
						output_text: "I'll check. Still checking.",
						output: [
							{ type: "message", content: [{ text: "I'll check." }] },
							{ type: "message", phase: "commentary", content: [{ text: "Still checking." }] },
						],
					}),
				),
			),
		).rejects.toMatchObject({ provider: "xai", status: 502 });
	});

	it("treats unrecognized phase values as unphased", async () => {
		// The interface types phase as a union, but relays cast external JSON;
		// "" or unknown strings must not strand a message outside both the
		// final_answer branch and the unphased heuristic (old behavior: every
		// message dropped, 502 no-answer error even with content present).
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{
					type: "message",
					phase: "starting",
					content: [
						{
							type: "output_text",
							text: "Bun 1.3.12 is documented.",
							annotations: [{ type: "url_citation", url: "https://bun.sh" }],
						},
					],
				},
				{ type: "message", phase: "wip", content: [{ type: "output_text", text: "I'll check." }] },
				{ type: "message", phase: "done", content: [{ type: "output_text", text: "Second finding." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toBe("Bun 1.3.12 is documented.\nSecond finding.");
	});

	it("prefers phased messages over the aggregate output_text", async () => {
		// A relay that populates the top-level aggregate AND phases its
		// messages mixes commentary into the aggregate; the phase-aware
		// extraction must win so narration stays excluded.
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output_text: "I'll search for it. The answer is 42.",
			output: [
				{ type: "message", phase: "commentary", content: [{ type: "output_text", text: "I'll search for it." }] },
				{ type: "message", phase: "final_answer", content: [{ type: "output_text", text: "The answer is 42." }] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toBe("The answer is 42.");
	});

	it("keeps an explicit final answer followed by an empty final item", async () => {
		// An empty trailing final_answer item is a relay artifact; it must not
		// discard the authoritative content that precedes it.
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output: [
				{
					type: "message",
					phase: "final_answer",
					content: [{ type: "output_text", text: "Bun 1.3.12 is the latest release." }],
				},
				{ type: "message", phase: "final_answer", content: [] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		const response = await searchXAI(makeParams(makeFetchMock(relayResponse)));

		expect(response.answer).toBe("Bun 1.3.12 is the latest release.");
	});

	it("does not fall back to the aggregate when commentary is present but the final answer is empty", async () => {
		// The aggregate mixes the explicitly tagged commentary in with the
		// answer; restoring it because the phased final item is empty would
		// expose narration as the answer.
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output_text: "I'll search for it. ",
			output: [
				{ type: "message", phase: "commentary", content: [{ type: "output_text", text: "I'll search for it." }] },
				{ type: "message", phase: "final_answer", content: [] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		await expect(searchXAI(makeParams(makeFetchMock(relayResponse)))).rejects.toMatchObject({
			provider: "xai",
			status: 502,
		});
	});

	it("does not fall back to the aggregate when unphased narration precedes an empty final item", async () => {
		// A relay that tags a final_answer item — even an empty one — uses the
		// phase protocol; its authoritative final is empty, so the aggregate
		// (populated from the unphased narration) must not be promoted either.
		const relayResponse = {
			id: "resp-relay",
			model: "grok-4.5",
			output_text: "I'll search for it. ",
			output: [
				{ type: "message", content: [{ type: "output_text", text: "I'll search for it." }] },
				{ type: "message", phase: "final_answer", content: [] },
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		};

		await expect(searchXAI(makeParams(makeFetchMock(relayResponse)))).rejects.toMatchObject({
			provider: "xai",
			status: 502,
		});
	});
});
