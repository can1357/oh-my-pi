import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	type AuthGatewayClient,
	type AuthGatewayServerHandle,
	createAuthGatewayRouter,
	hashAuthGatewayToken,
	startAuthGateway,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";

const GATEWAY_TOKEN = "gateway-token";
const CI_TOKEN = "ci-token";
const MiB = 1024 * 1024;

describe("auth-gateway model fallback", () => {
	let dir = "";
	let storage: AuthStorage;
	let gateway: AuthGatewayServerHandle | undefined;
	/** The status each `provider/id` fails with; a model absent here answers `from-<id>`. */
	let failures: Record<string, number> = {};
	let primary: MockModel;
	let backup: MockModel;

	function mockModel(provider: string, id: string): MockModel {
		return createMockModel({
			provider,
			id,
			handler: () => {
				const status = failures[`${provider}/${id}`];
				if (status !== undefined) throw new ProviderHttpError(`${id} refused`, status);
				return { content: [`from-${id}`] };
			},
		});
	}

	beforeEach(async () => {
		registerMockApi();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-fallback-"));
		storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(dir, "auth.db")));
		await storage.credentials.set("mock", [{ type: "api_key", key: "mock-key" }]);
		await storage.credentials.set("alpha", [{ type: "api_key", key: "alpha-key" }]);
		failures = { "mock/primary": 503 };
		primary = mockModel("mock", "primary");
		backup = mockModel("alpha", "backup");
	});

	afterEach(async () => {
		await gateway?.close();
		gateway = undefined;
		clearCustomApis();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	/** Serves `primary` and `backup` by `provider/id`, or through `lookup`; `fallbackModels` supplies the chains. */
	function boot(
		fallbackModels: (model: Model<Api>) => readonly Model<Api>[],
		clients?: readonly AuthGatewayClient[],
		lookup?: (id: string) => Model<Api> | undefined,
	): AuthGatewayServerHandle {
		const byKey = new Map<string, Model<Api>>(
			[primary, backup].map(model => [`${model.provider}/${model.id}`, model]),
		);
		const find = lookup ?? ((id: string) => byKey.get(id));
		gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: [GATEWAY_TOKEN],
			storage,
			resolveModel: (id, options) => {
				const model = find(id);
				return model && (options?.accepts?.(model) ?? true) ? model : undefined;
			},
			listModels: () => byKey.values(),
			fallbackModels,
			clients,
			version: "test",
		});
		return gateway;
	}

	function post(route: string, body: unknown, token = GATEWAY_TOKEN): Promise<Response> {
		if (!gateway) throw new Error("gateway not started");
		return fetch(`${gateway.url}${route}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify(body),
		});
	}

	async function chat(token = GATEWAY_TOKEN): Promise<{ status: number; content?: string | null }> {
		const response = await post(
			"/v1/chat/completions",
			{ model: "mock/primary", messages: [{ role: "user", content: "hi" }] },
			token,
		);
		const body = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
		return { status: response.status, content: body.choices?.[0]?.message?.content };
	}

	const toBackup = (model: Model<Api>): Model<Api>[] => (model.id === "primary" ? [backup] : []);

	it("resends a failed request to the model's fallback, but not after the requested model's own 400", async () => {
		boot(toBackup);
		expect(await chat()).toEqual({ status: 200, content: "from-backup" });

		failures["mock/primary"] = 400;
		backup.reset();
		expect((await chat()).status).toBe(400);
		expect(backup.calls).toHaveLength(0);
	});

	it("moves past a fallback that rejects the request, and answers with the requested model's failure when none succeeds", async () => {
		const refuser = mockModel("alpha", "refuser");
		failures["alpha/refuser"] = 400;
		boot(model => (model.id === "primary" ? [refuser, backup] : []));
		expect(await chat()).toEqual({ status: 200, content: "from-backup" });

		failures["alpha/backup"] = 502;
		expect((await chat()).status).toBe(503);
	});

	it("dispatches the chain's own model, which the catalog lookup may not return", async () => {
		// Stands in for an `@upstream`-pinned entry: resolving its id again would lose the pin.
		const pinned = mockModel("alpha", "pinned");
		boot(model => (model.id === "primary" ? [pinned] : []));
		expect(await chat()).toEqual({ status: 200, content: "from-pinned" });
	});

	it("walks the chain of the model the first attempt ran on, even when a catalog rebuild drops it before the fallback", async () => {
		let lookups = 0;
		// Only the first lookup finds the primary, as when a rebuild removes it while its request fails.
		boot(toBackup, undefined, id => (id === "mock/primary" && lookups++ === 0 ? primary : undefined));
		expect(await chat()).toEqual({ status: 200, content: "from-backup" });
	});

	it("keeps a scoped client's own failure when its fallback is a model it may not call", async () => {
		boot(toBackup, [{ name: "ci", tokenSha256: hashAuthGatewayToken(CI_TOKEN), models: ["mock/primary"] }]);
		expect((await chat(CI_TOKEN)).status).toBe(503);
		expect(backup.calls).toHaveLength(0);
	});

	it("answers with the requested model's failure when the fallback lookup throws", async () => {
		boot(() => {
			throw new Error("chain lookup failed");
		});
		expect((await chat()).status).toBe(503);
	});

	it("answers a request whose body the host already read, instead of rejecting", async () => {
		const router = createAuthGatewayRouter({ storage, resolveModel: () => primary, fallbackModels: toBackup });
		const body = JSON.stringify({ model: "mock/primary", messages: [{ role: "user", content: "hi" }] });
		const request = new Request("http://gateway.test/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Content-Length": String(body.length) },
			body,
		});
		await request.text();
		try {
			// The chat route reports the unreadable body as its own 400; no fallback runs.
			expect((await router.route(request, "sdk-host")).status).toBe(400);
		} finally {
			router.close();
		}
	});

	it("answers 413 for a body over the route's limit without reading it for a fallback", async () => {
		const fallbackModels = vi.fn(toBackup);
		const { url } = boot(fallbackModels);
		// Declared too large: the route refuses it unread, and a 413 never moves on.
		const declared = await post("/v1/embeddings", { model: "mock/primary", input: "x".repeat(9 * MiB) });
		expect(declared.status).toBe(413);

		// Streamed without a length: the route stops reading at its limit; it does not wait for an upload that never ends.
		const upload = new AbortController();
		const endless = new ReadableStream<Uint8Array>({ pull: controller => controller.enqueue(new Uint8Array(MiB)) });
		const streamed = await fetch(`${url}/v1/embeddings`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_TOKEN}` },
			body: endless,
			duplex: "half",
			signal: upload.signal,
		});
		upload.abort();
		expect(streamed.status).toBe(413);
		expect(fallbackModels).not.toHaveBeenCalled();
	});

	it("never falls back on /v1/pi/stream, whose omp clients walk their own chains", async () => {
		boot(toBackup);
		const response = await post("/v1/pi/stream", {
			model: "mock/primary",
			context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			stream: false,
		});
		expect(response.status).toBe(503);
		expect(backup.calls).toHaveLength(0);
	});
});
