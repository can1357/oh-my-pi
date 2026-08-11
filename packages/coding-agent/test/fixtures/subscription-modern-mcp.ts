#!/usr/bin/env bun
import * as fs from "node:fs";
import * as readline from "node:readline";

const args = new Set(process.argv.slice(2));
const stateArg = process.argv.indexOf("--state");
const statePathValue = stateArg >= 0 ? process.argv[stateArg + 1] : undefined;
if (!statePathValue) throw new Error("--state is required");
const statePath = statePathValue;

const generationPath = `${statePath}.generation`;
let generation = 1;
try {
	generation = Number(fs.readFileSync(generationPath, "utf8")) + 1;
} catch {
	// First fixture process.
}
fs.writeFileSync(generationPath, String(generation));

function record(value: Record<string, unknown>): void {
	fs.appendFileSync(statePath, `${JSON.stringify({ generation, ...value })}\n`);
}

function send(value: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function cacheResult(payload: Record<string, unknown>): Record<string, unknown> {
	return {
		resultType: "complete",
		ttlMs: 60_000,
		cacheScope: "public",
		_meta: {},
		...payload,
	};
}

function capabilities(): Record<string, unknown> {
	if (args.has("--fresh-capabilities")) {
		return generation === 1
			? { tools: { listChanged: true } }
			: { tools: { listChanged: false }, prompts: { listChanged: true } };
	}
	return {
		tools: { listChanged: true },
		prompts: { listChanged: true },
		resources: { listChanged: true, subscribe: true },
	};
}

let listenCount = 0;
let resourceReadCount = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
	let message: Record<string, any>;
	try {
		message = JSON.parse(line) as Record<string, any>;
	} catch {
		return;
	}
	const method = typeof message.method === "string" ? message.method : "response";
	record({ type: "client", method, id: message.id, params: message.params });

	if (method === "server/discover") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: cacheResult({
				supportedVersions: ["2026-07-28"],
				capabilities: capabilities(),
				_meta: {
					"io.modelcontextprotocol/serverInfo": { name: "subscription-fixture", version: String(generation) },
				},
			}),
		});
		return;
	}
	if (method === "tools/list") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: cacheResult({ tools: [{ name: `fixture_tool_${generation}`, inputSchema: { type: "object" } }] }),
		});
		return;
	}
	if (method === "prompts/list") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: cacheResult({ prompts: [{ name: `fixture_prompt_${generation}` }] }),
		});
		return;
	}
	if (method === "resources/list") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: cacheResult({ resources: [{ uri: "fixture://resource", name: "Fixture resource" }] }),
		});
		return;
	}
	if (method === "resources/read") {
		resourceReadCount += 1;
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: cacheResult({
				contents: [{ uri: "fixture://resource", text: `resource-read-${resourceReadCount}` }],
			}),
		});
		return;
	}
	if (method === "resources/templates/list") {
		send({ jsonrpc: "2.0", id: message.id, result: cacheResult({ resourceTemplates: [] }) });
		return;
	}
	if (method === "subscriptions/listen") {
		listenCount += 1;
		const subscriptionId = message.id as string | number;
		const requested = message.params?.notifications ?? {};
		const acknowledged = args.has("--ack-tools-only")
			? { ...(requested.toolsListChanged === true ? { toolsListChanged: true } : {}) }
			: requested;
		record({ type: "listen", listenCount, subscriptionId, requested, acknowledged });
		send({
			jsonrpc: "2.0",
			method: "notifications/subscriptions/acknowledged",
			params: {
				_meta: { "io.modelcontextprotocol/subscriptionId": subscriptionId },
				notifications: acknowledged,
			},
		});

		if (args.has("--emit-events") && listenCount === 1) {
			setTimeout(() => {
				const meta = { "io.modelcontextprotocol/subscriptionId": subscriptionId };
				if (acknowledged.toolsListChanged === true) {
					send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: meta } });
				}
				if (acknowledged.promptsListChanged === true) {
					send({ jsonrpc: "2.0", method: "notifications/prompts/list_changed", params: { _meta: meta } });
				}
				if (acknowledged.resourcesListChanged === true) {
					send({ jsonrpc: "2.0", method: "notifications/resources/list_changed", params: { _meta: meta } });
				}
				if (Array.isArray(acknowledged.resourceSubscriptions)) {
					send({
						jsonrpc: "2.0",
						method: "notifications/resources/updated",
						params: { _meta: meta, uri: "fixture://resource" },
					});
				}
			}, 250);
		}
		if (args.has("--crash-first") && generation === 1) {
			setTimeout(() => process.exit(17), 50);
		}
		return;
	}
	if (method === "notifications/cancelled") {
		const subscriptionId = message.params?.requestId as string | number;
		record({ type: "cancel", subscriptionId });
		if (args.has("--stale-after-cancel")) {
			setTimeout(() => {
				send({
					jsonrpc: "2.0",
					method: "notifications/resources/updated",
					params: {
						_meta: { "io.modelcontextprotocol/subscriptionId": subscriptionId },
						uri: "fixture://resource",
					},
				});
			}, 10);
		}
	}
});
