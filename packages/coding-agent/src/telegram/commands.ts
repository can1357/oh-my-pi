/**
 * Bot command surface: the menu registered with Telegram, the command parser
 * (including the `/cmd@botname` form Telegram sends in groups) and the help
 * texts rendered into topics, adoption topics and the general stream.
 */
import type { TelegramBotCommand } from "./types";

/** Telegram refuses topic names longer than this. */
export const TOPIC_NAME_LIMIT = 128;

/** Default name of a session created without one. */
export const AUTO_SESSION_NAME = "session";

export const BOT_COMMANDS: readonly TelegramBotCommand[] = [
	{ command: "new", description: "new session: /new [name] [directory]" },
	{ command: "sessions", description: "bridge sessions and live machine sessions" },
	{ command: "resume", description: "raise an earlier session: /resume <id part> [name]" },
	{ command: "status", description: "state of this session" },
	{ command: "steer", description: "cut into the running turn: /steer <text>" },
	{ command: "stop", description: "interrupt the turn" },
	{ command: "rename", description: "rename the session and its topic: /rename <name>" },
	{ command: "model", description: "switch model: /model <provider/model>" },
	{ command: "thinking", description: "thinking level: /thinking <level>" },
	{ command: "compact", description: "compact the context" },
	{ command: "close", description: "close the session and its topic" },
	{ command: "help", description: "help" },
];

function commandLines(names: readonly string[]): string[] {
	return names.flatMap(name => {
		const item = BOT_COMMANDS.find(one => one.command === name);
		return item === undefined ? [] : [`- \`/${item.command}\` — ${item.description}`];
	});
}

export const TOPIC_HELP: string = [
	"## In a session topic",
	"",
	"Plain text goes to the session; while a turn runs it queues as a follow-up.",
	"A photo arrives as an image, a document as a file in the bridge inbox.",
	"",
	...commandLines(["steer", "stop", "status", "rename", "model", "thinking", "compact", "close", "help"]),
].join("\n");

export const ADOPT_HELP: string = [
	"## Topic without a session",
	"",
	"The first ordinary message in a new topic starts a session in it.",
	"",
	...commandLines(["new", "resume", "sessions", "help"]),
].join("\n");

export const WORKSPACE_HELP: string = [
	"## General stream",
	"",
	...commandLines(["new", "resume", "sessions", "help"]),
	"",
	"Text written outside a session topic never reaches a session — create one with `/new` first.",
].join("\n");

const COMMAND = /^\/([a-z_]+)(?:@(\S+))?(?:\s+([\s\S]*))?$/iu;

export interface ParsedCommand {
	name: string;
	rest: string;
	/** Bot the message addresses (`/name@bot`); null when it names no bot. */
	addressee: string | null;
}

/**
 * Parses `/name`, `/name@bot` and `/name rest`; null when the text is not a
 * command. Names are matched case-insensitively (mobile keyboards capitalize
 * the first letter), and the caller decides whether `addressee` is this bot.
 */
export function parseCommand(text: string): ParsedCommand | null {
	const match = COMMAND.exec(String(text).trim());
	if (match === null) return null;
	return {
		name: match[1].toLowerCase(),
		rest: (match[3] ?? "").trim(),
		addressee: match[2] ?? null,
	};
}
