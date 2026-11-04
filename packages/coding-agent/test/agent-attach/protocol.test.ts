import { describe, expect, it } from "bun:test";
import { parseAgentAttachClientRequest, parseAgentAttachServerFrame } from "../../src/agent-attach/protocol";

describe("agent attach wire validation", () => {
	it("normalizes discovery requests and rejects stale attach generations", () => {
		expect(
			parseAgentAttachClientRequest({
				v: 1,
				op: "lookup",
				token: "secret",
				ownerSessionId: "owner",
				agentId: "Worker",
				ignored: true,
			}),
		).toEqual({
			v: 1,
			op: "lookup",
			token: "secret",
			ownerSessionId: "owner",
			agentId: "Worker",
		});
		expect(
			parseAgentAttachClientRequest({
				v: 1,
				op: "attach",
				token: "secret",
				ownerSessionId: "owner",
				agentId: "Worker",
				generation: 0,
			}),
		).toBeUndefined();
	});

	it("rejects unsafe acknowledgement IDs before command correlation", () => {
		expect(parseAgentAttachServerFrame({ type: "ack", requestId: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined();
	});
});
