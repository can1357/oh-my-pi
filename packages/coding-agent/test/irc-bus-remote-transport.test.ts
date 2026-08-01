/**
 * IrcBus RemoteTransport seam (murmur-l5vv): a local-registry MISS (`!ref`) hands off to an
 * installed transport instead of failing; every other failure mode (aborted / advisor /
 * no-session) stays local `failed` and never touches the transport. This is the loop-safety
 * invariant the murmur bridge relies on — only a genuine cross-process recipient leaves.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IrcBus, type RemoteTransport } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/hub";

function recordingTransport(outcome: "injected" | "failed" = "injected"): { transport: RemoteTransport; seen: IrcMessage[] } {
	const seen: IrcMessage[] = [];
	return {
		seen,
		transport: {
			async send(message) {
				seen.push(message);
				return { to: message.to, outcome };
			},
		},
	};
}

describe("IrcBus RemoteTransport seam", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("fires the transport on a !ref miss and returns its receipt, with the native id already minted", async () => {
		const bus = new IrcBus(AgentRegistry.global());
		const { transport, seen } = recordingTransport("injected");
		bus.setRemoteTransport(transport);

		const receipt = await bus.send({ from: "Main", to: "remote-peer", body: "how goes it", replyTo: "r1" });

		expect(receipt).toEqual({ to: "remote-peer", outcome: "injected" });
		expect(seen).toHaveLength(1);
		const msg = seen[0]!;
		expect(msg.from).toBe("Main");
		expect(msg.to).toBe("remote-peer");
		expect(msg.body).toBe("how goes it");
		expect(msg.replyTo).toBe("r1");
		// send() mints omp's native id/ts BEFORE the miss branch — the transport receives them.
		expect(typeof msg.id).toBe("string");
		expect(msg.id.length).toBeGreaterThan(0);
		expect(msg.ts).toBeGreaterThan(0);
	});

	it("does NOT fire the transport for a live local recipient (stays in-process)", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "idle" });
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport();
		bus.setRemoteTransport(transport);

		// A pending waiter satisfies delivery in-process without a session or the transport.
		const reply = bus.wait("Main", { from: "peer" }, 1000);
		const receipt = await bus.send({ from: "peer", to: "Main", body: "local hello" });

		expect(receipt.outcome).toBe("injected");
		expect(seen).toHaveLength(0);
		expect((await reply)?.body).toBe("local hello");
	});

	it("does NOT fire the transport for an aborted local recipient (stays failed)", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "aborted" });
		const bus = new IrcBus(registry);
		const { transport, seen } = recordingTransport();
		bus.setRemoteTransport(transport);

		const receipt = await bus.send({ from: "peer", to: "Main", body: "hi" });

		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/hard-aborted/);
		expect(seen).toHaveLength(0);
	});

	it("without a transport, a !ref miss still fails with the unknown-agent error", async () => {
		const bus = new IrcBus(AgentRegistry.global());
		const receipt = await bus.send({ from: "Main", to: "ghost", body: "hi" });
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/Unknown agent "ghost"/);
	});

	it("setRemoteTransport(undefined) clears the seam — a miss fails again", async () => {
		const bus = new IrcBus(AgentRegistry.global());
		bus.setRemoteTransport(recordingTransport().transport);
		bus.setRemoteTransport(undefined);

		const receipt = await bus.send({ from: "Main", to: "ghost", body: "hi" });
		expect(receipt.outcome).toBe("failed");
	});
});
