/**
 * Formatting shared by the status line and the footer: context usage levels,
 * billing summaries, the displayed working directory.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { SymbolSet } from "@oh-my-pi/pi-tui/theme/contract";
import { formatNumber, normalizePremiumRequests } from "@oh-my-pi/pi-utils";
import type { TspTone } from "@oh-my-pi/pi-wire";
import { shortenPath } from "../../utils/render-utils";

/** How full the context window reads. */
export type ContextLevel = "normal" | "warning" | "purple" | "error";

/** Level thresholds: a level starts at its percent or its token count, whichever comes first. */
const CONTEXT_LEVELS: readonly { level: ContextLevel; percent: number; tokens: number }[] = [
	{ level: "error", percent: 90, tokens: 500_000 },
	{ level: "purple", percent: 70, tokens: 270_000 },
	{ level: "warning", percent: 50, tokens: 150_000 },
];

export function contextLevel(percent: number, window: number): ContextLevel {
	if (!Number.isFinite(percent) || percent <= 0) return "normal";
	for (const { level, percent: atPercent, tokens } of CONTEXT_LEVELS) {
		const start = Number.isFinite(window) && window > 0 ? Math.min(atPercent, (tokens / window) * 100) : atPercent;
		if (percent >= start) return level;
	}
	return "normal";
}

/** Theme color of a context level. */
export function contextColor(level: ContextLevel): string {
	switch (level) {
		case "error":
			return "error";
		case "purple":
			return "thinkingHigh";
		case "warning":
			return "warning";
		default:
			return "statusLineContext";
	}
}

/** Chrome tone of a context level; undefined while normal. */
export function contextTone(level: ContextLevel): TspTone | undefined {
	if (level === "error") return "error";
	return level === "normal" ? undefined : "warning";
}

/** `25.0%/200K`; `<tokens>/?` when the window is unknown (`?` percent while usage is unknown). */
export function formatContextUsage(percent: number | null, window: number, tokens: number): string {
	if (!Number.isFinite(window) || window <= 0) return `${formatNumber(tokens)}/?`;
	return `${percent === null ? "?" : `${percent.toFixed(1)}%`}/${formatNumber(window)}`;
}

/** What a billing summary covers. */
export interface Billing {
	readonly cost: number;
	readonly usingSubscription: boolean;
	readonly premiumRequests: number;
	/** Decimals of the amounts (status line 2, footer 3). */
	readonly digits: number;
	readonly pricingPeriod?: "peak" | "off-peak";
	/** Subagent-tree spend, shown `(+…)` after the session's own. */
	readonly subagentCost?: number;
	readonly advisor?: { readonly cost: number; readonly usingSubscription: boolean };
}

/**
 * `$0.42`, `$1.234 ★ 3`, `S1.20 (+0.30)`, `(sub)`…: the session's spend with
 * its unit printed once, subagent spend, the pricing period, premium requests
 * and advisor spend. Undefined when there is nothing to bill.
 */
export function billingSummary(billing: Billing, symbols: SymbolSet): string | undefined {
	const premium = normalizePremiumRequests(billing.premiumRequests);
	const advisorCost = billing.advisor?.cost ?? 0;
	const subagentCost = billing.subagentCost ?? 0;
	if (
		!billing.cost &&
		!subagentCost &&
		!advisorCost &&
		!billing.usingSubscription &&
		!premium &&
		!billing.pricingPeriod
	) {
		return undefined;
	}
	const parts: string[] = [];
	const subscription = symbols.icon("subscription");
	const subscriptionUnit = symbols.preset === "nerd" && subscription ? `${subscription} ` : "S";
	let shown: boolean | undefined;
	if (billing.cost || billing.pricingPeriod || subagentCost) {
		const unit = billing.usingSubscription ? subscriptionUnit : "$";
		parts.push(`${unit}${billing.cost.toFixed(billing.digits)}`);
		shown = billing.usingSubscription;
	} else if (billing.usingSubscription) {
		parts.push(subscription || "(sub)");
		shown = true;
	}
	if (subagentCost) parts.push(`(+${subagentCost.toFixed(billing.digits)})`);
	if (billing.pricingPeriod) parts.push(billing.pricingPeriod === "peak" ? "↑" : "↓");
	if (premium) parts.push(`★ ${formatNumber(premium)}`);
	if (advisorCost && billing.advisor) {
		const usingSubscription = billing.advisor.usingSubscription;
		const unit = shown === usingSubscription ? "" : usingSubscription ? subscriptionUnit : "$";
		const amount = `${unit}${advisorCost.toFixed(billing.digits)}`;
		const advisor = symbols.icon("advisor") || "(adv)";
		const labelled = advisor === "(adv)" ? `${amount} ${advisor}` : `${advisor} ${amount}`;
		parts.push(parts.length > 0 ? `+ ${labelled}` : labelled);
	}
	return parts.length > 0 ? parts.join(" ") : undefined;
}

function within(root: string, dir: string): string | null {
	if (dir === root) return "";
	const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
	return dir.startsWith(prefix) ? dir.slice(prefix.length) : null;
}

/** Directories whose children are throwaway (shown with the scratch icon, relative to the root). */
function scratchRoots(home: string): string[] {
	const roots = [os.tmpdir(), path.join(home, "tmp"), "/tmp", "/var/tmp"];
	if (process.platform === "darwin") roots.push("/private/tmp", "/private/var/tmp");
	return roots.map(root => path.resolve(root));
}

/**
 * The working directory as the path segment shows it: relative to a scratch
 * root (flagged `scratch`) or to a project root (`~/Projects`, `~/repos`,
 * `/work`) when `strip`, then `~`-shortened when `abbreviate`.
 */
export function displayCwd(
	cwd: string,
	options: { home?: string; strip: boolean; abbreviate: boolean },
): { text: string; scratch: boolean } {
	const home = options.home ?? os.homedir();
	const dir = path.resolve(cwd);
	let text = cwd;
	let scratch = false;
	if (options.strip) {
		for (const root of scratchRoots(home)) {
			const relative = within(root, dir);
			if (relative !== null) {
				scratch = true;
				text = relative || cwd;
				break;
			}
		}
		if (!scratch) {
			for (const root of [path.join(home, "Projects"), path.join(home, "repos"), "/work"]) {
				const relative = within(path.resolve(root), dir);
				if (relative) {
					text = relative;
					break;
				}
			}
		}
	}
	return { text: options.abbreviate ? shortenPath(text, home) : text, scratch };
}

/** `text` kept to `max` characters from its end, led by `…` when cut. */
export function clampStart(text: string, max: number): string {
	return text.length <= max ? text : `…${text.slice(-Math.max(0, max - 1))}`;
}
