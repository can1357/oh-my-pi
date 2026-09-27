/**
 * Adoption: a topic nobody registered yet (created by hand, or found by the
 * bridge after a restart) gets its session on the first ordinary message. The
 * topic's own name — from its create service message or a manual rename —
 * becomes the session name, so an adopted topic keeps the label the operator
 * gave it.
 */
import { ADOPT_HELP, AUTO_SESSION_NAME, BOT_COMMANDS, parseCommand } from "./commands";
import type { TelegramBridgeContext } from "./context";
import { inTopic } from "./in-topic";
import { mdCode, mdText } from "./rich";
import type { TelegramMessage } from "./types";

const TEXT_NAME_WORDS = 4;
const TEXT_NAME_LIMIT = 40;
const COMMAND_PREFIX = "/";
const HELP_COMMANDS = new Set(["start", "help"]);
const WORKSPACE_COMMANDS = new Set(["new", "resume", "sessions"]);
const COMMANDS = new Set(BOT_COMMANDS.map(item => item.command));

/** Session name derived from the first message: at most four words, forty characters. */
export function nameFromText(text: string): string {
	const words = String(text).trim().split(/\s+/u).filter(Boolean).slice(0, TEXT_NAME_WORDS);
	let name = "";
	for (const word of words) {
		const grown = name === "" ? word : `${name} ${word}`;
		if (grown.length > TEXT_NAME_LIMIT) break;
		name = grown;
	}
	return (name === "" ? (words[0] ?? "") : name).slice(0, TEXT_NAME_LIMIT);
}

export interface TelegramAdopt {
	handle(input: { message: TelegramMessage; text: string; threadId: number }): Promise<string>;
	/** A topic was renamed while it had no session: remember the name and explain. */
	renamed(threadId: number, name: string): Promise<void>;
}

export function createAdopt(ctx: TelegramBridgeContext): TelegramAdopt {
	const names = new Map<number, string>();

	const topicName = (message: TelegramMessage): string | null => {
		const created = message.forum_topic_created ?? message.reply_to_message?.forum_topic_created;
		const name = String(created?.name ?? "").trim();
		if (name === "" || name.startsWith(COMMAND_PREFIX)) return null;
		return name;
	};

	const waitForText = (message: TelegramMessage): boolean =>
		message.forum_topic_created != null ||
		message.forum_topic_closed != null ||
		message.forum_topic_reopened != null ||
		message.general_forum_topic_hidden != null ||
		message.general_forum_topic_unhidden != null;

	const carried = (message: TelegramMessage, text: string): boolean =>
		text.trim() !== "" || (Array.isArray(message.photo) && message.photo.length > 0) || message.document != null;

	const remember = (message: TelegramMessage, threadId: number): void => {
		const name = topicName(message);
		if (name !== null) names.set(threadId, name);
	};

	const renamed = async (threadId: number, name: string): Promise<void> => {
		names.set(threadId, name);
		await ctx.notify(
			threadId,
			`Topic "${mdText(name)}" has no session yet: the first ordinary message will start one here.\n\n${ADOPT_HELP}`,
		);
	};

	const startHere = async (input: { message: TelegramMessage; text: string; threadId: number }): Promise<string> => {
		const known = names.get(input.threadId) ?? null;
		const name = ctx.registry.freeName(known ?? (nameFromText(input.text) || AUTO_SESSION_NAME));
		const cwd = ctx.config.defaultCwd;
		if (!ctx.existsDir(cwd)) {
			await ctx.notify(
				input.threadId,
				`⚠️ The default directory does not exist: ${mdCode(cwd)} — name one with \`/new <name> <directory>\`.`,
			);
			return "no_dir";
		}
		const now = ctx.clock.now();
		const placed = await ctx.workspace.place(
			{
				threadId: input.threadId,
				name,
				cwd,
				sessionFile: null,
				sessionId: null,
				status: "idle",
				createdAt: now,
				updatedAt: now,
			},
			{ renameTopic: known !== name },
		);
		if (!placed.ok) return placed.reason;
		ctx.log("topic adopted", { threadId: input.threadId, name, cwd });
		if (input.text.trim() === "" && !carried(input.message, input.text)) return "adopted";
		const entry = ctx.registry.get(input.threadId);
		if (entry === null) {
			ctx.log("adopted topic vanished from the registry", { threadId: input.threadId });
			return "adopted";
		}
		return inTopic({
			ctx,
			runtime: placed.runtime,
			entry,
			message: input.message,
			text: input.text,
		});
	};

	const handle = async (input: { message: TelegramMessage; text: string; threadId: number }): Promise<string> => {
		remember(input.message, input.threadId);
		const command = parseCommand(input.text);
		if (command === null) {
			if (carried(input.message, input.text)) return startHere(input);
			if (!waitForText(input.message)) await ctx.notify(input.threadId, ADOPT_HELP);
			ctx.log("service message in an unadopted topic", {
				threadId: input.threadId,
				name: names.get(input.threadId) ?? null,
			});
			return "topic_seen";
		}
		if (HELP_COMMANDS.has(command.name)) {
			await ctx.notify(input.threadId, ADOPT_HELP);
			return "help";
		}
		if (command.name === "new" && command.rest === "") return startHere({ ...input, text: "" });
		if (WORKSPACE_COMMANDS.has(command.name))
			return ctx.workspace.handle({ message: input.message, text: input.text });
		const head = COMMANDS.has(command.name)
			? `⚠️ \`/${mdText(command.name)}\` works in a topic that already has a session, and this one does not yet.`
			: `⚠️ Unknown command \`/${mdText(command.name)}\`.`;
		await ctx.notify(input.threadId, `${head}\n\n${ADOPT_HELP}`);
		return "unknown";
	};

	return { handle, renamed };
}
