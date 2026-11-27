/**
 * Unified mention source for local subagents ({@link AgentRegistry}) and
 * foreign peer instances/subagents ({@link agentMesh}).
 *
 * 100% synchronous Tier 0. Deduplicates strictly by target URL, leads foreign
 * subagent rows with their own `sub.id` (never truncating clones of a long
 * peer session title), and hides parked/aborted agents in unlocked `@` queries.
 */
import type { TspTone } from "@oh-my-pi/pi-wire";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { agentMesh } from "../../../irc/mesh";
import type { MeshPeer, MeshSubagent } from "../../../irc/mesh-protocol";
import { AgentRegistry, type AgentRef, type AgentStatus, MAIN_AGENT_ID } from "../../../registry/agent-registry";
import { FuzzyQuery, FuzzyText } from "../../../utils/fuzzy";
import {
	MATCH_TIER,
	type MatchTier,
	type MentionItem,
	type MentionQuery,
	type MentionSource,
	type MentionSourceResult,
} from "../types";

const MAX_AGENT_ITEMS = 25;

export interface AgentsMentionHost {
	/** Local agent registry; defaults to `AgentRegistry.global()`. */
	readonly registry?: () => { list(): AgentRef[] };
	/** Foreign mesh peers in this project; defaults to `agentMesh()?.peers() ?? []` (other projects stay out of `@`). */
	readonly peers?: () => readonly MeshPeer[];
}

function statusTone(status: AgentStatus | "unknown"): TspTone {
	switch (status) {
		case "running":
			return "success";
		case "aborted":
			return "error";
		default:
			return "muted";
	}
}

function statusOrder(status: AgentStatus | "unknown"): number {
	switch (status) {
		case "running":
			return 0;
		case "idle":
			return 1;
		case "parked":
			return 2;
		case "aborted":
			return 3;
		default:
			return 4;
	}
}

function isLiveStatus(status: AgentStatus | "unknown"): boolean {
	return status === "running" || status === "idle";
}

function shortModelLabel(resolvedModel: string | undefined): string {
	if (!resolvedModel) return "";
	const slash = resolvedModel.lastIndexOf("/");
	return slash >= 0 ? resolvedModel.slice(slash + 1) : resolvedModel;
}

function compactTitle(raw: string | undefined, fallback: string): string {
	const cleaned = (raw ?? "").replace(/\s+/g, " ").trim();
	return cleaned || fallback;
}

interface CandidateRow {
	readonly url: string;
	readonly item: MentionItem;
	readonly isForeign: boolean;
	readonly statusRank: number;
	readonly recency: number;
	readonly score: number;
}

function scoreMatch(
	rawQuery: string,
	fuzzyQuery: FuzzyQuery | undefined,
	primary: string,
	secondary: string,
	allowSecondary: boolean,
): { tier: MatchTier; score: number } | null {
	if (!rawQuery || !fuzzyQuery) return { tier: MATCH_TIER.Medium, score: 0 };
	const q = rawQuery.toLowerCase();
	const p = primary.toLowerCase();
	if (p === q) return { tier: MATCH_TIER.Exact, score: 0 };
	if (p.startsWith(q) || p.includes(`/${q}`) || p.includes(`-${q}`) || p.includes(`_${q}`) || p.includes(` ${q}`)) {
		return { tier: MATCH_TIER.Strong, score: 10 };
	}
	if (p.includes(q)) return { tier: MATCH_TIER.Medium, score: 25 };
	if (allowSecondary) {
		const primaryHit = fuzzyQuery.match(new FuzzyText(primary));
		if (primaryHit.matches) {
			return { tier: primaryHit.score < 30 ? MATCH_TIER.Medium : MATCH_TIER.Weak, score: 30 + primaryHit.score };
		}
		if (secondary) {
			const s = secondary.toLowerCase();
			if (s.includes(q)) return { tier: MATCH_TIER.Weak, score: 80 };
			const secHit = fuzzyQuery.match(new FuzzyText(secondary));
			if (secHit.matches) return { tier: MATCH_TIER.Weak, score: 120 + secHit.score };
		}
	}
	return null;
}

