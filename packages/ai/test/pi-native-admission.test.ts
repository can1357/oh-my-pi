import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import type { AuthGatewayServerHandle } from "@oh-my-pi/pi-ai/auth-gateway/types";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamPiNative } from "@oh-my-pi/pi-ai/providers/pi-native-client";
import {
	PI_NATIVE_ADMISSION_PATH,
	PI_NATIVE_ADMISSION_VERSION,
	PI_NATIVE_GOVERNED_STREAM_PATH,
	isPiNativeAdmissionEvent,
	type PiNativeAdmissionEvent,
} from "@oh-my-pi/pi-ai/providers/pi-native-admission";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { readSseJson, TempDir } from "@oh-my-pi/pi-utils";

interface NativeGatewayFixture {
	model: Model<"openai-completions">;
	requests: Array<{ model: string }>;
	close(): Promise<void>;
}

const context: Context = {
	systemPrompt: ["Return the requested answer."],
	messages: [{ role: "user", content: "Answer once.", timestamp: 0 }],
};

async function nativeGateway(
	options: { failFirst?: boolean; onFirst?: () => void; holdResponse?: Promise<void> } = {},
): Promise<NativeGatewayFixture> {
	const temp = TempDir.createSync("@pi-native-admission-");
	const requests: Array<{ model: string }> = [];
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as { model: string };
			requests.push({ model: body.model });
			if (requests.length === 1) {
				options.onFirst?.();
				if (options.failFirst) {
					return new Response("temporarily unavailable", { status: 503, headers: { "Retry-After": "0" } });
				}
			}
			await options.holdResponse;
			return new Response(
				`data: ${JSON.stringify({
					id: "native-result",
					object: "chat.completion.chunk",
					model: body.model,
					choices: [{ index: 0, delta: { content: "The approved answer." }, finish_reason: "stop" }],
					usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
				})}\n\ndata: [DONE]\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
	const model = buildModel({
		id: "native-admission-model",
		name: "Native admission model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: upstream.url.toString(),
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});
	let gateway: AuthGatewayServerHandle | undefined;
	let storage: AuthStorage | undefined;
	try {
		storage = await AuthStorage.create(path.join(temp.path(), "auth.db"));
		storage.keys.setRuntime(model.provider, "native-upstream-test-key");
		gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["native-origin-a", "native-origin-b"],
			storage,
			resolveModel: id => (id === `${model.provider}/${model.id}` ? model : undefined),
			version: "native-admission-test",
		});
		const currentGateway = gateway;
		const currentStorage = storage;
		return {
			model: { ...model, baseUrl: gateway.url, transport: "pi-native" },
			requests,
			async close() {
				await currentGateway.close();
				upstream.stop(true);
				currentStorage.close();
				temp.removeSync();
			},
		};
	} catch (error) {
		await gateway?.close();
		upstream.stop(true);
		storage?.close();
		temp.removeSync();
		throw error;
	}
}

const selectedOptions = {
	apiKey: "native-origin-a",
	preserveModelSelection: true,
	streamFirstEventTimeoutMs: 5000,
	streamIdleTimeoutMs: 5000,
};

describe("governed pi-native origin admission", () => {
	it("serves the selected model through a gateway retry when the origin still admits it", async () => {
		const fixture = await nativeGateway({ failFirst: true });
		try {
			const response = await streamPiNative(fixture.model, context, {
				...selectedOptions,
			}).result();
			expect(response.stopReason).toBe("stop");
			expect(
				response.content
					.filter(part => part.type === "text")
					.map(part => part.text)
					.join(""),
			).toBe("The approved answer.");
			expect(fixture.requests).toEqual([{ model: fixture.model.id }, { model: fixture.model.id }]);
		} finally {
			await fixture.close();
		}
	});

	it("does not issue a gateway retry after the origin revokes permission during a 503", async () => {
		let permitted = true;
		const fixture = await nativeGateway({
			failFirst: true,
			onFirst: () => {
				permitted = false;
			},
		});
		try {
			const response = streamPiNative(fixture.model, context, {
				...selectedOptions,
				onBeforeRequest: () => {
					if (!permitted) throw new AIError.ModelSelectionError("Origin permission was revoked.");
				},
			});
			await expect(response.result()).rejects.toBeInstanceOf(AIError.ModelSelectionError);
			expect(fixture.requests).toEqual([{ model: fixture.model.id }]);
		} finally {
			await fixture.close();
		}
	});

	it("binds a one-use approval to the originating authenticated request", async () => {
		const upstreamReceived = Promise.withResolvers<void>();
		const releaseResponse = Promise.withResolvers<void>();
		const fixture = await nativeGateway({
			onFirst: () => upstreamReceived.resolve(),
			holdResponse: releaseResponse.promise,
		});
		const controller = new AbortController();
		let source: AsyncGenerator<unknown> | undefined;
		try {
			const response = await fetch(`${fixture.model.baseUrl}${PI_NATIVE_GOVERNED_STREAM_PATH}`, {
				method: "POST",
				headers: { Authorization: "Bearer native-origin-a", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: `${fixture.model.provider}/${fixture.model.id}`,
					context,
					options: { preserveModelSelection: true },
					stream: true,
					admission: { version: PI_NATIVE_ADMISSION_VERSION },
				}),
				signal: controller.signal,
			});
			expect(response.status).toBe(200);
			source = readSseJson<unknown>(response.body!, controller.signal);
			let pending: PiNativeAdmissionEvent | undefined;
			while (!pending) {
				const next = await source.next();
				if (next.done) throw new Error("Gateway ended before origin admission.");
				if (isPiNativeAdmissionEvent(next.value)) pending = next.value;
			}
			const decide = (authorization: string) =>
				fetch(`${fixture.model.baseUrl}${PI_NATIVE_ADMISSION_PATH}`, {
					method: "POST",
					headers: { Authorization: authorization, "Content-Type": "application/json" },
					body: JSON.stringify({ requestId: pending.requestId, nonce: pending.nonce, allow: true }),
					signal: controller.signal,
				});
			expect((await decide("Bearer native-origin-b")).status).toBe(404);
			expect(fixture.requests).toEqual([]);
			expect((await decide("Bearer native-origin-a")).status).toBe(200);
			await upstreamReceived.promise;
			expect((await decide("Bearer native-origin-a")).status).toBe(404);
			expect(fixture.requests).toEqual([{ model: fixture.model.id }]);
			releaseResponse.resolve();
			let completed = false;
			for (;;) {
				const next = await source.next();
				if (next.done) break;
				if (typeof next.value === "object" && next.value !== null && "type" in next.value) {
					if (next.value.type === "done") completed = true;
				}
			}
			expect(completed).toBe(true);
		} finally {
			releaseResponse.resolve();
			controller.abort();
			await source?.return(undefined);
			await fixture.close();
		}
	});

	it("does not use an older unguarded endpoint when origin admission is unavailable", async () => {
		let inferenceRequests = 0;
		const oldGateway = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/v1/pi/stream") {
					inferenceRequests++;
					return new Response("unguarded inference", { status: 200 });
				}
				return new Response("unsupported endpoint", { status: 404 });
			},
		});
		try {
			const model = buildModel({
				id: "old-gateway-model",
				name: "Old gateway model",
				api: "openai-completions",
				provider: "openai",
				baseUrl: oldGateway.url.toString(),
				transport: "pi-native",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 1024,
			});
			await expect(streamPiNative(model, context, selectedOptions).result()).rejects.toBeInstanceOf(
				AIError.AuthGatewayError,
			);
			expect(inferenceRequests).toBe(0);
		} finally {
			oldGateway.stop(true);
		}
	});
});
