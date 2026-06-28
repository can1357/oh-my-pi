import { attach, create, Flag } from "./flags";

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
