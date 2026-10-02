/**
 * Host-level routing: the security gate, `/new`, prompts with follow-up
 * queuing, attachments, `/close`, renames, shutdown and forum reopen —
 * ported from the lifeos bridge tests.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { bridgeHarness, callback, fakeSession, message, update, type BridgeHarness } from "./host-fixtures";

const live: BridgeHarness[] = [];

function harness(options: Parameters<typeof bridgeHarness>[0] = {}): BridgeHarness {
	const made = bridgeHarness(options);
	live.push(made);
	return made;
}

afterEach(async () => {
	for (const made of live.splice(0)) {
		await made.host.stop();
		made.cleanup();
	}
});

/** Seeds a topic through `/new` with a session that reports `file`. */
async function seed(h: BridgeHarness, file: string | null = null, name = "Fox", chat = 555): Promise<void> {
	if (file !== null) h.queue(fakeSession({ file, name }));
	await h.host.handleUpdate(update({ message: message({ text: `/new ${name}`, chat }) }));
}

/** Every emoji the bridge reacted with on one message, in order. */
function reactionsOn(h: BridgeHarness, messageId: number): string[] {
	return h.api
		.of("setMessageReaction")
		.filter(entry => entry.fields.messageId === messageId)
		.map(entry => (entry.fields.reaction as Array<{ emoji: string }>)[0]?.emoji ?? "");
}

/** Lets the conveyor's serial rendering chain drain. */
async function settleConveyor(): Promise<void> {
	for (let tick = 0; tick < 500; tick += 1) await Promise.resolve();
}

describe("update gate", () => {
	it("drops updates from another chat or another user without answering", async () => {
		const h = harness();
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 7, text: "intruder", from: 2 }) }))).toBe(
			"denied",
		);
		expect(
			await h.host.handleUpdate(update({ message: message({ threadId: 7, text: "other chat", chat: 777 }) })),
		).toBe("denied");
		expect(
			await h.host.handleUpdate(update({ callback_query: callback({ threadId: 7, data: "turn:stop", from: 2 }) })),
		).toBe("denied");
		expect(
			await h.host.handleUpdate(update({ callback_query: callback({ threadId: 7, data: "turn:stop", chat: 777 }) })),
		).toBe("denied");
		expect(h.api.calls).toEqual([]);
		expect(h.requests).toHaveLength(0);
	});

	it("skips updates the bridge does not handle", async () => {
		const h = harness();
		expect(await h.host.handleUpdate({ update_id: 5, edited_message: { text: "edit" } } as never)).toBe("skipped");
		expect(h.api.calls).toEqual([]);
	});
});

describe("/new", () => {
	it("creates a topic, names the session and records it", async () => {
		const h = harness();
		expect(await h.host.handleUpdate(update({ message: message({ text: "/new Fox" }) }))).toBe("created");
		expect(h.api.of("createForumTopic").map(call => call.fields.name)).toEqual(["Fox"]);
		expect(h.requests[0].cwd).toBe("/work");
		expect(h.sessions[0].calls.filter(call => call.method === "setSessionName")).toEqual([
			{ method: "setSessionName", name: "Fox", source: "user" },
		]);
		expect(h.readRegistry()[0]).toMatchObject({ name: "Fox", cwd: "/work", threadId: 900, status: "idle" });
		expect(h.api.threadTexts(900).join("\n")).toContain("Fox");
	});

	it("takes the directory from the command", async () => {
		const h = harness();
		await h.host.handleUpdate(update({ message: message({ text: "/new Fox /srv/project" }) }));
		expect(h.requests[0].cwd).toBe("/srv/project");
	});

	it("refuses a name held by an open session without creating a topic", async () => {
		const h = harness();
		await seed(h);
		expect(await h.host.handleUpdate(update({ message: message({ text: "/new Fox" }) }))).toBe("taken");
		expect(h.api.of("createForumTopic")).toHaveLength(1);
		expect(h.requests).toHaveLength(1);
	});

	it("numbers the default session name when it is already taken", async () => {
		const h = harness();
		await h.host.handleUpdate(update({ message: message({ text: "/new" }) }));
		await h.host.handleUpdate(update({ message: message({ text: "/new" }) }));
		expect(h.api.of("createForumTopic").map(call => call.fields.name)).toEqual(["session", "session 2"]);
	});

	it("refuses a missing directory", async () => {
		const h = harness();
		h.existsDir = dir => dir !== "/nowhere";
		expect(await h.host.handleUpdate(update({ message: message({ text: "/new Fox /nowhere" }) }))).toBe("no_dir");
		expect(h.api.of("createForumTopic")).toHaveLength(0);
	});

	it("expands a home-relative directory", async () => {
		const h = harness();
		await h.host.handleUpdate(update({ message: message({ text: "/new Fox ~/tree" }) }));
		expect(h.requests[0].cwd).toBe("/home/dev/tree");
	});
});

