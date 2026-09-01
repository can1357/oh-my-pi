import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fuzzyFind } from "@oh-my-pi/pi-natives";
import { getProjectDir } from "@oh-my-pi/pi-utils";

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

function buildAutocompleteFuzzyDiscoveryProfile(
	query: string,
	basePath: string,
	signal?: AbortSignal,
): {
	query: string;
	path: string;
	maxResults: number;
	hidden: boolean;
	gitignore: boolean;
	cache: boolean;
	signal?: AbortSignal;
} {
	return {
		query,
		path: basePath,
		maxResults: 100,
		hidden: true,
		gitignore: true,
		cache: true,
		...(signal ? { signal } : {}),
	};
}

function findLastDelimiter(text: string): number {
	for (let i = text.length - 1; i >= 0; i -= 1) {
		if (PATH_DELIMITERS.has(text[i] ?? "")) {
			return i;
		}
	}
	return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;

	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) {
				quoteStart = i;
			}
		}
	}

	return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
	return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

/**
 * Locate the slash that opens a slash command on the line, allowing leading
 * whitespace. Returns the index of the `/` or `null` when the line is not a
 * slash command. Aligns with `trimStart` semantics so the editor and provider
 * agree on which prefixes count.
 */
export function findLeadingSlashCommandStart(text: string): number | null {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("/")) return null;
	return text.length - trimmed.length;
}

export function findTrailingSlashCommandStart(text: string): number | null {
	const match = /(?:^|\s)\/([^\s/]*)$/.exec(text);
	if (!match || match.index === undefined) return null;
	const slashOffset = match[0].indexOf("/");
	return match.index + slashOffset;
}

function extractQuotedPrefix(text: string): string | null {
	const quoteStart = findUnclosedQuoteStart(text);
	if (quoteStart === null) {
		return null;
	}

	if (quoteStart > 0 && text[quoteStart - 1] === "@") {
		if (!isTokenStart(text, quoteStart - 1)) {
			return null;
		}
		return text.slice(quoteStart - 1);
	}

	if (!isTokenStart(text, quoteStart)) {
		return null;
	}

	return text.slice(quoteStart);
}

function parsePathPrefix(prefix: string): { rawPrefix: string; isAtPrefix: boolean; isQuotedPrefix: boolean } {
	if (prefix.startsWith('@"')) {
		return { rawPrefix: prefix.slice(2), isAtPrefix: true, isQuotedPrefix: true };
	}
	if (prefix.startsWith('"')) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: false, isQuotedPrefix: true };
	}
	if (prefix.startsWith("@")) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: true, isQuotedPrefix: false };
	}
	return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}

function buildCompletionValue(
	path: string,
	options: { isDirectory: boolean; isAtPrefix: boolean; isQuotedPrefix: boolean },
): string {
	const needsQuotes = options.isQuotedPrefix || path.includes(" ");
	const prefix = options.isAtPrefix ? "@" : "";

	if (!needsQuotes) {
		return `${prefix}${path}`;
	}

	const openQuote = `${prefix}"`;
	const closeQuote = options.isDirectory ? "" : '"';
	return `${openQuote}${path}${closeQuote}`;
}

/**
 * Check if query is a subsequence of target (fuzzy match).
 * "wig" matches "skill:wig" because w-i-g appear in order.
 */
function fuzzyMatch(query: string, target: string): boolean {
	if (query.length === 0) return true;
	if (query.length > target.length) return false;

	let qi = 0;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (query[qi] === target[ti]) qi++;
	}
	return qi === query.length;
}

/**
 * Score a fuzzy match. Higher = better match.
 * Prioritizes: exact match > starts-with > contains > subsequence
 */
function fuzzyScore(query: string, target: string): number {
	if (query.length === 0) return 1;
	if (target === query) return 100;
	if (target.startsWith(query)) return 80;
	if (target.includes(query)) return 60;

	// Subsequence match - score by how "tight" the match is
	// (fewer gaps between matched characters = higher score)
	let qi = 0;
	let gaps = 0;
	let lastMatchIdx = -1;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (query[qi] === target[ti]) {
			if (lastMatchIdx >= 0 && ti - lastMatchIdx > 1) gaps++;
			lastMatchIdx = ti;
			qi++;
		}
	}
	if (qi !== query.length) return 0;

	// Base score 40 for subsequence, minus penalty for gaps
	return Math.max(1, 40 - gaps * 5);
}

export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
	/** Optional type-indicator glyph rendered in an aligned column before the label */
	icon?: string;
	/** Dim hint text shown inline after cursor when this item is selected */
	hint?: string;
}

type Awaitable<T> = T | Promise<T>;

export interface SlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	/** Optional type-indicator glyph shown before the command name in autocomplete */
	icon?: string;
	argumentHint?: string;
	/** Whether the command consumes argument text after the command name. False means the full input stays normal prompt text once args are present. */
	allowArgs?: boolean;
	/** Dynamic display-only description for slash-command autocomplete. Must be synchronous and side-effect free. */
	getAutocompleteDescription?: () => string | undefined;
	// Function to get argument completions for this command
	// Returns null if no argument completion is available
	getArgumentCompletions?(argumentPrefix: string): Awaitable<AutocompleteItem[] | null>;
	/** Return inline hint text for the current argument state (shown as dim ghost text after cursor) */
	getInlineHint?(argumentText: string): string | null;
}

