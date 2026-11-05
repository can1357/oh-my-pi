/**
 * An agent's end is one authority, and a failure of its end hook must mean the
 * same thing on both sides of a worker link: the agent ENDED, and some of its
 * tree's work could not be cancelled. Without a factory for the error class the
 * receiver gets a plain Error with the right name, `instanceof` fails, and the
 * kill is reported as `already_completed` — the agent reads as having finished
 * on its own, and the caller never hears that work is still running.
 */
import { afterEach, expect, it } from "bun:test";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { cancelAgentRegistration } from "../../src/async/job-control";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentEndHookError, AgentRegistry } from "../../src/registry/agent-registry";
import { type RpcApi, type RpcEndpoint, type RpcFrame, RpcLink, type RpcMethod } from "../../src/thread/rpc";
import type { ToolSession } from "../../src/tools";

const endpoint = (port: MessagePort): RpcEndpoint => ({
	send: frame => port.postMessage(frame),
	listen: handler => {
		const listener = (frame: RpcFrame) => handler(frame);
		port.on("message", listener);
		return () => port.off("message", listener);
	},
});

type ReleaseApi = { release: RpcMethod<[], boolean> };

let channel: MessageChannel | undefined;

afterEach(() => {
	channel?.port1.close();
	channel?.port2.close();
	channel = undefined;
});

for (const route of ["in-process", "across a worker link"] as const) {
	it(`reports a failing end hook as a cancellation ${route}`, async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const lane = registry.register({
			id: "Lane",
			displayName: "Lane",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		registry.onEnd(() => {
			throw new Error("end hook refused");
		});
		channel = new MessageChannel();
		const main = new RpcLink<ReleaseApi, RpcApi>(endpoint(channel.port1), { name: "main" });
		const worker = new RpcLink<RpcApi, ReleaseApi>(endpoint(channel.port2), { name: "worker" });
		main.handle("release", () => lifecycle.release("Lane", lane));
		let transported: unknown;
		const remoteLifecycle = {
			release: async () => {
				try {
					return await worker.call("release");
				} catch (error) {
					transported = error;
					throw error;
				}
			},
		};
		const session = {
			agentRegistry: registry,
			agentLifecycle: () => (route === "in-process" ? lifecycle : remoteLifecycle),
		} as unknown as ToolSession;

		try {
			const outcome = await cancelAgentRegistration(session, "Main", "Lane");

			expect(registry.get("Lane")).toBeUndefined();
			expect(outcome.status).toBe("cancelled");
			expect(outcome.message).toContain("but not all of its tree's work");
			if (route !== "in-process") expect(transported).toBeInstanceOf(AgentEndHookError);
		} finally {
			main.close();
			worker.close();
			await lifecycle.dispose();
		}
	});
}
