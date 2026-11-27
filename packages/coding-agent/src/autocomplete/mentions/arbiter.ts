/**
 * Cross-source Intent Arbiter for the unified mention palette.
 *
 * Design principles:
 * - **Files first**: bare `@` and general `@<query>` lead with workspace files.
 * - **Discoverable `@category:` shortcuts**: bare `@` pairs top files with crisp
 *   namespace jump rows (`@model:`, `@agent:`, `@session:`, `@git:`, `@pr:`) so
 *   nothing gets buried and there is zero 800-model / 30-agent spam.
 * - **Smart auto-switching**: once another category clearly wins (e.g. `@opus`
 *   has strong model matches and no strong file match, or `@model:`/`^`/`#123`
 *   explicitly locks a scope), that category takes over cleanly at full depth.
 */
import type { TspPickerColumn, TspPickerGroup, TspPickerItem, TspPickerScope } from "@oh-my-pi/pi-wire";
import {
	MATCH_TIER,
	MENTION_CATEGORY_ORDER,
	type MentionCategoryId,
	type MentionItem,
	type MentionPaletteView,
	type MentionQuery,
	type MentionSourceMeta,
	type MentionSourceResult,
} from "./types";

const OVERVIEW_FILES_CAP = 5;
const LOCKED_SCOPE_CAP = 20;
const DOMINANT_WINNER_CAP = 15;
const FILES_WITH_OTHERS_CAP = 6;
const SECONDARY_CATEGORY_CAP = 2;
const TOTAL_MIXED_CAP = 10;

interface NamespaceShortcutDef {
	readonly category: MentionCategoryId;
	readonly token: string;
	readonly label: string;
	readonly detail: string;
	readonly icon: string;
	readonly glyph: string;
	readonly aliases: readonly string[];
}

const NAMESPACE_SHORTCUTS: readonly NamespaceShortcutDef[] = [
	{
		category: "models",
		token: "@model:",
		label: "@model:",
		detail: "Tag a model + thinking effort (or ^)",
		icon: "cpu",
		glyph: "⬢",
		aliases: ["model", "models", "m"],
	},
	{
		category: "agents",
		token: "@agent:",
		label: "@agent:",
		detail: "Tag a local or peer subagent",
		icon: "users",
		glyph: "●",
		aliases: ["agent", "agents", "peer", "peers", "a"],
	},
	{
		category: "sessions",
		token: "@session:",
		label: "@session:",
		detail: "Tag a past conversation",
		icon: "message",
		glyph: "💬",
		aliases: ["session", "sessions", "chat", "conv", "conversation", "s"],
	},
	{
		category: "vcs",
		token: "@git:",
		label: "@git:",
		detail: "Tag a diff, branch, commit, or tag",
		icon: "git-branch",
		glyph: "⎇",
		aliases: ["git", "branch", "commit", "tag", "diff", "changes", "vcs", "g"],
	},
	{
		category: "forge",
		token: "@pr:",
		label: "@pr:",
		detail: "Tag a GitHub PR or issue (or #123)",
		icon: "pr",
		glyph: "⑂",
		aliases: ["pr", "issue", "github", "gh"],
	},
	{
		category: "mcp",
		token: "@mcp:",
		label: "@mcp:",
		detail: "Tag an MCP resource",
		icon: "mcp",
		glyph: "⌁",
		aliases: ["mcp", "resource"],
	},
	{
		category: "ssh",
		token: "@ssh:",
		label: "@ssh:",
		detail: "Tag an SSH host",
		icon: "host",
		glyph: "⇢",
		aliases: ["ssh", "host"],
	},
];

/** Universal right-aligned fact columns shared by all mention categories in Tern. */
export const MENTION_PICKER_COLUMNS: readonly TspPickerColumn[] = [
	{ id: "meta", format: "dim", priority: 1, min: 4 },
	{ id: "right", format: "text", priority: 2, min: 6 },
];

export interface ArbitratedMentions {
	readonly items: readonly MentionItem[];
	readonly palette: MentionPaletteView;
}

function categoryOrderIndex(id: MentionCategoryId): number {
	const index = MENTION_CATEGORY_ORDER.indexOf(id);
	return index === -1 ? MENTION_CATEGORY_ORDER.length : index;
}

function makeNamespaceShortcutItem(def: NamespaceShortcutDef, count: number | undefined): MentionItem {
	const right = count !== undefined && count > 0 && count <= 99 ? String(count) : undefined;
	return {
		category: def.category,
		tier: MATCH_TIER.Medium,
		value: def.token,
		insertText: def.token,
		appendSpace: false,
		isNamespaceShortcut: true,
		label: def.label,
		description: def.detail,
		nativeDetail: def.detail,
		icon: def.glyph,
		iconName: def.icon,
		pickerItem: {
			id: `ns:${def.category}`,
			label: def.label,
			detail: def.detail,
			icon: def.icon,
			mono: true,
			...(right ? { facts: { right } } : {}),
		},
	};
}

