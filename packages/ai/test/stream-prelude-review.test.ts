import { expect, it } from "bun:test";
import { holdSseUntilCommit, StreamCommitGate } from "../src/auth-gateway/stream-commit-gate";

it("keeps structural provider frames eligible for fallback", () => {
	const gate = new StreamCommitGate();
	for (const event of ["message_start", "response.output_item.added", "start"])
		expect(gate.classifyAndObserve(event, 10)).toBe("probing");
	expect(gate.classifyAndObserve("response.failed", 10)).toBe("terminated");
});

for (const terminal of [false, true]) {
	it(`preserves a successful ${terminal ? "terminal-only" : "metadata-only EOF"} response`, async () => {
		const bytes =
			"event: response.created\ndata: {}\n\n" + (terminal ? "event: response.completed\ndata: {}\n\n" : "");
		const input = new Response(bytes).body!;
		expect(await new Response(holdSseUntilCommit(input, new StreamCommitGate())).text()).toBe(bytes);
	});
}

it("preserves an oversized prelude chunk when the memory cap forces commitment", async () => {
	const bytes = "event: response.created\ndata: {}\n\n";
	expect(await new Response(holdSseUntilCommit(new Response(bytes).body!, new StreamCommitGate(8))).text()).toBe(
		bytes,
	);
});
