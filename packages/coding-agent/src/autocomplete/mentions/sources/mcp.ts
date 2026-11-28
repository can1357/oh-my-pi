/**
 * Unified mention source for MCP resources (`mcp://<resource-uri>`).
 *
 * Reads the connected servers' cached resource catalogs synchronously; a
 * catalog not loaded yet is fetched in the async pass (never waiting on
 * servers still connecting). URI templates are skipped: they need arguments.
 */
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { MCPManager, type MCPManagerApi } from "../../../mcp/manager";
import { FuzzyQuery, FuzzyText } from "../../../utils/fuzzy";
import {
	MATCH_TIER,
	type MatchTier,
	type MentionItem,
	type MentionQuery,
	type MentionSource,
	type MentionSourceResult,
} from "../types";

const MAX_MCP_ITEMS = 25;

export interface McpMentionHost {
	/** The MCP manager; defaults to `MCPManager.instance()`. */
	readonly manager?: () => MCPManagerApi | undefined;
}

interface McpEntry {
	readonly server: string;
	readonly uri: string;
	readonly label: string;
	readonly description: string;
}

function buildMcpItem(entry: McpEntry, tier: MatchTier): MentionItem {
	const url = `mcp://${entry.uri}`;
	const detail = entry.label === entry.uri ? entry.description : entry.uri;
	return {
		category: "mcp",
		tier,
		value: url,
		insertText: url,
		appendSpace: true,
		label: entry.label,
		description: detail,
		nativeDetail: detail,
		state: entry.server,
		icon: currentTheme().symbols.symbol("mention.mcp"),
		iconName: "mcp",
		pickerItem: {
			id: `mcp:${entry.server}:${entry.uri}`,
			label: entry.label,
			...(detail ? { detail } : {}),
			icon: "mcp",
			facts: { right: entry.server },
		},
	};
}

/** MCP resources mention source (`@mcp:`). */
export class McpMentionSource implements MentionSource {
	readonly id = "mcp" as const;
	readonly label = "MCP";

	readonly #host: McpMentionHost;

	constructor(host: McpMentionHost = {}) {
		this.#host = host;
	}

	#manager(): MCPManagerApi | undefined {
		return this.#host.manager ? this.#host.manager() : MCPManager.instance();
	}

	#entries(manager: MCPManagerApi): { entries: McpEntry[]; unloaded: string[] } {
		const entries: McpEntry[] = [];
		const unloaded: string[] = [];
		for (const server of manager.getConnectedServers()) {
			const catalog = manager.getServerResources(server);
			if (!catalog) {
				unloaded.push(server);
				continue;
			}
			for (const resource of catalog.resources) {
				entries.push({
					server,
					uri: resource.uri,
					label: (resource.title ?? resource.name ?? resource.uri).trim() || resource.uri,
					description: (resource.description ?? "").replace(/\s+/g, " ").trim(),
				});
			}
		}
		return { entries, unloaded };
	}

	warm(): void {
		const manager = this.#manager();
		if (!manager) return;
		for (const server of this.#entries(manager).unloaded) void manager.ensureServerResources(server).catch(() => {});
	}

	querySync(q: MentionQuery): MentionSourceResult {
		const manager = this.#manager();
		const explicit = q.syntaxLock === "mcp";
		if (!manager) {
			return { category: "mcp", items: [], bestTier: MATCH_TIER.None, total: 0, available: false };
		}
		const { entries, unloaded } = this.#entries(manager);
		return this.#rank(q, entries, explicit && unloaded.length > 0, explicit);
	}

	async queryAsync(
		q: MentionQuery,
		signal: AbortSignal,
		_onPartial: (result: MentionSourceResult) => void,
	): Promise<MentionSourceResult | null> {
		const manager = this.#manager();
		if (!manager || signal.aborted) return null;
		const { unloaded } = this.#entries(manager);
		if (unloaded.length === 0) return null;
		await Promise.allSettled(unloaded.map(server => manager.ensureServerResources(server)));
		if (signal.aborted) return null;
		const explicit = q.syntaxLock === "mcp";
		return this.#rank(q, this.#entries(manager).entries, false, explicit);
	}

	#rank(q: MentionQuery, entries: readonly McpEntry[], loading: boolean, explicit: boolean): MentionSourceResult {
		if (entries.length === 0) {
			return { category: "mcp", items: [], bestTier: MATCH_TIER.None, total: 0, loading, available: explicit };
		}
		const trimmed = q.query.trim();
		if (!trimmed) {
			const items = entries.slice(0, MAX_MCP_ITEMS).map(entry => buildMcpItem(entry, MATCH_TIER.Medium));
			return {
				category: "mcp",
				items,
				bestTier: MATCH_TIER.Medium,
				total: entries.length,
				loading,
				available: true,
			};
		}
		const lower = trimmed.toLowerCase();
		const fuzzy = new FuzzyQuery(trimmed);
		const scored: Array<{ item: MentionItem; score: number }> = [];
		for (const entry of entries) {
			const label = entry.label.toLowerCase();
			const uri = entry.uri.toLowerCase();
			let tier: MatchTier | null = null;
			let score = 0;
			if (label === lower || uri === lower) tier = MATCH_TIER.Exact;
			else if (label.startsWith(lower) || uri.startsWith(lower) || label.includes(` ${lower}`)) {
				tier = MATCH_TIER.Strong;
				score = 10;
			} else if (label.includes(lower) || uri.includes(lower) || entry.server.toLowerCase().includes(lower)) {
				tier = MATCH_TIER.Medium;
				score = 25;
			} else if (explicit) {
				const hit = fuzzy.match(new FuzzyText(`${entry.label} ${entry.uri} ${entry.description}`));
				if (hit.matches) {
					tier = MATCH_TIER.Weak;
					score = 60 + hit.score;
				}
			}
			if (tier === null) continue;
			scored.push({ item: buildMcpItem(entry, tier), score });
		}
		scored.sort((a, b) => a.item.tier - b.item.tier || a.score - b.score);
		const items = scored.slice(0, MAX_MCP_ITEMS).map(row => row.item);
		const bestTier = items.reduce<MatchTier>((best, item) => (item.tier < best ? item.tier : best), MATCH_TIER.None);
		return { category: "mcp", items, bestTier, total: scored.length, loading, available: true };
	}
}