/** Build the scope pill strip (`All` + available categories, keeping pill labels clean and compact). */
function buildScopes(
	sources: readonly MentionSourceMeta[],
	byId: ReadonlyMap<MentionCategoryId, MentionSourceResult>,
	lockedScope: MentionCategoryId | undefined,
	showCounts: boolean,
): TspPickerScope[] {
	let anyLoading = false;
	const categoryPills: TspPickerScope[] = [];
	for (const meta of sources) {
		const res = byId.get(meta.id);
		if (!res?.available) continue;
		if (res.loading) anyLoading = true;
		const pillCount = showCounts && res.total > 0 && res.total <= 99 ? res.total : undefined;
		categoryPills.push({
			id: meta.id,
			label: meta.label,
			icon: meta.icon,
			...(pillCount !== undefined ? { count: pillCount } : {}),
			...(res.loading ? { loading: true } : {}),
			...(lockedScope === meta.id ? { locked: true } : {}),
		});
	}
	return [
		{
			id: "all",
			label: "All",
			...(anyLoading ? { loading: true } : {}),
		},
		...categoryPills,
	];
}

/** Arbitrate results across all mention sources into display items + Tern palette metadata. */
export function arbitrateMentions(
	query: MentionQuery,
	results: readonly MentionSourceResult[],
	sources: readonly MentionSourceMeta[],
): ArbitratedMentions {
	const byId = new Map<MentionCategoryId, MentionSourceResult>();
	const metaById = new Map<MentionCategoryId, MentionSourceMeta>();
	for (const meta of sources) metaById.set(meta.id, meta);
	for (const res of results) byId.set(res.category, res);

	const pinned = query.pinnedScope ?? undefined;
	const explicitLock = pinned ?? query.syntaxLock;

	interface Section {
		readonly groupId: string;
		readonly label: string;
		readonly items: readonly MentionItem[];
		readonly count?: number;
	}

	let selectedSections: Section[] = [];
	let lockedScope: MentionCategoryId | undefined = query.syntaxLock;

	if (explicitLock) {
		const res = byId.get(explicitLock);
		if (res && res.items.length > 0) {
			selectedSections = [
				{
					groupId: explicitLock,
					label: metaById.get(explicitLock)?.label ?? explicitLock,
					items: res.items.slice(0, LOCKED_SCOPE_CAP),
					count: res.total <= 99 ? res.total : undefined,
				},
			];
		}
	} else if (query.query.trim() === "") {
		// Bare `@`: Files on top, followed by clean `@category:` jump shortcuts.
		const filesRes = byId.get("files");
		if (filesRes && filesRes.available && filesRes.items.length > 0) {
			selectedSections.push({
				groupId: "files",
				label: "Files",
				items: filesRes.items.slice(0, OVERVIEW_FILES_CAP),
			});
		}
		const shortcuts: MentionItem[] = [];
		for (const def of NAMESPACE_SHORTCUTS) {
			const res = byId.get(def.category);
			if (!res?.available) continue;
			shortcuts.push(makeNamespaceShortcutItem(def, res.total));
		}
		if (shortcuts.length > 0) {
			selectedSections.push({
				groupId: "categories",
				label: "More",
				items: shortcuts,
			});
		}
	} else {
		// Unlocked `@<query>`: Files stay on top whenever Files matches strongly/moderately;
		// non-file categories appear only on strong/exact matches, and auto-focus when Files misses.
		const trimmed = query.query.trim();
		const lower = trimmed.toLowerCase();
		const filesRes = byId.get("files");
		const filesHasStrong =
			filesRes !== undefined &&
			filesRes.available &&
			filesRes.items.length > 0 &&
			filesRes.bestTier <= MATCH_TIER.Medium;
		const filesHasAny = filesRes !== undefined && filesRes.available && filesRes.items.length > 0;

		const nonFileStrong = results
			.filter(
				r =>
					r.category !== "files" &&
					r.available &&
					r.items.length > 0 &&
					(r.bestTier <= MATCH_TIER.Strong || (query.modelEffortSuffix !== undefined && r.category === "models")),
			)
			.sort((a, b) => {
				if (query.modelEffortSuffix !== undefined) {
					if (a.category === "models" && b.category !== "models") return -1;
					if (b.category === "models" && a.category !== "models") return 1;
				}
				return a.bestTier - b.bestTier || categoryOrderIndex(a.category) - categoryOrderIndex(b.category);
			});

		// Matching `@category:` namespace shortcuts (e.g. `@mod` → `@model:`, `@ses` → `@session:`).
		const matchingShortcuts: MentionItem[] = [];
		if (lower.length >= 2 && !lower.includes("/") && !lower.includes(":")) {
			for (const def of NAMESPACE_SHORTCUTS) {
				const res = byId.get(def.category);
				if (!res?.available) continue;
				if (def.aliases.some(alias => alias.startsWith(lower))) {
					matchingShortcuts.push(makeNamespaceShortcutItem(def, res.total));
				}
			}
		}

		// Case 1: Model `:effort` suffix typed or Files has no strong match while one non-file category clearly wins.
		const topOther = nonFileStrong[0];
		const nonFileClearWinner =
			topOther !== undefined &&
			((query.modelEffortSuffix !== undefined && topOther.category === "models") ||
				(!filesHasStrong &&
					(nonFileStrong.length === 1 ||
						(nonFileStrong[1] !== undefined && nonFileStrong[1].bestTier >= topOther.bestTier + 2))));

		if (nonFileClearWinner && topOther) {
			lockedScope = topOther.category;
			selectedSections = [
				{
					groupId: topOther.category,
					label: metaById.get(topOther.category)?.label ?? topOther.category,
					items: topOther.items.slice(0, DOMINANT_WINNER_CAP),
				},
			];
		} else {
			let remaining = TOTAL_MIXED_CAP;

			// Files ALWAYS go first when they have hits (and aren't outclassed by a clear non-file winner).
			if (filesHasAny && filesRes) {
				const cap =
					nonFileStrong.length === 0 && matchingShortcuts.length === 0
						? DOMINANT_WINNER_CAP
						: Math.min(FILES_WITH_OTHERS_CAP, remaining);
				selectedSections.push({
					groupId: "files",
					label: "Files",
					items: filesRes.items.slice(0, cap),
				});
				remaining -= Math.min(cap, filesRes.items.length);
			}

			// Surface genuinely strong non-file hits below Files (concise cap, never flooding).
			for (const r of nonFileStrong) {
				if (remaining <= 0) break;
				const cap = Math.min(filesHasAny ? SECONDARY_CATEGORY_CAP : 5, remaining);
				selectedSections.push({
					groupId: r.category,
					label: metaById.get(r.category)?.label ?? r.category,
					items: r.items.slice(0, cap),
				});
				remaining -= Math.min(cap, r.items.length);
			}

			// Surface matching `@category:` shortcuts cleanly when query prefixes a namespace.
			if (matchingShortcuts.length > 0 && remaining > 0) {
				selectedSections.push({
					groupId: "categories",
					label: "Categories",
					items: matchingShortcuts.slice(0, Math.min(3, remaining)),
				});
			}

			// Fallback: if neither Files nor strong non-file matched, show best weak non-file hits (if any).
			if (selectedSections.length === 0) {
				const fallback = results
					.filter(r => r.available && r.items.length > 0)
					.sort(
						(a, b) => a.bestTier - b.bestTier || categoryOrderIndex(a.category) - categoryOrderIndex(b.category),
					);
				for (const r of fallback.slice(0, 2)) {
					selectedSections.push({
						groupId: r.category,
						label: metaById.get(r.category)?.label ?? r.category,
						items: r.items.slice(0, 4),
					});
				}
			}
		}
	}

	const items: MentionItem[] = [];
	const pickerItems: TspPickerItem[] = [];
	const order: (string | TspPickerGroup)[] = [];
	const seenIds = new Set<string>();
	const showGroupHeaders = selectedSections.length > 1;

	for (const section of selectedSections) {
		const sectionItems: MentionItem[] = [];
		for (const item of section.items) {
			if (seenIds.has(item.pickerItem.id)) continue;
			seenIds.add(item.pickerItem.id);
			sectionItems.push(item);
		}
		if (sectionItems.length === 0) continue;
		if (showGroupHeaders) {
			order.push({
				group: section.groupId,
				label: section.label,
				...(section.count !== undefined ? { count: section.count } : {}),
			});
		}
		for (const item of sectionItems) {
			items.push(item);
			pickerItems.push(item.pickerItem);
			order.push(item.pickerItem.id);
		}
	}

	const loading = results.some(r => r.loading);
	const showCounts = query.query.trim().length > 0;
	const scopes = buildScopes(sources, byId, pinned ? undefined : lockedScope, showCounts);
	const activeScope = pinned ?? lockedScope ?? "all";

	return {
		items,
		palette: {
			scopes,
			activeScope,
			...(lockedScope ? { lockedScope } : {}),
			columns: MENTION_PICKER_COLUMNS,
			pickerItems,
			order,
			loading,
			query: query.query,
			prefix: query.prefix,
			trigger: query.trigger,
		},
	};
}