describe("prompts in a topic", () => {
	it("passes text to the session as a follow-up-capable prompt", async () => {
		const h = harness();
		await seed(h);
		h.sessions[0].calls.length = 0;
		expect(
			await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "hello", messageId: 55 }) })),
		).toBe("prompt");
		expect(h.sessions[0].calls.filter(call => call.method === "prompt")).toEqual([
			{ method: "prompt", text: "hello", options: { streamingBehavior: "followUp" } },
		]);
	});

	it("queues the next message while a turn runs and marks it with eyes", async () => {
		const h = harness();
		await seed(h);
		await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "first", messageId: 55 }) }));
		await h.sessions[0].setStreaming(true);
		await h.sessions[0].emit({ type: "agent_start" } as never);
		await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "second", messageId: 56 }) }));
		const prompts = h.sessions[0].calls.filter(call => call.method === "prompt");
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toMatchObject({ text: "second", options: { streamingBehavior: "followUp" } });
		const eyes = h.api.of("setMessageReaction").find(call => call.fields.messageId === 56);
		expect(eyes?.fields).toMatchObject({ chatId: 555, messageId: 56 });
		expect(eyes?.fields.reaction).toEqual([{ type: "emoji", emoji: "👀" }]);
	});

	it("ends a message queued while the turn ran on 👌 when the turn settles", async () => {
		const h = harness();
		await seed(h);
		await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "first", messageId: 55 }) }));
		h.sessions[0].setStreaming(true);
		await h.sessions[0].emit({ type: "agent_start" } as never);
		await settleConveyor();
		await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "second", messageId: 56 }) }));
		expect(reactionsOn(h, 56)).toEqual(["👀"]);
		h.sessions[0].setStreaming(false);
		await h.sessions[0].emit({ type: "agent_end", isTerminal: true } as never);
		await settleConveyor();
		expect(reactionsOn(h, 55)).toContain("👌");
		expect(reactionsOn(h, 56)).toEqual(["👀", "👌"]);
	});

	it("reacts 🫡 on a message queued while the turn ran when the turn is stopped", async () => {
		const h = harness();
		await seed(h);
		await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "first", messageId: 55 }) }));
		h.sessions[0].setStreaming(true);
		await h.sessions[0].emit({ type: "agent_start" } as never);
		await settleConveyor();
		await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "second", messageId: 56 }) }));
		expect(
			await h.host.handleUpdate(update({ callback_query: callback({ threadId: 900, data: "turn:stop" }) })),
		).toBe("stopped");
		h.sessions[0].setStreaming(false);
		await h.sessions[0].emit({ type: "agent_end", isTerminal: true } as never);
		await settleConveyor();
		expect(reactionsOn(h, 56)).toEqual(["👀", "🫡"]);
	});

	it("sends a photo as an image and a document into the inbox with its path in the prompt", async () => {
		const h = harness();
		await seed(h);
		h.sessions[0].calls.length = 0;
		await h.host.handleUpdate(
			update({
				message: message({
					threadId: 900,
					text: "look",
					extra: {
						photo: [
							{ file_id: "small", file_unique_id: "s", width: 1, height: 1 },
							{ file_id: "big", file_unique_id: "b", width: 2, height: 2 },
						],
					},
				}),
			}),
		);
		const photo = h.sessions[0].calls.find(call => call.method === "prompt");
		const images = (photo?.options as { images?: Array<Record<string, unknown>> } | undefined)?.images ?? [];
		expect(images).toHaveLength(1);
		expect(Object.keys(images[0]).sort()).toEqual(["data", "mimeType", "type"]);
		expect(h.api.of("downloadFile").at(-1)?.fields).toEqual({ fileId: "big" });
		await h.sessions[0].setStreaming(false);
		await h.sessions[0].emit({ type: "agent_end", isTerminal: true } as never);
		await h.host.handleUpdate(
			update({
				message: message({
					threadId: 900,
					text: "read this",
					extra: { document: { file_id: "doc", file_unique_id: "d", file_name: "report.pdf" } },
				}),
			}),
		);
		const last = h.sessions[0].calls.filter(call => call.method === "prompt").at(-1);
		expect(String(last?.text)).toBe(`read this\nfile: ${h.dir}/state/inbox/900/1-report.pdf`);
	});

	it("refuses an empty message instead of prompting", async () => {
		const h = harness();
		await seed(h);
		h.sessions[0].calls.length = 0;
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "   " }) }))).toBe("empty");
		expect(h.sessions[0].calls.filter(call => call.method === "prompt")).toHaveLength(0);
	});
});

