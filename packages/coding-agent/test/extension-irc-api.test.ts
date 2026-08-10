/**
 * pi.irc — the scoped IRC ExtensionAPI surface (murmur-4e7n inbound, murmur-l5vv outbound).
 *
 * A narrow door onto the process-global IrcBus so an extension (the murmur bridge) reaches
 * inbound delivery (deliverInbound) and installs the outbound transport (setRemoteTransport)
 * without the bus class ever being exported to extensions.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { IrcApi } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
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

	it("exposes setRemoteTransport and installs it on the global bus (a registered remote ref routes to it)", async () => {
		const irc = await captureIrc();
		expect(typeof irc.setRemoteTransport).toBe("function");
		irc.registerRemotePeer?.({ id: "remote-peer", displayName: "remote-peer" });
		let seen: string | undefined;
		irc.setRemoteTransport?.({
			async send(message) {
				seen = message.to;
				return { to: message.to, outcome: "injected" };
			},
		});
		const receipt = await IrcBus.global().send({ from: "Main", to: "remote-peer", body: "hi" });
		expect(seen).toBe("remote-peer");
		expect(receipt.outcome).toBe("injected");
	});

	it("registerRemotePeer seeds a `remote` ref attributed to the extension, addressable via the transport", async () => {
		const irc = await captureIrc();
		irc.registerRemotePeer?.({ id: "beatrice", displayName: "beatrice" });
		const ref = AgentRegistry.global().get("beatrice");
		expect(ref?.kind).toBe("remote");
		expect(ref?.ownerToken?.startsWith("<inline>:")).toBe(true);

		let seen: string | undefined;
		irc.setRemoteTransport?.({
			async send(message) {
				seen = message.to;
				return { to: message.to, outcome: "injected" };
			},
		});
		const receipt = await IrcBus.global().send({ from: "Main", to: "beatrice", body: "hi" });
		expect(seen).toBe("beatrice");
		expect(receipt.outcome).toBe("injected");
	});

	it("unregisterRemotePeer retracts only the caller's own remote proxies", async () => {
		// A proxy owned by a different extension must not be retractable.
		AgentRegistry.global().register({
			id: "foreign",
			displayName: "foreign",
			kind: "remote",
			session: null,
			status: "running",
			ownerToken: "other-ext",
		});
		const irc = await captureIrc();
		irc.registerRemotePeer?.({ id: "mine", displayName: "mine" });

		expect(irc.unregisterRemotePeer?.("foreign")).toBe(false);
		expect(AgentRegistry.global().get("foreign")).toBeDefined();

		expect(irc.unregisterRemotePeer?.("mine")).toBe(true);
		expect(AgentRegistry.global().get("mine")).toBeUndefined();
	});

	it("registerRemotePeer never clobbers a live local agent or another extension's proxy", async () => {
		const registry = AgentRegistry.global();
		// A live local main session and a proxy owned by a different extension.
		registry.register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: {} as unknown as AgentSession,
			status: "running",
		});
		registry.register({
			id: "foreign",
			displayName: "foreign",
			kind: "remote",
			session: null,
			status: "running",
			ownerToken: "other-ext",
		});
		const irc = await captureIrc();

		// Colliding with a live local agent is refused — the real ref is untouched.
		expect(irc.registerRemotePeer?.({ id: "Main", displayName: "spoof" })).toBe(false);
		expect(registry.get("Main")?.kind).toBe("main");
		expect(registry.get("Main")?.session).not.toBeNull();

		// Colliding with another extension's proxy is refused too.
		expect(irc.registerRemotePeer?.({ id: "foreign" })).toBe(false);
		expect(registry.get("foreign")?.ownerToken).toBe("other-ext");

		// A free id registers; re-registering our own proxy updates it (still ours).
		expect(irc.registerRemotePeer?.({ id: "beatrice", displayName: "beatrice" })).toBe(true);
		expect(irc.registerRemotePeer?.({ id: "beatrice", displayName: "beatrice", status: "idle" })).toBe(true);
		expect(registry.get("beatrice")?.status).toBe("idle");
		expect(registry.get("beatrice")?.ownerToken?.startsWith("<inline>:")).toBe(true);
	});

	it("registerRemotePeer refuses the reserved ids (local root `Main`, broadcast `all`)", async () => {
		// createAgentSession registers the local Main AFTER extensions load, so the registry is empty
		// here — the reservation (not a presence check) is what stops the accepted proxy being silently
		// overwritten by the later local Main registration. `all` is the broadcast pseudo-recipient.
		const irc = await captureIrc();
		expect(irc.registerRemotePeer?.({ id: "Main", displayName: "remote-root" })).toBe(false);
		expect(AgentRegistry.global().get("Main")).toBeUndefined();
		expect(irc.registerRemotePeer?.({ id: "all", displayName: "everyone" })).toBe(false);
		expect(AgentRegistry.global().get("all")).toBeUndefined();
	});
});
