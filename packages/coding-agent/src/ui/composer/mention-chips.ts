/**
 * Unified mention chips for the composer draft:
 * - `agent://<id>` → `● <displayName>` (local subagent)
 * - `agent://<pid>[/<id>]` → `⇄ <peerTitle>[/<id>]` (foreign mesh peer)
 * - `git://branch/<name>` → `⎇ <name>`
 * - `git://commit/<sha>` → `○ <shortSha>`
 * - `git://tag/<name>` → `⚑ <name>`
 * - `pr://<N>` / `issue://<N>` → `⑂ #<N>` / `⊙ #<N>`
 *
 * Every chip expands back to its unambiguous canonical URL on submit (never in
 * local-execution `!cmd`/`$ code` drafts). Model mentions (`^provider/id[:level]`)
 * and skills (`/skill:<name>`) keep their dedicated atomizers.
 */
import { isLocalExecutionDraft } from "../../extensibility/skill-tokens";
import { agentMesh } from "../../irc/mesh";
import { AgentRegistry } from "../../registry/agent-registry";
import { lookupSessionTitle } from "../../session/session-index";
import type { DraftToken, TokenAtomizer } from "./composer";

/** Matches standalone mention URLs with trailing prose punctuation left outside the chip. */
const MENTION_URL_RE = /(^|[\s"'`(<=])((?:agent|session|git|pr|issue|mcp|ssh):\/\/[^\s"'`()<>]+)/g;

const AGENT_CHIP_STYLE = "accent strong";
const PEER_CHIP_STYLE = "customMessageLabel strong";
const SESSION_CHIP_STYLE = "customMessageLabel strong";
const GIT_CHIP_STYLE = "statusLineBranch strong";
const FORGE_CHIP_STYLE = "success strong";
const REMOTE_CHIP_STYLE = "accent strong";

export interface MentionChipHost {
	/** Resolve a local agent display name by id; defaults to `AgentRegistry.global()`. */
	readonly localAgentLabel?: (id: string) => string | undefined;
	/** Resolve a foreign peer display label (`title` or `title/id`); defaults to `agentMesh()?.label(...)`. */
	readonly peerLabel?: (pid: number, id?: string) => string | undefined;
	/** Resolve a past session title by id; defaults to SQLite `lookupSessionTitle`. */
	readonly sessionTitle?: (id: string) => string | undefined;
}

function stripTrailingPunctuation(token: string): { core: string; suffix: string } {
	let end = token.length;
	while (end > 0 && ".,;:!?".includes(token[end - 1]!)) end--;
	return { core: token.slice(0, end), suffix: token.slice(end) };
}

function formatMentionChip(
	url: string,
	host: MentionChipHost,
): { label: string; style: string; fallbackLabel?: string } | undefined {
	if (url.startsWith("agent://")) {
		const rest = url.slice("agent://".length);
		if (!rest || rest === "all") return undefined;
		const slash = rest.indexOf("/");
		const first = slash === -1 ? rest : rest.slice(0, slash);
		if (/^\d+$/.test(first)) {
			const pid = Number(first);
			const subId = slash === -1 ? undefined : rest.slice(slash + 1);
			if (subId?.includes("/")) return undefined;
			const resolved = host.peerLabel
				? host.peerLabel(pid, subId)
				: agentMesh()?.label({ pid, ...(subId ? { id: subId } : {}) });
			const base = resolved || (subId ? `pid ${pid}/${subId}` : `pid ${pid}`);
			return {
				label: `⇄ ${base}`,
				fallbackLabel: resolved ? `⇄ ${base} #${pid}` : undefined,
				style: PEER_CHIP_STYLE,
			};
		}
		if (slash !== -1) return undefined;
		const localLabel = host.localAgentLabel
			? host.localAgentLabel(first)
			: AgentRegistry.global().get(first)?.displayName;
		return { label: `● ${localLabel || first}`, style: AGENT_CHIP_STYLE };
	}

	if (url.startsWith("session://")) {
		const id = url.slice("session://".length);
		if (!id || id.includes("/")) return undefined;
		const title = (host.sessionTitle ? host.sessionTitle(id) : lookupSessionTitle(id))?.replace(/\s+/g, " ").trim();
		const short = title ? (title.length > 32 ? `${title.slice(0, 31)}…` : title) : id.slice(0, 8);
		return {
			label: `💬 ${short}`,
			fallbackLabel: title ? `💬 ${short} (${id.slice(0, 6)})` : undefined,
			style: SESSION_CHIP_STYLE,
		};
	}

	if (url === "git://diff" || url.startsWith("git://diff/")) {
		const target = url.slice("git://diff".length).replace(/^\//, "");
		const label = !target ? "uncommitted" : target === "staged" || target === "unstaged" ? target : `vs ${target}`;
		return { label: `± ${label}`, style: GIT_CHIP_STYLE };
	}
	if (url.startsWith("mcp://")) {
		const uri = url.slice("mcp://".length);
		if (!uri) return undefined;
		const tail = uri.replace(/\/+$/, "").split("/").pop() || uri;
		return { label: `⌁ ${tail}`, fallbackLabel: `⌁ ${uri}`, style: REMOTE_CHIP_STYLE };
	}
	if (url.startsWith("ssh://")) {
		const rest = url.slice("ssh://".length);
		const slash = rest.indexOf("/");
		let host = slash === -1 ? rest : rest.slice(0, slash);
		try {
			host = decodeURIComponent(host);
		} catch {}
		if (!host) return undefined;
		const remotePath = slash === -1 ? "" : rest.slice(slash + 1);
		return { label: `⇢ ${host}${remotePath ? `:${remotePath}` : ""}`, style: REMOTE_CHIP_STYLE };
	}

	if (url.startsWith("git://branch/")) {
		const branch = url.slice("git://branch/".length);
		if (!branch) return undefined;
		return { label: `⎇ ${branch}`, style: GIT_CHIP_STYLE };
	}
	if (url.startsWith("git://commit/")) {
		const sha = url.slice("git://commit/".length);
		if (!sha) return undefined;
		return { label: `○ ${sha.slice(0, 7)}`, style: GIT_CHIP_STYLE };
	}
	if (url.startsWith("git://tag/")) {
		const tag = url.slice("git://tag/".length);
		if (!tag) return undefined;
		return { label: `⚑ ${tag}`, style: GIT_CHIP_STYLE };
	}
	if (url.startsWith("pr://")) {
		const num = url.slice("pr://".length);
		if (!/^[1-9]\d*$/.test(num)) return undefined;
		return { label: `⑂ #${num}`, style: FORGE_CHIP_STYLE };
	}
	if (url.startsWith("issue://")) {
		const num = url.slice("issue://".length);
		if (!/^[1-9]\d*$/.test(num)) return undefined;
		return { label: `⊙ #${num}`, style: FORGE_CHIP_STYLE };
	}
	return undefined;
}

/** An atomizer rendering `agent://`, `git://`, `pr://`, and `issue://` mentions as inline draft chips. */
export function mentionChipAtomizer(host: MentionChipHost = {}): TokenAtomizer {
	return (text, taken) => {
		if (!text.includes("://") || isLocalExecutionDraft(text)) return [];
		const tokens: DraftToken[] = [];
		const given = new Map<string, string>();
		for (const match of text.matchAll(MENTION_URL_RE)) {
			const leading = match[1]!;
			const { core, suffix } = stripTrailingPunctuation(match[2]!);
			const chip = formatMentionChip(core, host);
			if (!chip) continue;
			let label = chip.label;
			const collision = (candidate: string) => {
				const existing = given.get(candidate);
				return (existing !== undefined && existing !== core) || taken(candidate, core);
			};
			if (collision(label)) {
				if (chip.fallbackLabel && !collision(chip.fallbackLabel)) label = chip.fallbackLabel;
				else continue;
			}
			const from = match.index + leading.length;
			const matchEnd = match.index + match[0].length;
			given.set(label, core);
			tokens.push({
				from,
				to: matchEnd - suffix.length,
				matchEnd,
				label,
				expansion: core,
				s: chip.style,
			});
		}
		return tokens;
	};
}
