import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager, resolveSubscriptionPostAction } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/manager";
import type { MCPServerConfig } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@pk-nerdsaver-ai/pi-utils";

describe("resolveSubscriptionPostAction", () => {
	it("returns rollback when notifications are disabled", () => {
		expect(resolveSubscriptionPostAction(false, 5, 5)).toBe("rollback");
		expect(resolveSubscriptionPostAction(false, 10, 2)).toBe("rollback");
	});

	it("returns ignore when notifications are enabled but epoch is stale", () => {
		expect(resolveSubscriptionPostAction(true, 8, 7)).toBe("ignore");
	});

	it("returns apply when notifications are enabled and epoch matches", () => {
		expect(resolveSubscriptionPostAction(true, 3, 3)).toBe("apply");
	});
});

type SubscriptionFixtureEvent = {
	generation: number;
	type: "client" | "listen" | "cancel";
	method?: string;
	subscriptionId?: string | number;
	requested?: Record<string, unknown>;
};

const SUBSCRIPTION_FIXTURE = path.join(import.meta.dir, "fixtures", "subscription-modern-mcp.ts");

function readFixtureEvents(statePath: string): SubscriptionFixtureEvent[] {
	try {
		return fs
			.readFileSync(statePath, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map(line => JSON.parse(line) as SubscriptionFixtureEvent);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function waitForFixture(
	statePath: string,
	predicate: (events: SubscriptionFixtureEvent[]) => boolean,
	timeoutMs = 10_000,
): Promise<SubscriptionFixtureEvent[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const events = readFixtureEvents(statePath);
		if (predicate(events)) return events;
		await Bun.sleep(20);
	}
	throw new Error(`Timed out waiting for subscription fixture ${statePath}`);
}

function subscriptionConfig(statePath: string, ...flags: string[]): MCPServerConfig {
	return {
		type: "stdio",
		command: process.execPath,
		args: [SUBSCRIPTION_FIXTURE, "--state", statePath, ...flags],
	};
}

describe("MCPManager modern subscription lifecycle", () => {
	let manager: MCPManager | undefined;
	let workDir: string | undefined;

	afterEach(async () => {
		await manager?.disconnectAll();
		if (workDir) removeSyncWithRetries(workDir);
		manager = undefined;
		workDir = undefined;
	});

	it("uses acknowledged modern filters, refreshes authorized snapshots, and ignores stale events after disable", async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-subscriptions-"));
		const statePath = path.join(workDir, "state.jsonl");
		manager = new MCPManager(workDir);
		manager.setNotificationsEnabled(true);

		let resourceEvents = 0;
		manager.setOnResourcesChanged((_serverName, uri) => {
			if (uri === "fixture://resource") resourceEvents++;
		});

		const connected = Promise.withResolvers<void>();
		await manager.connectServers(
			{ modern: subscriptionConfig(statePath, "--emit-events", "--stale-after-cancel") },
			{},
			event => {
				if (event.type === "connected" && event.serverName === "modern") connected.resolve();
			},
		);
		await connected.promise;
		const firstRead = await manager.readServerResource("modern", "fixture://resource");
		expect(firstRead?.contents[0]?.text).toBe("resource-read-1");
		const events = await waitForFixture(statePath, current => {
			const methods = current.filter(event => event.type === "client").map(event => event.method);
			return (
				current.some(event => event.type === "listen") &&
				methods.filter(method => method === "tools/list").length >= 2 &&
				methods.filter(method => method === "prompts/list").length >= 2 &&
				methods.filter(method => method === "resources/list").length >= 2 &&
				resourceEvents === 1
			);
		});

		const listen = events.find(event => event.type === "listen");
		expect(listen?.requested).toEqual({
			toolsListChanged: true,
			promptsListChanged: true,
			resourcesListChanged: true,
			resourceSubscriptions: ["fixture://resource"],
		});
		expect(manager.getNotificationState().subscriptions.get("modern")).toEqual(new Set(["fixture://resource"]));
		const refreshedRead = await manager.readServerResource("modern", "fixture://resource");
		expect(refreshedRead?.contents[0]?.text).toBe("resource-read-2");
		await waitForFixture(
			statePath,
			current => current.filter(event => event.type === "client" && event.method === "resources/read").length >= 2,
		);
		const clientMethods = events.filter(event => event.type === "client").map(event => event.method);
		expect(clientMethods).not.toContain("initialize");
		expect(clientMethods).not.toContain("resources/subscribe");
		expect(clientMethods).not.toContain("resources/unsubscribe");

		const activeSubscriptionId = listen?.subscriptionId;
		manager.setNotificationsEnabled(false);
		await waitForFixture(statePath, current =>
			current.some(event => event.type === "cancel" && event.subscriptionId === activeSubscriptionId),
		);
		await Bun.sleep(100);
		expect(resourceEvents).toBe(1);
		expect(manager.getNotificationState().subscriptions.size).toBe(0);
	});

	it("does not let a stale connection reconciliation cancel the current listener", async () => {
		const delayedFirstResources = Promise.withResolvers<Response>();
		const encoder = new TextEncoder();
		let resourcesListRequests = 0;
		let firstResourcesRequestId: string | number | undefined;
		let listenRequests = 0;
		let currentListenerCancelled = false;
		const cacheResult = (payload: Record<string, unknown>) => ({
			resultType: "complete",
			ttlMs: 60_000,
			cacheScope: "public",
			_meta: {},
			...payload,
		});
		const response = (id: string | number, result: Record<string, unknown>) =>
			new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
				headers: { "Content-Type": "application/json" },
			});
		const server = Bun.serve({
			port: 0,
			fetch: async request => {
				const message = (await request.json()) as {
					id: string | number;
					method: string;
				};
				switch (message.method) {
					case "server/discover":
						return response(
							message.id,
							cacheResult({
								supportedVersions: ["2026-07-28"],
								capabilities: { resources: { subscribe: true } },
								_meta: {
									"io.modelcontextprotocol/serverInfo": { name: "stale-reconciliation", version: "1" },
								},
							}),
						);
					case "tools/list":
						return response(message.id, cacheResult({ tools: [] }));
					case "prompts/list":
						return response(message.id, cacheResult({ prompts: [] }));
					case "resources/templates/list":
						return response(message.id, cacheResult({ resourceTemplates: [] }));
					case "resources/list": {
						resourcesListRequests++;
						if (resourcesListRequests === 1) {
							firstResourcesRequestId = message.id;
							return delayedFirstResources.promise;
						}
						return response(message.id, cacheResult({ resources: [{ uri: "file:///a", name: "A" }] }));
					}
					case "subscriptions/listen": {
						listenRequests++;
						const body = new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(
									encoder.encode(
										`data: ${JSON.stringify({
											jsonrpc: "2.0",
											method: "notifications/subscriptions/acknowledged",
											params: {
												_meta: { "io.modelcontextprotocol/subscriptionId": message.id },
												notifications: { resourceSubscriptions: ["file:///a"] },
											},
										})}\n\n`,
									),
								);
							},
							cancel() {
								currentListenerCancelled = true;
							},
						});
						return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
					}
					default:
						return response(message.id, cacheResult({}));
				}
			},
		});
		try {
			manager = new MCPManager(process.cwd());
			manager.setNotificationsEnabled(true);
			const config: MCPServerConfig = { type: "http", url: server.url.toString() };
			await manager.connectServers({ modern: config }, {});
			for (let attempt = 0; attempt < 100 && resourcesListRequests !== 1; attempt++) {
				await Bun.sleep(10);
			}
			expect(resourcesListRequests).toBe(1);

			await manager.disconnectAll();
			await manager.connectServers({ modern: config }, {});
			for (let attempt = 0; attempt < 100 && listenRequests !== 1; attempt++) {
				await Bun.sleep(10);
			}
			expect(listenRequests).toBe(1);
			expect(firstResourcesRequestId).toBeDefined();
			delayedFirstResources.resolve(
				response(firstResourcesRequestId!, cacheResult({ resources: [{ uri: "file:///a", name: "A" }] })),
			);
			await Bun.sleep(100);

			expect(currentListenerCancelled).toBeFalse();
			expect(listenRequests).toBe(1);
		} finally {
			server.stop(true);
		}
	});

	it("re-discovers capabilities and opens a fresh listener after reconnect", async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-subscription-reconnect-"));
		const statePath = path.join(workDir, "state.jsonl");

		manager = new MCPManager(workDir);
		manager.setNotificationsEnabled(true);

		await manager.connectServers(
			{ modern: subscriptionConfig(statePath, "--fresh-capabilities", "--crash-first") },
			{},
		);
		const events = await waitForFixture(
			statePath,
			current =>
				current.some(event => event.type === "listen" && event.generation === 1) &&
				current.some(event => event.type === "listen" && event.generation === 2),
			15_000,
		);
		const firstListen = events.find(event => event.type === "listen" && event.generation === 1);
		const secondListen = events.find(event => event.type === "listen" && event.generation === 2);
		expect(firstListen?.requested).toEqual({ toolsListChanged: true });
		expect(secondListen?.requested).toEqual({ promptsListChanged: true });
		expect(manager.getConnection("modern")?.protocol).toMatchObject({
			era: "modern",
			capabilities: {
				tools: { listChanged: false },
				prompts: { listChanged: true },
			},
		});
		const methods = events.filter(event => event.type === "client").map(event => event.method);
		expect(methods).not.toContain("initialize");
		expect(methods).not.toContain("resources/subscribe");
		expect(methods).not.toContain("resources/unsubscribe");
	}, 20_000);

	it("retries an initial HTTP listener failure before acknowledgment", async () => {
		const encoder = new TextEncoder();
		let listenRequests = 0;
		const cacheResult = (payload: Record<string, unknown>) => ({
			resultType: "complete",
			ttlMs: 60_000,
			cacheScope: "public",
			_meta: {},
			...payload,
		});
		const response = (id: string | number, result: Record<string, unknown>) =>
			new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
				headers: { "Content-Type": "application/json" },
			});
		const server = Bun.serve({
			port: 0,
			fetch: async request => {
				const message = (await request.json()) as {
					id: string | number;
					method: string;
				};
				if (message.method === "server/discover") {
					return response(
						message.id,
						cacheResult({
							supportedVersions: ["2026-07-28"],
							capabilities: { tools: { listChanged: true } },
						}),
					);
				}
				if (message.method === "tools/list") {
					return response(message.id, cacheResult({ tools: [] }));
				}
				if (message.method === "subscriptions/listen") {
					listenRequests++;
					if (listenRequests === 1) {
						return new Response("", { headers: { "Content-Type": "text/event-stream" } });
					}
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(
									encoder.encode(
										`data: ${JSON.stringify({
											jsonrpc: "2.0",
											method: "notifications/subscriptions/acknowledged",
											params: {
												_meta: { "io.modelcontextprotocol/subscriptionId": message.id },
												notifications: { toolsListChanged: true },
											},
										})}\n\n`,
									),
								);
							},
						}),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				return response(message.id, cacheResult({}));
			},
		});
		try {
			manager = new MCPManager(process.cwd());
			manager.setNotificationsEnabled(true);
			await manager.connectServers({ modern: { type: "http", url: server.url.toString() } }, {});
			for (let attempt = 0; attempt < 250 && listenRequests < 2; attempt++) {
				await Bun.sleep(10);
			}
			expect(listenRequests).toBe(2);
		} finally {
			server.stop(true);
		}
	});

	it("reopens an acknowledged HTTP listener after an unexpected stream drop", async () => {
		const encoder = new TextEncoder();
		let listenRequests = 0;
		let toolsListRequests = 0;
		const cacheResult = (payload: Record<string, unknown>) => ({
			resultType: "complete",
			ttlMs: 60_000,
			cacheScope: "public",
			_meta: {},
			...payload,
		});
		const response = (id: string | number, result: Record<string, unknown>) =>
			new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
				headers: { "Content-Type": "application/json" },
			});
		const acknowledgment = (id: string | number) => ({
			jsonrpc: "2.0",
			method: "notifications/subscriptions/acknowledged",
			params: {
				_meta: { "io.modelcontextprotocol/subscriptionId": id },
				notifications: { toolsListChanged: true },
			},
		});
		const server = Bun.serve({
			port: 0,
			fetch: async request => {
				const message = (await request.json()) as {
					id: string | number;
					method: string;
				};
				switch (message.method) {
					case "server/discover":
						return response(
							message.id,
							cacheResult({
								supportedVersions: ["2026-07-28"],
								capabilities: { tools: { listChanged: true } },
								_meta: {
									"io.modelcontextprotocol/serverInfo": { name: "stream-recovery", version: "1" },
								},
							}),
						);
					case "tools/list":
						toolsListRequests++;
						return response(message.id, cacheResult({ tools: [] }));
					case "subscriptions/listen":
						listenRequests++;
						if (listenRequests === 1) {
							return new Response(`data: ${JSON.stringify(acknowledgment(message.id))}\n\n`, {
								headers: { "Content-Type": "text/event-stream" },
							});
						}
						if (listenRequests === 2) {
							return new Response("", { headers: { "Content-Type": "text/event-stream" } });
						}
						return new Response(
							new ReadableStream<Uint8Array>({
								start(controller) {
									controller.enqueue(
										encoder.encode(
											`data: ${JSON.stringify(acknowledgment(message.id))}\n\ndata: ${JSON.stringify({
												jsonrpc: "2.0",
												method: "notifications/tools/list_changed",
												params: {
													_meta: { "io.modelcontextprotocol/subscriptionId": message.id },
												},
											})}\n\n`,
										),
									);
								},
							}),
							{ headers: { "Content-Type": "text/event-stream" } },
						);
					default:
						return response(message.id, cacheResult({}));
				}
			},
		});
		try {
			manager = new MCPManager(process.cwd());
			manager.setNotificationsEnabled(true);
			await manager.connectServers({ modern: { type: "http", url: server.url.toString() } }, {});
			for (let attempt = 0; attempt < 250 && (listenRequests < 3 || toolsListRequests < 2); attempt++) {
				await Bun.sleep(10);
			}
			expect(listenRequests).toBe(3);
			expect(toolsListRequests).toBeGreaterThanOrEqual(2);
		} finally {
			server.stop(true);
		}
	});

	it("clears recovery-only state during disconnectAll before a reused manager listener drops", async () => {
		const encoder = new TextEncoder();
		let listenRequests = 0;
		let heldStream: ReadableStreamDefaultController<Uint8Array> | undefined;
		const cacheResult = (payload: Record<string, unknown>) => ({
			resultType: "complete",
			ttlMs: 60_000,
			cacheScope: "public",
			_meta: {},
			...payload,
		});
		const response = (id: string | number, result: Record<string, unknown>) =>
			new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
				headers: { "Content-Type": "application/json" },
			});
		const acknowledgment = (id: string | number) =>
			`data: ${JSON.stringify({
				jsonrpc: "2.0",
				method: "notifications/subscriptions/acknowledged",
				params: {
					_meta: { "io.modelcontextprotocol/subscriptionId": id },
					notifications: { toolsListChanged: true },
				},
			})}\n\n`;
		const server = Bun.serve({
			port: 0,
			fetch: async request => {
				const message = (await request.json()) as { id: string | number; method: string };
				switch (message.method) {
					case "server/discover":
						return response(
							message.id,
							cacheResult({
								supportedVersions: ["2026-07-28"],
								capabilities: { tools: { listChanged: true } },
								_meta: {
									"io.modelcontextprotocol/serverInfo": { name: "timer-reset", version: "1" },
								},
							}),
						);
					case "tools/list":
						return response(message.id, cacheResult({ tools: [] }));
					case "subscriptions/listen":
						listenRequests++;
						if (listenRequests === 1) {
							return new Response(acknowledgment(message.id), {
								headers: { "Content-Type": "text/event-stream" },
							});
						}
						if (listenRequests === 2) {
							return new Response(
								new ReadableStream<Uint8Array>({
									start(controller) {
										heldStream = controller;
										controller.enqueue(encoder.encode(acknowledgment(message.id)));
									},
								}),
								{ headers: { "Content-Type": "text/event-stream" } },
							);
						}
						return new Response(acknowledgment(message.id), {
							headers: { "Content-Type": "text/event-stream" },
						});
					default:
						return response(message.id, cacheResult({}));
				}
			},
		});
		try {
			manager = new MCPManager(process.cwd());
			manager.setNotificationsEnabled(true);
			const config: MCPServerConfig = { type: "http", url: server.url.toString() };
			await manager.connectServers({ modern: config }, {});
			for (let attempt = 0; attempt < 100 && listenRequests < 1; attempt++) await Bun.sleep(10);
			expect(listenRequests).toBe(1);
			await Bun.sleep(10);

			await manager.disconnectAll();
			await manager.connectServers({ modern: config }, {});
			for (let attempt = 0; attempt < 100 && !heldStream; attempt++) await Bun.sleep(10);
			expect(heldStream).toBeDefined();
			heldStream!.close();

			for (let attempt = 0; attempt < 150 && listenRequests < 3; attempt++) await Bun.sleep(10);
			expect(listenRequests).toBe(3);
		} finally {
			server.stop(true);
		}
	});
});
