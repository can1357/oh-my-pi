import { expect, it } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Agent } from "../src/agent";

it("admits later prompts in arrival order behind a reserved turn", async () => {
	const mock = createMockModel({ handler: { content: ["done"] } });
	const agent = new Agent({ initialState: { model: mock.model }, streamFn: mock.stream });
	const owner = agent.reserveTurn();
	expect(await owner.ready).toBe(true);
	const first = agent.prompt("first later");
	const second = agent.prompt("second later");
	await agent.prompt("owner", { turnReservation: owner });
	await Promise.all([first, second]);
	expect(mock.calls.map(call => call.context.messages.at(-1)?.content)).toEqual([
		[{ type: "text", text: "owner" }],
		[{ type: "text", text: "first later" }],
		[{ type: "text", text: "second later" }],
	]);
});

it("makes continuations wait behind another reservation", async () => {
	const mock = createMockModel({ handler: { content: ["done"] } });
	const agent = new Agent({
		initialState: { model: mock.model, messages: [{ role: "user", content: "continue me", timestamp: Date.now() }] },
		streamFn: mock.stream,
	});
	const owner = agent.reserveTurn();
	await owner.ready;
	const continuation = agent.continue();
	expect(agent.state.isStreaming).toBe(false);
	owner.release();
	await continuation;
	expect(JSON.stringify(mock.calls[0]!.context.messages)).toContain("continue me");
});

it("removes an aborted queued reservation without blocking the next owner", async () => {
	const agent = new Agent();
	const first = agent.reserveTurn();
	await first.ready;
	const abort = new AbortController();
	const cancelled = agent.reserveTurn(abort.signal);
	const next = agent.reserveTurn();
	abort.abort();
	expect(await cancelled.ready).toBe(false);
	first.release();
	expect(await next.ready).toBe(true);
	next.release();
});

it("releases a reserved claim that fails before the run starts", async () => {
	const agent = new Agent({ initialState: { model: undefined } });
	const owner = agent.reserveTurn();
	await owner.ready;
	const next = agent.reserveTurn();
	try {
		await expect(agent.prompt("cannot dispatch", { turnReservation: owner })).rejects.toThrow("No model configured");
		expect(await next.ready).toBe(true);
	} finally {
		owner.release();
		next.release();
	}
});