function buildLocalAgentItem(ref: AgentRef, tier: MatchTier): MentionItem {
	const url = `agent://${ref.id}`;
	const title = compactTitle(ref.displayName, ref.id);
	const tone = statusTone(ref.status);
	const detail = ref.activity || (ref.id !== title ? ref.id : "");
	const right = shortModelLabel(ref.history?.resolvedModel) || ref.history?.agent || "";
	return {
		category: "agents",
		tier,
		value: url,
		insertText: url,
		appendSpace: true,
		label: title,
		description: detail || ref.status,
		nativeDetail: detail || ref.status,
		state: ref.status,
		icon: currentTheme().symbols.symbol("mention.agent"),
		iconName: "agent",
		pickerItem: {
			id: `agent:${url}`,
			label: title,
			...(detail ? { detail } : {}),
			dot: tone,
			badges: [{ text: ref.status, tone }],
			...(right ? { facts: { right } } : {}),
		},
	};
}

function buildForeignMainItem(peer: MeshPeer, tier: MatchTier): MentionItem {
	const url = `agent://${peer.pid}`;
	const title = compactTitle(peer.title, `pid ${peer.pid}`);
	const tone = statusTone(peer.status);
	const pidFact = `pid ${peer.pid}`;
	const detail = peer.status === "unknown" ? pidFact : `${peer.status} · ${pidFact}`;
	return {
		category: "agents",
		tier,
		value: url,
		insertText: url,
		appendSpace: true,
		label: title,
		description: detail,
		nativeDetail: peer.status === "unknown" ? "peer session" : peer.status,
		state: pidFact,
		icon: currentTheme().symbols.symbol("mention.peer"),
		iconName: "users",
		pickerItem: {
			id: `agent:${url}`,
			label: title,
			detail: peer.status === "unknown" ? "peer session" : peer.status,
			dot: tone,
			badges: [{ text: "peer", tone: "accent" }],
			facts: { right: pidFact },
		},
	};
}

function buildForeignSubagentItem(peer: MeshPeer, sub: MeshSubagent, tier: MatchTier): MentionItem {
	const url = `agent://${peer.pid}/${sub.id}`;
	const peerName = compactTitle(peer.title, `pid ${peer.pid}`);
	const tone = statusTone(sub.status);
	const pidFact = `pid ${peer.pid}`;
	// Lead with `sub.id` so sibling subagents under one peer never truncate to identical clones.
	return {
		category: "agents",
		tier,
		value: url,
		insertText: url,
		appendSpace: true,
		label: sub.id,
		description: `${peerName} · ${sub.status}`,
		nativeDetail: peerName,
		state: pidFact,
		icon: currentTheme().symbols.symbol("mention.peer"),
		iconName: "users",
		pickerItem: {
			id: `agent:${url}`,
			label: sub.id,
			detail: peerName,
			dot: tone,
			badges: [{ text: "peer", tone: "accent" }],
			facts: { right: pidFact },
		},
	};
}

/** Local and foreign mesh subagents mention source. */
export class AgentsMentionSource implements MentionSource {
	readonly id = "agents" as const;
	readonly label = "Agents";

	readonly #host: AgentsMentionHost;

	constructor(host: AgentsMentionHost = {}) {
		this.#host = host;
	}

