/**
 * Cross-source Intent Arbiter for the unified mention palette.
 *
 * Design principles:
 * - **Files on bare `@`**: an empty `@` lists what Files predicts (dirty and recent files, the folder).
 * - **Files first**: a general `@<query>` leads with workspace files.
 * - **Smart auto-switching**: once another category clearly wins (e.g. `@opus`
 *   has strong model matches and no strong file match, or `@m:`/`^`/`#123`
 *   explicitly locks a scope), that category takes over cleanly at full depth.
 * - **Scopes**: every registered category is a scope of the palette's scope bar. A mention is in
 *   one only when its syntax says so (`@m:`, `^`, `#123`, a path, the files lock): a clear winner
 *   takes the list over without becoming the scope.
 */
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspPickerColumn, TspPickerGroup, TspPickerItem } from "@oh-my-pi/pi-wire";
import { type MentionNamespace, splitMentionNamespace } from "./parse";
import { MENTION_SCOPES, type MentionScopeDef, mentionScopeOf } from "./scopes";
import {
	MATCH_TIER,
	MENTION_CATEGORY_ORDER,
	type MentionCategoryId,
	type MentionItem,
	type MentionPaletteView,
	type MentionQuery,
	type MentionScopeView,
	type MentionSourceMeta,
	type MentionSourceResult,
} from "./types";

const LOCKED_SCOPE_CAP = 20;
const DOMINANT_WINNER_CAP = 15;
const FILES_WITH_OTHERS_CAP = 6;
const SECONDARY_CATEGORY_CAP = 2;
const TOTAL_MIXED_CAP = 10;

/** What the jump row of each `@<namespace>:` token says it tags. */
const NAMESPACE_DETAILS: Readonly<Record<MentionNamespace, string>> = {
	m: "Tag a model + thinking effort (or ^)",
	p2p: "Tag a local agent or a peer from any project",
	ses: "Tag a past conversation",
	git: "Tag a diff, branch, commit, or tag",
	pr: "Tag a GitHub pull request (or #123)",
	iss: "Tag a GitHub issue",
	mcp: "Tag an MCP resource",
	ssh: "Tag an SSH host",
};

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

/**
 * The jump row of `scope`'s `@<namespace>:` token: the display name as label, the description as
 * detail, the token as the `meta` fact and the category count as `right`.
 */
function makeNamespaceShortcutItem(scope: MentionScopeDef, namespace: MentionNamespace, count: number): MentionItem {
	const detail = NAMESPACE_DETAILS[namespace];
	const token = `@${namespace}:`;
	const facts: Record<string, string> = { meta: token };
	const shown = scope.subKind ? undefined : shownCount(count);
	if (shown !== undefined) facts.right = String(shown);
	return {
		category: scope.category,
		tier: MATCH_TIER.Medium,
		value: token,
		insertText: token,
		appendSpace: false,
		isNamespaceShortcut: true,
		label: scope.label,
		description: detail,
		nativeDetail: detail,
		icon: currentTheme().symbols.symbol(scope.symbol),
		iconName: scope.icon,
		pickerItem: {
			id: `ns:${scope.subKind ?? scope.category}`,
			label: scope.label,
			detail,
			icon: scope.icon,
			facts,
		},
	};
}

/** A match count worth printing beside a category: 1..99, else nothing. */
function shownCount(total: number): number | undefined {
	return total > 0 && total <= 99 ? total : undefined;
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

	// A locked mention lists its category alone, and so does a bare `@`: what Files predicts for
	// an empty query, without being locked to it (the first typed character searches everything).
	const listed = query.syntaxLock ?? (query.query.trim() === "" ? "files" : undefined);

	interface Section {
		readonly groupId: string;
		readonly label: string;
		readonly items: readonly MentionItem[];
		readonly count?: number;
	}

	let selectedSections: Section[] = [];
	let lockedScope: MentionCategoryId | undefined = query.syntaxLock;

	if (listed) {
		const res = byId.get(listed);
		if (res && res.items.length > 0) {
			selectedSections = [
				{
					groupId: listed,
					label: metaById.get(listed)?.label ?? listed,
					items: res.items.slice(0, LOCKED_SCOPE_CAP),
					count: shownCount(res.total),
				},
			];
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

		// Match canonical namespace prefixes (e.g. `@se` → `@ses:`).
		const matchingShortcuts: MentionItem[] = [];
		for (const scope of MENTION_SCOPES) {
			const namespace = scope.namespace;
			if (!namespace?.startsWith(lower)) continue;
			const res = byId.get(scope.category);
			if (res) matchingShortcuts.push(makeNamespaceShortcutItem(scope, namespace, res.total));
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
					count: shownCount(topOther.total),
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
					count: shownCount(filesRes.total),
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
					count: shownCount(r.total),
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
						count: shownCount(r.total),
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

	const scopes: MentionScopeView[] = [];
	for (const def of MENTION_SCOPES) {
		if (!metaById.has(def.category)) continue;
		// Half a category's total (pull requests or issues) is known only while the query narrows to it.
		const counted = def.subKind === undefined || (query.syntaxLock === def.category && query.subKind === def.subKind);
		const count = counted ? shownCount(byId.get(def.category)?.total ?? 0) : undefined;
		scopes.push({ id: def.id, label: def.label, icon: def.icon, ...(count !== undefined ? { count } : {}) });
	}
	const scopeId = mentionScopeOf(query);
	const scope = scopes.find(view => view.id === scopeId)?.id;
	const typed = query.trigger === "@" ? splitMentionNamespace(query.prefix.slice(1)).rest : query.rawBody;

	return {
		items,
		palette: {
			...(lockedScope ? { lockedScope } : {}),
			scopes,
			...(scope ? { scope } : {}),
			typed,
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
