import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { GetUserJwtResponseSchema } from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { logger } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

const CONNECT_END_STREAM_FLAG = 0x02;

const devinModel: Model<"devin-agent"> = buildModel({
	id: "devin-test",
	name: "Devin Test",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 64_000,
});

function trailerFrame(error: Record<string, unknown>): Uint8Array {
	const payload = Buffer.from(JSON.stringify({ error }), "utf8");
	const frame = Buffer.alloc(5 + payload.length);
	frame[0] = CONNECT_END_STREAM_FLAG;
	frame.writeUInt32BE(payload.length, 1);
	frame.set(payload, 5);
	return frame;
}

async function runTrailer(error: Record<string, unknown>) {
	const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
	const trailer = trailerFrame(error);
	const fetchImpl = (async (input: string | URL | Request) => {
		if (String(input).includes("GetUserJwt")) return new Response(authPayload);
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(trailer);
					controller.close();
				},
			}),
			{ status: 200 },
		);
	}) as typeof fetch;

	return streamDevin(
		devinModel,
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ apiKey: "token", fetch: fetchImpl },
	).result();
}

describe("streamDevin trailer evidence", () => {
	it("keeps the plain trailer error format when no details are present", async () => {
		const result = await runTrailer({ code: "invalid_argument", message: "Error" });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Devin stream error invalid_argument: Error");
		expect(result.errorMessage).not.toContain("[details:");
	});

	it("appends summarized trailer details to the surfaced error", async () => {
		const result = await runTrailer({
			code: "invalid_argument",
			message: "Error",
			details: [{ type: "google.rpc.DebugInfo", debug: { detail: "field X rejected" } }],
		});

		expect(result.errorMessage).toContain("Devin stream error invalid_argument: Error");
		expect(result.errorMessage).toContain("[details: google.rpc.DebugInfo:");
		expect(result.errorMessage).toContain("field X rejected");
	});

	it("skips malformed details entries while keeping usable ones", async () => {
		const result = await runTrailer({
			code: "invalid_argument",
			message: "boom",
			details: [null, 42, {}, { type: "grpc-status-details-bin" }],
		});

		expect(result.errorMessage).toContain("Devin stream error invalid_argument: boom");
		expect(result.errorMessage).toContain("[details: grpc-status-details-bin]");
	});

	it("leaves the classification-relevant message text untouched", async () => {
		const result = await runTrailer({
			code: "invalid_argument",
			message: "an internal error occurred (trace ID: evidence)",
			details: [{ type: "trace" }],
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("an internal error occurred (trace ID: evidence)");
		expect(result.errorMessage).toContain("[details: trace]");
	});
	it("uses a detail value when no debug rendering is available", async () => {
		const result = await runTrailer({
			code: "invalid_argument",
			message: "Error",
			details: [{ type: "google.rpc.ErrorInfo", value: "encoded-evidence" }],
		});

		expect(result.errorMessage).toContain("[details: google.rpc.ErrorInfo: encoded-evidence]");
	});

	it("bounds details and raw trailer evidence in the warning", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const result = await runTrailer({
			code: "invalid_argument",
			message: "Error",
			details: [{ type: "google.rpc.DebugInfo", debug: { detail: "x".repeat(10_000) } }],
		});

		expect(result.errorMessage?.length).toBeLessThanOrEqual(2100);
		const warning = warnSpy.mock.calls.find(
			([message]) => message === "devin: stream rejected via Connect trailer",
		)?.[1] as Record<string, unknown> | undefined;
		expect(warning).toMatchObject({
			model: "devin-test",
			code: "invalid_argument",
			message: "Error",
			requestBytes: expect.any(Number),
			compressedBytes: expect.any(Number),
			tools: 0,
			messages: 1,
			hadOutput: false,
		});
		expect(warning?.detail).toHaveLength(2001);
		expect(warning?.rawTrailer).toHaveLength(2001);
		expect(warning?.detail).toEndWith("…");
		expect(warning?.rawTrailer).toEndWith("…");
	});
});
