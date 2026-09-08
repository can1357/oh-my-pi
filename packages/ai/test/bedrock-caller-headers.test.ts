import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import {
	bedrockTestModel,
	BEDROCK_TEST_CONTEXT,
	type BedrockCapture,
	capturingBedrockFetch,
	withSkippedBedrockAuth,
} from "./helpers/bedrock-stream";

// Caller headers (including `before_provider_headers` extension edits) reach the
// Bedrock request, but SigV4's own headers must never come from the caller:
// `signRequest` signs the caller's value and then RETURNS its own, so the wire
// would carry different bytes than the signature covers and Bedrock would reject
// every request. Exercised through the real signing path, not a unit stub.

function model(): Model<"bedrock-converse-stream"> {
	return bedrockTestModel();
}

const context = BEDROCK_TEST_CONTEXT;

describe("Bedrock caller headers", () => {
	it("forwards caller headers but never lets them supply SigV4's own", async () => {
		const seen: { headers?: Record<string, string> } = {};
		await withSkippedBedrockAuth(async () => {
			const stream = streamBedrock(model(), context, {
				region: "us-east-1",
				fetch: capturingBedrockFetch(seen),
				headers: {
					"x-trace": "kept",
					// Every header SigV4 generates for itself. Signed as the caller's value
					// but sent as the signer's, these would break the signature.
					host: "evil.example.com",
					"x-amz-date": "19700101T000000Z",
					"x-amz-content-sha256": "deadbeef",
					"x-amz-security-token": "forged",
				},
			});
			await stream.result();
		});

		const headers = seen.headers ?? {};
		// The benign caller header still reaches the request: that is the feature.
		expect(headers["x-trace"]).toBe("kept");
		// None of the signer-owned values are the caller's.
		expect(headers.host).not.toBe("evil.example.com");
		expect(headers["x-amz-date"]).not.toBe("19700101T000000Z");
		expect(headers["x-amz-content-sha256"]).not.toBe("deadbeef");
		expect(headers["x-amz-security-token"]).not.toBe("forged");
		// And the request was actually signed, so this is the real path.
		expect(headers.authorization ?? headers.Authorization).toContain("AWS4-HMAC-SHA256");
	});

	// A caller spelling differing only in case leaves two object keys: SigV4 signs
	// one, fetch comma-joins both onto the wire, and AWS rejects the mismatch.
	it("does not leave a differently cased duplicate of a header it sets itself", async () => {
		const seen: { headers?: Record<string, string> } = {};
		await withSkippedBedrockAuth(async () => {
			const stream = streamBedrock(model(), context, {
				region: "us-east-1",
				fetch: capturingBedrockFetch(seen),
				headers: {
					"Content-Type": "text/plain",
					Accept: "text/plain",
					Host: "evil.example.com",
					// Recomputed by the fetch layer from the serialized body, so a caller
					// value would be signed but never sent.
					"Content-Length": "999",
					"X-Trace": "kept",
				},
			});
			await stream.result();
		});

		const headers = seen.headers ?? {};
		const names = Object.keys(headers).map(name => name.toLowerCase());
		// Each field appears exactly once, whatever casing the caller used.
		for (const field of ["content-type", "accept", "host", "content-length"]) {
			expect(names.filter(name => name === field).length).toBeLessThanOrEqual(1);
		}
		expect(headers["content-type"]).toBe("application/json");
		// Ordinary caller headers still land, lower-cased.
		expect(headers["x-trace"]).toBe("kept");
	});
});

describe("amazon-bedrock user-agent default", () => {
	it("defaults user-agent to the shared omp UA when no headers are set", async () => {
		const seen: { headers?: Record<string, string> } = {};
		await withSkippedBedrockAuth(async () => {
			const stream = streamBedrock(model(), context, { region: "us-east-1", fetch: capturingBedrockFetch(seen) });
			await stream.result();
		});

		const headers = seen.headers ?? {};
		expect(headers["user-agent"]).toBe(USER_AGENT);
		expect(headers.authorization ?? headers.Authorization).toContain("AWS4-HMAC-SHA256");
	});

	it("lets a per-call header win over a model-configured header", async () => {
		const seen: { headers?: Record<string, string> } = {};
		const modelWithHeaders = bedrockTestModel({ headers: { "User-Agent": "from-model", "X-Model": "m" } });
		await withSkippedBedrockAuth(async () => {
			const stream = streamBedrock(modelWithHeaders, context, {
				region: "us-east-1",
				fetch: capturingBedrockFetch(seen),
				headers: { "user-agent": "from-caller" },
			});
			await stream.result();
		});

		const headers = seen.headers ?? {};
		const names = Object.keys(headers).map(name => name.toLowerCase());
		expect(names.filter(name => name === "user-agent").length).toBe(1);
		expect(headers["user-agent"]).toBe("from-caller");
		expect(headers["x-model"]).toBe("m");
	});

	it("applies the signer-owned/reserved header filter to model.headers too", async () => {
		const seen: { headers?: Record<string, string> } = {};
		const modelWithHeaders = bedrockTestModel({
			headers: { Host: "evil.example.com", "Content-Type": "text/plain" },
		});
		await withSkippedBedrockAuth(async () => {
			const stream = streamBedrock(modelWithHeaders, context, {
				region: "us-east-1",
				fetch: capturingBedrockFetch(seen),
			});
			await stream.result();
		});

		const headers = seen.headers ?? {};
		const names = Object.keys(headers).map(name => name.toLowerCase());
		expect(headers.host).toBe("bedrock-runtime.us-east-1.amazonaws.com");
		expect(headers["content-type"]).toBe("application/json");
		for (const field of ["host", "content-type"]) {
			expect(names.filter(name => name === field).length).toBe(1);
		}
	});

	it("carries per-call headers from streamSimple through the option mapper", async () => {
		const seen: BedrockCapture = {};
		await withSkippedBedrockAuth(async () => {
			await streamSimple(bedrockTestModel(), BEDROCK_TEST_CONTEXT, {
				fetch: capturingBedrockFetch(seen),
				headers: { "User-Agent": "from-options" },
			}).result();
		});

		expect(seen.headers?.["user-agent"]).toBe("from-options");
	});
});
