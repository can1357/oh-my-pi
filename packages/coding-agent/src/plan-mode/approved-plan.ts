import { normalizeLocalScheme } from "../tools/path-utils";
import { ToolError } from "../tools/tool-errors";

/** Shape forwarded from the plan-proposal handler to InteractiveMode's
 *  approval popup. Populated by the `xd://propose` dispatch when the agent
 *  submits a plan for approval. `planFilePath` is the agent-chosen
 *  `local://<slug>-plan.md` artifact — it is never renamed on approval, so
 *  links to it stay valid for the session. */
export interface PlanApprovalDetails {
	planFilePath: string;
	title: string;
	planExists: boolean;
}

/** Validate and normalize the agent-supplied plan title into a safe filename stem.
 *  Spaces and other URL-safe punctuation are replaced with hyphens so models that
 *  produce natural-language titles (e.g. "My feature plan") still succeed.
 *  Characters that cannot be safely represented after replacement are dropped.
 *  The result is restricted to letters, numbers, underscores, and hyphens so it
 *  is safe to splice into a `local://` URL without escaping. */
export function normalizePlanTitle(title: string): { title: string; fileName: string } {
	const trimmed = title.trim();
	if (!trimmed) {
		throw new ToolError("Plan title is required and must not be empty.");
	}

	if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
		throw new ToolError("Plan title must not contain path separators or '..'.");
	}

	// Strip a trailing `.md` if the model included it, then sanitize:
	// spaces → hyphens, any remaining invalid char → dropped.
	const withoutExt = trimmed.replace(/\.md$/i, "");
	const sanitized = withoutExt
		.replace(/\s+/g, "-")
		.replace(/[^A-Za-z0-9_-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");

	if (!sanitized) {
		throw new ToolError(
			"Plan title must contain at least one letter, number, underscore, or hyphen after sanitization.",
		);
	}

	const fileName = `${sanitized}.md`;
	return { title: sanitized, fileName };
}

/** Best-effort derivation of a plan title from inputs the agent already produced.
 *  Returns the first non-empty candidate that survives `normalizePlanTitle`:
 *    1. an explicit `suppliedTitle` (e.g. `extra.title` from the resolve call),
 *    2. the first level-1 markdown heading inside `planContent`,
 *    3. the filename stem of `planFilePath` (e.g. `PLAN` from `local://PLAN.md`),
 *    4. the literal `"plan"` so callers never have to handle `null`.
 *  The fallback exists because some grammar-constrained models cannot emit a
 *  string into the open `extra` schema and instead drop in `{}` (issue #1179);
 *  plan-mode would otherwise loop forever on an unreachable validation. */
export function resolvePlanTitle(input: { suppliedTitle?: unknown; planContent: string; planFilePath: string }): {
	title: string;
	fileName: string;
	source: "supplied" | "heading" | "filename" | "default";
} {
	const candidates: Array<{ value: string; source: "supplied" | "heading" | "filename" | "default" }> = [];
	if (typeof input.suppliedTitle === "string") {
		const trimmed = input.suppliedTitle.trim();
		if (trimmed) candidates.push({ value: trimmed, source: "supplied" });
	}
	const heading = firstLevelOneHeading(input.planContent);
	if (heading) candidates.push({ value: heading, source: "heading" });
	const stem = planFilenameStem(input.planFilePath);
	if (stem) candidates.push({ value: stem, source: "filename" });
	candidates.push({ value: "plan", source: "default" });

	for (const candidate of candidates) {
		try {
			const normalized = normalizePlanTitle(candidate.value);
			return { ...normalized, source: candidate.source };
		} catch {
			// Fall through to the next candidate.
		}
	}
	// Last-ditch literal so the type-system contract holds even if `normalizePlanTitle("plan")` ever throws.
	return { title: "plan", fileName: "plan.md", source: "default" };
}

/** First `# Heading` text on its own line, trimmed. Returns the empty string if
 *  none is found so callers can chain it through truthiness checks. */
function firstLevelOneHeading(planContent: string): string {
	const match = planContent.match(/^[ \t]*#[ \t]+(.+?)[ \t]*$/m);
	return match?.[1]?.trim() ?? "";
}

/** Stem of a `local://name.md` (or bare `name.md`) URL — the filename without
 *  scheme or extension. Returns the empty string for inputs that have no stem. */
function planFilenameStem(planFilePath: string): string {
	const withoutScheme = planFilePath.replace(/^local:\/+/, "");
	const lastSegment = withoutScheme.split(/[\\/]/).pop() ?? "";
	return lastSegment.replace(/\.md$/i, "");
}

/** Humanize a normalized plan title for use as a session display name.
 *  Replaces `-`/`_` separators with spaces and capitalizes the first letter.
 *  Returns an empty string when the input collapses to whitespace. */
export function humanizePlanTitle(title: string): string {
	const spaced = title.replace(/[-_]+/g, " ").trim();
	if (!spaced) return "";
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The `local://` URL a plan slug maps to. The agent writes the plan here and
 *  passes the slug to `resolve`; the file is never renamed, so this URL — and
 *  any hyperlink to it — stays valid for the life of the session. */
export function planFileUrlForSlug(slug: string): string {
	return `local://${slug}-plan.md`;
}

/** Derive a `<slug>` from an agent-supplied `extra.title`, or `undefined` when
 *  the title is missing/non-string/unsanitizable. A trailing `-plan` is stripped
 *  so a supplied "auth-plan" maps to `auth-plan.md`, not `auth-plan-plan.md`. */
function planSlugFromSupplied(suppliedTitle: unknown): string | undefined {
	if (typeof suppliedTitle !== "string" || !suppliedTitle.trim()) return undefined;
	try {
		const { title } = normalizePlanTitle(suppliedTitle);
		const slug = title.replace(/-plan$/i, "");
		return slug || title;
	} catch {
		return undefined;
	}
}

export interface ResolveApprovedPlanInput {
	/** The agent's `extra.title` from the `resolve` call, if any. */
	suppliedTitle?: unknown;
	/** The plan path recorded in plan-mode state (the entry default or a prior plan). */
	statePlanFilePath: string;
	/** Read a plan `local://` URL, returning null when the file does not exist. */
	readPlan: (planUrl: string) => Promise<string | null>;
	/** Optional fallback: list candidate plan `local://` URLs (newest first) so a
	 *  plan whose name can't be reconstructed (e.g. a dropped `extra.title`) is
	 *  still found. */
	listPlanFiles?: () => Promise<string[]>;
}

export interface ResolvedApprovedPlan {
	planFilePath: string;
	planContent: string;
	title: string;
}

/** Locate the plan file the agent wrote and finalize its title — without
 *  renaming anything. Tries, in order: the slug derived from `extra.title`
 *  (`local://<slug>-plan.md`), a state plan that the artifact scan can't see,
 *  scanned plan files newest-to-oldest, then the state plan path as a final
 *  fallback. Throws a `ToolError` guiding the agent when none exist. */
export async function resolveApprovedPlan(input: ResolveApprovedPlanInput): Promise<ResolvedApprovedPlan> {
	const ordered: string[] = [];
	const consider = (url: string | undefined): void => {
		if (url && !ordered.includes(url)) ordered.push(url);
	};

	const slug = planSlugFromSupplied(input.suppliedTitle);
	consider(slug ? planFileUrlForSlug(slug) : undefined);

	const listed = input.listPlanFiles ? await input.listPlanFiles() : [];
	// A state plan the scan cannot surface (cwd-relative, or a local file whose
	// name does not end in `plan.md`) has no mtime in `listed` to compete on, so
	// it keeps precedence over scanned artifacts — otherwise a stale older draft
	// could shadow the deliberately-set current plan. A state plan already inside
	// the scan competes purely on the newest-first ordering below (issue #6569).
	// Compare canonical `local://` spellings so a resumed `local:/…` state path
	// still matches the scanner's `local://…` entry (normalizeLocalScheme).
	const canonicalListed = new Set(listed.map(normalizeLocalScheme));
	if (input.statePlanFilePath && !canonicalListed.has(normalizeLocalScheme(input.statePlanFilePath))) {
		consider(input.statePlanFilePath);
	}
	for (const url of listed) consider(url);
	consider(input.statePlanFilePath);

	for (const url of ordered) {
		const content = await input.readPlan(url);
		if (content !== null) return finalizeApprovedPlan(url, content, input.suppliedTitle);
	}

	const target = ordered[0] ?? input.statePlanFilePath;
	throw new ToolError(
		`Plan file not found at ${target}. Write the finalized plan to ${target} before requesting approval.`,
	);
}

function finalizeApprovedPlan(planFilePath: string, planContent: string, suppliedTitle: unknown): ResolvedApprovedPlan {
	const { title } = resolvePlanTitle({ suppliedTitle, planContent, planFilePath });
	return { planFilePath, planContent, title };
}
