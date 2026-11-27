/**
 * Cross-source Intent Arbiter for the unified mention palette.
 *
 * Design principles:
 * - **Categories on bare `@`**: an empty `@` lists only the namespace jump rows
 *   (`@f:`, `@m:`, `@a:`, `@h:`, `@g:`, `@p:`, `@i:`, `@r:`, `@s:`), so nothing gets
 *   buried and there is zero 800-model / 30-agent spam.
 * - **Files first**: a general `@<query>` leads with workspace files.
 * - **Smart auto-switching**: once another category clearly wins (e.g. `@opus`
 *   has strong model matches and no strong file match, or `@m:`/`^`/`#123`
 *   explicitly locks a scope), that category takes over cleanly at full depth.
 */
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspPickerColumn, TspPickerGroup, TspPickerItem } from "@oh-my-pi/pi-wire";
import {
	MATCH_TIER,
	MENTION_CATEGORY_ORDER,
	type MentionCategoryId,
	type MentionItem,
	type MentionPaletteView,
	type MentionQuery,
	type MentionSourceMeta,
	type MentionSourceResult,
	type MentionSubKind,
} from "./types";

const LOCKED_SCOPE_CAP = 20;
const DOMINANT_WINNER_CAP = 15;
const FILES_WITH_OTHERS_CAP = 6;
const SECONDARY_CATEGORY_CAP = 2;
const TOTAL_MIXED_CAP = 10;

/** One `@<x>:` jump row: a short token that locks its category, named by the long form. */
interface NamespaceShortcutDef {
	readonly category: MentionCategoryId;
	/** Inserted and shown token (`@m:`); the parser maps it to {@link category}. */
	readonly token: string;
	/** Display name (`Models`). */
	readonly name: string;
	readonly detail: string;
	/** Tern icon name. */
	readonly icon: string;
	/** Theme symbol key of the terminal glyph. */
	readonly symbol: string;
	/** Typed prefixes (`@mod`) that surface the row; 2+ characters. */
	readonly aliases: readonly string[];
	/** Sub-kind the token narrows to; such a row shows no category-wide count. */
	readonly subKind?: MentionSubKind;
}

const NAMESPACE_SHORTCUTS: readonly NamespaceShortcutDef[] = [
	{
		category: "files",
		token: "@f:",
		name: "Files",
		detail: "Tag a file or directory",
		icon: "file",
		symbol: "mention.file",
		aliases: ["file", "files"],
	},
	{
		category: "models",
		token: "@m:",
		name: "Models",
		detail: "Tag a model + thinking effort (or ^)",
		icon: "cpu",
		symbol: "mention.model",
		aliases: ["model", "models"],
	},
	{
		category: "agents",
		token: "@a:",
		name: "Agents",
		detail: "Tag a local or peer subagent",
		icon: "users",
		symbol: "mention.agent",
		aliases: ["agent", "agents", "peer", "peers"],
	},
	{
		category: "sessions",
		token: "@h:",
		name: "Sessions",
		detail: "Tag a past conversation",
		icon: "message",
		symbol: "mention.session",
		aliases: ["session", "sessions", "history", "chat", "conv", "conversation"],
	},
	{
		category: "vcs",
		token: "@g:",
		name: "Git",
		detail: "Tag a diff, branch, commit, or tag",
		icon: "git-branch",
		symbol: "mention.git",
		aliases: ["git", "branch", "commit", "tag", "diff", "changes", "vcs"],
	},
	{
		category: "forge",
		token: "@p:",
		name: "PRs",
		detail: "Tag a GitHub pull request (or #123)",
		icon: "pr",
		symbol: "mention.pr",
		aliases: ["pr", "prs", "pull", "github", "gh"],
		subKind: "pr",
	},
	{
		category: "forge",
		token: "@i:",
		name: "Issues",
		detail: "Tag a GitHub issue",
		icon: "info",
		symbol: "mention.issue",
		aliases: ["issue", "issues"],
		subKind: "issue",
	},
	{
		category: "mcp",
		token: "@r:",
		name: "MCP",
		detail: "Tag an MCP resource",
		icon: "mcp",
		symbol: "mention.mcp",
		aliases: ["mcp", "resource", "resources"],
	},
	{
		category: "ssh",
		token: "@s:",
		name: "SSH",
		detail: "Tag an SSH host",
		icon: "host",
		symbol: "mention.ssh",
		aliases: ["ssh", "host", "hosts"],
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

/**
 * A category jump row: the display name as label, the description as detail,
 * the token as the `meta` fact and the category count as `right`.
 */
function makeNamespaceShortcutItem(def: NamespaceShortcutDef, count: number): MentionItem {
	const facts: Record<string, string> = { meta: def.token };
	const shown = def.subKind ? undefined : shownCount(count);
	if (shown !== undefined) facts.right = String(shown);
	return {
		category: def.category,
		tier: MATCH_TIER.Medium,
		value: def.token,
		insertText: def.token,
		appendSpace: false,
		isNamespaceShortcut: true,
		label: def.name,
		description: def.detail,
		nativeDetail: def.detail,
		icon: currentTheme().symbols.symbol(def.symbol),
		iconName: def.icon,
		pickerItem: {
			id: `ns:${def.subKind ?? def.category}`,
			label: def.name,
			detail: def.detail,
			icon: def.icon,
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

	const explicitLock = query.syntaxLock;

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
					count: shownCount(res.total),
				},
			];
		}
	} else if (query.query.trim() === "") {
		// Bare `@`: the category jump rows alone; the composer Tab-cycles them.
		const shortcuts: MentionItem[] = [];
		for (const def of NAMESPACE_SHORTCUTS) {
			const res = byId.get(def.category);
			if (res?.available) shortcuts.push(makeNamespaceShortcutItem(def, res.total));
		}
		if (shortcuts.length > 0) {
			selectedSections.push({ groupId: "categories", label: "Categories", items: shortcuts });
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

	return {
		items,
		palette: {
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
