/**
 * Adoption: the first ordinary message in a topic nobody registered starts a
 * session there, named after the topic (or the message), with the general
 * stream's commands still available.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { bridgeHarness, message, update, type BridgeHarness } from "./host-fixtures";
import { nameFromText } from "@oh-my-pi/pi-coding-agent/telegram/adopt";

const TOPIC = 530186;

const live: BridgeHarness[] = [];

function harness(): BridgeHarness {
	const made = bridgeHarness();
	live.push(made);
	return made;
}

afterEach(async () => {
	for (const made of live.splice(0)) {
		await made.host.stop();
		made.cleanup();
	}
});

describe("adoption", () => {
	it("starts a session on the first ordinary message and sends it there", async () => {
		const h = harness();
		expect(
			await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "Answer in one word: ok" }) })),
		).toBe("prompt");
		expect(h.api.of("createForumTopic")).toHaveLength(0);
		expect(h.requests[0].cwd).toBe("/work");
		const stored = h.readRegistry()[0];
		expect(stored.name).toBe("Answer in one word:");
		expect(stored.cwd).toBe("/work");
		expect(stored.threadId).toBe(TOPIC);
		expect(h.sessions[0].calls.filter(call => call.method === "setSessionName")).toEqual([
			{ method: "setSessionName", name: "Answer in one word:", source: "user" },
		]);
		expect(h.api.of("editForumTopic").at(-1)?.fields).toMatchObject({ threadId: TOPIC, name: "Answer in one word:" });
	});

	it("takes the session name from the topic's create service message", async () => {
		const h = harness();
		expect(
			await h.host.handleUpdate(
				update({ message: message({ threadId: TOPIC, extra: { forum_topic_created: { name: "Debugging" } } }) }),
			),
		).toBe("topic_seen");
		expect(h.api.calls).toEqual([]);
		expect(h.readRegistry()).toHaveLength(0);
		expect(await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "hello" }) }))).toBe(
			"prompt",
		);
		expect(h.readRegistry()[0].name).toBe("Debugging");
		expect(h.api.of("editForumTopic")).toHaveLength(0);
		expect(h.sessions[0].calls.filter(call => call.method === "setSessionName")).toEqual([
			{ method: "setSessionName", name: "Debugging", source: "user" },
		]);
	});

	it("reads the topic name from the reply-to service message of the first post", async () => {
		const h = harness();
		const extra = {
			reply_to_message: {
				message_id: 1,
				chat: { id: 555, type: "supergroup" as const },
				date: 0,
				forum_topic_created: { name: "Debugging" },
			},
		};
		expect(await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "look", extra }) }))).toBe(
			"prompt",
		);
		expect(h.readRegistry()[0].name).toBe("Debugging");
		expect(h.api.of("editForumTopic")).toHaveLength(0);
	});

	it("suffixes a name an open session already holds and renames the topic", async () => {
		const h = harness();
		await h.host.handleUpdate(update({ message: message({ text: "/new Debugging" }) }));
		await h.host.handleUpdate(
			update({ message: message({ threadId: TOPIC, extra: { forum_topic_created: { name: "Debugging" } } }) }),
		);
		expect(await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "look" }) }))).toBe("prompt");
		expect(
			h
				.readRegistry()
				.map(entry => entry.name)
				.sort(),
		).toEqual(["Debugging", "Debugging 2"]);
		expect(h.api.of("editForumTopic").at(-1)?.fields).toMatchObject({ threadId: TOPIC, name: "Debugging 2" });
	});

	it("starts a session from a captionless photo and names it by default", async () => {
		const h = harness();
		expect(
			await h.host.handleUpdate(
				update({
					message: message({
						threadId: TOPIC,
						extra: { photo: [{ file_id: "big", file_unique_id: "b", width: 2, height: 2 }] },
					}),
				}),
			),
		).toBe("photo");
		expect(h.readRegistry()[0].name).toBe("session");
		const prompt = h.sessions[0].calls.find(call => call.method === "prompt");
		expect(prompt?.text).toBe("photo");
	});

	it("answers /start and /help in the topic without starting a session", async () => {
		const h = harness();
		expect(await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "/start" }) }))).toBe("help");
		expect(h.api.of("sendRichMessage").at(-1)?.fields.threadId).toBe(TOPIC);
		expect(h.api.sentTexts().at(-1)).toContain("The first ordinary message in a new topic starts a session in it.");
		expect(await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "/help" }) }))).toBe("help");
		expect(h.api.of("createForumTopic")).toHaveLength(0);
		expect(h.requests).toHaveLength(0);
	});

	it("lists the registry into an unknown topic for /sessions", async () => {
		const h = harness();
		await h.host.handleUpdate(update({ message: message({ text: "/new Fox" }) }));
		expect(await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "/sessions" }) }))).toBe(
			"sessions",
		);
		expect(h.api.of("sendRichMessage").at(-1)?.fields.threadId).toBe(TOPIC);
		expect(h.api.sentTexts().at(-1)).toContain("| 1 | Fox | 💤 waiting | `/work` |");
	});

	it("answers a command of another session and an unknown command with a hint", async () => {
		const h = harness();
		expect(await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "/foo" }) }))).toBe(
			"unknown",
		);
		expect(h.api.sentTexts().at(-1)).toContain("Unknown command `/foo`");
		expect(await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "/status" }) }))).toBe(
			"unknown",
		);
		expect(h.api.sentTexts().at(-1)).toContain("does not yet");
		expect(h.requests).toHaveLength(0);
	});

	it("remembers a manual rename of an unadopted topic", async () => {
		const h = harness();
		expect(
			await h.host.handleUpdate(
				update({ message: message({ threadId: TOPIC, extra: { forum_topic_edited: { name: "Plans" } } }) }),
			),
		).toBe("topic_renamed");
		expect(h.api.sentTexts().at(-1)).toContain('Topic "Plans" has no session yet');
		expect(await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "go" }) }))).toBe("prompt");
		expect(h.readRegistry()[0].name).toBe("Plans");
	});

	it("answers a message without text or attachment with the help text", async () => {
		const h = harness();
		expect(await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "   " }) }))).toBe(
			"topic_seen",
		);
		expect(h.api.sentTexts().at(-1)).toContain("## Topic without a session");
		expect(h.requests).toHaveLength(0);
	});

	it("lets neither a foreign user nor a foreign chat reach an unknown topic", async () => {
		const h = harness();
		expect(
			await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "intruder", from: 2 }) })),
		).toBe("denied");
		expect(
			await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "other chat", chat: 777 }) })),
		).toBe("denied");
		expect(
			await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "/start", from: 2 }) })),
		).toBe("denied");
		expect(h.api.calls).toEqual([]);
		expect(h.readRegistry()).toHaveLength(0);
	});

	it("ignores a topic name Telegram took from a command", async () => {
		const h = harness();
		await h.host.handleUpdate(
			update({ message: message({ threadId: TOPIC, extra: { forum_topic_created: { name: "/new" } } }) }),
		);
		await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "read the report" }) }));
		expect(h.readRegistry()[0].name).toBe("read the report");
	});

	it("adopts an unknown topic for /new instead of creating another one", async () => {
		const h = harness();
		expect(await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "/new Fox" }) }))).toBe(
			"created",
		);
		expect(h.api.of("createForumTopic")).toHaveLength(0);
		const stored = h.readRegistry()[0];
		expect(stored.threadId).toBe(TOPIC);
		expect(stored.name).toBe("Fox");
		expect(stored.cwd).toBe("/work");
		expect(h.api.of("editForumTopic").at(-1)?.fields).toMatchObject({ threadId: TOPIC, name: "Fox" });
	});

	it("adopts a default-named session for a bare /new in an unknown topic", async () => {
		const h = harness();
		await h.host.handleUpdate(
			update({ message: message({ threadId: TOPIC, extra: { forum_topic_created: { name: "/new" } } }) }),
		);
		expect(await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "/new" }) }))).toBe(
			"adopted",
		);
		expect(h.readRegistry()[0].name).toBe("session");
		expect(h.sessions[0].calls.filter(call => call.method === "prompt")).toHaveLength(0);
	});

	it("raises a resumed session in the unknown topic it was asked from", async () => {
		const h = harness();
		const file = `${h.dir}/abc123.jsonl`;
		h.found = [file];
		h.sessionCwd = () => "/work/tree";
		expect(await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "/resume abc123" }) }))).toBe(
			"created",
		);
		expect(h.api.of("createForumTopic")).toHaveLength(0);
		const stored = h.readRegistry()[0];
		expect(stored.threadId).toBe(TOPIC);
		expect(stored.name).toBe("abc123");
		expect(stored.cwd).toBe("/work/tree");
		expect(stored.sessionFile).toBe(file);
	});

	it("points a resumed session at its own topic when it is already open elsewhere", async () => {
		const h = harness();
		const file = `${h.dir}/abc123.jsonl`;
		h.found = [file];
		h.sessionCwd = () => "/work";
		await h.host.handleUpdate(update({ message: message({ threadId: TOPIC, text: "/resume abc123" }) }));
		expect(
			await h.host.handleUpdate(update({ message: message({ threadId: 777001, text: "/resume abc123" }) })),
		).toBe("already_open");
	});
});

describe("nameFromText", () => {
	it("keeps at most four words and forty characters", () => {
		expect(nameFromText("Answer in one word")).toBe("Answer in one word");
		expect(nameFromText("Answer in one word: ok")).toBe("Answer in one word:");
		expect(nameFromText("one two three four five")).toBe("one two three four");
		expect(nameFromText("x".repeat(60))).toBe("x".repeat(40));
		expect(nameFromText("word ".repeat(20))).toBe("word word word word");
		expect(nameFromText("  ")).toBe("");
	});
});
