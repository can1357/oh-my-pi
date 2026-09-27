/**
 * Texts and transcript parsing of read-only mirror topics.
 *
 * A mirror relays what an *interactive* session running in another omp process
 * already wrote to its JSONL file: agent replies keep their markdown, human
 * prompts travel as escaped quotes, `ask` tool calls and results become
 * notices, everything else (thinking, other tool calls, tool results) stays in
 * the file. The module also owns the byte-level session-file readers the tail
 * loop runs on.
 */
import * as path from "node:path";
import { AUTO_SESSION_NAME, TOPIC_NAME_LIMIT } from "./commands";
import { mdCode, mdText } from "./rich";

/** Bytes of a session file scanned while looking for the header. */
export const SESSION_HEAD_BYTES = 64 * 1024;

/** The session in the terminal ended; the topic's next message continues it here. */
export const MIRROR_ENDED = "The session ended in the terminal; writing here now continues it here.";
export const MIRROR_CLOSED =
	"⚠️ Mirror closed: this session is no longer relayed here. While it runs in the terminal you cannot write here.";
export const MIRROR_READOPTED =
	"⚠️ The session is running in the terminal again — this topic mirrors it; you cannot write here until it ends.";
const MIRROR_COMMANDS = "Only /close and /rename work in a mirror topic.";
const ASK_HEAD = "The agent is waiting for an answer in the terminal:";
const ASK_TAIL = "You can answer only in the terminal.";
const ASK_ANSWER = "Answer:";
const ASK_NOTHING = "—";
const ASK_QUESTION_LIMIT = 200;
const ASK_OPTION_LIMIT = 20;

/** Which side of the transcript a relayed message came from. */
export type MirrorWho = "agent" | "human";

/** One relayable transcript message. */
export interface TranscriptMessage {
	who: MirrorWho;
	text: string;
}

/** Session facts a mirror needs for its topic name and header. */
export interface MirrorSessionInfo {
	sessionId: string;
	sessionName: string | null;
	cwd: string;
	pid: number;
	sessionFile: string;
}

function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function arrayOf(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function clip(value: unknown, width: number): string {
	const text = String(value ?? "")
		.replace(/\s+/gu, " ")
		.trim();
	return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/** Reads the text of a message content field (string or text parts). */
function textOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	const parts = arrayOf(content)
		.map(part =>
			field(part, "type") === "text" && typeof field(part, "text") === "string"
				? (field(part, "text") as string)
				: "",
		)
		.filter(text => text !== "");
	return parts.join("\n").trim();
}

function optionOf(value: unknown, recommended: boolean): { label: string; description: string; recommended: boolean } {
	if (typeof value === "string") return { label: value, description: "", recommended };
	const label = field(value, "label");
	const description = field(value, "description");
	return {
		label: typeof label === "string" ? label : "",
		description: typeof description === "string" ? description : "",
		recommended,
	};
}

function optionLines(options: readonly { label: string; description: string; recommended: boolean }[]): string[] {
	return options.slice(0, ASK_OPTION_LIMIT).map((option, at) => {
		const description = option.description !== "" ? ` — ${mdText(option.description)}` : "";
		const mark = option.recommended ? " ⭐" : "";
		return `${at + 1}. **${mdText(option.label)}**${description}${mark}`;
	});
}

function askQuestionsOf(part: unknown): unknown[] | null {
	if (field(part, "type") !== "toolCall" || field(part, "name") !== "ask") return null;
	const questions = field(field(part, "arguments"), "questions");
	return Array.isArray(questions) ? questions : null;
}

function askNoticeText(questions: readonly unknown[]): string {
	const lines = [`**${ASK_HEAD}**`];
	for (const question of questions) {
		lines.push("", `**${mdText(clip(field(question, "question"), ASK_QUESTION_LIMIT))}**`);
		const recommended = field(question, "recommended");
		lines.push(
			...optionLines(arrayOf(field(question, "options")).map((option, at) => optionOf(option, at === recommended))),
		);
	}
	lines.push("", ASK_TAIL);
	return lines.join("\n");
}

function answerOf(result: unknown): string {
	const selected = arrayOf(field(result, "selectedOptions")).filter(
		(option): option is string => typeof option === "string" && option !== "",
	);
	const custom = field(result, "customInput");
	const said = typeof custom === "string" && custom !== "" ? custom : selected.join(", ");
	return mdText(said === "" ? ASK_NOTHING : said);
}

function askAnswerText(details: unknown): string {
	const nested = field(details, "results");
	const results = Array.isArray(nested)
		? nested
		: [details].filter(result => typeof field(result, "question") === "string");
	const lines = results.map(result =>
		results.length > 1 ? `${mdText(String(field(result, "id") ?? "—"))}: ${answerOf(result)}` : answerOf(result),
	);
	return `**${ASK_ANSWER}** ${lines.join("; ")}`;
}

function assistantMessages(content: unknown): TranscriptMessage[] {
	const found: TranscriptMessage[] = [];
	const said: string[] = [];
	const flush = (): void => {
		const joined = said.join("\n").trim();
		said.length = 0;
		if (joined !== "") found.push({ who: "agent", text: joined });
	};
	for (const part of arrayOf(content)) {
		const questions = askQuestionsOf(part);
		if (questions !== null) {
			flush();
			found.push({ who: "agent", text: askNoticeText(questions) });
			continue;
		}
		const text = field(part, "text");
		if (field(part, "type") === "text" && typeof text === "string") said.push(text);
	}
	flush();
	return found;
}

/** The relayable messages of one JSONL line, in file order. */
function lineMessages(line: string): TranscriptMessage[] {
	const found: TranscriptMessage[] = [];
	if (line.trim() === "") return found;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return found;
	}
	const type = field(parsed, "type");
	if (type === "custom_message") {
		if (field(parsed, "attribution") !== "user") return found;
		const said = textOf(field(parsed, "content"));
		if (said !== "") found.push({ who: "human", text: said });
		return found;
	}
	if (type !== "message") return found;
	const message = field(parsed, "message");
	const role = field(message, "role");
	if (role === "toolResult") {
		if (field(message, "toolName") === "ask") {
			found.push({ who: "agent", text: askAnswerText(field(message, "details")) });
		}
		return found;
	}
	if (role === "user") {
		if (field(message, "synthetic") === true) return found;
		const said = textOf(field(message, "content"));
		if (said !== "") found.push({ who: "human", text: said });
		return found;
	}
	if (role !== "assistant") return found;
	found.push(...assistantMessages(field(message, "content")));
	return found;
}

