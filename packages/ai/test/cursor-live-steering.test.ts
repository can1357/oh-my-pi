import { describe, expect, it } from "bun:test";
import { CursorSteerInjector } from "@oh-my-pi/pi-ai/providers/cursor/live-steering";
import type { LiveSteerClaim, LiveSteerClaimOptions, LiveSteering, UserMessage } from "@oh-my-pi/pi-ai/types";

type Outcome = "answered" | "rejected" | undefined;

/** A source handing out `batches` one per claim; records each claim's options and outcome. */
function steeringSource(batches: UserMessage[][]): {
	source: LiveSteering;
	outcomes: Outcome[];
	claimOptions: (LiveSteerClaimOptions | undefined)[];
} {
	const outcomes: Outcome[] = [];
	const claimOptions: (LiveSteerClaimOptions | undefined)[] = [];
	const source: LiveSteering = {
		wait: async () => {},
		claim: async (_signal, options): Promise<LiveSteerClaim | undefined> => {
			claimOptions.push(options);
			const messages = batches.shift();
			if (!messages) return undefined;
			const index = outcomes.push(undefined) - 1;
			return {
				messages,
				accept: () => {
					throw new Error("Cursor steering never leaves input to a successor request");
				},
				acceptAnswered: () => {
					outcomes[index] = "answered";
				},
				reject: () => {
					outcomes[index] = "rejected";
				},
			};
		},
	};
	return { source, outcomes, claimOptions };
}

function user(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

/** A Cursor endpoint no other test shares: a failed run turns injection off per endpoint. */
function endpoint(): string {
	return `https://cursor-${crypto.randomUUID()}.test`;
}

describe("CursorSteerInjector", () => {
	it("sends claimed input, asides included, as one user message and records it answered once Cursor appends it", async () => {
		const { source, outcomes, claimOptions } = steeringSource([
			[user("use tabs"), user([{ type: "text", text: " job bg_1 finished " }])],
		]);
		const sent: string[] = [];
		const steer = new CursorSteerInjector(source, endpoint(), text => {
			sent.push(text);
			return "message-1";
		});

		await steer.afterExec();

		expect(claimOptions).toEqual([{ asides: true }]);
		expect(sent).toEqual(["use tabs\n\njob bg_1 finished"]);
		expect(outcomes).toEqual([undefined]);

		// Another message's echo does not confirm it.
		steer.onAppended({ messageId: "message-0", text: "older input" });
		expect(outcomes).toEqual([undefined]);
		expect(steer.delivered).toBe(false);

		steer.onAppended({ messageId: "message-1" });
		expect(outcomes).toEqual(["answered"]);
		expect(steer.delivered).toBe(true);

		await steer.finish(false);
		expect(outcomes).toEqual(["answered"]);
	});

	it("keeps one message unconfirmed at a time", async () => {
		const { source, outcomes } = steeringSource([[user("first")], [user("second")]]);
		const sent: string[] = [];
		const steer = new CursorSteerInjector(source, endpoint(), text => {
			sent.push(text);
			return `message-${sent.length}`;
		});

		await steer.afterExec();
		await steer.afterExec();
		expect(sent).toEqual(["first"]);

		steer.onAppended({ messageId: "message-1" });
		await steer.afterExec();
		expect(sent).toEqual(["first", "second"]);
		expect(outcomes).toEqual(["answered", undefined]);
	});

	it("returns input to the caller when the run cannot take it", async () => {
		const { source, outcomes } = steeringSource([[user("use tabs")]]);
		const steer = new CursorSteerInjector(source, endpoint(), () => {
			throw new Error("Cursor run ended");
		});

		await steer.afterExec();

		expect(outcomes).toEqual(["rejected"]);
		expect(steer.delivered).toBe(false);
	});

	it("returns unconfirmed input when the run ends, and stops claiming", async () => {
		const { source, outcomes, claimOptions } = steeringSource([[user("use tabs")], [user("later")]]);
		const runEndpoint = endpoint();
		const steer = new CursorSteerInjector(source, runEndpoint, () => "message-1");

		await steer.afterExec();
		await steer.finish(false);
		await steer.afterExec();

		expect(outcomes).toEqual(["rejected"]);
		expect(claimOptions).toHaveLength(1);
		expect(CursorSteerInjector.available(runEndpoint)).toBe(true);
	});

	it("turns injection off for the endpoint after a run fails with input unconfirmed", async () => {
		const failedEndpoint = endpoint();
		const failed = steeringSource([[user("use tabs")]]);
		const steer = new CursorSteerInjector(failed.source, failedEndpoint, () => "message-1");
		await steer.afterExec();
		await steer.finish(true);

		expect(failed.outcomes).toEqual(["rejected"]);
		expect(CursorSteerInjector.available(failedEndpoint)).toBe(false);
		expect(CursorSteerInjector.available(endpoint())).toBe(true);

		const next = steeringSource([[user("later")]]);
		await new CursorSteerInjector(next.source, failedEndpoint, () => "message-2").afterExec();
		expect(next.claimOptions).toHaveLength(0);
	});
});
