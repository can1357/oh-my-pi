/**
 * Per-install rewrite of prompt text and tool descriptions.
 *
 * Every install picks one committed paraphrase per source string, keyed by the
 * persisted install id, so requests from different installs do not share the
 * same prose while each install stays byte-stable (system-prompt `systemKey`
 * and provider prompt caches never churn between turns). The pool is authored
 * offline by `scripts/gen-prompt-perturbation.ts`. Its manual entry for the
 * system-prompt opener has an empty variant, so perturbed requests carry no
 * persona line.
 *
 * Off by default. A model opts in through the `prompt-perturbation` KDL axis
 * (see `packages/catalog/src/compat/rules/`); `OMP_PROMPT_PERTURBATION=1`
 * forces it on for every model and `OMP_PROMPT_PERTURBATION=0` forces it off.
 */
import { createHash } from "node:crypto";
import { resolveCatalogPolicy } from "@oh-my-pi/pi-catalog/compat/catalog-policy";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { getInstallId } from "@oh-my-pi/pi-utils";
import type { Context, Tool } from "../types";
// A `.txt` asset (like `template.html.txt`) so the pool is parsed only when a request is first perturbed.
import poolText from "./perturbation-pool.json.txt" with { type: "text" };

interface PerturbationEntry {
	source: string;
	variants: readonly string[];
	/** Hand-authored entry; regeneration leaves it alone. */
	manual?: boolean;
}

interface PerturbationPool {
	version: number;
	entries: readonly PerturbationEntry[];
}

interface Perturbation {
	pattern: RegExp;
	replacements: ReadonlyMap<string, string>;
}

let built = false;
let perturbation: Perturbation | null = null;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Choose this install's variant of every pooled source, in one alternation. */
function buildPerturbation(): Perturbation | null {
	const pool = JSON.parse(poolText) as PerturbationPool;
	const entries = pool.entries.filter(entry => entry.source.length > 0 && entry.variants.length > 0);
	if (entries.length === 0) return null;
	const installId = getInstallId();
	const replacements = new Map<string, string>();
	for (const entry of entries) {
		const digest = createHash("sha256").update(`prompt-perturbation\u0000${installId}\u0000${entry.source}`).digest();
		const variant = entry.variants[digest.readUInt32BE(0) % entry.variants.length];
		if (variant !== undefined) replacements.set(entry.source, variant);
	}
	if (replacements.size === 0) return null;
	// Longest first so a source that contains another source is matched whole.
	const alternatives = [...replacements.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
	return { pattern: new RegExp(alternatives.join("|"), "g"), replacements };
}

/** Rewrite every pooled source in `text` with this install's variant. */
export function perturbPromptText(text: string): string {
	if (text.length === 0) return text;
	if (!built) {
		perturbation = buildPerturbation();
		built = true;
	}
	if (perturbation === null) return text;
	return text.replace(perturbation.pattern, match => perturbation!.replacements.get(match) ?? match);
}

function perturbTools(tools: Tool[] | undefined): Tool[] | undefined {
	if (tools === undefined) return undefined;
	let changed = false;
	const next = tools.map(tool => {
		const description = perturbPromptText(tool.description);
		if (description === tool.description) return tool;
		changed = true;
		return { ...tool, description };
	});
	return changed ? next : tools;
}

/** Whether requests to `model` are perturbed: `OMP_PROMPT_PERTURBATION` (`0`/`1`) wins over the KDL axis. */
export function isPromptPerturbationEnabled(model: Model): boolean {
	const env = process.env.OMP_PROMPT_PERTURBATION;
	if (env === "0") return false;
	if (env === "1") return true;
	return resolveCatalogPolicy(model).promptPerturbation === true;
}

/**
 * Rewrite the model-visible prose of a request to `model` when perturbation is
 * enabled for it: system-prompt blocks and every tool description, including
 * tools Anthropic may activate later.
 */
export function perturbContext(model: Model, context: Context): Context {
	if (!isPromptPerturbationEnabled(model)) return context;
	const systemPrompt = context.systemPrompt?.map(perturbPromptText);
	const tools = perturbTools(context.tools);
	const inactiveTools = perturbTools(context.inactiveTools);
	if (systemPrompt === context.systemPrompt && tools === context.tools && inactiveTools === context.inactiveTools) {
		return context;
	}
	return {
		...context,
		...(systemPrompt !== context.systemPrompt && { systemPrompt }),
		...(tools !== context.tools && { tools }),
		...(inactiveTools !== context.inactiveTools && { inactiveTools }),
	};
}

/** Drop the memoized choices; tests and long-lived processes that adopt a new install id call this. */
export function resetPromptPerturbation(): void {
	built = false;
	perturbation = null;
}
