import { describe, expect, test } from "bun:test";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

function fakeAgent() {
	const exited = Promise.withResolvers<number>();
	const encoder = new TextEncoder();
	let output!: ReadableStreamDefaultController<Uint8Array>;
	const proc: RpcAgentProcess = {
		stdin: { write: () => 0 },
		stdout: new ReadableStream<Uint8Array>({
			start(controller) {
				output = controller;
				controller.enqueue(encoder.encode('{"type":"ready"}\n'));
			},
		}),
		peekStderr: () => "",
		kill: () => exited.resolve(0),
		exited: exited.promise,
	};
	return {
		proc,
		emit(frame: unknown) {
			output.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
		},
	};
}

describe("RpcClient session event filter", () => {
	test("forwards every wire session event type to onSessionEvent listeners", async () => {
		const agent = fakeAgent();
		const client = new RpcClient({ spawn: () => agent.proc });
		try {
			await client.start();
			const types: string[] = [];
			const drained = Promise.withResolvers<void>();
			client.onSessionEvent(event => {
				types.push(event.type);
				if (event.type === "queue_update") drained.resolve();
			});

			// The three event types the filter used to drop, followed by an
			// already-accepted type as an in-order drain barrier.
			agent.emit({ type: "config_warnings_changed" });
			agent.emit({ type: "advisor_cost_changed" });
			agent.emit({ type: "advisor_yielded" });
			agent.emit({ type: "queue_update", steering: [], followUp: [], liveSteered: 0 });
			await drained.promise;

			expect(types).toEqual(["config_warnings_changed", "advisor_cost_changed", "advisor_yielded", "queue_update"]);
		} finally {
			await client.stop();
		}
	});
});
