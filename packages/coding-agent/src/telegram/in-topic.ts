/**
 * In-topic handling: the prompt/attachment path and the session commands
 * (`/steer`, `/stop`, `/status`, `/rename`, `/model`, `/thinking`, `/compact`,
 * `/close`, `/help`). Everything the session cannot handle right now replies
 * with a warning instead of staying silent.
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { TOPIC_HELP, TOPIC_NAME_LIMIT, parseCommand } from "./commands";
import type { TelegramBridgeContext } from "./context";
import { inboxFileName } from "./inbox";
import { mdCode, mdText } from "./rich";
import { statusText } from "./status";
import type { TopicSessionRuntime } from "./topic-session";
import type { TelegramMessage, TopicEntry } from "./types";

const DEAD_TEXT = "⚠️ This session is not running right now — send a message and it will be raised.";
const WORKSPACE_ONLY = new Set(["new", "resume", "sessions"]);

const THINKING_LEVELS = "off, minimal, low, medium, high, xhigh, max, auto";

function imageContent(data: Uint8Array): ImageContent {
	return { type: "image", data: Buffer.from(data).toString("base64"), mimeType: "image/jpeg" };
}

const senderName = (message: TelegramMessage): string => {
	const from = message.from;
	if (from === undefined) return "telegram user";
	const full = [from.first_name, from.last_name].filter(part => part !== undefined && part !== "").join(" ");
	return full !== "" ? full : (from.username ?? "telegram user");
};

async function attempt<T>(
	ctx: TelegramBridgeContext,
	threadId: number | null,
	prefix: string,
	run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; value: null }> {
	try {
		return { ok: true, value: await run() };
	} catch (error) {
		await ctx.notify(threadId, `⚠️ ${prefix}: ${mdText(error instanceof Error ? error.message : String(error))}`);
		return { ok: false, value: null };
	}
}

async function inTopicCommand(input: {
	ctx: TelegramBridgeContext;
	runtime: TopicSessionRuntime | null;
	entry: TopicEntry;
	command: { name: string; rest: string };
	/** Telegram sender display name, attributed on relayed prompts. */
	from: string;
}): Promise<string | null> {
	const { ctx, runtime, entry, command, from } = input;
	const threadId = runtime === null ? entry.threadId : runtime.threadId;
	const rest = command.rest;
	const dead = (): Promise<boolean> => ctx.notify(threadId, DEAD_TEXT);
	if (command.name === "steer") {
		if (rest === "") {
			await ctx.notify(threadId, "⚠️ Form: `/steer <text>`");
			return "steer";
		}
		if (runtime === null) {
			await dead();
			return "steer";
		}
		const done = await attempt(ctx, threadId, "cutting in failed", () => runtime.steer(rest, from));
		if (done.ok) await ctx.notify(threadId, "Passed to the session.");
		return "steer";
	}
	if (command.name === "stop") {
		if (runtime === null) {
			await ctx.notify(threadId, "⚠️ No turn is running: the session is not up.");
			return "stop";
		}
		const done = await attempt(ctx, threadId, "interrupting failed", () => runtime.abort());
		if (done.ok) await ctx.notify(threadId, "Turn interrupted.");
		return "stop";
	}
	if (command.name === "status") {
		const done =
			runtime === null
				? { ok: true as const, value: null }
				: await attempt(ctx, threadId, "reading the state failed", async () => runtime.state());
		if (done.ok) await ctx.notify(threadId, statusText(done.value, entry));
		return "status";
	}
	if (command.name === "rename") {
		if (rest === "" || rest.length > TOPIC_NAME_LIMIT) {
			await ctx.notify(
				threadId,
				`⚠️ The name must be non-empty and at most ${TOPIC_NAME_LIMIT} characters: \`/rename <name>\``,
			);
			return "rename";
		}
		const done = await attempt(ctx, threadId, "renaming failed", async () => {
			const outcome = await ctx.workspace.renameTopic(threadId, rest);
			if (outcome === "closed_mark") throw new Error("the name may not carry the closed mark");
			await ctx.topics.rename(threadId, rest);
		});
		if (done.ok) await ctx.notify(threadId, `The session and its topic are now "${mdText(rest)}".`);
		return "rename";
	}
	if (command.name === "model") {
		if (!/^[^/\s]+\/[^/\s]+$/u.test(rest)) {
			await ctx.notify(threadId, "⚠️ Form: `/model <provider/model>`, e.g. `/model anthropic/claude-sonnet-4-5`");
			return "model";
		}
		if (runtime === null) {
			await dead();
			return "model";
		}
		const done = await attempt(ctx, threadId, "switching the model failed", () => runtime.setModel(rest));
		if (done.ok) await ctx.notify(threadId, `Model: ${mdCode(rest)}`);
		return "model";
	}
	if (command.name === "thinking") {
		if (rest === "") {
			await ctx.notify(threadId, `⚠️ Form: \`/thinking <level>\` (${THINKING_LEVELS})`);
			return "thinking";
		}
		if (parseConfiguredThinkingLevel(rest) === undefined) {
			await ctx.notify(threadId, `⚠️ Unknown thinking level "${mdText(rest)}". Available: ${THINKING_LEVELS}.`);
			return "thinking";
		}
		if (runtime === null) {
			await dead();
			return "thinking";
		}
		const done = await attempt(ctx, threadId, "changing the thinking level failed", () => runtime.setThinking(rest));
		if (done.ok) await ctx.notify(threadId, `Thinking level: ${mdText(rest)}`);
		return "thinking";
	}
	if (command.name === "compact") {
		if (runtime === null) {
			await dead();
			return "compact";
		}
		// Compaction can run for minutes: report the start now and route the
		// failure later, so the poll loop keeps answering during it.
		await ctx.notify(threadId, "Compaction started.");
		runtime.compact().catch(async (error: unknown) => {
			await ctx.notify(
				threadId,
				`⚠️ Compaction failed: ${mdText(error instanceof Error ? error.message : String(error))}`,
			);
		});
		return "compact";
	}
	if (command.name === "close") {
		await ctx.notify(threadId, "Closing the session and its topic.");
		await attempt(ctx, threadId, "closing the session failed", () => ctx.desk.close(threadId));
		await attempt(ctx, threadId, "closing the topic failed", () => ctx.topics.close(threadId, entry.name));
		await ctx.notify(threadId, "Session closed. A message in this topic will raise it again.");
		return "close";
	}
	if (command.name === "help") {
		await ctx.notify(threadId, TOPIC_HELP);
		return "help";
	}
	return null;
}

