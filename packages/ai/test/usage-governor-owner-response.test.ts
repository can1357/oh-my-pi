import { afterEach, describe, expect, test } from "bun:test";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai";
import { UsageService, type UsageServiceDeps } from "../src/auth/usage";
import { fingerprintBearer } from "../src/auth/bearer-fingerprint";
import { withOAuthAccess } from "../src/auth-retry";
import { stream, streamSimple } from "../src/stream";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "../src/types";
import {
	clearUsageAdmission,
	configureUsageAdmission,
	currentUsageAdmission,
	withUsageAdmission,
} from "../src/usage-governor/admission";
import type { UsageAdmission, UsageRouteBinding } from "../src/usage-governor/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

const api = "owner-response-test" as Api;
const source = "owner-response-test";
const model = { id: "m", name: "M", api, provider: "owner-test", contextWindow: 1000, maxTokens: 100 } as Model<Api>;
const context: Context = { systemPrompt: [], messages: [{ role: "user", content: "hello", timestamp: 1 }] };
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
const binding: UsageRouteBinding = {
	scopeId: "s",
	revision: 1,
	owner: { kind: "role", role: "task" },
	target: { selector: "owner-test/m", provider: "owner-test", modelId: "m" },
	credentialId: 2,
	intent: "proactive",
	bearerFingerprint: fingerprintBearer("key-b"),
};

function fakeAdmission(name: string, log: string[], wait?: Promise<void>): UsageAdmission {
	return {
		active: true,
		validateRoute: () => {
			log.push(`${name}:validate`);
			return true;
		},
		admit: async () => {
			log.push(`${name}:admit`);
			await wait;
			return { id: name, waitedMs: 0 };
		},
		settle: (_id, outcome) => {
			log.push(`${name}:${outcome}`);
		},
	};
}

function installTransport(onSend: (options: SimpleStreamOptions | undefined) => boolean): void {
	registerCustomApi(
		api,
		(_model, _context, options) => {
			const ok = onSend(options);
			const result = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (ok) result.push({ type: "done", reason: "stop", message: { ...message } });
				else result.fail(Object.assign(new Error("401 authentication_error"), { status: 401 }));
			});
			return result;
		},
		source,
	);
}

afterEach(() => {
	unregisterCustomApis(source);
	configureUsageAdmission(undefined);
});

describe("usage admission ownership", () => {
	test("keeps the original verifier and settlement owner while admission waits", async () => {
		const gate = Promise.withResolvers<void>();
		const log: string[] = [];
		const a = fakeAdmission("a", log, gate.promise);
		const b = fakeAdmission("b", log);
		configureUsageAdmission(a);
		installTransport(() => {
			log.push("send");
			return true;
		});
		const result = streamSimple(model, context, { apiKey: "key-b", credentialId: 2, usageRouteBinding: binding });
		configureUsageAdmission(b);
		gate.resolve();
		await result.result();
		expect(log).toEqual(["a:validate", "a:admit", "a:validate", "send", "a:sent"]);
	});

	test("isolates concurrent scoped owners and explicit undefined masks the fallback", async () => {
		const gate = Promise.withResolvers<void>();
		const log: string[] = [];
		const a = fakeAdmission("a", log, gate.promise);
		const b = fakeAdmission("b", log, gate.promise);
		configureUsageAdmission(a);
		expect(withUsageAdmission(undefined, () => currentUsageAdmission())).toBeUndefined();
		clearUsageAdmission(b);
		expect(currentUsageAdmission()).toBe(a);
		installTransport(() => true);
		const first = withUsageAdmission(a, () => streamSimple(model, context, { apiKey: "a" }).result());
		const second = withUsageAdmission(b, () => streamSimple(model, context, { apiKey: "b" }).result());
		gate.resolve();
		await Promise.all([first, second]);
		expect(log.filter(item => item === "a:admit")).toHaveLength(1);
		expect(log.filter(item => item === "b:admit")).toHaveLength(1);
		expect(log.filter(item => item === "a:sent")).toHaveLength(1);
		expect(log.filter(item => item === "b:sent")).toHaveLength(1);
	});

	test("disabled owner dispatches synchronously and does not use the enabled fallback", async () => {
		const log: string[] = [];
		configureUsageAdmission(fakeAdmission("fallback", log));
		const disabled: UsageAdmission = {
			active: false,
			admit: async () => {
				throw new Error("unexpected");
			},
			settle: () => {},
		};
		let dispatched = false;
		installTransport(() => {
			dispatched = true;
			return true;
		});
		const result = withUsageAdmission(disabled, () => streamSimple(model, context, { apiKey: "key" }));
		expect(dispatched).toBe(true);
		await result.result();
		expect(log).toEqual([]);
	});

	test("OAuth storage owner overrides fallback, including disabled owner", async () => {
		const log: string[] = [];
		const owner = fakeAdmission("owner", log);
		configureUsageAdmission(fakeAdmission("fallback", log));
		const storage = {
			governor: owner,
			oauth: { access: async () => ({ accessToken: "token", credentialId: 2 }) },
			limits: { rotate: async () => ({ switched: false }) },
		};
		await withOAuthAccess(storage as never, "owner-test", async () => "ok");
		expect(log).toEqual(["owner:admit", "owner:sent"]);
		log.length = 0;
		await withOAuthAccess(
			{ ...storage, governor: { ...owner, active: false } } as never,
			"owner-test",
			async () => "ok",
		);
		expect(log).toEqual([]);
	});
});

