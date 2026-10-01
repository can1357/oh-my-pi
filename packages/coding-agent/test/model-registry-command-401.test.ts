import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { withAuth } from "@oh-my-pi/pi-ai/auth-retry";
import { CommandConfigResolutionError } from "@oh-my-pi/pi-ai/error";
import type { Context, FetchImpl, Model, StopReason } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { invalidateCommandConfig } from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import {
	failedTrackingCommand,
	gatedTokenCommand,
	mintingCommand,
	okChatCompletionStream,
	runCount,
	stdoutFileCommand,
	trackedTokenCommand,
	unauthorizedResponse,
	waitForFile,
} from "./helpers/command-config";

const PROMPT: Context = { systemPrompt: ["s"], messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function authError(): Error & { status: number } {
	return Object.assign(new Error("401 authentication_error"), { status: 401 });
}

/** One `streamSimple` turn whose key resolves through the registry, as an agent turn does. */
async function streamTurn(registry: ModelRegistry, model: Model, fetch: FetchImpl): Promise<StopReason> {
	const handle = streamSimple(model, PROMPT, { apiKey: registry.resolver(model), fetch, maxTokens: 16 });
	for await (const _event of handle) {
		// drain
	}
	return (await handle.result()).stopReason;
}

/** One non-streaming `withAuth` operation that materializes the model headers inside its attempt. */
async function withAuthTurn(registry: ModelRegistry, model: Model, fetch: FetchImpl): Promise<StopReason> {
	try {
		return await withAuth(registry.resolver(model), async (key): Promise<StopReason> => {
			const headers = await registry.resolveModelHeaders(model);
			const response = await fetch(`${model.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { ...headers, Authorization: `Bearer ${key}` },
			});
			if (response.status === 401) throw authError();
			return "stop";
		});
	} catch (error) {
		if ((error as { status?: number }).status === 401) return "error";
		throw error;
	}
}

const DRIVERS = [
	{ name: "streamSimple", turn: streamTurn },
	{ name: "withAuth", turn: withAuthTurn },
] as const;

describe("ModelRegistry !command credentials after a 401", () => {
	let tempDir = "";
	let authStorage: AuthStorage;
	let modelsPath = "";

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-model-command-401-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		authStorage.close();
		if (!tempDir || !fs.existsSync(tempDir)) return;
		try {
			removeSyncWithRetries(tempDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
		}
	});

	function tempFile(name: string, contents = ""): string {
		const file = path.join(tempDir, name);
		fs.writeFileSync(file, contents);
		return file;
	}

	/** Configure `custom-proxy` (openai-completions, one `custom-model`) with extra provider fields. */
	function customProvider(provider: Record<string, unknown>): { registry: ModelRegistry; model: Model } {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						models: [{ id: "custom-model", name: "Custom Model" }],
						...provider,
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");
		if (!model) throw new Error("Expected custom model");
		return { registry, model };
	}

	test("a constant command header survives a rotation of its command-backed bearer", async () => {
		const bearerFile = tempFile("bearer.txt", "bearer-1");
		const { registry } = customProvider({
			apiKey: `!${stdoutFileCommand(bearerFile)}`,
			headers: { "x-tenant-token": `!${stdoutFileCommand(tempFile("tenant.txt", "tenant"))}` },
		});
		let acceptedBearer = "Bearer bearer-1";
		const wire: string[] = [];
		const fetch: FetchImpl = async (_url, init) => {
			const headers = new Headers(init?.headers);
			const auth = headers.get("authorization");
			const tenant = headers.get("x-tenant-token");
			wire.push(`${auth}|${tenant}`);
			return auth === acceptedBearer && tenant === "tenant" ? okChatCompletionStream() : unauthorizedResponse();
		};
		const turn = (): Promise<StopReason> => {
			const model = registry.find("custom-proxy", "custom-model");
			if (!model) throw new Error("Expected custom model");
			return streamTurn(registry, model, fetch);
		};

		const turns = [await turn()];
		// The credential service rotates the bearer; the tenant helper keeps printing the same value.
		acceptedBearer = "Bearer bearer-2";
		fs.writeFileSync(bearerFile, "bearer-2");
		turns.push(await turn());
		turns.push(await turn());
		// F5 on the provider re-runs both helpers; the reprinted tenant is accepted again.
		await registry.refreshProvider("custom-proxy", "online", { refreshCommandCredentials: true });
		turns.push(await turn());

		expect(turns).toEqual(["stop", "stop", "stop", "stop"]);
		expect(wire).toEqual([
			"Bearer bearer-1|tenant",
			"Bearer bearer-1|tenant",
			"Bearer bearer-2|tenant",
			"Bearer bearer-2|tenant",
			"Bearer bearer-2|tenant",
		]);
	});

	test("a key helper that reprints a 401'd key is trusted again on the next operation", async () => {
		const counterFile = tempFile("counter.txt");
		const { registry, model } = customProvider({
			apiKey: `!${trackedTokenCommand(tempFile("token.txt", "same-key"), counterFile)}`,
		});
		let serverAccepts = false;
		const sent: string[] = [];
		const attempt = async (key: string): Promise<string> => {
			sent.push(key);
			if (!serverAccepts) throw authError();
			return key;
		};

		await expect(withAuth(registry.resolver(model), attempt)).rejects.toMatchObject({ status: 401 });
		// The 401 was transient: the server now accepts the key the helper keeps printing.
		serverAccepts = true;
		expect(await withAuth(registry.resolver(model), attempt)).toBe("same-key");

		expect(sent).toEqual(["same-key", "same-key"]);
		// The first mint, then the 401's fresh run, which reprinted the same key.
		expect(runCount(counterFile)).toBe(2);
	});

	for (const driver of DRIVERS) {
		test(`a persistent 401 costs two requests and one run per command per operation (${driver.name})`, async () => {
			const keyCounter = tempFile("key-counter.txt");
			const headerCounter = tempFile("header-counter.txt");
			const { registry, model } = customProvider({
				apiKey: `!${mintingCommand(keyCounter, "key")}`,
				headers: { "x-tenant-token": `!${mintingCommand(headerCounter, "tenant")}` },
			});
			// Warm both caches, as an earlier successful turn would.
			expect(await registry.getApiKey(model)).toBe("key-1");
			expect((await registry.resolveModelHeaders(model))?.["x-tenant-token"]).toBe("tenant-1");
			let requests = 0;
			const fetch: FetchImpl = async () => {
				requests++;
				return unauthorizedResponse();
			};

			const perOperation: number[][] = [];
			for (let operation = 0; operation < 2; operation++) {
				const before = [requests, runCount(keyCounter), runCount(headerCounter)];
				expect(await driver.turn(registry, model, fetch)).toBe("error");
				perOperation.push([
					requests - before[0],
					runCount(keyCounter) - before[1],
					runCount(headerCounter) - before[2],
				]);
			}

			// [requests, key runs, header runs]: the refresh step re-mints each command once,
			// and the rotate step finds no unsent bearer.
			expect(perOperation).toEqual([
				[2, 1, 1],
				[2, 1, 1],
			]);
		});
	}

	for (const driver of DRIVERS) {
		test(`a header helper that never succeeds runs twice, then waits out its backoff (${driver.name})`, async () => {
			const headerCounter = tempFile("header-counter.txt");
			const { registry, model } = customProvider({
				apiKey: "static-api-key",
				headers: { "x-tenant-token": `!${failedTrackingCommand(headerCounter)}` },
			});
			const tenants: Array<string | null> = [];
			const fetch: FetchImpl = async (_url, init) => {
				tenants.push(new Headers(init?.headers).get("x-tenant-token"));
				return unauthorizedResponse();
			};

			const headerRuns: number[] = [];
			for (let operation = 0; operation < 4; operation++) {
				const before = runCount(headerCounter);
				expect(await driver.turn(registry, model, fetch)).toBe("error");
				headerRuns.push(runCount(headerCounter) - before);
			}

			// The 401s never clear the 30 s failure backoff, and the header is omitted.
			expect(headerRuns).toEqual([2, 0, 0, 0]);
			expect(tenants).toEqual([null, null, null, null]);
		});
	}

	test("a 401 on authenticated discovery leaves a constant Authorization header helper usable for chat", async () => {
		const headerCounter = tempFile("header-counter.txt");
		const discoveryAuth: Array<string | null> = [];
		const chatAuth: Array<string | null> = [];
		const fetch: FetchImpl = async (input, init) => {
			const url = String(input);
			const auth = new Headers(init?.headers).get("authorization");
			if (url === "http://127.0.0.1:8080/models") {
				discoveryAuth.push(auth);
				return unauthorizedResponse();
			}
			if (url.endsWith("/chat/completions")) {
				chatAuth.push(auth);
				return auth === "Token valid-token" ? okChatCompletionStream() : unauthorizedResponse();
			}
			return Response.json({}, { status: 404 });
		};
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"llama-proxy": {
						baseUrl: "http://127.0.0.1:8080",
						api: "openai-completions",
						apiKey: "static-api-key",
						headers: {
							Authorization: `!${trackedTokenCommand(tempFile("auth.txt", "Token valid-token"), headerCounter)}`,
						},
						discovery: { type: "llama.cpp" },
						models: [{ id: "chat-model", name: "Chat model" }],
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath, { fetch });
		const chat = (): Promise<StopReason> => {
			const model = registry.find("llama-proxy", "chat-model");
			if (!model) throw new Error("Expected configured chat model");
			return streamTurn(registry, model, fetch);
		};

		const before = await chat();
		await registry.refreshProvider("llama-proxy", "online");
		const after = await chat();

		expect([before, after]).toEqual(["stop", "stop"]);
		// Discovery sends the API key as its bearer and gets the 401.
		expect(discoveryAuth).toEqual(["Bearer static-api-key"]);
		expect(chatAuth).toEqual(["Token valid-token", "Token valid-token"]);
		// That 401 marked the provider header, so the second chat ran its helper again.
		expect(runCount(headerCounter)).toBe(2);
	});

	test("a 401-marked command key is never sent on the next turn when re-minting fails", async () => {
		const tokenFile = tempFile("token.txt", "rejected-key");
		const command = trackedTokenCommand(tokenFile, tempFile("counter.txt"));
		const { registry, model } = customProvider({ apiKey: `!${command}`, authHeader: true });
		expect(await registry.getApiKey(model)).toBe("rejected-key");
		fs.writeFileSync(tokenFile, "FAIL");
		const sent: string[] = [];
		const reject = async (key: string): Promise<never> => {
			sent.push(key);
			throw authError();
		};

		await expect(withAuth(registry.resolver(model), reject)).rejects.toMatchObject({ status: 401 });
		let nextTurnFailure: unknown;
		try {
			await withAuth(registry.resolver(model), reject);
		} catch (error) {
			nextTurnFailure = error;
		}

		expect(nextTurnFailure).toBeInstanceOf(CommandConfigResolutionError);
		expect((nextTurnFailure as Error).message).toBe("custom-proxy apiKey command exited with status 1");
		// The next turn sends nothing.
		expect(sent).toEqual(["rejected-key"]);
		expect(await registry.getApiKey(model)).toBeUndefined();
	});

	test("concurrent 401 recoveries share one replacement command run", async () => {
		const tokenFile = tempFile("token.txt", "stale-key");
		const counterFile = tempFile("counter.txt");
		const { registry, model } = customProvider({ apiKey: `!${trackedTokenCommand(tokenFile, counterFile)}` });
		expect(await registry.getApiKey(model)).toBe("stale-key");
		fs.writeFileSync(tokenFile, "fresh-key");

		const requests = await Promise.all(
			Array.from({ length: 5 }, () =>
				withAuth(registry.resolver(model), async key => {
					if (key === "stale-key") throw authError();
					return key;
				}),
			),
		);

		expect(requests).toEqual(["fresh-key", "fresh-key", "fresh-key", "fresh-key", "fresh-key"]);
		expect(runCount(counterFile)).toBe(2);
	});

	test("a late 401 for the old key reuses a peer's replacement instead of minting again", async () => {
		const tokenFile = tempFile("token.txt", "stale-key");
		const counterFile = tempFile("counter.txt");
		const { registry, model } = customProvider({ apiKey: `!${trackedTokenCommand(tokenFile, counterFile)}` });
		const resolver = registry.resolver(model);
		expect(await resolver({ lastChance: false, error: undefined })).toMatchObject({ apiKey: "stale-key" });
		fs.writeFileSync(tokenFile, "fresh-key");
		const staleKey401 = { lastChance: false, error: authError(), previousKey: "stale-key" };

		expect(await resolver(staleKey401)).toMatchObject({ apiKey: "fresh-key" });
		// A second request that sent stale-key gets its 401 after the peer re-minted.
		fs.writeFileSync(tokenFile, "fresher-key");
		expect(await resolver(staleKey401)).toMatchObject({ apiKey: "fresh-key" });
		expect(runCount(counterFile)).toBe(2);
	});

	test.skipIf(process.platform === "win32")(
		"a 401 during a failing refresh run spends one shared replacement attempt",
		async () => {
			const tokenFile = tempFile("token.txt", "stale-key");
			const counterFile = tempFile("counter.txt");
			const startedFile = path.join(tempDir, "run-started");
			const releaseFile = tempFile("run-release");
			const command = gatedTokenCommand(tokenFile, counterFile, startedFile, releaseFile, 2);
			const { registry, model } = customProvider({ apiKey: `!${command}` });
			const resolver = registry.resolver(model);
			expect(await resolver({ lastChance: false, error: undefined })).toMatchObject({ apiKey: "stale-key" });
			fs.rmSync(startedFile);
			fs.rmSync(releaseFile);
			fs.writeFileSync(tokenFile, "fresh-key");

			// An ordinary refresh starts one attempt while stale-key is still servable.
			invalidateCommandConfig(`!${command}`);
			const refreshing = resolver({ lastChance: false, error: undefined });
			await waitForFile(startedFile);
			// A 401 for stale-key joins that run, which then fails.
			const recovery = resolver({ lastChance: false, error: authError(), previousKey: "stale-key" });
			fs.writeFileSync(releaseFile, "");

			expect(await refreshing).toMatchObject({ apiKey: "fresh-key" });
			expect(await recovery).toMatchObject({ apiKey: "fresh-key" });
			expect(runCount(counterFile)).toBe(3);
		},
		20_000,
	);

	test("a 401 only marks command headers on the requested model", async () => {
		const tokenB = tempFile("model-b-token.txt", "b-good");
		const counterB = tempFile("model-b-counter.txt");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: "provider-key",
						models: [
							{ id: "model-a", name: "Model A" },
							{
								id: "model-b",
								name: "Model B",
								headers: { "x-b-token": `!${trackedTokenCommand(tokenB, counterB)}` },
							},
						],
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		const modelA = registry.find("custom-proxy", "model-a");
		const modelB = registry.find("custom-proxy", "model-b");
		if (!modelA || !modelB) throw new Error("Expected custom models");
		expect((await registry.resolveModelHeaders(modelB))?.["x-b-token"]).toBe("b-good");
		fs.writeFileSync(tokenB, "FAIL");

		await registry.resolver(modelA)({ lastChance: false, error: authError() });

		expect((await registry.resolveModelHeaders(modelB))?.["x-b-token"]).toBe("b-good");
		expect(runCount(counterB)).toBe(1);
	});

	test("a 401-marked header is not resent when its re-mint fails", async () => {
		const bearerFile = tempFile("bearer.txt", "stale-bearer");
		const tenantFile = tempFile("tenant.txt", "stale-tenant");
		const { registry, model } = customProvider({
			apiKey: `!${stdoutFileCommand(bearerFile)}`,
			headers: { "x-tenant-token": `!${stdoutFileCommand(tenantFile)}` },
		});
		const seen: string[] = [];
		const fetch: FetchImpl = async (_url, init) => {
			const headers = new Headers(init?.headers);
			seen.push(`${headers.get("authorization")}|${headers.get("x-tenant-token")}`);
			if (seen.length === 1) {
				fs.writeFileSync(bearerFile, "fresh-bearer");
				fs.writeFileSync(tenantFile, "");
			}
			return unauthorizedResponse();
		};

		expect(await streamTurn(registry, model, fetch)).toBe("error");

		expect(seen).toEqual(["Bearer stale-bearer|stale-tenant", "Bearer fresh-bearer|null"]);
	});

	test("a 401 re-mints provider header commands a consumer resolved itself", async () => {
		const tenantFile = tempFile("tenant.txt", "stale-tenant");
		const { registry, model } = customProvider({
			apiKey: "static-api-key",
			headers: { "x-tenant-token": `!${stdoutFileCommand(tenantFile)}` },
		});
		const sent: Array<string | undefined> = [];
		// An SDK consumer that materializes registry headers inside its own attempt (#9760).
		const attempt = async (): Promise<string> => {
			const headers = await registry.resolveModelHeaders(model);
			sent.push(headers?.["x-tenant-token"]);
			if (sent.length === 1) {
				fs.writeFileSync(tenantFile, "fresh-tenant");
				throw authError();
			}
			return "ok";
		};

		await expect(withAuth(registry.resolver(model), attempt)).rejects.toMatchObject({ status: 401 });
		expect(await withAuth(registry.resolver(model), attempt)).toBe("ok");

		expect(sent).toEqual(["stale-tenant", "fresh-tenant"]);
	});
});
