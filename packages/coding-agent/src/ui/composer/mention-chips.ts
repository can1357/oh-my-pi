/**
 * Unified mention chips for the composer draft, each led by its `mention.*` theme glyph:
 * - `agent://<id>` → `<displayName>` (local subagent)
 * - `agent://<pid>[/<id>]` → `<peerTitle>[/<id>]` (foreign mesh peer)
 * - `session://<id>` → session title
 * - `git://diff[/<target>]`, `git://branch/<name>`, `git://commit/<sha>`, `git://tag/<name>`
 * - `pr://<N>` / `issue://<N>` → `#<N>`
 * - `mcp://<uri>`, `ssh://<host>/<path>`
 *
 * Every chip expands back to its unambiguous canonical URL on submit (never in
 * local-execution `!cmd`/`$ code` drafts). Model mentions (`^provider/id[:level]`)
 * and skills (`/skill:<name>`) keep their dedicated atomizers.
 */
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { sessionMentionHead } from "../../autocomplete/mentions/sources/sessions";
import { MENTION_STYLES } from "../../autocomplete/mentions/style";
import type { MentionCategoryId } from "../../autocomplete/mentions/types";
import { isLocalExecutionDraft } from "../../extensibility/skill-tokens";
import { agentMesh } from "../../irc/mesh";
import { AgentRegistry } from "../../registry/agent-registry";
import { lookupSessionTitle } from "../../session/session-index";
import type { DraftToken, TokenAtomizer } from "./composer";

/** Matches standalone mention URLs with trailing prose punctuation left outside the chip. */
const MENTION_URL_RE = /(^|[\s"'`(<=])((?:agent|session|git|pr|issue|mcp|ssh):\/\/[^\s"'`()<>]+)/g;

const AGENT_CHIP_STYLE = chipStyle("agents");
const PEER_CHIP_STYLE = "customMessageLabel strong";
const SESSION_CHIP_STYLE = chipStyle("sessions");
const GIT_CHIP_STYLE = chipStyle("vcs");
const FORGE_CHIP_STYLE = chipStyle("forge");
const MCP_CHIP_STYLE = chipStyle("mcp");
const SSH_CHIP_STYLE = chipStyle("ssh");

/** A chip drawn bold in its category's color. */
function chipStyle(category: MentionCategoryId): string {
	return `${MENTION_STYLES[category].color} strong`;
}

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
	const symbols = currentTheme().symbols;
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
			const glyph = symbols.symbol("mention.peer");
			return {
				label: `${glyph} ${base}`,
				fallbackLabel: resolved ? `${glyph} ${base} #${pid}` : undefined,
				style: PEER_CHIP_STYLE,
			};
		}
		if (slash !== -1) return undefined;
		const localLabel = host.localAgentLabel
			? host.localAgentLabel(first)
			: AgentRegistry.global().get(first)?.displayName;
		return { label: `${symbols.symbol("mention.agent")} ${localLabel || first}`, style: AGENT_CHIP_STYLE };
	}

	if (url.startsWith("session://")) {
		const id = url.slice("session://".length);
		if (!id || id.includes("/")) return undefined;
		const title = (host.sessionTitle ? host.sessionTitle(id) : lookupSessionTitle(id))?.replace(/\s+/g, " ").trim();
		const head = sessionMentionHead(title || id.slice(0, 8));
		const short = head.label.length > 32 ? `${head.label.slice(0, 31)}…` : head.label;
		return {
			label: `${head.glyph} ${short}`,
			fallbackLabel: title ? `${head.glyph} ${short} (${id.slice(0, 6)})` : undefined,
			style: SESSION_CHIP_STYLE,
		};
	}

	if (url === "git://diff" || url.startsWith("git://diff/")) {
		const target = url.slice("git://diff".length).replace(/^\//, "");
		const label = !target ? "uncommitted" : target === "staged" || target === "unstaged" ? target : `vs ${target}`;
		return { label: `${symbols.symbol("mention.diff")} ${label}`, style: GIT_CHIP_STYLE };
	}
	if (url.startsWith("mcp://")) {
		const uri = url.slice("mcp://".length);
		if (!uri) return undefined;
		const tail = uri.replace(/\/+$/, "").split("/").pop() || uri;
		const glyph = symbols.symbol("mention.mcp");
		return { label: `${glyph} ${tail}`, fallbackLabel: `${glyph} ${uri}`, style: MCP_CHIP_STYLE };
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
		return {
			label: `${symbols.symbol("mention.ssh")} ${host}${remotePath ? `:${remotePath}` : ""}`,
			style: SSH_CHIP_STYLE,
		};
	}

	if (url.startsWith("git://branch/")) {
		const branch = url.slice("git://branch/".length);
		if (!branch) return undefined;
		return { label: `${symbols.symbol("mention.branch")} ${branch}`, style: GIT_CHIP_STYLE };
	}
	if (url.startsWith("git://commit/")) {
		const sha = url.slice("git://commit/".length);
		if (!sha) return undefined;
		return { label: `${symbols.symbol("mention.commit")} ${sha.slice(0, 7)}`, style: GIT_CHIP_STYLE };
	}
	if (url.startsWith("git://tag/")) {
		const tag = url.slice("git://tag/".length);
		if (!tag) return undefined;
		return { label: `${symbols.symbol("mention.tag")} ${tag}`, style: GIT_CHIP_STYLE };
	}
	if (url.startsWith("pr://")) {
		const num = url.slice("pr://".length);
		if (!/^[1-9]\d*$/.test(num)) return undefined;
		return { label: `${symbols.symbol("mention.pr")} #${num}`, style: FORGE_CHIP_STYLE };
	}
	if (url.startsWith("issue://")) {
		const num = url.slice("issue://".length);
		if (!/^[1-9]\d*$/.test(num)) return undefined;
		return { label: `${symbols.symbol("mention.issue")} #${num}`, style: FORGE_CHIP_STYLE };
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