describe("response credential identity", () => {
	test("attributes retries to the credential actually used, preserving callback arguments and return", async () => {
		const ids: Array<number | null | undefined> = [];
		const signal = new AbortController().signal;
		let attempts = 0;
		installTransport(options => {
			attempts++;
			const returned = options?.onResponse?.({ status: attempts === 1 ? 401 : 200, headers: {} }, model, signal);
			expect(returned).toBeUndefined();
			return attempts === 2;
		});
		let resolutions = 0;
		const result = streamSimple(model, context, {
			apiKey: () =>
				++resolutions === 1 ? { apiKey: "key-a", credentialId: 1 } : { apiKey: "key-b", credentialId: 2 },
			onResponse: (response, responseModel, responseSignal) => {
				ids.push(response.credentialId);
				expect(responseModel).toBe(model);
				expect(responseSignal).toBe(signal);
			},
		});
		await result.result();
		expect(ids).toEqual([1, 2]);
	});

	test("raw stream supplies null for an unknown external credential", async () => {
		let received: number | null | undefined;
		installTransport(options => {
			options?.onResponse?.({ status: 200, headers: {} });
			return true;
		});
		await stream(model, context, {
			apiKey: "external",
			onResponse: response => {
				received = response.credentialId;
			},
		}).result();
		expect(received).toBeNull();
	});
});

describe("exact response-header ingestion", () => {
	test("uses only the serving OAuth row and never falls back for explicit invalid identities", () => {
		const a = { type: "oauth" as const, access: "a", refresh: "ra", expires: 9999999999999, accountId: "a" };
		const b = { type: "oauth" as const, access: "b", refresh: "rb", expires: 9999999999999, accountId: "b" };
		const unsupported = { ...b, accountId: "unsupported" };
		const rows = [
			{ id: 1, credential: a },
			{ id: 2, credential: b },
			{ id: 3, credential: { type: "api_key", key: "key" } },
			{ id: 4, credential: unsupported },
		];
		const ingested: string[] = [];
		const provider = {
			parseRateLimitHeaders: () => ({ provider: "owner-test", fetchedAt: Date.now(), limits: [], metadata: {} }),
			supports: (params: { credential: { accountId?: string } }) => params.credential.accountId !== "unsupported",
		};
		const service = new UsageService({
			pool: { entries: (name: string) => (name === "owner-test" ? rows : []) },
			affinity: { activeOAuth: () => a },
			usageProviders: () => provider,
			cache: { reportKey: (request: { credential: { accountId?: string } }) => request.credential.accountId },
			store: {
				ingestUsageReport: (_provider: string, credential: { accountId: string }) => {
					ingested.push(credential.accountId);
					return true;
				},
			},
		} as unknown as UsageServiceDeps);
		expect(service.ingestHeaders("owner-test", {}, { sessionId: "s", credentialId: 2 })).toBe(true);
		expect(ingested).toEqual(["b"]);
		expect(service.ingestHeaders("owner-test", {}, { sessionId: "s", credentialId: null })).toBe(false);
		expect(service.ingestHeaders("owner-test", {}, { sessionId: "s", credentialId: 99 })).toBe(false);
		expect(service.ingestHeaders("wrong-provider", {}, { sessionId: "s", credentialId: 2 })).toBe(false);
		expect(service.ingestHeaders("owner-test", {}, { sessionId: "s", credentialId: 3 })).toBe(false);
		expect(service.ingestHeaders("owner-test", {}, { sessionId: "s", credentialId: 4 })).toBe(false);
		rows.splice(1, 1);
		expect(service.ingestHeaders("owner-test", {}, { sessionId: "s", credentialId: 2 })).toBe(false);
		expect(ingested).toEqual(["b"]);
		expect(service.ingestHeaders("owner-test", {}, { sessionId: "s" })).toBe(true);
		expect(ingested).toEqual(["b", "a"]);
	});
});
