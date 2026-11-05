import type { AssistantMessage, StopDetails } from "../types";
import { OpenAIHttpError, ProviderHttpError } from "./classes";
import { attach, create, Flag, isContentPolicyRefusal, isProviderRefusal } from "./flags";

/** Which part of a provider exchange produced a non-HTTP error. */
export type ProviderResponseErrorKind =
	/** Stream closed before a terminal completion/response event. */
	| "incomplete-stream"
	/** Terminal event carried an error / unexpected stop reason. */
	| "output"
	/** Response body was empty/missing when content was required. */
	| "empty-body"
	/** Response completed without actionable output (for example, thoughts only). */
	| "empty-output"
	/** Malformed wire envelope (unexpected message ordering / shape). */
	| "envelope"
	/** Content was blocked by a provider safety filter. */
	| "content-blocked"
	/** Runtime/namespace resolution or other provider-internal failure. */
	| "runtime";

export interface ProviderResponseErrorOptions {
	provider?: string;
	kind?: ProviderResponseErrorKind;
	cause?: unknown;
}

/**
 * A non-HTTP provider failure: a truncated stream, an error stop reason, an
 * empty body, a malformed envelope, or a runtime fault. For non-2xx HTTP
 * responses use {@link ProviderHttpError} (or a provider subclass) instead.
 */
export class ProviderResponseError extends Error {
	readonly provider: string | undefined;
	readonly kind: ProviderResponseErrorKind;

	constructor(message: string, options: ProviderResponseErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ProviderResponseError";
		this.provider = options.provider;
		this.kind = options.kind ?? "output";
		// A safety filter block is terminal and intentionally non-retryable.
		if (this.kind === "content-blocked") attach(this, create(Flag.ContentBlocked));
		// A logically empty completed output needs a session-level reminder that
		// asks for the missing final answer. Empty bodies and incomplete streams
		// stay on the generic transient retry/model-fallback path.
		else if (this.kind === "empty-output") attach(this, create(Flag.Transient, Flag.EmptyResponse));
		else if (this.kind === "incomplete-stream" || this.kind === "empty-body") attach(this, create(Flag.Transient));
	}
}

/** The caller-visible line for a provider refusal: `Refusal (<code>): <provider message>`. */
export function formatRefusalMessage(code: string, explanation: string): string {
	return `Refusal (${code}): ${explanation}`;
}

/**
 * The provider declined the request's content under its usage policy — a
 * refusal, not a failed call. `code` and `explanation` are the provider's own
 * error code and message; the message reads `Refusal (<code>): <explanation>`,
 * the same shape as an Anthropic classifier refusal.
 *
 * It never rotates credentials: the content, not the account, was refused.
 */
export class ProviderRefusalError extends ProviderResponseError {
	readonly code: string;
	readonly explanation: string;

	constructor(code: string, explanation: string, options: Omit<ProviderResponseErrorOptions, "kind"> = {}) {
		super(formatRefusalMessage(code, explanation), { ...options, kind: "content-blocked" });
		this.name = "ProviderRefusalError";
		this.code = code;
		this.explanation = explanation;
	}
}

/** `stopDetails` of a provider refusal: the provider's own error code and message. */
export type RefusalStopDetails = StopDetails & { type: "refusal"; category: string; explanation: string };

/**
 * The `stopDetails` a provider catch block records for a content-policy
 * refusal anywhere in `error`'s cause chain — a streamed
 * {@link ProviderRefusalError}, a non-2xx OpenAI-wire body whose code is a
 * refusal code, or any other provider error carrying such a code (Codex's
 * HTTP error, an in-band stream error) — as
 * `{ type: "refusal", category: <code>, explanation: <message> }`.
 */
export function contentPolicyRefusalDetails(error: unknown): RefusalStopDetails | undefined {
	const seen = new Set<Error>();
	let link = error;
	while (link instanceof Error && !seen.has(link)) {
		seen.add(link);
		if (link instanceof ProviderRefusalError) {
			return { type: "refusal", category: link.code, explanation: link.explanation };
		}
		if (link instanceof OpenAIHttpError) {
			const { detail, code } = OpenAIHttpError.parseEnvelope(link.captured.bodyJson, link.captured.bodyText);
			if (code !== undefined && isContentPolicyRefusal(code, detail)) {
				return { type: "refusal", category: code, explanation: detail ?? link.message };
			}
		} else {
			const code: unknown = Reflect.get(link, "code");
			// The provider's own sentence, not a label the transport put in its place: a Codex
			// rate-limit message replacing an eligibility denial's wording would read as a content
			// refusal and stop rotating to the sibling account that can serve it.
			const own: unknown = Reflect.get(link, "providerMessage");
			const message = typeof own === "string" && own.length > 0 ? own : link.message;
			if (typeof code === "string" && isContentPolicyRefusal(code, message)) {
				return { type: "refusal", category: code, explanation: message };
			}
		}
		link = link.cause;
	}
	return undefined;
}

/** The part of a failed assistant turn {@link isProviderRefusal} reads. */
type RefusedTurn = Pick<AssistantMessage, "stopReason" | "stopDetails">;

function isAssistantTurn(value: unknown): value is RefusedTurn {
	return typeof value === "object" && value !== null && "stopReason" in value && "role" in value;
}

/**
 * Whether an upstream failure — a thrown error or a failed assistant turn — is
 * a provider refusal of the request's content. Credential rotation must skip
 * it whatever HTTP status carried it: every sibling account sends the same content.
 */
export function isContentPolicyRefusalError(error: unknown): boolean {
	if (isAssistantTurn(error)) return isProviderRefusal(error);
	return contentPolicyRefusalDetails(error) !== undefined;
}

/** Non-2xx response from the Devin API. */
export class DevinApiError extends ProviderHttpError {
	override readonly name = "DevinApiError";
}

/** Non-2xx response from the GitLab Duo direct-access API. */
export class GitLabDuoApiError extends ProviderHttpError {
	override readonly name = "GitLabDuoApiError";
}

/** Non-2xx response from the GitLab Duo Workflow API. */
export class GitLabDuoWorkflowApiError extends ProviderHttpError {
	override readonly name = "GitLabDuoWorkflowApiError";
}
