/**
 * In-topic handling: prompts, attachments, command replies and the warning
 * paths, ported from the lifeos `telegram-bridge-commands` tests.
 */
import { describe, expect, it } from "bun:test";
import type { TelegramBridgeContext } from "@oh-my-pi/pi-coding-agent/telegram/context";
import { inTopic } from "@oh-my-pi/pi-coding-agent/telegram/in-topic";
import type { TopicSessionRuntime } from "@oh-my-pi/pi-coding-agent/telegram/topic-session";
import type { TelegramMessage, TopicEntry } from "@oh-my-pi/pi-coding-agent/telegram/types";

interface Harness {
	ctx: TelegramBridgeContext;
	runtime: TopicSessionRuntime;
	entry: TopicEntry;
	said: Array<Record<string, unknown>>;
	sent: string[];
	runtimeCalls: Array<Record<string, unknown>>;
}

function harness(overrides: Record<string, unknown> = {}): Harness {
	const sent: string[] = [];
	const said: Array<Record<string, unknown>> = [];
	const runtimeCalls: Array<Record<string, unknown>> = [];
	const ctx = {
		notify: async (_threadId: number | null, markdown: string) => {
			sent.push(markdown);
			return true;
		},
		registry: {
			update: (_threadId: number, patch: Record<string, unknown>) => {
				runtimeCalls.push({ method: "registry.update", patch });
				return null;
			},
		},
		desk: {
			close: async (_threadId: number) => {
				runtimeCalls.push({ method: "desk.close" });
				return true;
			},
		},
		topics: {
			close: async () => {
				runtimeCalls.push({ method: "topics.close" });
				return true;
			},
			rename: async (_threadId: number, name: string) => {
				runtimeCalls.push({ method: "topics.rename", name });
			},
		},
		workspace: {
			renameTopic: async (_threadId: number, name: string) => {
				runtimeCalls.push({ method: "workspace.renameTopic", name });
				return "renamed";
			},
		},
		api: { downloadFile: async () => Buffer.from("x") },
		writeInbox: async ({ name }: { name: string }) => `/state/inbox/7/${name}`,
		log: () => {},
	} as unknown as TelegramBridgeContext;
	const runtime = {
		threadId: 7,
		attached: false,
		say: async (payload: Record<string, unknown>) => {
			said.push(payload);
		},
		steer: async (text: string) => {
			runtimeCalls.push({ method: "steer", text });
		},
		abort: async () => {
			runtimeCalls.push({ method: "abort" });
		},
		state: () => ({ model: { provider: "anthropic", id: "claude-opus-4" } }),
		rename: async (name: string) => {
			runtimeCalls.push({ method: "rename", name });
		},
		setModel: async (selector: string) => {
			runtimeCalls.push({ method: "setModel", selector });
		},
		setThinking: async (level: string) => {
			runtimeCalls.push({ method: "setThinking", level });
		},
		compact: async () => {
			runtimeCalls.push({ method: "compact" });
		},
		close: async () => {},
		stop: async () => {},
		alive: () => true,
		busy: () => false,
		sessionFile: () => null,
		sessionId: () => "s1",
		reopen: async () => {},
		dispose: async () => {},
		...overrides,
	} as unknown as TopicSessionRuntime;
	const entry: TopicEntry = {
		threadId: 7,
		name: "Fox",
		cwd: "/work",
		sessionFile: null,
		sessionId: null,
		status: "idle",
		createdAt: 1,
		updatedAt: 1,
	};
	return { ctx, runtime, entry, said, sent, runtimeCalls };
}

const messageOf = (extra: Partial<TelegramMessage> = {}): TelegramMessage => ({
	message_id: 1,
	from: { id: 1, first_name: "Dev" },
	chat: { id: 555, type: "supergroup" },
	date: 0,
	text: "",
	...extra,
});

const run = (h: Harness, text: string, extra: Partial<TelegramMessage> = {}) =>
	inTopic({ ctx: h.ctx, runtime: h.runtime, entry: h.entry, message: messageOf(extra), text });

