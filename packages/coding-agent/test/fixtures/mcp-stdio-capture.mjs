#!/usr/bin/env node
import * as fs from "node:fs";
import * as readline from "node:readline";

const frameLog = process.env.OMP_TEST_FRAME_LOG;
if (!frameLog) throw new Error("OMP_TEST_FRAME_LOG is required");

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", line => {
	fs.appendFileSync(frameLog, `${line}\n`);

	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}

	if (message.method === "fixture/emit-server-request") {
		send({
			jsonrpc: "2.0",
			id: "fixture-server-request",
			method: "roots/list",
			params: {},
		});
		return;
	}

	if (message.method === "fixture/respond" && message.id !== undefined) {
		send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
		return;
	}

	if (message.method === "subscriptions/listen" && message.id !== undefined) {
		const subscriptionMeta = { "io.modelcontextprotocol/subscriptionId": message.id };
		if (message.params?.notifications?.resourceSubscriptions?.includes("fixture://before-ack")) {
			send({
				jsonrpc: "2.0",
				method: "notifications/resources/updated",
				params: { _meta: subscriptionMeta, uri: "fixture://before-ack" },
			});
			return;
		}
		const notifications =
			process.env.OMP_TEST_ACK_TOOLS_ONLY === "1"
				? { toolsListChanged: message.params?.notifications?.toolsListChanged === true }
				: message.params?.notifications;
		send({
			jsonrpc: "2.0",
			method: "notifications/subscriptions/acknowledged",
			params: { _meta: subscriptionMeta, notifications },
		});
		if (process.env.OMP_TEST_EMIT_SUBSCRIPTION_DURING_LISTEN_WRITE === "1") {
			send({
				jsonrpc: "2.0",
				method: "notifications/tools/list_changed",
				params: { _meta: subscriptionMeta },
			});
		}
		return;
	}

	if (message.method === "fixture/emit-subscription") {
		const requestId = message.params?.requestId;
		const method = message.params?.notificationMethod ?? "notifications/tools/list_changed";
		send({
			jsonrpc: "2.0",
			method,
			params: {
				_meta: { "io.modelcontextprotocol/subscriptionId": requestId },
				...(message.params?.uri ? { uri: message.params.uri } : {}),
			},
		});
		return;
	}

	if (message.method === "fixture/close-subscription") {
		const requestId = message.params?.requestId;
		send({
			jsonrpc: "2.0",
			id: requestId,
			result: {
				resultType: "complete",
				_meta: { "io.modelcontextprotocol/subscriptionId": requestId },
			},
		});
		return;
	}

	if (message.method === "fixture/close-input") {
		rl.close();
		process.stdin.destroy();
		setTimeout(() => process.exit(0), 2_000);
	}
});