/**
 * Extracts the relayable messages of a JSONL chunk: assistant text (with `ask`
 * notices in file order), `ask` results, and human prompts (plain user messages
 * plus `custom_message` entries attributed to the user, such as the Telegram and
 * collab prompt types). Thinking, other tool calls, tool results and synthetic
 * user messages are dropped.
 */
export function transcriptMessages(text: string): TranscriptMessage[] {
	const found: TranscriptMessage[] = [];
	for (const line of String(text).split("\n")) found.push(...lineMessages(line));
	return found;
}

/** A relayable message and the byte position just past the line that carried it. */
export interface PositionedTranscriptMessage {
	message: TranscriptMessage;
	offset: number;
}

/**
 * Like {@link transcriptMessages}, but every message carries the byte position
 * just past its own line. `text` holds complete lines (as
 * {@link readSessionLines} returns them), so a relay that stops after any
 * message can be resumed from the next one without re-reading that line.
 */
export function transcriptMessagesFrom(text: string, from: number): PositionedTranscriptMessage[] {
	const found: PositionedTranscriptMessage[] = [];
	const encoder = new TextEncoder();
	const lines = String(text).split("\n");
	let at = from;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		at += encoder.encode(line).length + (index < lines.length - 1 ? 1 : 0);
		for (const message of lineMessages(line)) found.push({ message, offset: at });
	}
	return found;
}

/** Agent replies travel as-is; human prompts become escaped multi-line quotes. */
export function mirrorChunks(message: TranscriptMessage): string[] {
	if (message.who === "human") return [humanQuote(message.text)];
	return message.text === "" ? [] : [message.text];
}

function humanQuote(value: unknown): string {
	const lines = String(value)
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.map(line => mdText(line));
	const head = "> 👤 **Human:**";
	const [first = "", ...rest] = lines;
	return [first === "" ? head : `${head} ${first}`, ...rest.map(line => `> ${line}`)].join("\n");
}

