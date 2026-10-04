import { afterEach, describe, expect, it, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { executeSend } from "@oh-my-pi/pi-coding-agent/irc/messaging";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

afterEach(() => vi.restoreAllMocks());

describe("direct IRC delivery receipts", () => {
	it("distinguishes a new recipient turn from a context-only delivery", async () => {
		const registry = new AgentRegistry();
		let outcome: "woken" | "injected" = "woken";
		const session = { deliverIrcMessage: async () => outcome } as unknown as AgentSession;
		registry.register({ id: "Worker", displayName: "worker", kind: "sub", session });
		vi.spyOn(IrcBus, "global").mockReturnValue(new IrcBus(registry));
		const woken = await executeSend({ registry, senderId: "Main" }, { to: "Worker", message: "ping" });
		expect(woken.content).toEqual([
			{ type: "text", text: "Delivered to Worker; it started a turn to handle the message." },
		]);
		expect(woken.details?.receipts).toEqual([{ to: "Worker", outcome: "woken" }]);
		outcome = "injected";
		const injected = await executeSend({ registry, senderId: "Main" }, { to: "Worker", message: "another ping" });
		expect(injected.content).toEqual([
			{ type: "text", text: "Delivered to Worker; added to its context without starting a turn." },
		]);
		expect(injected.details?.receipts).toEqual([{ to: "Worker", outcome: "injected" }]);
	});
});
