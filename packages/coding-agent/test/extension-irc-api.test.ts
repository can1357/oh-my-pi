/**
 * pi.irc — the scoped inbound-IRC ExtensionAPI surface (murmur-4e7n / PR-A).
 *
 * A narrow door onto the process-global IrcBus: `pi.irc.deliverInbound` delegates to
 * `IrcBus.global().deliverInbound`, so an extension (the murmur bridge) reaches inbound
 * delivery without the bus class ever being exported to extensions.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { IrcApi } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

async function captureIrc(): Promise<IrcApi> {
	let irc: IrcApi | undefined;
	await loadExtensionFromFactory(
		pi => {
			irc = pi.irc;
		},
		process.cwd(),
		new EventBus(),
		new ExtensionRuntime(),
	);
	if (!irc) throw new Error("pi.irc was not exposed to the extension");
	return irc;
}

describe("pi.irc (ExtensionAPI inbound surface)", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	it("delegates to the global bus — a miss returns deliverInbound's failed receipt + a native id", async () => {
		const irc = await captureIrc();
		const { receipt, id } = await irc.deliverInbound({ from: "remote", to: "ghost", body: "hi" });
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/Unknown agent "ghost"/);
		expect(typeof id).toBe("string");
	});

	it("resolves a recipient on the global registry (proves it uses IrcBus.global(), not a fresh bus)", async () => {
		AgentRegistry.global().register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "idle" });
		const irc = await captureIrc();
		IrcBus.global().wait("Main", { from: "peer" }, 1000);
		const { receipt } = await irc.deliverInbound({ from: "peer", to: "Main", body: "hi" });
		expect(receipt.outcome).not.toBe("failed");
	});
});
