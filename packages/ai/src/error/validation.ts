import { attach, create, Flag, PROVIDER_OPERATION_DEADLINE_PREFIX } from "./flags";

/**
 * Caller-supplied input failed validation before/while building a provider
 * request: bad request body, malformed tool arguments, unsupported content
 * type, a schema that cannot be normalized, an unknown tool, etc.
 *
 * This is a programmer/config/contract error, not a transient provider fault —
 * it is never retried.
 */
export class ValidationError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ValidationError";
	}
}

/** A referenced tool was not found in the active tool set. */
export class ToolNotFoundError extends ValidationError {
	constructor(toolName: string) {
		super(`Tool "${toolName}" not found`);
		this.name = "ToolNotFoundError";
	}
}

/**
 * Provider/auth configuration was missing or malformed (env var pointing at a
 * missing file, missing projectId, bad bind string, mTLS half-configured, …).
 */
export class ConfigurationError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ConfigurationError";
	}
}

/** A request was abandoned because it exceeded a stream/idle/first-event deadline. */
export class StreamTimeoutError extends Error {
	constructor(message = "Request timed out.", options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "StreamTimeoutError";
		attach(this, create(Flag.Transient, Flag.Timeout));
	}
}

/**
 * The whole-operation budget for one logical provider request ran out.
 *
 * Distinct from {@link StreamTimeoutError}: that watchdog fires when a live
 * stream goes silent, while this one fires when the aggregate wall clock
 * across every nested retry of the same request is spent. It is raised
 * *instead of* a retry sleep that would land past the budget, so the failure
 * is immediate rather than one more wait. Flagged transient so higher-level
 * recovery may still replay the request with a fresh budget.
 */
export class ProviderOperationDeadlineError extends Error {
	/** Configured budget for the operation, in milliseconds. */
	readonly budgetMs: number;
	/** Wall clock already spent on the operation when the retry was refused. */
	readonly elapsedMs: number;
	/** The retry sleep that was declined instead of taken. */
	readonly declinedDelayMs: number;

	constructor(budgetMs: number, elapsedMs: number, declinedDelayMs: number) {
		super(
			`${PROVIDER_OPERATION_DEADLINE_PREFIX} after ${Math.round(elapsedMs / 1000)}s of a ${Math.round(budgetMs / 1000)}s budget; declined a ${Math.round(declinedDelayMs)}ms retry wait.`,
		);
		this.name = "ProviderOperationDeadlineError";
		this.budgetMs = budgetMs;
		this.elapsedMs = elapsedMs;
		this.declinedDelayMs = declinedDelayMs;
		attach(this, create(Flag.Transient, Flag.Timeout));
	}
}
