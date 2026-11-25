import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/daemon/client";
import type { DaemonClient, DaemonTunnel } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { IrcDeliveryReceipt, IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/irc-types";
import { AgentMesh } from "@oh-my-pi/pi-coding-agent/irc/mesh-link";
import { AGENT_MESH_KIND, AGENT_MESH_VERSION, type MeshDown } from "@oh-my-pi/pi-coding-agent/irc/mesh-protocol";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** A daemon whose mesh room is one in-memory tunnel: the test plays the room, the mesh link the instance. */
function fakeMeshDaemon() {
	const attached = Promise.withResolvers<(chunk: Uint8Array) => void>();
	const receipt = Promise.withResolvers<IrcDeliveryReceipt>();
	const tunnel = {
		send(data: string | Uint8Array) {
			const text = typeof data === "string" ? data : new TextDecoder().decode(data);
			for (const line of text.split("\n")) {
				if (!line) continue;
				const frame = JSON.parse(line) as { t: string; receipt?: IrcDeliveryReceipt };
				if (frame.t === "receipt" && frame.receipt) {
					receipt.resolve(frame.receipt);
				}
			}
			return true;
		},
		start(onData: (chunk: Uint8Array) => void) {
			attached.resolve(onData);
		},
		close() {},
	} as unknown as DaemonTunnel;
	const client = {
		welcome: { caps: { [AGENT_MESH_KIND]: AGENT_MESH_VERSION } },
		onReconnect: () => () => {},
		open: async () => ({ unit: { id: "mesh-room" }, lease: "lease", created: true }),
		attach: async () => tunnel,
		release: async () => {},
	} as unknown as DaemonClient;
	return {
		client,
		receipt: receipt.promise,
		/** Hand the instance a `deliver` frame from another omp instance in the project. */
		async deliver(frame: Omit<Extract<MeshDown, { t: "deliver" }>, "t">) {
			const onData = await attached.promise;
			onData(new TextEncoder().encode(`${JSON.stringify({ t: "deliver", ...frame })}\n`));
		},
	};
}

const session = {
	sessionManager: { onSessionNameChanged: () => () => {}, getSessionName: () => undefined },
	registerSessionChangeCallback: () => () => {},
} as unknown as AgentSession;

describe("AgentMesh inbound delivery", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("refuses a mesh message addressed to a bridged peer instead of relaying it through the extension transport", async () => {
		const daemon = fakeMeshDaemon();
		vi.spyOn(daemonClient, "daemonClient").mockResolvedValue(daemon.client);
		const relayed: IrcMessage[] = [];
		IrcBus.localForRegistry().setRemoteTransport(
			"demo",
			{
				async send(message) {
					relayed.push(message);
					return { to: message.to, outcome: "injected" };
				},
			},
			"bridge-extension",
		);
		const mesh = new AgentMesh(os.tmpdir(), session);
		try {
			await daemon.deliver({ id: "m1", fromPid: process.pid + 1, from: "Main", to: "@demo/leia", body: "hello" });
			expect(await daemon.receipt).toEqual({
				to: "@demo/leia",
				outcome: "failed",
				error: "Instance mesh messages must target a local agent.",
			});
			expect(relayed).toEqual([]);
		} finally {
			mesh.stop();
		}
	});
});
