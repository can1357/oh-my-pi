/**
 * Protocol handler for `session://` URLs: read-only access to past conversations
 * (sessions) stored on disk, rendered with the same concise transcript view as
 * `history://`.
 *
 * URL forms:
 * - `session://` — recent sessions for the caller's cwd (id, title, updated, turns).
 * - `session://<id>` — transcript of that session (accepts full id or unique prefix).
 *   Supports `?detail=brief|normal|full|user:full,call:brief`, `?budget=<chars>`,
 *   and `?turns=-5|1,3`.
 */
import * as fs from "node:fs/promises";
import { getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import sessionPromptDoc from "../prompts/internal-urls/session.md" with { type: "text" };
import {
	listAllSessionsForPicker,
	listSessionsForPicker,
	sessionDisplayName,
	type SessionInfo,
} from "../session/session-listing";
import { loadSessionMessagesReadOnly } from "../session/session-loader";
import { sessionDirForCwd } from "../session/session-paths";
import { FileSessionStorage } from "../session/session-storage";
import {
	renderTranscriptMessages,
	TRANSCRIPT_KINDS,
	TRANSCRIPT_LEVELS,
	type TranscriptDetailRequest,
	type TranscriptDetails,
	type TranscriptViewOptions,
} from "../session/transcript-view";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	UrlCompletion,
} from "./types";

const COMPLETE_DETAIL: TranscriptDetails = {
	user: "full",
	assistant: "full",
	thinking: "omit",
	call: "normal",
	result: "omit",
};
const MIN_BUDGET = 500;
const LIST_CAP = 30;

function parseDetail(text: string): TranscriptDetailRequest {
	const all = TRANSCRIPT_LEVELS.find(level => level === text);
	if (all) return all;
	const request: Partial<TranscriptDetails> = {};
	for (const pair of text.split(",")) {
		const [name, value] = pair.split(":");
		const kind = TRANSCRIPT_KINDS.find(candidate => candidate === name);
		const level = TRANSCRIPT_LEVELS.find(candidate => candidate === value);
		if (!kind || !level) {
			throw new Error(`Invalid session:// detail "${text}". Use brief|normal|full or kind:level pairs.`);
		}
		if (level !== "auto") request[kind] = level;
	}
	return request;
}

function parseBudget(text: string): number {
	const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
	if (!(value >= MIN_BUDGET)) {
		throw new Error(`Invalid session:// budget "${text}". Expected a whole number >= ${MIN_BUDGET}.`);
	}
	return value;
}

/** `3` (one turn), `3,5` (inclusive); negatives count back from the last turn. */
function parseTurns(text: string): number | [number, number] {
	const match = /^(-?\d+)(?:,(-?\d+))?$/.exec(text.trim());
	if (!match) {
		throw new Error(`Invalid session:// turns "${text}". Expected a turn or range like 3,5 or -3,-1.`);
	}
	return match[2] === undefined ? Number(match[1]) : [Number(match[1]), Number(match[2])];
}

function sessionViewOptions(url: InternalUrl, title: string): TranscriptViewOptions {
	const detail = url.searchParams.get("detail");
	const budget = url.searchParams.get("budget");
	const turns = url.searchParams.get("turns");
	return {
		budget: budget === null ? Number.POSITIVE_INFINITY : parseBudget(budget),
		detail: detail !== null ? parseDetail(detail) : budget !== null ? "auto" : COMPLETE_DETAIL,
		turns: turns !== null ? parseTurns(turns) : undefined,
		window: undefined,
		title,
	};
}

function formatAge(date: Date): string {
	const sec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
	if (sec < 60) return `${sec}s ago`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
	if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
	return `${Math.floor(sec / 86400)}d ago`;
}

function matchSession(sessions: readonly SessionInfo[], idQuery: string): SessionInfo | undefined {
	const exact = sessions.find(s => s.id === idQuery);
	if (exact) return exact;
	const lower = idQuery.toLowerCase();
	const prefixed = sessions.filter(s => s.id.toLowerCase().startsWith(lower));
	return prefixed.length === 1 ? prefixed[0] : undefined;
}

async function listProjectSessions(cwd: string): Promise<SessionInfo[]> {
	const storage = new FileSessionStorage();
	const dir = sessionDirForCwd(cwd);
	try {
		await fs.access(dir);
	} catch {
		return [];
	}
	const listing = await listSessionsForPicker(dir, storage, new Set());
	const scanned = await listing.complete;
	return scanned.length > 0 ? scanned : listing.sessions;
}

/** Read-only protocol handler for past conversation transcripts (`session://`). */
export class SessionProtocolHandler implements ProtocolHandler {
	readonly scheme = "session";
	readonly spec: SchemeSpec = {
		backing: "virtual",
		selectors: "lines",
		immutable: false,
	};

	promptDoc(): string {
		return sessionPromptDoc.trim();
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const cwd = context?.cwd ?? process.cwd();
		const targetId = decodeURIComponent(url.rawHost || url.hostname).trim();
		const local = await listProjectSessions(cwd);

		if (!targetId) {
			const lines = ["# Recent Sessions", ""];
			if (local.length === 0) {
				lines.push("No past sessions found for this project.");
			} else {
				lines.push("| id | title | updated |", "|---|---|---|");
				for (const info of local.slice(0, LIST_CAP)) {
					const title = sessionDisplayName(info).replaceAll("|", "\\|");
					lines.push(`| ${info.id} | ${title} | ${formatAge(info.modified)} |`);
				}
				lines.push("", "Read a session transcript with `read session://<id>`.");
			}
			const content = `${lines.join("\n")}\n`;
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf-8"),
			};
		}

		let found = matchSession(local, targetId);
		if (!found) {
			const allListing = await listAllSessionsForPicker(new FileSessionStorage(), new Set(), getSessionsDir());
			found = matchSession(allListing.sessions, targetId) ?? matchSession(await allListing.complete, targetId);
		}
		if (!found) {
			throw new Error(`Session not found: ${targetId}. List recent project sessions with session://`);
		}

		const messages = await loadSessionMessagesReadOnly(found.path);
		const title = sessionDisplayName(found);
		const content = renderTranscriptMessages(messages, sessionViewOptions(url, `# ${title} (${found.id})`)).text;
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: found.path,
			notes: [`Session: ${found.id} (${formatAge(found.modified)})`],
		};
	}

	async complete(_query: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		const cwd = context?.cwd ?? process.cwd();
		const sessions = await listProjectSessions(cwd);
		return sessions.slice(0, LIST_CAP).map(info => ({
			value: info.id,
			label: sessionDisplayName(info),
			description: formatAge(info.modified),
		}));
	}
}
