import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "../session/session-entries";
import { normalizeToolName } from "../tools/builtin-names";

/** Transport provenance only; role and attribution retain their native meaning. */
export interface IrcSource {
	id: string;
	from: string;
	to: string;
	ts: number;
	replyTo?: string;
	wakeRelay?: boolean;
	fromParent?: boolean;
}

export type IrcSteeringMessage = UserMessage & { ircSource: IrcSource };
export const IRC_CONSUMED_ENTRY_TYPE = "irc:consumed";

export function ircSource(message: IrcMessage, fromParent = false): IrcSource {
	return {
		id: message.id,
		from: message.from,
		to: message.to,
		ts: message.ts,
		...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
		...(message.wakeRelay ? { wakeRelay: true } : {}),
		...(fromParent ? { fromParent: true } : {}),
	};
}

export function incomingIrcIdentity(message: AgentMessage): unknown {
	if (message.role === "custom" && message.customType === "irc:incoming") return message.details;
	if (message.role === "user" && "ircSource" in message) return message.ircSource;
	if (message.role !== "toolResult") return undefined;
	const toolName = normalizeToolName(message.toolName);
	let details = message.details;
	if (toolName === "write" && isRecord(details) && isRecord(details.xdev)) {
		const dispatch = details.xdev;
		if (
			dispatch.mode !== "execute" ||
			typeof dispatch.tool !== "string" ||
			normalizeToolName(dispatch.tool) !== "wait"
		)
			return undefined;
		details = dispatch.inner;
	} else if (toolName !== "wait") return undefined;
	return isRecord(details) && details.op === "wait" ? details.waited : undefined;
}

/** Derived from the owning manager's journal, never a second persisted ledger.
 * Appends update an already-bound index; replacements and rewrites rebuild once.
 * The whole journal matters: compaction and tree navigation do not redeliver mail.
 * A fork/new session instead binds only the entries retained by its own manager. */
export class IrcIdentityIndex {
	#entries: readonly SessionEntry[] | undefined;
	#revision = -1;
	readonly #received = new Map<string, Set<string>>();

	bind(entries: readonly SessionEntry[], revision: number): void {
		if (this.#entries === entries && this.#revision === revision) return;
		this.#received.clear();
		for (const entry of entries) this.#rememberEntry(entry);
		this.#entries = entries;
		this.#revision = revision;
	}

	clear(): void {
		this.#entries = undefined;
		this.#revision = -1;
		this.#received.clear();
	}

	append(entry: SessionEntry, entries: readonly SessionEntry[], revision: number): void {
		if (this.#entries === entries && this.#revision === revision) this.#rememberEntry(entry);
	}

	has(from: string, id: string): boolean {
		return this.#received.get(from)?.has(id) === true;
	}

	#rememberEntry(entry: SessionEntry): void {
		let identity: unknown;
		if (entry.type === "custom_message" && entry.customType === "irc:incoming") identity = entry.details;
		else if (entry.type === "custom" && entry.customType === IRC_CONSUMED_ENTRY_TYPE) identity = entry.data;
		else if (entry.type === "message") identity = incomingIrcIdentity(entry.message);
		if (!isRecord(identity) || typeof identity.from !== "string" || typeof identity.id !== "string") return;
		let ids = this.#received.get(identity.from);
		if (!ids) {
			ids = new Set();
			this.#received.set(identity.from, ids);
		}
		ids.add(identity.id);
	}
}
