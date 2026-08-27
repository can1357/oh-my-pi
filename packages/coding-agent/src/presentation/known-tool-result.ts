import { z } from "@oh-my-pi/omptype/zod";
import type { PresentationContentBlock } from "./schemas/content";
import { toolContentBlockSchema } from "./schemas/content";
import type {
	PresentationEditDetails,
	PresentationEvalDetails,
	PresentationLegacyBashDetails,
} from "./schemas/details";
import { editDetailsSchema, evalDetailsSchema, legacyBashDetailsSchema } from "./schemas/details";

/**
 * The migration seam: the **one** place an untyped legacy tool result enters the
 * new pipeline.
 *
 * Everything downstream switches exhaustively on {@link KnownToolResult} with a
 * `satisfies never` default, so an unhandled producer is a compile error instead
 * of a silently-degraded frame. The ACP mapper never switches on `toolName` to
 * recover a detail shape again.
 *
 * Provenance, not name, selects the external arm. An unrecognised *built-in* is
 * reported as {@link UnmodelledBuiltinResult} — an explicit arm consumers must
 * handle — rather than being waved through as external data, because "external"
 * carries a different trust and validation contract: only genuinely external
 * input crosses the untyped/unvalidated boundary this seam guards.
 */

/** Where a result came from. Supplied by the caller, never guessed from the name. */
export type ToolSource =
	| { readonly origin: "builtin"; readonly name: string }
	| {
			readonly origin: "external";
			readonly name: string;
			readonly provider: "mcp" | "extension" | "custom";
	  };

/** Fields shared by every arm of {@link KnownToolResult}. */
export interface KnownToolResultBase {
	readonly toolName: string;
	readonly content: readonly PresentationContentBlock[];
	/** The result-level failure flag as recorded by the agent loop. */
	readonly isError: boolean;
}

/** A built-in whose details the seam models. */
export interface BashLikeResult extends KnownToolResultBase {
	readonly tool: "bash";
	readonly details: PresentationLegacyBashDetails;
}

export interface EvalResult extends KnownToolResultBase {
	readonly tool: "eval";
	readonly details: PresentationEvalDetails;
}

export interface EditResult extends KnownToolResultBase {
	readonly tool: "edit";
	readonly details: PresentationEditDetails;
}

/**
 * A registered built-in the seam does not model yet.
 *
 * Deliberately its own arm. The alternative — defaulting to the external arm —
 * would apply salvage-everything parsing to data that should be strictly
 * validated, and it would hide a modelling gap behind a green test.
 */
export interface UnmodelledBuiltinResult extends KnownToolResultBase {
	readonly tool: "unmodelled_builtin";
	readonly details: unknown;
}

/** An MCP/extension/custom tool. Its details are genuinely unknown. */
export interface ExternalToolResult extends KnownToolResultBase {
	readonly tool: "external";
	readonly provider: "mcp" | "extension" | "custom";
	readonly details: unknown;
}

export type KnownToolResult = BashLikeResult | EvalResult | EditResult | UnmodelledBuiltinResult | ExternalToolResult;

/** Detail families the seam models, keyed by built-in tool name. */
const BUILTIN_DETAIL_FAMILY = {
	bash: "bash",
	shell: "bash",
	exec: "bash",
	eval: "eval",
	edit: "edit",
	patch: "edit",
	apply_patch: "edit",
} as const satisfies Record<string, "bash" | "eval" | "edit">;

type ModelledBuiltinName = keyof typeof BUILTIN_DETAIL_FAMILY;

function isModelledBuiltin(name: string): name is ModelledBuiltinName {
	return Object.hasOwn(BUILTIN_DETAIL_FAMILY, name);
}

/** Thrown when a *built-in* result fails its own strict schema. */
export class BuiltinResultSchemaError extends Error {
	readonly toolName: string;
	readonly issues: readonly string[];

	constructor(toolName: string, issues: readonly string[]) {
		super(`Built-in tool "${toolName}" produced details that failed its presentation schema: ${issues.join("; ")}`);
		this.name = "BuiltinResultSchemaError";
		this.toolName = toolName;
		this.issues = issues;
	}
}

const legacyEnvelopeSchema = z.looseObject({
	content: z.array(z.unknown()).optional(),
	details: z.unknown().optional(),
	isError: z.boolean().optional(),
});

/** How a built-in schema violation is handled. */
export interface ParseLegacyToolResultOptions {
	/**
	 * `"throw"` (the default in development and tests) surfaces a built-in
	 * producer bug immediately. `"degrade"` is for production paths that must not
	 * take a session down over a rendering detail: the result becomes an
	 * {@link UnmodelledBuiltinResult}, which every consumer already handles, and
	 * the caller is expected to log.
	 */
	readonly onBuiltinSchemaError?: "throw" | "degrade";
}

