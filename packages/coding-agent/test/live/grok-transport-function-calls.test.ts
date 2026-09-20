import { describe, expect, test } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { GrokLiveTransport } from "../../src/live/grok-transport";
import type { LiveServerEvent } from "../../src/live/protocol";

function functionCallDone(callId: string, request: string): string {
	return JSON.stringify({
		type: "response.function_call_arguments.done",
		call_id: callId,
		arguments: JSON.stringify({ request }),
	});
}

describe("GrokLiveTransport function-call batches", () => {
	test("does not abort when Grok issues another batch while one is pending", () => {
		const events: LiveServerEvent[] = [];
		const transport = new GrokLiveTransport({
			authStorage: {} as AuthStorage,
			sessionId: "s",
			instructions: "delegate work",
			voice: "eve",
			callbacks: {
				onEvent: event => events.push(event),
				onOutputLevel: () => {},
			},
		});

		transport.handleServerMessage(functionCallDone("c1", "inspect the repo"));
		transport.handleServerMessage(JSON.stringify({ type: "response.done" }));
		transport.handleServerMessage(functionCallDone("c2", "run the tests"));
		transport.handleServerMessage(JSON.stringify({ type: "response.done" }));

		expect(events.filter(event => event.type === "error")).toEqual([]);
		const delegations = events.filter(event => event.type === "delegation.created");
		expect(delegations).toHaveLength(1);
		expect(delegations[0]).toMatchObject({
			type: "delegation.created",
			item: { id: "c1" },
		});
	});
});