describe("/close", () => {
	it("disposes an owned session and marks the topic closed, and the next message raises it again", async () => {
		const h = harness();
		await seed(h, "/sessions/fox.jsonl");
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "/close" }) }))).toBe("close");
		expect(h.sessions[0].calls.some(call => call.method === "dispose")).toBe(true);
		expect(h.readRegistry()[0].status).toBe("closed");
		expect(h.host.status().liveSessions).toBe(0);
		h.queue(fakeSession({ file: "/sessions/fox.jsonl" }));
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "again" }) }))).toBe("prompt");
		expect(h.requests).toHaveLength(2);
		expect(h.requests[1].sessionFile).toBe("/sessions/fox.jsonl");
		// The raised session carries the topic's name.
		expect(h.sessions[1].calls.filter(call => call.method === "setSessionName")).toEqual([
			{ method: "setSessionName", name: "Fox", source: "user" },
		]);
	});

	it("closes a forum topic through the API and reopens it on the next message", async () => {
		const h = harness({ config: { chatId: -555 } });
		await seed(h, null, "Fox", -555);
		expect(
			await h.host.handleUpdate(update({ message: message({ threadId: 900, chat: -555, text: "/close" }) })),
		).toBe("close");
		expect(h.api.of("closeForumTopic").map(call => call.fields.threadId)).toEqual([900]);
		expect(h.readRegistry()[0].status).toBe("closed");
		h.queue(fakeSession());
		await h.host.handleUpdate(update({ message: message({ threadId: 900, chat: -555, text: "again" }) }));
		expect(h.api.of("reopenForumTopic").map(call => call.fields.threadId)).toEqual([900]);
		const renamed = h.api
			.of("editForumTopic")
			.filter(call => call.fields.name !== undefined)
			.at(-1);
		expect(renamed?.fields).toMatchObject({ chatId: -555, threadId: 900, name: "Fox" });
	});

	it("marks a private-chat topic closed by renaming it", async () => {
		const h = harness();
		await seed(h);
		await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "/close" }) }));
		expect(h.api.of("closeForumTopic")).toHaveLength(0);
		const renamed = h.api
			.of("editForumTopic")
			.filter(call => call.fields.name !== undefined)
			.at(-1);
		expect(renamed?.fields.name).toBe("Fox · closed");
	});
});

