import { describe, expect, it } from "bun:test";
import { readOpenAIErrorEnvelope } from "@oh-my-pi/pi-ai/utils/openai-http";

function failed(body: string): Response {
	return new Response(body, { status: 502, statusText: "Bad Gateway" });
}

describe("readOpenAIErrorEnvelope", () => {
	it("reads the nested envelope's message and prefers code over type", async () => {
		const body = JSON.stringify({
			error: { message: "quota exceeded", code: "insufficient_quota", type: "billing" },
		});
		expect(await readOpenAIErrorEnvelope(failed(body))).toEqual({
			detail: "quota exceeded",
			code: "insufficient_quota",
		});
	});

	it("surfaces flat string errors and top-level messages instead of the JSON body", async () => {
		expect((await readOpenAIErrorEnvelope(failed('{"error":"model overloaded"}'))).detail).toBe("model overloaded");
		expect((await readOpenAIErrorEnvelope(failed('{"message":"not found"}'))).detail).toBe("not found");
	});

	it("reports no detail for an empty envelope so callers fall back to the status text", async () => {
		expect((await readOpenAIErrorEnvelope(failed('{"error":{"message":"","type":"server_error"}}'))).detail).toBe("");
		expect((await readOpenAIErrorEnvelope(failed('{"error":""}'))).detail).toBe("");
	});

	it("returns the raw body when it is not an error envelope", async () => {
		expect((await readOpenAIErrorEnvelope(failed("upstream timed out"))).detail).toBe("upstream timed out");
	});
});
