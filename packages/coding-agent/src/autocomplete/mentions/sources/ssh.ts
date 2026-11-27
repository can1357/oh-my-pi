/**
 * Unified mention source for configured SSH hosts (`ssh://<host>/`).
 *
 * Hosts come from the `ssh` capability (`ssh.json` files and `~/.ssh/config`
 * aliases), loaded once per cwd and cached; keystrokes rank the cached list.
 */
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { SSHHost } from "../../../capability/ssh";
import { hostAddress, loadConfiguredHosts } from "../../../internal-urls/ssh-protocol";
import {
	MATCH_TIER,
	type MatchTier,
	type MentionItem,
	type MentionQuery,
	type MentionSource,
	type MentionSourceResult,
} from "../types";

const MAX_SSH_ITEMS = 25;
const CACHE_TTL_MS = 60_000;

export interface SshMentionHost {
	readonly getCwd: () => string;
	/** Host loader; defaults to the `ssh` capability. */
	readonly loadHosts?: (cwd: string) => Promise<SSHHost[]>;
}

interface HostSnapshot {
	readonly cwd: string;
	readonly hosts: readonly SSHHost[];
	readonly loadedAt: number;
}

function buildSshItem(host: SSHHost, tier: MatchTier): MentionItem {
	const url = `ssh://${encodeURIComponent(host.name)}/`;
	const address = hostAddress(host);
	const detail = host.description ?? (address === host.name ? "" : address);
	return {
		category: "ssh",
		tier,
		value: url,
		insertText: url,
		appendSpace: true,
		label: host.name,
		description: detail,
		nativeDetail: detail,
		icon: currentTheme().symbols.symbol("mention.ssh"),
		iconName: "host",
		pickerItem: {
			id: `ssh:${host.name}`,
			label: host.name,
			...(detail ? { detail } : {}),
			icon: "host",
			mono: true,
		},
	};
}

/** SSH hosts mention source (`@ssh:`). */
export class SshMentionSource implements MentionSource {
	readonly id = "ssh" as const;
	readonly label = "SSH";

	readonly #host: SshMentionHost;
	#snapshot: HostSnapshot | undefined;
	#inflight: { cwd: string; promise: Promise<HostSnapshot> } | undefined;

	constructor(host: SshMentionHost) {
		this.#host = host;
	}

	warm(): void {
		const cwd = this.#host.getCwd();
		if (!this.#isFresh(cwd)) void this.#refresh(cwd);
	}

	#isFresh(cwd: string): boolean {
		return this.#snapshot?.cwd === cwd && Date.now() - this.#snapshot.loadedAt < CACHE_TTL_MS;
	}

	#refresh(cwd: string): Promise<HostSnapshot> {
		if (this.#inflight?.cwd === cwd) return this.#inflight.promise;
		const load = this.#host.loadHosts ?? loadConfiguredHosts;
		const promise = load(cwd)
			.catch(() => [] as SSHHost[])
			.then(hosts => {
				const snap: HostSnapshot = { cwd, hosts, loadedAt: Date.now() };
				this.#snapshot = snap;
				return snap;
			})
			.finally(() => {
				if (this.#inflight?.promise === promise) this.#inflight = undefined;
			});
		this.#inflight = { cwd, promise };
		return promise;
	}

	querySync(q: MentionQuery): MentionSourceResult {
		const cwd = this.#host.getCwd();
		const explicit = q.syntaxLock === "ssh";
		const fresh = this.#isFresh(cwd);
		if (!fresh) void this.#refresh(cwd);
		const hosts = this.#snapshot?.cwd === cwd ? this.#snapshot.hosts : [];
		return this.#rank(q, hosts, !fresh && explicit, explicit);
	}

	async queryAsync(
		q: MentionQuery,
		signal: AbortSignal,
		_onPartial: (result: MentionSourceResult) => void,
	): Promise<MentionSourceResult | null> {
		const cwd = this.#host.getCwd();
		if (this.#isFresh(cwd)) return null;
		const snap = await this.#refresh(cwd);
		if (signal.aborted) return null;
		return this.#rank(q, snap.hosts, false, q.syntaxLock === "ssh");
	}

	#rank(q: MentionQuery, hosts: readonly SSHHost[], loading: boolean, explicit: boolean): MentionSourceResult {
		if (hosts.length === 0) {
			return { category: "ssh", items: [], bestTier: MATCH_TIER.None, total: 0, loading, available: explicit };
		}
		const lower = q.query.trim().toLowerCase();
		const scored: Array<{ item: MentionItem; score: number }> = [];
		for (const host of hosts) {
			const name = host.name.toLowerCase();
			let tier: MatchTier | null;
			let score = 0;
			if (!lower) tier = MATCH_TIER.Medium;
			else if (name === lower) tier = MATCH_TIER.Exact;
			else if (name.startsWith(lower) || name.includes(`-${lower}`) || name.includes(`.${lower}`)) {
				tier = MATCH_TIER.Strong;
				score = 10;
			} else if (explicit && (name.includes(lower) || hostAddress(host).toLowerCase().includes(lower))) {
				tier = MATCH_TIER.Medium;
				score = 25;
			} else tier = null;
			if (tier === null) continue;
			scored.push({ item: buildSshItem(host, tier), score });
		}
		scored.sort((a, b) => a.item.tier - b.item.tier || a.score - b.score);
		const items = scored.slice(0, MAX_SSH_ITEMS).map(row => row.item);
		const bestTier = items.reduce<MatchTier>((best, item) => (item.tier < best ? item.tier : best), MATCH_TIER.None);
		return { category: "ssh", items, bestTier, total: scored.length, loading, available: true };
	}
}