describe("rename and status", () => {
	it("follows a manual topic rename into the session name", async () => {
		const h = harness();
		await seed(h);
		h.sessions[0].calls.length = 0;
		await h.host.handleUpdate(
			update({ message: message({ threadId: 900, extra: { forum_topic_edited: { name: "Wolf" } } }) }),
		);
		expect(h.readRegistry()[0].name).toBe("Wolf");
		expect(h.sessions[0].calls.filter(call => call.method === "setSessionName")).toEqual([
			{ method: "setSessionName", name: "Wolf", source: "user" },
		]);
	});

	it("renames the session and the topic from /rename", async () => {
		const h = harness();
		await seed(h);
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "/rename Wolf" }) }))).toBe(
			"rename",
		);
		expect(h.readRegistry()[0].name).toBe("Wolf");
		expect(h.api.of("editForumTopic").at(-1)?.fields).toMatchObject({ threadId: 900, name: "Wolf" });
	});

	it("answers /status from the session getters without raising a session", async () => {
		const h = harness();
		await seed(h);
		h.sessions[0].calls.length = 0;
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "/status" }) }))).toBe(
			"status",
		);
		const text = h.api.threadTexts(900).at(-1) ?? "";
		expect(text).toContain("anthropic/claude-opus-4");
		expect(text).toContain("**State:** waiting");
		expect(text).toContain("**Context:** ▰▰▰▱▱▱▱▱▱▱ 25%");
	});

	it("does not raise a session for a command that can answer without one", async () => {
		const h = harness();
		await seed(h);
		h.queue(fakeSession());
		await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "/close" }) }));
		h.sessions.length = 0;
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "/status" }) }))).toBe(
			"status",
		);
		expect(h.sessions).toHaveLength(0);
		expect(h.readRegistry()[0].status).toBe("closed");
	});

	it("lists the registry in /sessions", async () => {
		const h = harness();
		await seed(h);
		expect(await h.host.handleUpdate(update({ message: message({ text: "/sessions" }) }))).toBe("sessions");
		const shown = h.api.sentTexts().at(-1) ?? "";
		expect(shown).toContain("| 1 | Fox | 💤 waiting | `/work` |");
		expect(shown).toContain("No live omp sessions without a topic.");
	});

	it("marks the registry running while a turn is in flight and idle once it settles", async () => {
		const h = harness();
		await seed(h);
		expect(h.readRegistry()[0].status).toBe("idle");
		await h.sessions[0].setStreaming(true);
		await h.sessions[0].emit({ type: "agent_start" } as never);
		expect(h.readRegistry()[0].status).toBe("running");
		await h.sessions[0].setStreaming(false);
		await h.sessions[0].emit({ type: "agent_end", isTerminal: true } as never);
		// The conveyor serializes its rendering on a promise chain; drain it.
		for (let tick = 0; tick < 500 && h.readRegistry()[0].status !== "idle"; tick += 1) {
			await Promise.resolve();
		}
		expect(h.readRegistry()[0].status).toBe("idle");
	});

	it("tells the user when the session refuses the prompt", async () => {
		const h = harness();
		await seed(h);
		h.sessions[0].session.prompt = async () => {
			throw new Error("provider exploded");
		};
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "go" }) }))).toBe("prompt");
		// The dispatch runs in the background; its failure reaches the topic afterwards.
		for (let tick = 0; tick < 500 && !h.api.threadTexts(900).some(text => text.includes("exploded")); tick += 1) {
			await Promise.resolve();
		}
		expect(h.api.threadTexts(900).at(-1)).toContain("Passing the message failed: provider exploded");
	});
});

describe("turn dispatch", () => {
	it("keeps serving updates while a prompt's turn is still running", async () => {
		const h = harness();
		await seed(h);
		// A prompt that starts a turn resolves only when the turn ends.
		const turn = Promise.withResolvers<boolean>();
		h.sessions[0].session.prompt = () => turn.promise;
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "go" }) }))).toBe("prompt");
		await h.sessions[0].emit({ type: "agent_start" } as never);
		expect(
			await h.host.handleUpdate(update({ callback_query: callback({ threadId: 900, data: "turn:stop" }) })),
		).toBe("stopped");
		expect(h.sessions[0].calls.filter(call => call.method === "abort")).toHaveLength(1);
		turn.resolve(true);
	});
});

