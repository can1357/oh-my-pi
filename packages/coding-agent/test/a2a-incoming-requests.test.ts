import { describe, expect, it } from "bun:test";
import { IncomingRequests } from "../src/a2a/incoming-requests";

describe("incoming A2A requests", () => {
	it("scopes consumption to the addressed agent and peer", async () => {
		const registry = new IncomingRequests();
		const first = { to: "agent-a", from: "peer", messageId: "a", at: 1 };
		const other = { to: "agent-b", from: "peer", messageId: "b", at: 2 };
		await registry.note(first);
		await registry.note(other);
		expect(await registry.consume({ to: "agent-b", from: "peer", messageId: "a" })).toBeUndefined();
		expect(await registry.consume({ to: "agent-b", from: "other" })).toBeUndefined();
		expect(await registry.consume({ to: "agent-b", from: "peer" })).toEqual(other);
		expect(await registry.list()).toEqual([first]);
	});

	it("lists and consumes oldest matching requests, or a specific message", async () => {
		const registry = new IncomingRequests();
		const first = { to: "agent", from: "peer", messageId: "first", at: 1 };
		const second = { to: "agent", from: "peer", messageId: "second", at: 2 };
		const third = { to: "agent", from: "peer", messageId: "third", at: 3 };
		await registry.note(first);
		await registry.note(second);
		await registry.note(third);
		expect(await registry.list("agent")).toEqual([first, second, third]);
		expect(await registry.list("missing")).toEqual([]);
		expect(await registry.consume({ to: "agent", from: "peer", messageId: "second" })).toEqual(second);
		expect(await registry.consume({ to: "agent", from: "peer" })).toEqual(first);
		expect(await registry.consume({ to: "agent" })).toEqual(third);
		expect(await registry.consume({ to: "agent" })).toBeUndefined();
	});

	it("gives exactly one concurrent consumer the request", async () => {
		const registry = new IncomingRequests();
		const request = { to: "agent", from: "peer", messageId: "one", at: 1 };
		await registry.note(request);
		const results = await Promise.all([
			registry.consume({ to: "agent", messageId: "one" }),
			registry.consume({ to: "agent", from: "peer" }),
		]);
		expect(results.filter(result => result !== undefined)).toEqual([request]);
		expect(await registry.list()).toEqual([]);
	});
});