export interface AutocompleteProvider {
	/** Get autocomplete suggestions for current text/cursor position. Expensive providers SHOULD stop when `signal` aborts. */
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
	): Promise<{
		items: AutocompleteItem[];
		prefix: string; // What we're matching against (e.g., "/" or "src/")
	} | null>;

	/** Apply the selected item and return new text + cursor position */
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
		onApplied?: () => void;
	};

	/** Get inline hint text to show as dim ghost text after the cursor */
	getInlineHint?(lines: string[], cursorLine: number, cursorCol: number): string | null;
	/** Synchronously try to complete a slash command at the start of a line (no async I/O). */
	/** Returns matched items and the full prefix, or null if not applicable. */
	trySyncSlashCompletion?(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null;
	/**
	 * Synchronously try to expand text immediately before the cursor (no async I/O).
	 * Called after every single-character insert. Implementations MUST cheaply
	 * early-return when the trailing context cannot trigger them.
	 * Returns the number of characters to delete immediately before the cursor
	 * and the literal string to insert in their place, or null to leave the
	 * buffer untouched.
	 */
	trySyncInlineReplace?(textBeforeCursor: string): { replaceLen: number; insert: string } | null;

	/**
	 * Force file-path completion (called on Tab). Returns matched items plus the
	 * full prefix, or null when no path token sits before the cursor. Present on
	 * file-aware providers; absent on slash-only ones.
	 * Expensive providers SHOULD stop when `signal` aborts.
	 */
	getForceFileSuggestions?(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null>;

	/** Whether a Tab press should attempt file completion at the cursor. */
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

type CommandEntry = SlashCommand | AutocompleteItem;
/** Optional behaviors for {@link CombinedAutocompleteProvider}. */
export interface CombinedAutocompleteOptions {
	/** Usage count per command name; higher counts rank earlier among equal text-match scores. */
	commandUsage?: (name: string) => number;
}

function getCommandName(cmd: CommandEntry): string | undefined {
	return "name" in cmd ? cmd.name : cmd.value;
}

function getCommandAliases(cmd: CommandEntry): string[] {
	if (!("aliases" in cmd) || !Array.isArray(cmd.aliases)) return [];
	return cmd.aliases.filter(alias => typeof alias === "string" && alias.length > 0);
}

function getStaticCommandDescription(cmd: CommandEntry): string {
	return cmd.description ?? "";
}

function getAutocompleteCommandDescription(cmd: CommandEntry): string {
	if ("getAutocompleteDescription" in cmd && typeof cmd.getAutocompleteDescription === "function") {
		return cmd.getAutocompleteDescription() ?? cmd.description ?? "";
	}
	return cmd.description ?? "";
}

function commandMatchesNameOrAlias(cmd: CommandEntry, commandName: string): boolean {
	const name = getCommandName(cmd);
	if (name === commandName) return true;
	return getCommandAliases(cmd).includes(commandName);
}

export function scoreCommandTextMatch(lowerPrefix: string, lowerTarget: string): number {
	if (lowerPrefix.length === 0) return 1;
	if (lowerPrefix === lowerTarget) return 1000;
	// Flat score for every prefix match so same-prefix commands keep registry
	// order under the stable sort. A length penalty here would rank the shorter
	// name first (e.g. `/set` → `setup` above `settings`), silently changing the
	// command that the sync-completion path applies on Enter.
	if (lowerTarget.startsWith(lowerPrefix)) return 900;
	return fuzzyMatch(lowerPrefix, lowerTarget) ? fuzzyScore(lowerPrefix, lowerTarget) : 0;
}

function buildSlashCommandCompletions(
	commands: CommandEntry[],
	lowerPrefix: string,
	commandUsage?: (name: string) => number,
): AutocompleteItem[] {
	return (
		commands
			.flatMap(cmd => {
				const name = getCommandName(cmd);
				if (!name) return [];
				const usage = commandUsage?.(name) ?? 0;
				const hint = "argumentHint" in cmd && cmd.argumentHint ? cmd.argumentHint : undefined;
				const staticDesc = getStaticCommandDescription(cmd);
				let fullDescMemo: string | undefined;
				let fullDescComputed = false;
				// Resolve the (possibly live) display description lazily, only once a
				// candidate actually matches — getAutocompleteDescription reads live
				// session state and must not run for every command on each keystroke.
				const resolveFullDesc = (): string | undefined => {
					if (!fullDescComputed) {
						const displayDesc = getAutocompleteCommandDescription(cmd);
						fullDescMemo = hint ? (displayDesc ? `${hint} - ${displayDesc}` : hint) : displayDesc;
						fullDescComputed = true;
					}
					return fullDescMemo;
				};
				let best: (AutocompleteItem & { score: number; usage: number }) | undefined;

				const isSkillCommand = name.startsWith(SKILL_NAMESPACE);
				// Skills are matched by their bare name as well as the full
				// `skill:` name so a broken-out or mid-prompt skill ranks at
				// prefix strength (`/batch` → `skill:batch`) instead of a weak
				// full-name fuzzy hit.
				const nameScore =
					lowerPrefix.length === 0 && isSkillCommand
						? 950
						: isSkillCommand
							? Math.max(
									scoreCommandTextMatch(lowerPrefix, name.toLowerCase()),
									scoreCommandTextMatch(lowerPrefix, name.slice(SKILL_NAMESPACE.length).toLowerCase()),
								)
							: scoreCommandTextMatch(lowerPrefix, name.toLowerCase());
				const lowerDesc = staticDesc.toLowerCase();
				const descScore =
					lowerDesc && fuzzyMatch(lowerPrefix, lowerDesc) ? fuzzyScore(lowerPrefix, lowerDesc) * 0.5 : 0;
				const primaryScore = Math.max(nameScore, descScore);
				if (primaryScore > 0) {
					const fullDesc = resolveFullDesc();
					best = {
						value: name,
						label: "name" in cmd ? cmd.name : cmd.label,
						score: primaryScore,
						usage,
						...(cmd.icon && { icon: cmd.icon }),
						...(fullDesc && { description: fullDesc }),
					};
				}

				if (lowerPrefix.length > 0) {
					for (const alias of getCommandAliases(cmd)) {
						if (alias === name) continue;
						const aliasScore = scoreCommandTextMatch(lowerPrefix, alias.toLowerCase());
						if (aliasScore === 0 || (best && aliasScore <= best.score)) continue;
						const fullDesc = resolveFullDesc();
						best = {
							value: alias,
							label: alias,
							score: aliasScore,
							usage,
							...(cmd.icon && { icon: cmd.icon }),
							...(fullDesc && { description: fullDesc }),
						};
					}
				}

				return best ? [best] : [];
			})
			// Equal text-match scores fall back to usage frequency, then to the
			// stable registry order.
			.sort((a, b) => b.score - a.score || b.usage - a.usage)
			.map(({ score: _score, usage: _usage, ...rest }) => rest)
	);
}

function hasPromptTextBeforeSlash(
	lines: string[],
	cursorLine: number,
	textBeforeCursor: string,
	slashStart: number,
): boolean {
	for (let i = 0; i < cursorLine; i += 1) {
		if ((lines[i] || "").trim() !== "") return true;
	}
	return textBeforeCursor.slice(0, slashStart).trim() !== "";
}

export const SKILL_NAMESPACE = "skill:";

/**
 * Match tier used to compare a skill's bare name against non-skill command
 * names when deciding whether the skill may break out of the collapsed
 * `skill:` group: exact (1000) > prefix (900) > anything weaker (0). Fuzzy
 * hits deliberately map to 0 — a fuzzy skill match is never strong enough to
 * mix skills into the command popup.
 */
function skillBreakoutTier(lowerPrefix: string, lowerTarget: string): number {
	if (lowerPrefix === lowerTarget) return 1000;
	if (lowerTarget.startsWith(lowerPrefix)) return 900;
	return 0;
}

/**
 * Collapse `skill:*` commands into a single `/skill:` namespace row while the
 * typed prefix has not committed to the namespace. A lone group entry (shown
 * only while the prefix is still a prefix of `skill:`) keeps the `/` popup
 * readable. A skill breaks out of the group only when its bare name matches
 * the prefix at a strictly stronger tier than every non-skill command name
 * and alias (`/batch` → `skill:batch` while no command prefix-matches
 * `batch`); a tie keeps the popup command-only, and fuzzy-only skill hits
 * never surface. Accepting the group inserts `/skill:` without a trailing
 * space so the reopened popup expands to the individual skills.
 */
function collapseSkillNamespace(commands: CommandEntry[], lowerPrefix: string): CommandEntry[] {
	if (lowerPrefix.startsWith(SKILL_NAMESPACE)) return commands;
	const approachesNamespace = SKILL_NAMESPACE.startsWith(lowerPrefix);
	let commandTier = 0;
	if (!approachesNamespace) {
		for (const cmd of commands) {
			const name = getCommandName(cmd);
			if (!name || name.startsWith(SKILL_NAMESPACE)) continue;
			commandTier = Math.max(commandTier, skillBreakoutTier(lowerPrefix, name.toLowerCase()));
			for (const alias of getCommandAliases(cmd)) {
				commandTier = Math.max(commandTier, skillBreakoutTier(lowerPrefix, alias.toLowerCase()));
			}
			if (commandTier === 1000) break;
		}
	}
	let skillCount = 0;
	let skillIcon: string | undefined;
	const rest = commands.filter(cmd => {
		const name = getCommandName(cmd);
		if (!name?.startsWith(SKILL_NAMESPACE)) return true;
		skillCount += 1;
		skillIcon ??= cmd.icon;
		return (
			!approachesNamespace &&
			skillBreakoutTier(lowerPrefix, name.slice(SKILL_NAMESPACE.length).toLowerCase()) > commandTier
		);
	});
	if (skillCount === 0) return commands;
	if (!SKILL_NAMESPACE.startsWith(lowerPrefix)) return rest;
	rest.push({
		name: SKILL_NAMESPACE,
		description: `${skillCount} skill${skillCount === 1 ? "" : "s"}`,
		...(skillIcon && { icon: skillIcon }),
	});
	return rest;
}

/**
 * Whether a mid-prompt slash token (`prose … /tok`) is skill-shaped enough to
 * surface `name` in the skill popup. Deliberately stricter than submitted
 * slash-command matching: a stray `/word` in running prose must not keep the
 * popup alive through fuzzy name/description hits, so a token only matches as
 * - a prefix of the `skill:` namespace (incl. the bare `/` entry point),
 * - an explicit `skill:…` query (full fuzzy name/description search), or
 * - a prefix of the skill's bare name (`/hum` → `skill:humanizer`).
 * Anything else yields no items, letting the caller fall through to path
 * completion or close the popup. Shared with the editor's accept-time
 * staleness guard so Tab/Enter never accepts a skill the refreshed popup
 * would no longer show.
 */
export function midPromptSkillTokenMatches(lowerToken: string, name: string, description?: string): boolean {
	if (SKILL_NAMESPACE.startsWith(lowerToken)) return true;
	const lowerName = name.toLowerCase();
	if (lowerToken.startsWith(SKILL_NAMESPACE)) {
		if (scoreCommandTextMatch(lowerToken, lowerName) > 0) return true;
		return !!description && scoreCommandTextMatch(lowerToken, description.toLowerCase()) > 0;
	}
	return lowerName.startsWith(SKILL_NAMESPACE) && lowerName.slice(SKILL_NAMESPACE.length).startsWith(lowerToken);
}

function buildMidPromptSkillCompletions(commands: CommandEntry[], lowerPrefix: string): AutocompleteItem[] {
	return buildSlashCommandCompletions(
		commands.filter(cmd => {
			const name = getCommandName(cmd);
			return (
				name?.startsWith(SKILL_NAMESPACE) &&
				midPromptSkillTokenMatches(lowerPrefix, name, getStaticCommandDescription(cmd))
			);
		}),
		lowerPrefix,
	);
}

// Combined provider that handles both slash commands and file paths.
export class CombinedAutocompleteProvider implements AutocompleteProvider {
	#commands: CommandEntry[];
	#basePath: string;
	#commandUsage?: (name: string) => number;
	// Intentionally separate from pi-natives cache: this cache is a local,
	// per-directory readdir fast-path for prefix completions. Global fuzzy
	// discovery continues to use native fuzzyFind + shared scan cache.
	#dirCache: Map<string, { entries: fs.Dirent[]; timestamp: number }> = new Map();
	readonly #DIR_CACHE_TTL = 2000; // 2 seconds

	constructor(
		commands: CommandEntry[] = [],
		basePath: string = getProjectDir(),
		options?: CombinedAutocompleteOptions,
	) {
		this.#commands = commands;
		this.#basePath = basePath;
		this.#commandUsage = options?.commandUsage;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		if (signal?.aborted) return null;
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		const leadingSlashStart = findLeadingSlashCommandStart(textBeforeCursor);
		const trailingSlashStart = findTrailingSlashCommandStart(textBeforeCursor);
		const hasPromptTextBeforeTrailingSlash =
			trailingSlashStart !== null &&
			hasPromptTextBeforeSlash(lines, cursorLine, textBeforeCursor, trailingSlashStart);
		const hasPromptTextBeforeLeadingSlash =
			leadingSlashStart !== null && hasPromptTextBeforeSlash(lines, cursorLine, textBeforeCursor, leadingSlashStart);
		const slashStart = hasPromptTextBeforeTrailingSlash
			? trailingSlashStart
			: hasPromptTextBeforeLeadingSlash
				? null
				: leadingSlashStart;
		if (slashStart !== null) {
			const commandText = textBeforeCursor.slice(slashStart);
			const spaceIndex = commandText.indexOf(" ");
			const isMidPromptSkillLookup = hasPromptTextBeforeTrailingSlash;

			if (spaceIndex === -1) {
				// No space yet - complete command names
				const prefix = commandText.slice(1); // Remove the "/"
				const lowerPrefix = prefix.toLowerCase();

				const matches = isMidPromptSkillLookup
					? buildMidPromptSkillCompletions(this.#commands, lowerPrefix)
					: buildSlashCommandCompletions(
							collapseSkillNamespace(this.#commands, lowerPrefix),
							lowerPrefix,
							this.#commandUsage,
						);

				if (matches.length > 0) {
					return {
						items: matches,
						// Preserve the full text-before-cursor for submitted slash
						// commands so the editor's Enter-staleness check still applies
						// completion for `  /sk`. Mid-prompt skill lookup keeps only
						// the slash token because acceptance replaces only that token.
						prefix: isMidPromptSkillLookup ? commandText : textBeforeCursor,
					};
				}
				if (!isMidPromptSkillLookup && slashStart === leadingSlashStart && !commandText.slice(1).includes("/")) {
					return null;
				}

				// A slash token with no matching command may still be an absolute
				// path (`/tmp/fo` at prompt start, `see /tmp` mid-prompt); fall
				// through to file-path completion.
			} else if (!isMidPromptSkillLookup) {
				// Give matched commands first chance to complete arguments, then
				// fall through to prompt-composer file completion when they have
				// no argument provider or it has no matches.
				const commandName = commandText.slice(1, spaceIndex); // Command without "/"
				const argumentText = commandText.slice(spaceIndex + 1); // Text after space

				const command = this.#commands.find(cmd => commandMatchesNameOrAlias(cmd, commandName));
				if (command && "allowArgs" in command && command.allowArgs === false && !/\S/.test(argumentText)) {
					return null;
				}
				if (
					command &&
					(!("allowArgs" in command) || command.allowArgs !== false) &&
					"getArgumentCompletions" in command &&
					command.getArgumentCompletions
				) {
					const argumentSuggestions = await command.getArgumentCompletions(argumentText);
					if (Array.isArray(argumentSuggestions) && argumentSuggestions.length > 0) {
						return {
							items: argumentSuggestions,
							prefix: argumentText,
						};
					}
				}
			}
		}

		// Check for @ file reference (fuzzy search) - must be after a delimiter or at start
		const atPrefix = this.#extractAtPrefix(textBeforeCursor);
		if (atPrefix) {
			const { rawPrefix, isQuotedPrefix } = parsePathPrefix(atPrefix);
			// Recursive fuzzy walks rooted outside the project (e.g. `@../`,
			// `@~/`, `@/abs`) can be huge — a parent dir full of sibling
			// projects blows past several seconds of latency. Outside cwd,
			// fall back to plain prefix listing of the immediate directory
			// (matches Claude Code's behavior). Inside cwd we keep the
			// fuzzy-then-prefix flow.
			if (rawPrefix.length > 0 && this.#isOutsideCwd(rawPrefix)) {
				const items = await this.#getFileSuggestions(atPrefix);
				if (items.length === 0) return null;
				return { items, prefix: atPrefix };
			}
			const suggestions =
				rawPrefix.length > 0
					? await this.#getFuzzyFileSuggestions(rawPrefix, { isQuotedPrefix, signal })
					: await this.#getFileSuggestions("@");
			if (suggestions.length === 0 && rawPrefix.length > 0) {
				const fallback = await this.#getFileSuggestions(atPrefix);
				if (fallback.length === 0) return null;
				return { items: fallback, prefix: atPrefix };
			}
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: atPrefix,
			};
		}

		// Check for file paths - triggered by Tab or if we detect a path pattern
		const pathMatch = this.#extractPathPrefix(textBeforeCursor, false);

		if (pathMatch !== null) {
			const suggestions = await this.#getFileSuggestions(pathMatch);
			if (suggestions.length === 0) return null;

			// Check if we have an exact match that is a directory
			// In that case, we might want to return suggestions for the directory content instead
			// But only if the prefix ends with /
			if (suggestions.length === 1 && suggestions[0]?.value === pathMatch && !pathMatch.endsWith("/")) {
				// Exact match found (e.g. user typed "src" and "src/" is the only match)
				// We still return it so user can select it and add /
				return {
					items: suggestions,
					prefix: pathMatch,
				};
			}

			return {
				items: suggestions,
				prefix: pathMatch,
			};
		}

		return null;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const afterCursor = currentLine.slice(cursorCol);

		const leadingSlashStart = findLeadingSlashCommandStart(textBeforeCursor);
		const trailingSlashStart = findTrailingSlashCommandStart(textBeforeCursor);
		const isMidPromptSkillLookup =
			item.value.startsWith("skill:") &&
			trailingSlashStart !== null &&
			hasPromptTextBeforeSlash(lines, cursorLine, textBeforeCursor, trailingSlashStart) &&
			findTrailingSlashCommandStart(prefix) !== null;

		if (isMidPromptSkillLookup && trailingSlashStart !== null) {
			// Replace ONLY the partial slash token (e.g. "/sec") at the cursor with
			// `/skill:<name> `; the rest of the user's draft — prose typed before
			// the slash, text after the cursor, and any other lines — is preserved.
			// The submit-time parser (`parseSkillInvocation` in coding-agent/skills)
			// detects the mid-prompt `/skill:<name>` token and threads the surrounding
			// prose through as `args`, so the skill still invokes (issue #3913, after
			// the original mid-prompt autocomplete landed in #3654 wiped the draft).
			const beforeSlash = currentLine.slice(0, trailingSlashStart);
			const insert = `/${item.value} `;
			const newLine = `${beforeSlash}${insert}${afterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforeSlash.length + insert.length,
			};
		}

		// Slash command suggestions can be accepted before the debounced refresh
		// catches up to newly typed characters. Replace the live command token,
		// not only the prefix captured when the suggestion list was rendered.
		// Absolute-path completions share the leading-slash prefix shape but
		// insert values starting with `/` (or `"` when quoted); those must take
		// the path tail below instead of command-style `/<name> ` insertion.
		const isPathCompletionItem = item.value.startsWith("/") || item.value.startsWith('"');
		if (findLeadingSlashCommandStart(prefix) !== null && leadingSlashStart !== null && !isPathCompletionItem) {
			const slashPrefix = textBeforeCursor.slice(leadingSlashStart);
			if (!slashPrefix.includes(" ") && !slashPrefix.slice(1).includes("/")) {
				const beforeSlash = currentLine.slice(0, leadingSlashStart);
				// The collapsed `/skill:` namespace row completes to the namespace
				// itself: no trailing space, so completion continues with the
				// individual skills instead of finishing a command token.
				const insert = item.value === SKILL_NAMESPACE ? `/${item.value}` : `/${item.value} `;
				const newLine = `${beforeSlash}${insert}${afterCursor}`;
				const newLines = [...lines];
				newLines[cursorLine] = newLine;

				return {
					lines: newLines,
					cursorLine,
					cursorCol: beforeSlash.length + insert.length,
				};
			}
		}

		let beforePrefix = currentLine.slice(0, cursorCol - prefix.length);

		// Check if we're completing a file attachment (prefix starts with "@")
		if (prefix.startsWith("@")) {
			const liveAtPrefix = this.#extractAtPrefix(textBeforeCursor);
			if (liveAtPrefix) {
				beforePrefix = currentLine.slice(0, cursorCol - liveAtPrefix.length);
			}
			// This is a file attachment completion
			const newLine = `${beforePrefix + item.value} ${afterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 1, // +1 for space
			};
		}

		// Slash command argument and plain file path completion both fall through
		// to the path-completion tail below — `beforePrefix` already covers the
		// rendered prefix, which preserves earlier arguments (e.g. accepting
		// `package.json` for `/swarm run pac<Tab>` keeps the `run` token intact).
		// For file paths, complete the path
		const newLine = beforePrefix + item.value + afterCursor;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;

		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + item.value.length,
		};
	}

	// Extract @ prefix for fuzzy file suggestions
	#extractAtPrefix(text: string): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix?.startsWith('@"')) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;

		if (text[tokenStart] === "@") {
			return text.slice(tokenStart);
		}

		return null;
	}

	// Extract a path-like prefix from the text before cursor
	#extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const pathPrefix = lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1);

		// For forced extraction (Tab key), always return something
		if (forceExtract) {
			return pathPrefix;
		}

		// Automatic updates complete only unambiguous path syntax. Bare relative
		// tokens remain available through explicit Tab completion.
		if (
			pathPrefix.startsWith("/") ||
			pathPrefix.startsWith("./") ||
			pathPrefix.startsWith("../") ||
			pathPrefix.startsWith("~/") ||
			// Windows drive-absolute paths (C:/Users, C:\Users).
			/^[A-Za-z]:[\\/]/.test(pathPrefix)
		) {
			return pathPrefix;
		}

		return null;
	}

	// Expand home directory (~/) to actual home path
	#expandHomePath(filePath: string): string {
		if (filePath.startsWith("~/")) {
			const expandedPath = path.join(os.homedir(), filePath.slice(2));
			// Preserve trailing slash if original path had one
			return filePath.endsWith("/") && !expandedPath.endsWith("/") ? `${expandedPath}/` : expandedPath;
		} else if (filePath === "~") {
			return os.homedir();
		}
		return filePath;
	}

	// Resolve `rawPrefix` lexically (no I/O) and report whether it points
	// somewhere outside `this.#basePath`. Used to skip recursive fuzzy walks
	// rooted at parent / absolute / home paths — those routinely include
	// thousands of unrelated files and stall the UI for seconds.
	#isOutsideCwd(rawPrefix: string): boolean {
		if (rawPrefix.length === 0) return false;
		let target: string;
		if (rawPrefix.startsWith("~")) {
			target = this.#expandHomePath(rawPrefix);
		} else if (path.isAbsolute(rawPrefix)) {
			target = rawPrefix;
		} else {
			target = path.resolve(this.#basePath, rawPrefix);
		}
		const rel = path.relative(this.#basePath, target);
		if (rel === "" || rel === ".") return false;
		if (path.isAbsolute(rel)) return true;
		const firstSep = rel.indexOf(path.sep);
		const head = firstSep === -1 ? rel : rel.slice(0, firstSep);
		return head === "..";
	}

	async #resolveScopedFuzzyQuery(
		rawQuery: string,
	): Promise<{ baseDir: string; query: string; displayBase: string } | null> {
		const slashIndex = rawQuery.lastIndexOf("/");
		if (slashIndex === -1) {
			return null;
		}

		const displayBase = rawQuery.slice(0, slashIndex + 1);
		const query = rawQuery.slice(slashIndex + 1);

		let baseDir: string;
		if (displayBase.startsWith("~/")) {
			baseDir = this.#expandHomePath(displayBase);
		} else if (displayBase.startsWith("/")) {
			baseDir = displayBase;
		} else {
			baseDir = path.join(this.#basePath, displayBase);
		}

		try {
			if (!(await fs.promises.stat(baseDir)).isDirectory()) {
				return null;
			}
		} catch {
			return null;
		}

		return { baseDir, query, displayBase };
	}

	#scopedPathForDisplay(displayBase: string, relativePath: string): string {
		if (displayBase === "/") {
			return `/${relativePath}`;
		}
		return `${displayBase}${relativePath}`;
	}

	async #getCachedDirEntries(searchDir: string): Promise<fs.Dirent[]> {
		const now = Date.now();
		const cached = this.#dirCache.get(searchDir);

		if (cached && now - cached.timestamp < this.#DIR_CACHE_TTL) {
			return cached.entries;
		}

		const entries = await fs.promises.readdir(searchDir, { withFileTypes: true });
		this.#dirCache.set(searchDir, { entries, timestamp: now });

		if (this.#dirCache.size > 100) {
			const sortedKeys = [...this.#dirCache.entries()]
				.sort((a, b) => a[1].timestamp - b[1].timestamp)
				.slice(0, 50)
				.map(([key]) => key);
			for (const key of sortedKeys) {
				this.#dirCache.delete(key);
			}
		}

		return entries;
	}

	invalidateDirCache(dir?: string): void {
		if (dir) {
			this.#dirCache.delete(dir);
		} else {
			this.#dirCache.clear();
		}
	}

	// Get file/directory suggestions for a given path prefix
	async #getFileSuggestions(prefix: string): Promise<AutocompleteItem[]> {
		try {
			let searchDir: string;
			let searchPrefix: string;
			const { rawPrefix, isAtPrefix, isQuotedPrefix } = parsePathPrefix(prefix);
			let expandedPrefix = rawPrefix;

			// Normalize backslashes to forward slashes so Windows native paths
			// (C:\tmp\foo) work with the /-based splitting/joining below.
			expandedPrefix = expandedPrefix.replace(/\\/g, "/");

			// Capture the pre-expansion prefix so root checks can still
			// detect bare "~" and "~/" after #expandHomePath rewrites them.
			const preExpand = expandedPrefix;

			// Handle home directory expansion
			if (expandedPrefix.startsWith("~")) {
				expandedPrefix = this.#expandHomePath(expandedPrefix);
			}

			const isRootPrefix =
				preExpand === "" ||
				preExpand === "./" ||
				preExpand === "../" ||
				preExpand === "~" ||
				preExpand === "~/" ||
				preExpand === "/" ||
				(isAtPrefix && preExpand === "");

			if (isRootPrefix) {
				// Complete from specified position
				if (expandedPrefix.startsWith("~") || path.isAbsolute(expandedPrefix)) {
					searchDir = expandedPrefix;
				} else {
					searchDir = path.join(this.#basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else if (expandedPrefix.endsWith("/")) {
				// If prefix ends with /, show contents of that directory
				if (expandedPrefix.startsWith("~") || path.isAbsolute(expandedPrefix)) {
					searchDir = expandedPrefix;
				} else {
					searchDir = path.join(this.#basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else {
				// Split into directory and file prefix
				const dir = path.dirname(expandedPrefix);
				const file = path.basename(expandedPrefix);
				if (expandedPrefix.startsWith("~") || path.isAbsolute(expandedPrefix)) {
					searchDir = dir;
				} else {
					searchDir = path.join(this.#basePath, dir);
				}
				searchPrefix = file;
			}

			const entries = await this.#getCachedDirEntries(searchDir);
			const suggestions: AutocompleteItem[] = [];

			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
					continue;
				}
				// Skip .git directory
				if (entry.name === ".git") {
					continue;
				}

				// Check if entry is a directory (or a symlink pointing to a directory)
				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						const fullPath = path.join(searchDir, entry.name);
						isDirectory = (await fs.promises.stat(fullPath)).isDirectory();
					} catch {
						// Broken symlink, file deleted between readdir and stat, or permission error
						continue;
					}
				}

				let relativePath: string;
				const name = entry.name;
				const displayPrefix = rawPrefix.replace(/\\/g, "/");

				if (displayPrefix.endsWith("/")) {
					// If prefix ends with /, append entry to the prefix
					relativePath = displayPrefix + name;
				} else if (displayPrefix.includes("/")) {
					// Preserve ~/ format for home directory paths
					if (displayPrefix.startsWith("~/")) {
						const homeRelativeDir = displayPrefix.slice(2); // Remove ~/
						const dir = path.dirname(homeRelativeDir);
						relativePath = `~/${dir === "." ? name : path.join(dir, name)}`;
					} else if (path.isAbsolute(displayPrefix)) {
						// Absolute path — covers both /unix/paths and Windows C:/drive/paths.
						// Use string concat with / instead of path.join (which uses platform-native
						// separators and produces drive-relative results like "C:alpha" when
						// dirname returns "C:" without a trailing slash).
						const dir = displayPrefix.slice(0, displayPrefix.lastIndexOf("/"));
						relativePath = dir === "" || dir === "/" ? `/${name}` : `${dir}/${name}`;
					} else {
						relativePath = path.join(path.dirname(displayPrefix), name);
						if (displayPrefix.startsWith("./") && !relativePath.startsWith("./")) {
							relativePath = `./${relativePath}`;
						}
					}
				} else {
					// For standalone entries, preserve ~/ if original prefix was ~/
					if (displayPrefix.startsWith("~")) {
						relativePath = `~/${name}`;
					} else {
						relativePath = name;
					}
				}

				// Normalize backslashes to forward slashes so suggestions are consistent
				// with the user's input (which uses / on all platforms) and work correctly
				// when inserted back into the editor. Forward slashes are valid on Windows.
				relativePath = relativePath.replace(/\\/g, "/");
				const pathValue = isDirectory ? `${relativePath}/` : relativePath;
				const value = buildCompletionValue(pathValue, {
					isDirectory,
					isAtPrefix,
					isQuotedPrefix,
				});

				suggestions.push({
					value,
					label: name + (isDirectory ? "/" : ""),
				});
			}

			// Sort directories first, then alphabetically
			suggestions.sort((a, b) => {
				const aIsDir = a.value.endsWith("/");
				const bIsDir = b.value.endsWith("/");
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.label.localeCompare(b.label);
			});

			return suggestions;
		} catch {
			// Directory doesn't exist or not accessible
			return [];
		}
	}

	async #getFuzzyFileSuggestions(
		query: string,
		options: { isQuotedPrefix: boolean; signal?: AbortSignal },
	): Promise<AutocompleteItem[]> {
		try {
			const scopedQuery = await this.#resolveScopedFuzzyQuery(query);
			if (options.signal?.aborted) return [];
			const searchPath = scopedQuery?.baseDir ?? this.#basePath;
			const fuzzyQuery = scopedQuery?.query ?? query;
			const result = await fuzzyFind(buildAutocompleteFuzzyDiscoveryProfile(fuzzyQuery, searchPath, options.signal));
			const lowerQuery = fuzzyQuery.toLowerCase();
			const filteredMatches = result.matches.filter(entry => {
				const p = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
				const normalized = p.replaceAll("\\", "/");
				if (/(^|\/)\.git(\/|$)/.test(normalized)) {
					return false;
				}
				return lowerQuery.length === 0 || fuzzyMatch(lowerQuery, normalized.toLowerCase());
			});
			// `fuzzyFind` is already capped via `maxResults` in
			// `buildAutocompleteFuzzyDiscoveryProfile`; no extra slice here.
			const topEntries = filteredMatches;
			const suggestions: AutocompleteItem[] = [];
			for (const { path: entryPath, isDirectory } of topEntries) {
				const pathWithoutSlash = isDirectory ? entryPath.slice(0, -1) : entryPath;
				const displayPath = scopedQuery
					? this.#scopedPathForDisplay(scopedQuery.displayBase, pathWithoutSlash)
					: pathWithoutSlash;
				const entryName = path.basename(pathWithoutSlash);
				const completionPath = isDirectory ? `${displayPath}/` : displayPath;
				const value = buildCompletionValue(completionPath, {
					isDirectory,
					isAtPrefix: true,
					isQuotedPrefix: options.isQuotedPrefix,
				});
				suggestions.push({
					value,
					label: entryName + (isDirectory ? "/" : ""),
					description: displayPath,
				});
			}
			return suggestions;
		} catch {
			return [];
		}
	}

	// Force file completion (called on Tab key) - always returns suggestions
	async getForceFileSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		signal?: AbortSignal,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		if (signal?.aborted) return null;
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Don't trigger if we're typing a slash command at the start of the line
		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return null;
		}

		// Force extract path prefix - this will always return something
		const pathMatch = this.#extractPathPrefix(textBeforeCursor, true);
		if (pathMatch !== null) {
			const suggestions = await this.#getFileSuggestions(pathMatch);
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: pathMatch,
			};
		}

		return null;
	}

	// Check if we should trigger file completion (called on Tab key)
	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Don't trigger if we're typing a slash command at the start of the line
		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return false;
		}

		return true;
	}

	/** Get inline hint text for slash commands with subcommand hints */
	getInlineHint(lines: string[], cursorLine: number, cursorCol: number): string | null {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		const slashStart = findLeadingSlashCommandStart(textBeforeCursor);
		if (slashStart === null) return null;

		const commandText = textBeforeCursor.slice(slashStart);
		const spaceIndex = commandText.indexOf(" ");
		if (spaceIndex === -1) return null;

		const commandName = commandText.slice(1, spaceIndex);
		const argumentText = commandText.slice(spaceIndex + 1);

		const command = this.#commands.find(cmd => commandMatchesNameOrAlias(cmd, commandName));

		if (!command || !("getInlineHint" in command) || !command.getInlineHint) {
			return null;
		}

		return command.getInlineHint(argumentText);
	}
	trySyncSlashCompletion(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
		const slashStart = findLeadingSlashCommandStart(textBeforeCursor);
		if (slashStart === null) return null;
		const commandText = textBeforeCursor.slice(slashStart);
		if (commandText.length <= 1) return null; // Bare "/" alone, don't auto-complete
		if (commandText.includes(" ")) return null; // Only complete command name, not args

		const prefix = commandText.slice(1);
		const lowerPrefix = prefix.toLowerCase();

		// The `/skill:` namespace row is excluded here: the sync path submits
		// immediately after applying, and the bare namespace is not a command.
		const matches = buildSlashCommandCompletions(
			collapseSkillNamespace(this.#commands, lowerPrefix),
			lowerPrefix,
			this.#commandUsage,
		).filter(item => item.value !== SKILL_NAMESPACE);

		if (matches.length === 0) return null;
		// Mirror `getSuggestions`: preserve leading whitespace so the editor's
		// sync apply path passes the full text-before-cursor through.
		return { items: matches, prefix: textBeforeCursor };
	}
}
