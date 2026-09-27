/**
 * The general stream: `/new`, `/resume`, `/sessions`, `/help` outside a
 * session topic, plus topic creation/adoption helpers shared with the
 * adoption flow and the forum-rename path.
 *
 * `/resume` takes the working directory from the session file's own `session`
 * header — never from `telegram.defaultCwd` — so a resumed session continues
 * in the project it was recorded in.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../session/session-manager";
import type { SessionInfo } from "../session/session-listing";
import { AUTO_SESSION_NAME, parseCommand, TOPIC_NAME_LIMIT, WORKSPACE_HELP } from "./commands";
import type { TelegramBridgeContext } from "./context";
import type { DeskOpenResult } from "./desk";
import { livePresenceOrEmpty, LOCAL_HOLDER_TEXT, sessionHolder, UNKNOWN_LIVENESS_TEXT } from "./liveness";
import { mdCode, mdText } from "./rich";
import { sessionListText } from "./status";
import { withoutClosedMark } from "./topics";
import type { TelegramMessage, TopicEntry, TopicEntryDraft } from "./types";

const MATCH_LIMIT = 25;

const HINT =
	"Outside a session topic, text never reaches a session. Create one with `/new` or raise an earlier one with `/resume`.";

/** `~/…` expanded against the user's home directory. */
export function expandHome(value: string, home: string = os.homedir()): string {
	const text = String(value);
	if (text === "~") return home;
	return text.startsWith("~/") ? path.join(home, text.slice(2)) : text;
}

/** Session id of a session file: its basename without the `.jsonl` suffix. */
export function sessionIdOf(file: string): string {
	return path.basename(String(file), ".jsonl");
}

export function shortId(id: string): string {
	return String(id).slice(0, 8);
}

/** Working directory recorded in the session file's `session` header; null when absent. */
export async function sessionCwdOf(file: string): Promise<string | null> {
	const peeked = await SessionManager.peekSessionInit(file);
	if (peeked === null) return null;
	const cwd = peeked.cwd;
	return typeof cwd === "string" && cwd.trim() !== "" ? cwd : null;
}

function matchesPart(session: SessionInfo, part: string): boolean {
	const wanted = part.toLowerCase();
	return (
		session.id.toLowerCase().startsWith(wanted) ||
		path.basename(session.path).toLowerCase().includes(wanted) ||
		session.path.toLowerCase().includes(wanted)
	);
}

/** Session files whose id path matches `part`; at most {@link MATCH_LIMIT}. */
export async function findSessionFiles(part: string): Promise<string[]> {
	const wanted = String(part).trim();
	if (wanted === "") return [];
	const sessions = await SessionManager.listAll();
	return sessions
		.filter(session => matchesPart(session, wanted))
		.slice(0, MATCH_LIMIT)
		.map(session => session.path);
}

export interface TelegramWorkspace {
	handle(input: { message: TelegramMessage; text: string }): Promise<string>;
	/** Adopts the topic `threadId` (or creates one) and raises its session. */
	place(entry: TopicEntryDraft, options?: { renameTopic?: boolean }): Promise<DeskOpenResult>;
	/** Forum topic renamed by hand: registry + session name follow. */
	renameTopic(threadId: number, name: string): Promise<string>;
	/** Live omp sessions of other processes that have no bridge topic. */
	liveText(): Promise<string>;
}

