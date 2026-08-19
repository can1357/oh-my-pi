import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IrcBus, type IrcDeliveryReceipt } from "@pk-nerdsaver-ai/pi-coding-agent/irc/bus";
import { canonicalIrcCwd, IrcIpc, type IrcRemotePeer, ircCwdKey } from "@pk-nerdsaver-ai/pi-coding-agent/irc/ipc";
import { resolveCollaborationPolicy } from "@pk-nerdsaver-ai/pi-coding-agent/orchestration/collaboration-policy";
import { AgentRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";

interface FakeRemoteTransport {
	ipc: IrcIpc;
	transportCalls: () => number;
}

function fakeRemoteTransport(
	status: IrcRemotePeer["status"] = "running",
	outcomes: readonly IrcDeliveryReceipt["outcome"][] = [],
): FakeRemoteTransport {
	let calls = 0;
	const peer: IrcRemotePeer = {
		id: "Remote@remote-process",
		localId: "Remote",
		processId: "remote-process",
		displayName: "remote",
		kind: "sub",
		status,
		lastActivity: Date.now(),
		unread: 0,
	};
	const ipc = {
		send: async (
			_targetId: string,
			_message: unknown,
			_opts: unknown,
			authorize?: (candidate: IrcRemotePeer) => string | undefined,
		): Promise<IrcDeliveryReceipt> => {
			const error = authorize?.(peer);
			if (error) return { to: peer.id, outcome: "failed", error };
			const outcome = outcomes[calls] ?? "injected";
			calls++;
			return outcome === "failed"
				? { to: peer.id, outcome, error: "remote transport failed" }
				: { to: peer.id, outcome };
		},
	};
	return { ipc: ipc as unknown as IrcIpc, transportCalls: () => calls };
}

describe("cross-process IRC collaboration policy", () => {
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("filters remote discovery through the viewer's peer scope", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "ompk-irc-policy-"));
		const descriptorDir = path.join(os.tmpdir(), "omp-irc", ircCwdKey(await canonicalIrcCwd(cwd)));
		const localRegistry = new AgentRegistry();
		const remoteRegistry = new AgentRegistry();
		const localIpc = new IrcIpc();
		const remoteIpc = new IrcIpc();

		localRegistry.register({ id: "Viewer", displayName: "viewer", kind: "sub", session: null });
		remoteRegistry.register({ id: "Allowed", displayName: "allowed", kind: "sub", session: null });
		remoteRegistry.register({ id: "Hidden", displayName: "hidden", kind: "sub", session: null });

		try {
			await localIpc.configure({ cwd, registry: localRegistry, bus: new IrcBus(localRegistry) });
			await remoteIpc.configure({ cwd, registry: remoteRegistry, bus: new IrcBus(remoteRegistry) });

			const unrestricted = await localIpc.list("Viewer");
			expect(unrestricted.map(peer => peer.localId).sort()).toEqual(["Allowed", "Hidden"]);
			const allowedId = unrestricted.find(peer => peer.localId === "Allowed")?.id;
			if (!allowedId) throw new Error("Expected the allowed remote peer to be discoverable.");

			localRegistry.setCollaborationPolicy(
				"Viewer",
				resolveCollaborationPolicy({ mode: "message-peers", peerScope: "allowed", allowedPeers: [allowedId] }),
			);
			expect((await localIpc.list("Viewer")).map(peer => peer.id)).toEqual([allowedId]);

			localRegistry.setCollaborationPolicy(
				"Viewer",
				resolveCollaborationPolicy({ mode: "report-only", parentId: "LocalParent" }),
			);
			expect(await localIpc.list("Viewer")).toEqual([]);
		} finally {
			await Promise.all([localIpc.stop(), remoteIpc.stop()]);
			await Promise.all([
				rm(cwd, { recursive: true, force: true }),
				rm(descriptorDir, { recursive: true, force: true }),
			]);
		}
	});

	it("rejects an out-of-scope remote send before transport", async () => {
		const registry = new AgentRegistry();
		const bus = new IrcBus(registry);
		const remote = fakeRemoteTransport();
		bus.attachIpc(remote.ipc);
		registry.register({
			id: "Child",
			displayName: "child",
			kind: "sub",
			session: null,
			collaborationPolicy: resolveCollaborationPolicy({ mode: "report-only", parentId: "Main" }),
		});

		const receipt = await bus.send({ from: "Child", to: "Remote@remote-process", body: "should be denied" });

		expect(receipt).toMatchObject({ to: "Remote@remote-process", outcome: "failed" });
		expect(receipt.error).toContain("report-only-parent-only");
		expect(remote.transportCalls()).toBe(0);
	});

	it("applies remote wake budgets before transport", async () => {
		const registry = new AgentRegistry();
		const bus = new IrcBus(registry);
		const remote = fakeRemoteTransport("idle");
		bus.attachIpc(remote.ipc);
		registry.register({
			id: "Sender",
			displayName: "sender",
			kind: "sub",
			session: null,
			collaborationPolicy: resolveCollaborationPolicy({
				mode: "message-peers",
				peerScope: "all",
				wakePolicy: "allow",
				wakeBudget: 1,
			}),
		});

		expect((await bus.send({ from: "Sender", to: "Remote@remote-process", body: "first" })).outcome).toBe("injected");
		const second = await bus.send({ from: "Sender", to: "Remote@remote-process", body: "second" });

		expect(second).toMatchObject({ to: "Remote@remote-process", outcome: "failed" });
		expect(second.error).toContain("wake-budget-exhausted");
		expect(remote.transportCalls()).toBe(1);
	});

	it("restores remote wake budget when delivery fails", async () => {
		const registry = new AgentRegistry();
		const bus = new IrcBus(registry);
		const remote = fakeRemoteTransport("idle", ["failed", "injected"]);
		bus.attachIpc(remote.ipc);
		registry.register({
			id: "Sender",
			displayName: "sender",
			kind: "sub",
			session: null,
			collaborationPolicy: resolveCollaborationPolicy({
				mode: "message-peers",
				peerScope: "all",
				wakePolicy: "allow",
				wakeBudget: 1,
			}),
		});

		const failed = await bus.send({ from: "Sender", to: "Remote@remote-process", body: "first" });
		const retried = await bus.send({ from: "Sender", to: "Remote@remote-process", body: "retry" });

		expect(failed).toMatchObject({ outcome: "failed", error: "remote transport failed" });
		expect(retried.outcome).toBe("injected");
		expect(remote.transportCalls()).toBe(2);
	});
});