/** Topic name of a new mirror: the session title, else its presence name, else the short session id. */
export function mirrorName(session: MirrorSessionInfo, title: string | null): string {
	const fromTitle = (title ?? "").trim();
	const named = fromTitle !== "" ? fromTitle : (session.sessionName ?? "").trim();
	if (named !== "") return named.slice(0, TOPIC_NAME_LIMIT);
	const id = shortId(session.sessionId);
	return id === "" ? AUTO_SESSION_NAME : id;
}

function runningInTerminal(pid: number | null): string {
	const where = pid === null ? "the terminal" : `the terminal (pid ${pid})`;
	return `The session is running in ${where} — writing here is not allowed: a second writer would corrupt its file. When it ends, a message here continues it.`;
}

/** Header of a freshly adopted mirror: name, session, pid and directory. */
export function mirrorHeader(session: MirrorSessionInfo, name: string): string {
	return [
		`## 🖥 ${mdText(name)}`,
		"",
		`Mirror of session ${mdCode(shortId(session.sessionId))} — it is running in the terminal (pid ${mdCode(session.pid)}).`,
		"",
		`- **Directory:** ${mdCode(clip(session.cwd, 120))}`,
		"",
		`> ⚠️ ${runningInTerminal(session.pid)}`,
	].join("\n");
}

/** Read-only refusal shown for any mirror text that is not `/close` or `/rename`. */
export function refusalText(command: { name: string; rest: string } | null, pid: number | null): string {
	const lines = [`⚠️ ${runningInTerminal(pid)}`];
	if (command !== null) lines.push(MIRROR_COMMANDS);
	return lines.join("\n");
}

export function shortId(id: unknown): string {
	return String(id ?? "").slice(0, 8);
}

export function sessionIdOf(file: unknown): string {
	return path.basename(String(file ?? ""), ".jsonl");
}

export type SessionFileSize = { ok: true; size: number } | { ok: false; reason: string };

export async function sessionFileSize(file: string): Promise<SessionFileSize> {
	try {
		const handle = Bun.file(file);
		if (!(await handle.exists())) return { ok: false, reason: "file does not exist" };
		return { ok: true, size: handle.size };
	} catch (error) {
		return { ok: false, reason: String(error instanceof Error ? error.message : error) };
	}
}

async function readSessionHead(file: string): Promise<string | null> {
	try {
		const bytes = await Bun.file(file).slice(0, SESSION_HEAD_BYTES).bytes();
		return new TextDecoder().decode(bytes);
	} catch {
		return null;
	}
}

/** Working directory recorded in the session header, or null. */
export async function sessionCwdOf(file: string): Promise<string | null> {
	const text = await readSessionHead(file);
	if (text === null) return null;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (field(parsed, "type") !== "session") continue;
		const cwd = field(parsed, "cwd");
		return typeof cwd === "string" && cwd.trim() !== "" ? cwd : null;
	}
	return null;
}

/** Current session title: the title slot, else the header title, else null. */
export async function sessionTitleOf(file: string): Promise<string | null> {
	const text = await readSessionHead(file);
	if (text === null) return null;
	let fromHeader: string | null = null;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const rawTitle = field(parsed, "title");
		const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
		if (title === "") continue;
		if (field(parsed, "type") === "title") return title;
		if (field(parsed, "type") === "session" && fromHeader === null) fromHeader = title;
	}
	return fromHeader;
}

export type SessionLines = { ok: true; text: string; offset: number } | { ok: false; reason: string };

/**
 * Reads the complete lines of a session file starting at `from`, up to `size`
 * (default: the current file size). A trailing partial line is left for the
 * next read: `offset` is the byte position after the last newline.
 */
export async function readSessionLines(file: string, options: { from: number; size?: number }): Promise<SessionLines> {
	const measured: SessionFileSize =
		options.size === undefined ? await sessionFileSize(file) : { ok: true, size: options.size };
	if (!measured.ok) return measured;
	const length = measured.size - options.from;
	if (!Number.isFinite(length) || length <= 0) return { ok: true, text: "", offset: Math.max(0, options.from) };
	try {
		const bytes = await Bun.file(file)
			.slice(options.from, options.from + length)
			.bytes();
		const at = bytes.lastIndexOf(0x0a);
		if (at === -1) return { ok: true, text: "", offset: options.from };
		const whole = bytes.subarray(0, at + 1);
		return { ok: true, text: new TextDecoder().decode(whole), offset: options.from + whole.byteLength };
	} catch (error) {
		return { ok: false, reason: String(error instanceof Error ? error.message : error) };
	}
}
