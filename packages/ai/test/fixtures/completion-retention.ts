import assert from "node:assert/strict";
import { registerCustomApi } from "../../src/api-registry";
import { createMockModel } from "../../src/providers/mock";
import { complete, completeSimple } from "../../src/stream";
import type { AssistantMessage, AssistantMessageEvent } from "../../src/types";
import { AssistantMessageEventStream } from "../../src/utils/event-stream";

const completion = process.argv[2] === "complete" ? complete : completeSimple;
// Exempt this local provider from leaked-thinking healing, which replaces event identities.
const model = { ...createMockModel().model, provider: "openai", baseUrl: "https://api.openai.com/v1" };
const response = new AssistantMessageEventStream();
const started = Promise.withResolvers<void>();
registerCustomApi(model.api, () => {
	started.resolve();
	return response;
});

const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "first second" }],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
};

function emit(): WeakRef<AssistantMessageEvent>[] {
	const events: AssistantMessageEvent[] = [
		{ type: "start", partial: message },
		{ type: "text_start", contentIndex: 0, partial: message },
		{ type: "text_delta", contentIndex: 0, delta: "first ", partial: message },
	];
	const references = events.map(event => new WeakRef(event));
	for (const event of events) response.push(event);
	// An async iterator may retain its latest yield while waiting for the next event.
	response.push({ type: "text_delta", contentIndex: 0, delta: "second", partial: message });
	return references;
}

let settled = false;
const result = completion(model, { messages: [{ role: "user", content: "go", timestamp: 0 }] });
void result.then(
	() => {
		settled = true;
		started.reject(new Error("completion settled before provider dispatch"));
	},
	error => {
		settled = true;
		started.reject(error);
	},
);
await started.promise;
const references = emit();
const deadline = performance.now() + 5_000;
let collected = false;
do {
	// WeakRef targets survive the job that dereferences them; collect in a later turn.
	await Bun.sleep(0);
	Bun.gc(true);
	collected = references.every(reference => reference.deref() === undefined);
} while (!collected && performance.now() < deadline);
assert.equal(settled, false, "completion settled before the producer sent a terminal event");
assert.equal(collected, true, "completion retained earlier events while the producer was paused");

if (process.argv[3] === "failure") {
	const failure = new Error("producer disconnected before completion");
	response.fail(failure);
	await assert.rejects(result, error => error === failure);
} else {
	response.push({ type: "done", reason: "stop", message });
	response.end();
	assert.deepEqual((await result).content, [{ type: "text", text: "first second" }]);
	assert.equal((await result).stopReason, "stop");
}
process.stdout.write("verified\n");
