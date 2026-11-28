import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { makeAssistantMessage } from "./helpers";

/**
 * Shape of `@mendable/firecrawl-js` `SearchData`: plain own fields plus a
 * non-enumerable `data` getter that throws to steer callers to `.web`.
 * `JSON.stringify` never reads it; the persistence walk must not either.
 */
function sdkResultWithThrowingGetter(): object {
	const result = { web: [{ url: "https://example.com", title: "Example" }] };
	Object.defineProperty(result, "data", {
		get() {
			throw new Error("SearchData has no '.data'. Results are grouped by source: .web (1 results)");
		},
		enumerable: false,
	});
	return result;
}

describe("tool result details with throwing accessors", () => {
	it("persists the tool result and every later entry", async () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		session.appendMessage({ role: "user", content: "search", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "firecrawl_search",
			content: [{ type: "text", text: "results" }],
			details: sdkResultWithThrowingGetter(),
			isError: false,
			timestamp: 2,
		});
		session.appendMessage({ role: "user", content: "after the search", timestamp: 3 });
		await session.flush();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file");
		const lines = storage
			.readTextSync(sessionFile)
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		const messages = lines.filter(line => line.type === "message").map(line => line.message);

		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
		expect(messages[2].details).toEqual({ web: [{ url: "https://example.com", title: "Example" }] });
	});

	// A field the line drops (`jsonlEvents`) makes the walk rebuild the object from the fields it read; reading a
	// getter again for the rebuilt copy wrote its second answer where `JSON.stringify` writes its first.
	it("writes a getter's first answer into an entry the walk rebuilds", async () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		session.appendMessage({ role: "user", content: "count", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		let reads = 0;
		session.appendCustomEntry("counter", {
			get a() {
				return ++reads;
			},
			jsonlEvents: [],
		});
		await session.flush();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file");
		const lines = Bun.JSONL.parse(storage.readTextSync(sessionFile)) as Array<Record<string, unknown>>;
		const custom = lines.find(line => line.type === "custom");

		expect(custom?.data).toEqual({ a: 1 });
	});
});