/**
 * Narrow one legacy `AgentToolResult`-shaped value into {@link KnownToolResult}.
 *
 * The content array salvages block-by-block: a malformed block is dropped rather
 * than voiding a result whose other blocks are fine. Built-in *details* do not
 * salvage — see {@link ParseLegacyToolResultOptions}.
 */
export function parseLegacyToolResult(
	source: ToolSource,
	result: unknown,
	options: ParseLegacyToolResultOptions = {},
): KnownToolResult {
	const envelope = legacyEnvelopeSchema.safeParse(result);
	const raw = envelope.success ? envelope.data : { content: undefined, details: undefined, isError: undefined };
	const content = salvageContentBlocks(raw.content);
	const isError = raw.isError === true;
	const base: KnownToolResultBase = { toolName: source.name, content, isError };

	if (source.origin === "external") {
		return { ...base, tool: "external", provider: source.provider, details: raw.details };
	}
	// Every modelled built-in (bash/eval/edit family) is a typed compatibility
	// boundary: unlike external data, it must arrive as a valid AgentToolResult
	// envelope before its details can be interpreted. A malformed envelope
	// (wrong top-level type, non-array `content`) must not silently degrade
	// into a successful empty result for any of them — it is producer/transport
	// corruption, not real tool output.
	if (!envelope.success && isModelledBuiltin(source.name)) {
		// Envelope-level corruption degrades fail-closed: `raw` collapsed to
		// all-undefined, so the salvaged base would claim an empty, successful
		// result — force `isError` so the degraded card settles FAILED.
		return degradeOrThrow(base, source.name, envelope.error, result, options, true);
	}

	if (!isModelledBuiltin(source.name)) {
		return { ...base, tool: "unmodelled_builtin", details: raw.details };
	}

	const family = BUILTIN_DETAIL_FAMILY[source.name];
	// Bash and eval permit an empty details object. Edit-family producers are
	// deliberately stricter: their required `diff` is the contract that tells
	// the adapter whether an empty visual diff is an intentional no-diff result
	// rather than malformed producer output.
	const details = raw.details === undefined || raw.details === null ? {} : raw.details;
	switch (family) {
		case "bash": {
			const parsed = legacyBashDetailsSchema.safeParse(details);
			if (parsed.success) return { ...base, tool: "bash", details: parsed.data };
			return degradeOrThrow(base, source.name, parsed.error, raw.details, options);
		}
		case "eval": {
			const parsed = evalDetailsSchema.safeParse(details);
			if (parsed.success) return { ...base, tool: "eval", details: parsed.data };
			return degradeOrThrow(base, source.name, parsed.error, raw.details, options);
		}
		case "edit": {
			const parsed = editDetailsSchema.safeParse(details);
			if (parsed.success) return { ...base, tool: "edit", details: parsed.data };
			return degradeOrThrow(base, source.name, parsed.error, raw.details, options);
		}
		default: {
			const exhaustive: never = family;
			throw new Error(`Unhandled built-in detail family: ${String(exhaustive)}`);
		}
	}
}

function degradeOrThrow(
	base: KnownToolResultBase,
	toolName: string,
	error: z.ZodError,
	details: unknown,
	options: ParseLegacyToolResultOptions,
	envelopeCorrupt = false,
): UnmodelledBuiltinResult {
	const issues = error.issues.map(issue => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
	if ((options.onBuiltinSchemaError ?? "throw") === "throw") {
		throw new BuiltinResultSchemaError(toolName, issues);
	}
	// Two distinct failure classes reach here. A *details*-schema violation
	// keeps the well-formed envelope's own `isError`. Envelope-level corruption
	// has no trustworthy envelope — its salvaged base defaults to a succeeded
	// empty result — so it degrades fail-closed instead of silently flipping
	// producer/transport corruption into a success card.
	return {
		...base,
		isError: envelopeCorrupt ? true : base.isError,
		tool: "unmodelled_builtin",
		details,
	};
}

function salvageContentBlocks(value: readonly unknown[] | undefined): readonly PresentationContentBlock[] {
	if (value === undefined) return [];
	const blocks: PresentationContentBlock[] = [];
	for (const candidate of value) {
		const parsed = toolContentBlockSchema.safeParse(candidate);
		if (parsed.success) blocks.push(parsed.data);
	}
	return blocks;
}

/** The concatenated text of a parsed result, in block order. */
export function knownResultText(result: KnownToolResult): string {
	return result.content
		.filter((block): block is Extract<PresentationContentBlock, { type: "text" }> => block.type === "text")
		.map(block => block.text)
		.join("\n");
}
