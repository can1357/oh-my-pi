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

it("holds raw prompts and continuations until every cleanup releases admission", async () => {
	const mock = createMockModel({ handler: { content: ["done"] } });
	const agent = new Agent({
		initialState: {
			model: mock.model,
			messages: [{ role: "user", content: "continued after cleanup", timestamp: Date.now() }],
		},
		streamFn: mock.stream,
	});
	const outer = agent.holdTurnAdmission();
	const inner = agent.holdTurnAdmission();
	const continuation = agent.continue();
	const prompt = agent.prompt("prompt after cleanup");
	outer();
	await Promise.resolve();
	expect(mock.calls).toHaveLength(0);
	expect(agent.state.isStreaming).toBe(false);
	inner();
	await Promise.all([prompt, continuation]);
	expect(JSON.stringify(mock.calls[0]!.context.messages)).toContain("continued after cleanup");
	expect(JSON.stringify(mock.calls.at(-1)!.context.messages)).toContain("prompt after cleanup");
});

it("revokes a grant when cleanup begins before its claimant resumes", async () => {
	const mock = createMockModel({ handler: { content: ["done"] } });
	const agent = new Agent({ initialState: { model: mock.model }, streamFn: mock.stream });
	const reservation = agent.reserveTurn();
	expect(await reservation.ready).toBe(true);
	const release = agent.holdTurnAdmission();
	release();
	await agent.prompt("revoked", { turnReservation: reservation });
	expect(mock.calls).toHaveLength(0);
	await agent.prompt("fresh submission");
	expect(JSON.stringify(mock.calls[0]!.context.messages)).not.toContain("revoked");
});

it("does not let an ungranted ticket bypass cleanup and blocks superseded claims", async () => {
	const mock = createMockModel({ handler: { content: ["done"] } });
	const agent = new Agent({ initialState: { model: mock.model }, streamFn: mock.stream });
	const release = agent.holdTurnAdmission();
	const waiting = agent.reserveTurn();
	await agent.prompt("too early", { turnReservation: waiting });
	expect(mock.calls).toHaveLength(0);
	release();
	let current = true;
	const reserved = agent.reserveTurn(undefined, () => current);
	await reserved.ready;
	current = false;
	await agent.prompt("superseded", { turnReservation: reserved });
	expect(mock.calls).toHaveLength(0);
	await agent.prompt("current");
	expect(JSON.stringify(mock.calls[0]!.context.messages)).not.toContain("superseded");
});