	querySync(q: MentionQuery): MentionSourceResult {
		const explicit = q.syntaxLock === "agents";
		const onlyPeers = q.subKind === "peer";
		const localRefs = (this.#host.registry?.() ?? AgentRegistry.global())
			.list()
			.filter(ref => ref.kind !== "advisor" && ref.id !== MAIN_AGENT_ID && (explicit || isLiveStatus(ref.status)));
		const peers = this.#host.peers?.() ?? agentMesh()?.peers() ?? [];
		const livePeers = explicit
			? peers
			: peers.filter(peer => isLiveStatus(peer.status) || peer.agents.some(sub => isLiveStatus(sub.status)));

		const hasAny = (!onlyPeers && localRefs.length > 0) || livePeers.length > 0;
		if (!hasAny) {
			return { category: "agents", items: [], bestTier: MATCH_TIER.None, total: 0, available: false };
		}

		const trimmed = q.query.trim();
		const fuzzyQuery = trimmed ? new FuzzyQuery(trimmed) : undefined;
		const rows: CandidateRow[] = [];
		const seenUrls = new Set<string>();

		const pushUnique = (row: CandidateRow) => {
			if (seenUrls.has(row.url)) return;
			seenUrls.add(row.url);
			rows.push(row);
		};

		if (!onlyPeers) {
			for (const ref of localRefs) {
				const primary = ref.displayName && ref.displayName !== ref.id ? `${ref.id} ${ref.displayName}` : ref.id;
				const secondary = [ref.activity ?? "", ref.history?.agent ?? "", ref.status].filter(Boolean).join(" ");
				const matched = scoreMatch(trimmed, fuzzyQuery, primary, secondary, explicit);
				if (!matched) continue;
				pushUnique({
					url: `agent://${ref.id}`,
					item: buildLocalAgentItem(ref, matched.tier),
					isForeign: false,
					statusRank: statusOrder(ref.status),
					recency: ref.lastActivity,
					score: matched.score,
				});
			}
		}

		for (const peer of livePeers) {
			const peerTitle = compactTitle(peer.title, `pid ${peer.pid}`);
			if (explicit || isLiveStatus(peer.status)) {
				const mainHit = scoreMatch(trimmed, fuzzyQuery, peerTitle, `peer ${peer.pid} ${peer.status}`, explicit);
				if (mainHit) {
					pushUnique({
						url: `agent://${peer.pid}`,
						item: buildForeignMainItem(peer, mainHit.tier),
						isForeign: true,
						statusRank: statusOrder(peer.status),
						recency: 0,
						score: mainHit.score,
					});
				}
			}

			for (const sub of peer.agents) {
				if (sub.id === MAIN_AGENT_ID) continue;
				if (!explicit && !isLiveStatus(sub.status)) continue;
				const subHit = scoreMatch(
					trimmed,
					fuzzyQuery,
					sub.id,
					`${peerTitle} peer ${peer.pid} ${sub.status}`,
					explicit,
				);
				if (!subHit) continue;
				pushUnique({
					url: `agent://${peer.pid}/${sub.id}`,
					item: buildForeignSubagentItem(peer, sub, subHit.tier),
					isForeign: true,
					statusRank: statusOrder(sub.status),
					recency: 0,
					score: subHit.score,
				});
			}
		}

		// Broadcast `agent://all` only when explicitly scoped to Agents or when typing `all`.
		if (!onlyPeers && (explicit || trimmed.toLowerCase() === "all")) {
			const allHit = scoreMatch(trimmed, fuzzyQuery, "all", "broadcast every agent", explicit);
			if (allHit) {
				const icon = currentTheme().symbols.symbol("mention.agent");
				pushUnique({
					url: "agent://all",
					item: {
						category: "agents",
						tier: trimmed ? allHit.tier : MATCH_TIER.Weak,
						value: "agent://all",
						insertText: "agent://all",
						appendSpace: true,
						label: "all",
						description: "Broadcast to all local agents",
						icon,
						iconName: "users",
						pickerItem: {
							id: "agent:agent://all",
							label: "all",
							detail: "Broadcast to all local agents",
							icon: "users",
						},
					},
					isForeign: false,
					statusRank: 5,
					recency: 0,
					score: allHit.score + 50,
				});
			}
		}

		rows.sort(
			(a, b) =>
				a.item.tier - b.item.tier ||
				a.statusRank - b.statusRank ||
				Number(a.isForeign) - Number(b.isForeign) ||
				a.score - b.score ||
				b.recency - a.recency,
		);

		const items = rows.slice(0, MAX_AGENT_ITEMS).map(row => row.item);
		const bestTier = items.reduce<MatchTier>((best, item) => (item.tier < best ? item.tier : best), MATCH_TIER.None);
		return {
			category: "agents",
			items,
			bestTier,
			total: rows.length,
			available: true,
		};
	}
}
