import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { type RpcAgentProcess, RpcCommandError } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type {
	RpcAttachedFrame,
	RpcCommandOutputFrame,
	RpcConfigUpdateFrame,
	RpcHostFrame,
	RpcSessionReplacedFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { SessionHostFixture, waitFor } from "./helpers/session-host-harness";

let fixture: SessionHostFixture;

beforeEach(async () => {
	fixture = await SessionHostFixture.create();
});
afterEach(async () => {
	await fixture.dispose();
});

const isConfigUpdate = (frame: RpcHostFrame): frame is RpcConfigUpdateFrame => frame.type === "config_update";
const isAssistantEntry = (frame: RpcHostFrame): boolean =>
	frame.type === "entry" && frame.entry.type === "message" && frame.entry.message.role === "assistant";

describe("RpcClient host frames", () => {
	it("delivers attached, entries, session_replaced and command output, registered before start, in seq order", async () => {
		const host = await fixture.startHost();
		const client = await fixture.client(host);
		const frames: RpcHostFrame[] = [];
		client.onHostFrame(frame => frames.push(frame));
		await client.start();

		await client.promptAndWait("hi");
		await waitFor(() => frames.some(isAssistantEntry));
		await client.newSession();
		await client.prompt("/session");

		// `session_replaced` and `command_output` precede their command's response on the wire, so both are in.
		const attached = frames[0] as RpcAttachedFrame;
		expect(attached).toMatchObject({ type: "attached", hostId: host.hostId });
		expect(attached.snapshot.state.sessionId).toBeDefined();

		const roles = frames.flatMap(f =>
			f.type === "entry" && f.entry.type === "message" ? [f.entry.message.role] : [],
		);
		expect(roles.slice(0, 2)).toEqual(["user", "assistant"]);

		const replaced = frames.find((f): f is RpcSessionReplacedFrame => f.type === "session_replaced")!;
		expect(replaced).toMatchObject({ reason: "new", snapshot: { header: { id: host.session.sessionId } } });
		const output = frames.find((f): f is RpcCommandOutputFrame => f.type === "command_output")!;
		expect(output.text).toContain(`Session: ${host.session.sessionId}`);

		const order = (type: RpcHostFrame["type"]): number => frames.findIndex(f => f.type === type);
		expect(order("attached")).toBe(0);
		expect(order("entry")).toBeLessThan(order("session_replaced"));
		expect(order("session_replaced")).toBeLessThan(order("command_output"));

		// Frames the host stamps keep their `seq`; arrival order is seq order.
		const seqs = frames.flatMap(f => ("seq" in f && typeof f.seq === "number" ? [f.seq] : []));
		expect(seqs.length).toBeGreaterThan(3);
		expect(seqs[0]).toBe(attached.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);
	});

	it("stops delivering to a listener once it unsubscribes, without affecting the others", async () => {
		const host = await fixture.startHost();
		const client = await fixture.client(host);
		const seen: string[] = [];
		const outputs: string[] = [];
		const unsubscribe = client.onHostFrame(frame => seen.push(frame.type));
		client.onHostFrame(frame => void (frame.type === "command_output" && outputs.push(frame.text)));
		await client.start();
		// The host reports this client's own arrival right behind `attached`.
		await waitFor(() => seen.includes("clients_changed"));
		unsubscribe();
		const before = [...seen];
		await client.prompt("/session");
		expect(outputs).toHaveLength(1);
		expect(seen).toEqual(before);
	});

	it("shows every attached client a model or thinking change one of them made", async () => {
		const host = await fixture.startHost();
		const a = await fixture.client(host);
		const b = await fixture.client(host);
		const seenByA: RpcConfigUpdateFrame[] = [];
		const seenByB: RpcConfigUpdateFrame[] = [];
		a.onHostFrame(frame => void (isConfigUpdate(frame) && seenByA.push(frame)));
		b.onHostFrame(frame => void (isConfigUpdate(frame) && seenByB.push(frame)));
		await a.start();
		await b.start();

		await a.setModel("anthropic", "claude-opus-4-5");
		await waitFor(() => seenByB.length === 1);
		for (const frames of [seenByA, seenByB]) {
			expect(frames[0]).toMatchObject({ model: { provider: "anthropic", id: "claude-opus-4-5" } });
			expect(frames[0].thinkingLevel).toBe(host.session.thinkingLevel);
		}

		// The selector `cycleThinkingLevel` returns can be `auto`; the frame carries the effective level.
		expect(await b.cycleThinkingLevel()).not.toBeNull();
		await waitFor(() => seenByA.length === 2);
		for (const frames of [seenByA, seenByB]) expect(frames[1].thinkingLevel).toBe(host.session.thinkingLevel);
	});

	it("rejects every mutating control sent against a stale epoch with the host's current epoch, changing nothing", async () => {
		const host = await fixture.startHost();
		const client = await fixture.client(host);
		let attached: RpcAttachedFrame | undefined;
		const configUpdates: RpcConfigUpdateFrame[] = [];
		client.onHostFrame(frame => {
			if (frame.type === "attached") attached = frame;
			if (isConfigUpdate(frame)) configUpdates.push(frame);
		});
		await client.start();
		await waitFor(() => attached !== undefined);
		const stale = { ifEpoch: attached!.epoch };
		await client.newSession();
		const { model, thinkingLevel } = host.session;
		const entriesBefore = host.session.sessionManager.getEntries().length;

		const controls: Array<() => Promise<unknown>> = [
			() => client.prompt("late", undefined, undefined, stale),
			() => client.steer("late", undefined, stale),
			() => client.followUp("late", undefined, stale),
			() => client.removeQueuedMessage("late", "followUp", stale),
			() => client.setModel("anthropic", "claude-opus-4-5", stale),
			() => client.cycleModel(stale),
			() => client.setThinkingLevel(Effort.High, stale),
			() => client.cycleThinkingLevel(stale),
		];
		for (const control of controls) {
			const error = await control().then(
				() => undefined,
				(rejection: unknown) => rejection,
			);
			expect(error).toBeInstanceOf(RpcCommandError);
			expect(error).toMatchObject({ code: "stale" });
			expect((error as RpcCommandError).epoch).toBeGreaterThan(stale.ifEpoch);
		}

		expect(host.session.model).toBe(model);
		expect(host.session.thinkingLevel).toBe(thinkingLevel);
		expect(host.session.sessionManager.getEntries().length).toBe(entriesBefore);
		expect(configUpdates).toEqual([]);

		// The same control without preconditions (the stdio shape) still runs.
		await client.setThinkingLevel(Effort.High);
		expect(host.session.thinkingLevel).toBe(Effort.High);
	});

	it("forwards only ifEpoch and ifLeaf from a guard object with other keys, so it cannot rewrite the command", async () => {
		const host = await fixture.startHost();
		const client = await fixture.client(host);
		let attached: RpcAttachedFrame | undefined;
		const outputs: string[] = [];
		client.onHostFrame(frame => {
			if (frame.type === "attached") attached = frame;
			if (frame.type === "command_output") outputs.push(frame.text);
		});
		await client.start();
		await waitFor(() => attached !== undefined);
		// Structurally a valid guard, but its extra keys name fields of the commands it travels on.
		const guard = {
			ifEpoch: attached!.epoch,
			type: "exit",
			level: "off",
			provider: "nope",
			modelId: "nope",
			message: "/shake bogus",
		};

		await client.setThinkingLevel(Effort.High, guard);
		expect(host.session.thinkingLevel).toBe(Effort.High);
		await client.setModel("anthropic", "claude-opus-4-5", guard);
		expect(host.session.model).toMatchObject({ provider: "anthropic", id: "claude-opus-4-5" });
		expect(await client.cycleThinkingLevel(guard)).not.toBeNull();
		await client.prompt("/session", undefined, undefined, guard);
		expect(outputs).toHaveLength(1);
		expect(outputs[0]).toContain(`Session: ${host.session.sessionId}`);

		// An `exit` forwarded from the guard would have stopped the host as its last client.
		expect(host.exited).toBe(false);
		expect((await client.getState()).sessionId).toBe(host.session.sessionId);
	});

	it("rejects a control whose ifLeaf is not the session's leaf, including an explicit null", async () => {
		const host = await fixture.startHost();
		const client = await fixture.client(host);
		await client.start();
		await client.promptAndWait("hi");
		await client.waitForSettled();
		const leafId = host.session.sessionManager.getLeafId();
		expect(leafId).not.toBeNull();
		const thinkingLevel = host.session.thinkingLevel;

		await expect(client.setThinkingLevel(Effort.High, { ifLeaf: "not-the-leaf" })).rejects.toMatchObject({
			code: "stale",
			leafId,
		});
		// null names the empty session: forwarded, not dropped like an unset guard.
		await expect(client.setThinkingLevel(Effort.High, { ifLeaf: null })).rejects.toMatchObject({
			code: "stale",
			leafId,
		});
		expect(host.session.thinkingLevel).toBe(thinkingLevel);

		await client.setThinkingLevel(Effort.High, { ifLeaf: leafId });
		expect(host.session.thinkingLevel).toBe(Effort.High);
	});

	it("tells close listeners once when the transport drops, but not for stop() or detach()", async () => {
		const host = await fixture.startHost();
		let transport: RpcAgentProcess | undefined;
		const dropped = await fixture.client(host, { onTransport: t => void (transport = t) });
		const closes: Error[] = [];
		const removed: Error[] = [];
		dropped.onClose(error => closes.push(error));
		const unsubscribe = dropped.onClose(error => removed.push(error));
		unsubscribe();
		await dropped.start();
		await fixture.waitForClients(host, 1);

		transport!.kill();
		await waitFor(() => closes.length === 1);
		await fixture.waitForClients(host, 0);
		expect(closes[0]).toBeInstanceOf(Error);
		expect(removed).toEqual([]);

		const stopped = await fixture.client(host);
		const detached = await fixture.client(host);
		const quiet: Error[] = [];
		stopped.onClose(error => quiet.push(error));
		detached.onClose(error => quiet.push(error));
		await stopped.start();
		await detached.start();
		await stopped.stop();
		await detached.detach();
		await fixture.waitForClients(host, 0);
		await dropped.stop();
		expect(closes).toHaveLength(1);
		expect(quiet).toEqual([]);
		expect(host.exited).toBe(false);
	});
});
