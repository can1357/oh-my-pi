import { describe, expect, it } from "bun:test";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { GetUserJwtResponseSchema } from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

/**
 * Regression for #4228: a Devin Connect frame header advertising an outsized
 * payload length must fail fast with a `ProviderResponseError({ kind:
 * "envelope" })` instead of buffering unbounded data via `Buffer.concat` until
 * the idle-timeout wrapper aborts.
 */

const devinModel: Model<"devin-agent"> = buildModel({
	id: "devin-test",
	name: "Devin Test",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
});

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
};

function corruptFrameHeader(advertisedLen: number): Uint8Array {
	const out = new Uint8Array(5);
	const view = new DataView(out.buffer);
	view.setUint8(0, 0);
	view.setUint32(1, advertisedLen, false);
	return out;
}

describe("streamDevin frame length cap", () => {
	it("rejects a frame advertising a payload above the 16 MiB cap without buffering it", async () => {
		const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
		// 32 MiB advertised — twice the cap, well below UINT32_MAX so the
		// concat-forever bug would silently swallow it on the vulnerable branch.
		const header = corruptFrameHeader(32 * 1024 * 1024);
		let concatBytes = 0;

		const fetchImpl = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("GetUserJwt")) return new Response(authPayload);
			return new Response(
				new ReadableStream<Uint8Array>({
					async pull(controller) {
						// One header + a single 1 MiB filler chunk. The pre-fix reader
						// would keep polling forever waiting for 32 MiB to arrive.
						controller.enqueue(header);
						const filler = new Uint8Array(1024 * 1024);
						concatBytes += filler.length;
						controller.enqueue(filler);
						controller.close();
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		const stream = streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl });
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Devin Connect frame length");
		expect(result.errorMessage).toContain("16777216");
		// Fewer than 2 MiB should ever flow through: the reader must reject the
		// frame the moment it decodes the length prefix, not after a payload
		// arrives.
		expect(concatBytes).toBeLessThan(2 * 1024 * 1024);
	});

	it("carries the envelope diagnostic on the error event and finalized message", async () => {
		const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
		const header = corruptFrameHeader(64 * 1024 * 1024);

		const fetchImpl = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("GetUserJwt")) return new Response(authPayload);
			return new Response(
				new ReadableStream<Uint8Array>({
					async pull(controller) {
						controller.enqueue(header);
						controller.close();
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		const stream = streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl });
		let errorEvent:
			| {
					type: "error";
					error: { errorMessage?: string; stopReason?: string };
			  }
			| undefined;
		for await (const event of stream) {
			if (event.type === "error") {
				errorEvent = event as typeof errorEvent;
			}
		}

		expect(errorEvent).toBeDefined();
		expect(errorEvent?.error.stopReason).toBe("error");
		expect(errorEvent?.error.errorMessage).toContain("67108864");
		expect(errorEvent?.error.errorMessage).toContain("16777216");
	});
});
