import { afterEach, describe, expect, test } from "bun:test";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai";
import { fingerprintBearer } from "../src/auth/bearer-fingerprint";
import { streamSimple } from "../src/stream";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "../src/types";
import { configureUsageAdmission, UsageRouteInvalidatedError } from "../src/usage-governor/admission";
import type { UsageAdmission, UsageRouteBinding } from "../src/usage-governor/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

const api = "usage-binding-test" as Api;
const source = "usage-binding-test";
const model = {
	id: "test-model",
	name: "Test",
	api,
	provider: "test-provider",
	contextWindow: 1000,
	maxTokens: 100,
} as Model<Api>;
const context: Context = { systemPrompt: [], messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const usageContext = { source: "subagent" as const, sessionId: "session" };
const binding: UsageRouteBinding = {
	scopeId: "scope",
	revision: 1,
	owner: { kind: "role", role: "task" },
	target: { selector: "test-provider/test-model", provider: model.provider, modelId: model.id },
	credentialId: 17,
	intent: "proactive",
	bearerFingerprint: fingerprintBearer("bound-secret"),
};
const bound = { apiKey: "bound-secret", credentialId: 17, usageRouteBinding: binding };

function admission(active = true): UsageAdmission {
	return {
		active,
		validateRoute: (route, request) =>
			route === binding &&
			request.credentialId === 17 &&
			request.bearerFingerprint === binding.bearerFingerprint &&
			request.provider === model.provider &&
			request.modelId === model.id &&
			request.context?.sessionId === usageContext.sessionId,
		admit: async () => ({ id: "grant", waitedMs: 0 }),
		settle: () => {},
	};
}

function transport(keys: unknown[], succeeds: (key: unknown) => boolean): void {
	registerCustomApi(
		api,
		(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
			const key = options?.apiKey;
			keys.push(key);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (!succeeds(key)) {
					stream.fail(Object.assign(new Error("401 authentication_error"), { status: 401 }));
					return;
				}
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api,
					provider: model.provider,
					model: model.id,
					timestamp: 1,
					stopReason: "stop",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		},
		source,
	);
}

afterEach(() => {
	unregisterCustomApis(source);
	configureUsageAdmission(undefined);
});

describe("stream retry route binding", () => {
	test("stops after a bound retry fails instead of resolving and sending an unbound key", async () => {
		configureUsageAdmission(admission());
		const keys: unknown[] = [];
		transport(keys, () => false);
		let resolutions = 0;
		const stream = streamSimple(model, context, {
			usageContext,
			apiKey: () => (++resolutions === 1 ? "initial-secret" : resolutions === 2 ? bound : "unsafe-secret"),
		});
		let error: unknown;
		try {
			await stream.result();
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeDefined();
		expect(String(error)).not.toContain("secret");
		expect(resolutions).toBe(2);
		expect(keys).toEqual(["initial-secret", "bound-secret"]);
	});

	test("dispatches a valid bound retry and returns its result", async () => {
		configureUsageAdmission(admission());
		const keys: unknown[] = [];
		transport(keys, key => key === "bound-secret");
		let resolutions = 0;
		const stream = streamSimple(model, context, {
			usageContext,
			apiKey: () => (++resolutions === 1 ? "initial-secret" : bound),
		});
		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["initial-secret", "bound-secret"]);
		expect(resolutions).toBe(2);
	});

	test("rejects a bound retry when admission is disabled", async () => {
		configureUsageAdmission(admission(false));
		const keys: unknown[] = [];
		transport(keys, () => false);
		let resolutions = 0;
		const stream = streamSimple(model, context, {
			usageContext,
			apiKey: () => (++resolutions === 1 ? "initial-secret" : bound),
		});
		await expect(stream.result()).rejects.toBeInstanceOf(UsageRouteInvalidatedError);
		expect(keys).toEqual(["initial-secret"]);
		expect(resolutions).toBe(2);
	});

	test("continues legacy unbound retries when admission is disabled", async () => {
		configureUsageAdmission(admission(false));
		const keys: unknown[] = [];
		transport(keys, key => key === "third-secret");
		let resolutions = 0;
		const stream = streamSimple(model, context, {
			usageContext,
			apiKey: () => ["initial-secret", "second-secret", "third-secret"][resolutions++],
		});
		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(keys).toEqual(["initial-secret", "second-secret", "third-secret"]);
	});
});
