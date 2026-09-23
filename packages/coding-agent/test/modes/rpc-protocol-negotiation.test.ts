import { expect, it } from "bun:test";
import { MAX_RPC_FRAME_BYTES, RpcFrameDecoder, RpcFrameEncoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import { createRpcOutput, negotiateRpcProtocol } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { isRecord } from "@oh-my-pi/pi-utils";

it.each([
	{ name: "selects v1", versions: [1], finalVersion: 1 },
	{ name: "selects v2", versions: [2], finalVersion: 2 },
	{ name: "switches from v2 to v1", versions: [2, 1], finalVersion: 1 },
	{ name: "preserves v1 after rejecting an unsupported version", versions: [1, 99], finalVersion: 1 },
	{ name: "preserves v2 after rejecting an unsupported version", versions: [2, 99], finalVersion: 2 },
])("RPC negotiation $name", ({ versions, finalVersion }) => {
	const lines: string[] = [];
	const output = createRpcOutput(new RpcFrameEncoder(), {
		write: frames => lines.push(...frames),
	});
	for (const protocolVersion of versions) {
		output(negotiateRpcProtocol({ id: `version-${protocolVersion}`, type: "negotiate_protocol", protocolVersion }));
	}
	// A response above the physical frame limit distinguishes v1 refusal from v2 chunking.
	output({
		id: "overflow",
		type: "response",
		command: "set_todos",
		success: true,
		data: { content: "x".repeat(MAX_RPC_FRAME_BYTES) },
	});

	const physicalFrames: unknown[] = lines.map(line => JSON.parse(line));
	expect(physicalFrames.some(frame => isRecord(frame) && frame.type === "rpc_chunk")).toBe(finalVersion === 2);
	const decoder = new RpcFrameDecoder();
	const frames = physicalFrames.map(frame => decoder.push(frame)).filter(isRecord);
	expect(frames.slice(0, -1)).toMatchObject(
		versions.map(version => ({
			id: `version-${version}`,
			command: "negotiate_protocol",
			...(version === 99
				? { success: false, error: expect.stringContaining("supported: 1, 2") }
				: { success: true, data: { protocolVersion: version } }),
		})),
	);
	const overflow = frames.at(-1);
	expect(overflow).toMatchObject({ id: "overflow", success: finalVersion === 2 });
	if (finalVersion === 1) expect(overflow?.error).toContain("transport limit");
});