async function deliverAttachment(
	ctx: TelegramBridgeContext,
	runtime: TopicSessionRuntime,
	message: TelegramMessage,
	text: string,
): Promise<string | null> {
	const from = senderName(message);
	const photo = Array.isArray(message.photo) && message.photo.length > 0 ? message.photo.at(-1) : undefined;
	if (photo !== undefined) {
		const done = await attempt(ctx, runtime.threadId, "downloading the photo failed", async () => {
			const data = await ctx.api.downloadFile(photo.file_id);
			await runtime.say({
				text: text === "" ? "photo" : text,
				images: [imageContent(data)],
				messageId: message.message_id,
				from,
			});
		});
		return done.ok ? "photo" : "photo_failed";
	}
	const document = message.document;
	if (document !== undefined) {
		const done = await attempt(ctx, runtime.threadId, "saving the file failed", async () => {
			const data = await ctx.api.downloadFile(document.file_id);
			const saved = await ctx.writeInbox({
				threadId: runtime.threadId,
				name: inboxFileName(message.message_id, document),
				data,
			});
			const prefix = text === "" ? "" : `${text}\n`;
			await runtime.say({ text: `${prefix}file: ${saved}`, messageId: message.message_id, from });
		});
		return done.ok ? "document" : "document_failed";
	}
	return null;
}

export async function inTopic(input: {
	ctx: TelegramBridgeContext;
	runtime: TopicSessionRuntime | null;
	entry: TopicEntry;
	message: TelegramMessage;
	text: string;
}): Promise<string> {
	const { ctx, runtime, entry, message, text } = input;
	const command = parseCommand(text);
	if (command !== null) {
		const handled = await inTopicCommand({ ctx, runtime, entry, command, from: senderName(message) });
		if (handled !== null) return handled;
		const threadId = runtime === null ? entry.threadId : runtime.threadId;
		if (WORKSPACE_ONLY.has(command.name)) {
			await ctx.notify(
				threadId,
				`⚠️ /${command.name} creates a new topic — write it in the general stream, outside a session topic.`,
			);
			return "workspace_command";
		}
		await ctx.notify(threadId, `⚠️ Unknown command \`/${mdText(command.name)}\`.\n\n${TOPIC_HELP}`);
		return "unknown";
	}
	if (runtime === null) {
		await ctx.notify(entry.threadId, DEAD_TEXT);
		return "dead";
	}
	const attachment = await deliverAttachment(ctx, runtime, message, text);
	if (attachment !== null) return attachment;
	if (text.trim() === "") {
		await ctx.notify(runtime.threadId, "⚠️ Empty message — there is nothing to pass to the session.");
		return "empty";
	}
	const done = await attempt(ctx, runtime.threadId, "passing the message failed", () =>
		runtime.say({ text, messageId: message.message_id, from: senderName(message) }),
	);
	return done.ok ? "prompt" : "prompt_failed";
}