describe("stop sources", () => {
	it("aborts the topic's turn from the stop button and from a stopped draft", async () => {
		const h = harness();
		await seed(h);
		await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "go" }) }));
		h.sessions[0].setStreaming(true);
		await h.sessions[0].emit({ type: "agent_start" } as never);
		expect(
			await h.host.handleUpdate(update({ callback_query: callback({ threadId: 900, data: "turn:stop" }) })),
		).toBe("stopped");
		expect(h.sessions[0].calls.filter(call => call.method === "abort")).toHaveLength(1);
		expect(h.api.of("answerCallbackQuery").at(-1)?.fields).toEqual({ id: "cb1", text: "Stopping" });
		expect(
			await h.host.handleUpdate(
				update({ stopped_message_generation: { chat: { id: 555, type: "supergroup" }, message_thread_id: 900 } }),
			),
		).toBe("stopped");
		expect(h.sessions[0].calls.filter(call => call.method === "abort")).toHaveLength(2);
	});

	it("never raises a session for a stop in a topic with no process", async () => {
		const h = harness();
		await seed(h);
		h.queue(fakeSession());
		await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "/close" }) }));
		h.sessions.length = 0;
		expect(
			await h.host.handleUpdate(
				update({ stopped_message_generation: { chat: { id: 555, type: "supergroup" }, message_thread_id: 900 } }),
			),
		).toBe("stopped");
		expect(
			await h.host.handleUpdate(update({ callback_query: callback({ threadId: 900, data: "turn:stop" }) })),
		).toBe("stopped");
		expect(h.sessions).toHaveLength(0);
		expect(h.api.of("answerCallbackQuery").at(-1)?.fields).toEqual({ id: "cb1", text: "No turn running" });
	});

	it("never aborts another topic's session from a stop without a thread", async () => {
		const h = harness();
		await seed(h);
		await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "go" }) }));
		h.sessions[0].setStreaming(true);
		await h.sessions[0].emit({ type: "agent_start" } as never);
		expect(await h.host.handleUpdate(update({ callback_query: callback({ data: "turn:stop" }) }))).toBe("stopped");
		expect(h.sessions[0].calls.filter(call => call.method === "abort")).toHaveLength(0);
	});
});

describe("host lifecycle", () => {
	it("stops owned sessions on shutdown but keeps the registry entry raisable", async () => {
		const h = harness();
		await seed(h, "/sessions/old.jsonl");
		h.queue(fakeSession({ file: "/sessions/old.jsonl" }));
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "again" }) }))).toBe("prompt");
		await h.host.stop();
		expect(h.sessions.every(session => session.calls.some(call => call.method === "dispose"))).toBe(true);
		expect(h.host.status().liveSessions).toBe(0);
		expect(h.readRegistry()[0].status).not.toBe("closed");
		h.restart();
		h.queue(fakeSession({ file: "/sessions/old.jsonl" }));
		expect(await h.host.handleUpdate(update({ message: message({ threadId: 900, text: "back" }) }))).toBe("prompt");
		expect(h.requests.at(-1)?.sessionFile).toBe("/sessions/old.jsonl");
		expect(h.sessions.at(-1)?.calls.filter(call => call.method === "setSessionName")).toEqual([
			{ method: "setSessionName", name: "Fox", source: "user" },
		]);
	});

	it("is idempotent on stop and reports status to listeners", async () => {
		const h = harness();
		const seen: string[] = [];
		const off = h.host.onStatusChange(status => seen.push(status.state));
		await h.host.stop();
		await h.host.stop();
		expect(seen).toContain("stopped");
		const status = h.host.status();
		expect(status).toMatchObject({ state: "stopped", attachedThreadId: null, error: null });
		off();
	});
});
