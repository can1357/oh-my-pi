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
import { IrcBus, type RemoteTransport } from "@oh-my-pi/pi-coding-agent/irc/bus";
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

/** A transport that records the delivered id + bare toName and reports success. */
function injectingTransport(onSend?: (to: string, toName: string | undefined) => void): RemoteTransport {
	return {
		async send(message, opts) {
			onSend?.(message.to, opts?.toName);
			return { to: message.to, outcome: "injected" };
		},
	};
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

	it("claims a namespace via setRemoteTransport; a registered peer routes to the transport with its bare name", async () => {
		const irc = await captureIrc();
		expect(typeof irc.setRemoteTransport).toBe("function");
		let seen: string | undefined;
		let seenToName: string | undefined;
		irc.setRemoteTransport?.(
			"cluster-a",
			injectingTransport((to, toName) => {
				seen = to;
				seenToName = toName;
			}),
		);
		const id = irc.registerRemotePeer?.({ name: "beatrice", displayName: "beatrice" });
		expect(id).toBe("@cluster-a/beatrice");
		const receipt = await IrcBus.global().send({ from: "Main", to: "@cluster-a/beatrice", body: "hi" });
		expect(receipt.outcome).toBe("injected");
		expect(seen).toBe("@cluster-a/beatrice");
		expect(seenToName).toBe("beatrice");
	});

	it("registerRemotePeer seeds a `remote` ref at @ns/name attributed to the extension", async () => {
		const irc = await captureIrc();
		irc.setRemoteTransport?.("cluster-a", injectingTransport());
		const id = irc.registerRemotePeer?.({ name: "beatrice", displayName: "beatrice" });
		expect(id).toBe("@cluster-a/beatrice");
		const ref = AgentRegistry.global().get("@cluster-a/beatrice");
		expect(ref?.kind).toBe("remote");
		expect(ref?.displayName).toBe("beatrice");
		expect(ref?.ownerToken?.startsWith("<inline>:")).toBe(true);
	});

	it("registerRemotePeer returns undefined before a namespace is claimed", async () => {
		const irc = await captureIrc();
		expect(irc.registerRemotePeer?.({ name: "beatrice" })).toBeUndefined();
		expect(
			AgentRegistry.global()
				.list()
				.some(ref => ref.kind === "remote"),
		).toBe(false);
	});

	it("registerRemotePeer returns undefined for an invalid bare name", async () => {
		const irc = await captureIrc();
		irc.setRemoteTransport?.("cluster-a", injectingTransport());
		expect(irc.registerRemotePeer?.({ name: "a/b" })).toBeUndefined(); // "/" is the @ns/name separator
		expect(irc.registerRemotePeer?.({ name: "has space" })).toBeUndefined();
		expect(
			AgentRegistry.global()
				.list()
				.some(ref => ref.kind === "remote"),
		).toBe(false);
	});

	it("unregisterRemotePeer retracts only the caller's own proxies (by composed id or bare name)", async () => {
		// A proxy owned by a different extension (a different namespace) must not be retractable.
		AgentRegistry.global().register({
			id: "@other/foreign",
			displayName: "foreign",
			kind: "remote",
			session: null,
			status: "running",
			ownerToken: "other-ext",
		});
		const irc = await captureIrc();
		irc.setRemoteTransport?.("cluster-a", injectingTransport());
		irc.registerRemotePeer?.({ name: "mine" });

		// Ownership-checked: cannot retract a foreign proxy.
		expect(irc.unregisterRemotePeer?.("@other/foreign")).toBe(false);
		expect(AgentRegistry.global().get("@other/foreign")).toBeDefined();

		// Retract by bare name (composed against the claimed namespace)...
		expect(irc.unregisterRemotePeer?.("mine")).toBe(true);
		expect(AgentRegistry.global().get("@cluster-a/mine")).toBeUndefined();

		// ...or by the composed id.
		irc.registerRemotePeer?.({ name: "again" });
		expect(irc.unregisterRemotePeer?.("@cluster-a/again")).toBe(true);
		expect(AgentRegistry.global().get("@cluster-a/again")).toBeUndefined();
	});

	it("setRemoteTransport rejects a second, different namespace from the same extension load", async () => {
		const irc = await captureIrc();
		irc.setRemoteTransport?.("cluster-a", injectingTransport());
		expect(() => irc.setRemoteTransport?.("cluster-b", injectingTransport())).toThrow(/single namespace/);
		// Re-using the SAME namespace is fine (reinstall after a reconnect).
		expect(() => irc.setRemoteTransport?.("cluster-a", injectingTransport())).not.toThrow();
	});
});