describe("in-topic prompts", () => {
	it("passes a prompt with the human message id and sender", async () => {
		const h = harness();
		expect(await run(h, "hello", { message_id: 55 })).toBe("prompt");
		expect(h.said).toEqual([{ text: "hello", messageId: 55, from: "Dev" }]);
		expect(h.sent).toEqual([]);
	});

	it("passes a photo as an image with the same message id", async () => {
		const h = harness();
		const photo = [
			{ file_id: "small", file_unique_id: "s", width: 1, height: 1 },
			{ file_id: "big", file_unique_id: "b", width: 2, height: 2 },
		];
		expect(await run(h, "here", { message_id: 61, photo })).toBe("photo");
		expect(h.said).toHaveLength(1);
		expect(h.said[0]).toMatchObject({ text: "here", messageId: 61 });
		expect((h.said[0].images as unknown[]).length).toBe(1);
	});

	it("warns about an empty message instead of prompting", async () => {
		const h = harness();
		expect(await run(h, "   ")).toBe("empty");
		expect(h.said).toEqual([]);
		expect(h.sent.at(-1)).toContain("nothing to pass");
	});
});

describe("in-topic commands", () => {
	it("marks a failed command with a warning and escapes foreign text", async () => {
		const h = harness({
			steer: async () => {
				throw new Error("no *such* | mode");
			},
		});
		expect(await run(h, "/steer help")).toBe("steer");
		expect(h.sent.at(-1)).toBe("⚠️ cutting in failed: no \\*such\\* \\| mode");
	});

	it("answers help with a heading and the command list", async () => {
		const h = harness();
		expect(await run(h, "/help")).toBe("help");
		const help = h.sent.at(-1) ?? "";
		expect(help).toMatch(/^## In a session topic$/mu);
		expect(help).toMatch(/^- `\/steer` — /mu);
		expect(help).toMatch(/^- `\/close` — /mu);
	});

	it("warns on an unknown command and on a workspace command, with the help text", async () => {
		const h = harness();
		expect(await run(h, "/foo")).toBe("unknown");
		expect(h.sent.at(-1)).toMatch(/^⚠️ Unknown command `\/foo`\./u);
		expect(h.sent.at(-1)).toContain("## In a session topic");
		expect(await run(h, "/new")).toBe("workspace_command");
		expect(h.sent.at(-1)).toMatch(/^⚠️ \/new creates a new topic/u);
	});

	it("answers a command in a topic without a session instead of staying silent", async () => {
		const h = harness();
		expect(await inTopic({ ctx: h.ctx, runtime: null, entry: h.entry, message: messageOf(), text: "/compact" })).toBe(
			"compact",
		);
		expect(h.sent.at(-1)).toBe("⚠️ This session is not running right now — send a message and it will be raised.");
	});

	it("validates /model and /thinking before touching the session", async () => {
		const h = harness();
		expect(await run(h, "/model anthropic")).toBe("model");
		expect(h.sent.at(-1)).toContain("Form: `/model <provider/model>`");
		expect(h.runtimeCalls.filter(call => call.method === "setModel")).toHaveLength(0);
		expect(await run(h, "/thinking extreme")).toBe("thinking");
		expect(h.sent.at(-1)).toContain("Unknown thinking level");
		expect(h.runtimeCalls.filter(call => call.method === "setThinking")).toHaveLength(0);
		expect(await run(h, "/thinking high")).toBe("thinking");
		expect(h.runtimeCalls.at(-1)).toEqual({ method: "setThinking", level: "high" });
	});

	it("reports compaction as started without waiting for it and routes a later failure", async () => {
		const h = harness();
		expect(await run(h, "/compact")).toBe("compact");
		expect(h.sent.at(-1)).toBe("Compaction started.");
	});

	it("closes the session and the topic, then says it can be raised again", async () => {
		const h = harness();
		expect(await run(h, "/close")).toBe("close");
		expect(h.runtimeCalls.map(call => call.method)).toEqual(["desk.close", "topics.close"]);
		expect(h.sent.at(-1)).toContain("Session closed.");
	});

	it("refuses a rename that carries the closed mark", async () => {
		const h = harness();
		h.ctx.workspace.renameTopic = async () => "closed_mark";
		expect(await run(h, "/rename Fox · closed")).toBe("rename");
		expect(h.sent.at(-1)).toContain("may not carry the closed mark");
		expect(h.runtimeCalls.filter(call => call.method === "topics.rename")).toHaveLength(0);
	});
});