export function createWorkspace(ctx: TelegramBridgeContext): TelegramWorkspace {
	const threadOf = (message: TelegramMessage | null | undefined): number | null =>
		typeof message?.message_thread_id === "number" ? message.message_thread_id : null;

	const resolveTarget = async (part: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }> => {
		if (part.includes("/") || part.startsWith("~") || part.endsWith(".jsonl")) {
			const full = expandHome(part, ctx.home);
			if (!fs.existsSync(full)) return { ok: false, reason: `⚠️ No such session file: ${mdCode(full)}` };
			return { ok: true, path: full };
		}
		const found = await ctx.findSessions(part);
		if (found.length === 0) return { ok: false, reason: `⚠️ No session matches "${mdText(part)}".` };
		if (found.length > 1)
			return {
				ok: false,
				reason: `⚠️ ${found.length} sessions match "${mdText(part)}" — name a longer part of the id.`,
			};
		return { ok: true, path: found[0] };
	};

	const raise = async (entry: TopicEntry): Promise<DeskOpenResult> => {
		const started = await ctx.launch.start(entry, { rename: entry.sessionFile === null ? entry.name : null });
		if (!started.ok) return started;
		await ctx.notify(
			entry.threadId,
			`Session "${mdText(entry.name)}", directory ${mdCode(entry.cwd)}. Write text and it will reach the session.`,
		);
		return started;
	};

	const createTopic = async (entry: Omit<TopicEntryDraft, "threadId">): Promise<DeskOpenResult> => {
		const threadId = await ctx.topics.create(entry.name);
		if (threadId === null) return { ok: false, reason: "no_topic" };
		const placed: TopicEntry = ctx.registry.put({ ...entry, threadId });
		return raise(placed);
	};

	const adoptTopic = async (entry: TopicEntryDraft, renameTopic: boolean): Promise<DeskOpenResult> => {
		const placed = ctx.registry.put(entry);
		const started = await ctx.launch.start(placed, { rename: placed.name });
		if (!started.ok) return started;
		if (renameTopic) {
			try {
				await ctx.topics.rename(placed.threadId, placed.name);
			} catch (error) {
				await ctx.notify(placed.threadId, `⚠️ Could not rename the topic: ${mdText(String(error))}`);
			}
		}
		await ctx.notify(placed.threadId, `Session "${mdText(placed.name)}" started in ${mdCode(placed.cwd)}.`);
		return started;
	};

	const place = async (
		entry: TopicEntryDraft | Omit<TopicEntryDraft, "threadId">,
		options?: { renameTopic?: boolean },
	): Promise<DeskOpenResult> =>
		"threadId" in entry ? adoptTopic(entry, options?.renameTopic ?? false) : createTopic(entry);

	const openedTopic = async (
		threadId: number | null,
		entry: Omit<TopicEntry, "threadId">,
	): Promise<DeskOpenResult> => {
		if (entry.name.length > TOPIC_NAME_LIMIT) {
			await ctx.notify(
				threadId,
				`⚠️ Topic names are at most ${TOPIC_NAME_LIMIT} characters — Telegram rejects longer ones.`,
			);
			return { ok: false, reason: "name_long" };
		}
		const done = await place(typeof threadId === "number" ? { ...entry, threadId } : entry, {
			renameTopic: threadId !== null,
		});
		if (!done.ok && done.reason === "no_topic") {
			await ctx.notify(
				threadId,
				"⚠️ Telegram created a topic without a thread id — there is nowhere to run the session.",
			);
		}
		return done;
	};

	const createSession = async (rest: string, threadId: number | null): Promise<string> => {
		const words = rest.split(/\s+/u).filter(Boolean);
		const named = words.shift() ?? "";
		const name = named === "" ? ctx.registry.freeName(AUTO_SESSION_NAME) : named;
		const taken = ctx.registry.byName(name);
		if (taken !== null && taken.status !== "closed") {
			await ctx.notify(threadId, `⚠️ The name "${mdText(name)}" is taken — pick another or open that topic.`);
			return "taken";
		}
		const target = words.join(" ");
		// The registry is per bot, not per launch directory: only an absolute
		// path survives a host started from another cwd later.
		const cwd =
			target === "" ? ctx.config.defaultCwd : path.resolve(ctx.config.defaultCwd, expandHome(target, ctx.home));
		if (!ctx.existsDir(cwd)) {
			await ctx.notify(threadId, `⚠️ No such directory: ${mdCode(cwd)}`);
			return "no_dir";
		}
		const now = ctx.clock.now();
		const done = await openedTopic(threadId, {
			name,
			cwd,
			sessionFile: null,
			sessionId: null,
			status: "idle",
			createdAt: now,
			updatedAt: now,
		});
		return done.ok ? "created" : done.reason;
	};

	const resumeSession = async (rest: string, threadId: number | null): Promise<string> => {
		const words = rest.split(/\s+/u).filter(Boolean);
		const target = words.shift() ?? "";
		const named = words.join(" ") || null;
		if (target === "") {
			await ctx.notify(threadId, "⚠️ Form: `/resume <part of id or path .jsonl> [name]`");
			return "usage";
		}
		const resolved = await resolveTarget(target);
		if (!resolved.ok) {
			await ctx.notify(threadId, resolved.reason);
			return "no_session";
		}
		const id = sessionIdOf(resolved.path);
		// "Already open here" is the precise answer; the second-writer gate would
		// only say "held" because this host is the holder.
		const existing = ctx.registry.list().find(entry => entry.sessionFile === resolved.path) ?? null;
		if (existing !== null && existing.status !== "closed") {
			await ctx.notify(threadId, `⚠️ That session already runs in topic "${mdText(existing.name)}".`);
			return "already_open";
		}
		const holder = await sessionHolder(ctx.liveness, { file: resolved.path, id });
		if (holder.lookup === "unknown") {
			await ctx.notify(threadId, UNKNOWN_LIVENESS_TEXT);
			return "unknown_liveness";
		}
		if (holder.lookup === "held") {
			await ctx.notify(
				threadId,
				holder.local
					? LOCAL_HOLDER_TEXT
					: `⚠️ Session ${mdCode(shortId(id))} is live in another process — writing the same file is refused.`,
			);
			return "busy_session";
		}
		const cwd = await ctx.sessionCwd(resolved.path);
		if (cwd === null) {
			await ctx.notify(
				threadId,
				`⚠️ File ${mdCode(resolved.path)} has no session record with a directory — there is nowhere to raise it.`,
			);
			return "no_cwd";
		}
		if (!ctx.existsDir(cwd)) {
			await ctx.notify(threadId, `⚠️ The session directory is gone: ${mdCode(cwd)} — there is nowhere to raise it.`);
			return "no_cwd_dir";
		}
		const name = (named ?? id).slice(0, TOPIC_NAME_LIMIT);
		if (existing !== null) {
			const placed = existing.cwd === cwd ? existing : ctx.registry.update(existing.threadId, { cwd });
			const started = await ctx.launch.start(placed, { rename: placed.name });
			if (!started.ok) return started.reason;
			await ctx.notify(
				placed.threadId,
				`Session "${mdText(placed.name)}" raised again in ${mdCode(cwd)}. Write text — it goes there.`,
			);
			if (threadId !== null && threadId !== placed.threadId) {
				await ctx.notify(
					threadId,
					`That session lives in topic "${mdText(placed.name)}" — it was raised again; write there.`,
				);
			}
			return "reopened";
		}
		const now = ctx.clock.now();
		const done = await openedTopic(threadId, {
			name,
			cwd,
			sessionFile: resolved.path,
			sessionId: id,
			status: "idle",
			createdAt: now,
			updatedAt: now,
		});
		return done.ok ? "created" : done.reason;
	};

	const liveText = async (): Promise<string> => {
		const view = await livePresenceOrEmpty(ctx);
		if (!view.ok) return `⚠️ Could not read the machine's live sessions: ${mdText(view.reason)}`;
		const rows = view.sessions
			.filter(session => session.kind === "interactive" && ctx.registry.bySessionFile(session.sessionFile) === null)
			.map(session => {
				const id = mdCode(`id ${shortId(session.sessionId)}`);
				const name = mdText(session.sessionName ?? "unnamed");
				return `- ${id} · ${name} · ${session.kind} · ${mdCode(session.cwd)}`;
			});
		if (rows.length === 0) return "No live omp sessions without a topic.";
		return [
			"**Live omp sessions on this machine without a topic — list only:** writing into another live session is refused; two writers would corrupt its file.",
			"",
			...rows,
		].join("\n");
	};

	const handle = async (input: { message: TelegramMessage; text: string }): Promise<string> => {
		const threadId = threadOf(input.message);
		const command = parseCommand(input.text);
		if (command === null) {
			await ctx.notify(threadId, HINT);
			return "hint";
		}
		if (command.name === "new") return createSession(command.rest, threadId);
		if (command.name === "resume") return resumeSession(command.rest, threadId);
		if (command.name === "sessions") {
			await ctx.notify(threadId, [sessionListText(ctx.registry.list()), await liveText()].join("\n\n"));
			return "sessions";
		}
		if (command.name === "help") {
			await ctx.notify(threadId, WORKSPACE_HELP);
			return "help";
		}
		await ctx.notify(
			threadId,
			`⚠️ Outside a session topic only \`/new\`, \`/resume\`, \`/sessions\` and \`/help\` work.\n\n${WORKSPACE_HELP}`,
		);
		return "unknown";
	};

	const renameTopic = async (threadId: number, name: string): Promise<string> => {
		const entry = ctx.registry.get(threadId);
		if (entry === null) {
			ctx.log("topic rename for an unknown topic", { threadId });
			return "unknown";
		}
		if (withoutClosedMark(name) !== null) {
			ctx.log("topic rename carries the closed mark", { threadId });
			return "closed_mark";
		}
		if (entry.name === name) return "same";
		ctx.registry.update(threadId, { name });
		const runtime = ctx.desk.get(threadId);
		if (runtime !== null && runtime.alive()) {
			try {
				await runtime.rename(name);
			} catch (error) {
				ctx.log("session rename failed", { threadId, error: String(error) });
			}
		}
		return "renamed";
	};

	return { handle, place, renameTopic, liveText };
}
