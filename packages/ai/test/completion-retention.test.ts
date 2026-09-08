import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { complete, completeSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

afterEach(() => {
	clearCustomApis();
});

describe("completion event retention", () => {
	for (const completion of [complete, completeSimple]) {
		test(`${completion.name} releases streamed events while preserving the final response`, async () => {
			registerMockApi();
			const mock = createMockModel({ responses: [{ content: ["first", "second", "third"] }] });
			const streams = new Set<AssistantMessageEventStream>();
			const push = AssistantMessageEventStream.prototype.push;
			const observer = spyOn(AssistantMessageEventStream.prototype, "push").mockImplementation(function (
				this: AssistantMessageEventStream,
				event: AssistantMessageEvent,
			) {
				streams.add(this);
				push.call(this, event);
			});
			try {
				const message = await completion(mock.model, {
					systemPrompt: [],
					messages: [{ role: "user", content: "go", timestamp: 0 }],
				});
				expect(message.content).toEqual([
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
					{ type: "text", text: "third" },
				]);
				expect(message.stopReason).toBe("stop");
				expect([...streams].flatMap(stream => stream.queue)).toEqual([]);
			} finally {
				observer.mockRestore();
			}
		});
	}
});
