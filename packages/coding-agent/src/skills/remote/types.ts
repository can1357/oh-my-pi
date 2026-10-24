/**
 * Remote skill sources.
 *
 * A remote skill is discovered from a local descriptor index and loaded from a
 * pinned provider revision on demand. The descriptor is the only thing present
 * before first use: discovery never touches the network.
 */

/** Error codes surfaced to callers and the model. Keep stable: they are user-facing. */
export type RemoteSkillErrorCode =
	| "INVALID_SOURCE"
	| "INVALID_SKILL"
	| "AUTH_REQUIRED"
	| "ACCESS_DENIED"
	| "NOT_FOUND"
	| "RATE_LIMITED"
	| "NETWORK"
	| "PATH_DENIED"
	| "RESOURCE_LIMIT_EXCEEDED"
	| "OFFLINE_RESOURCE_MISSING";

export class RemoteSkillError extends Error {
	readonly code: RemoteSkillErrorCode;

	constructor(code: RemoteSkillErrorCode, message: string, options?: ErrorOptions) {
		super(`${code}: ${message}`, options);
		this.name = "RemoteSkillError";
		this.code = code;
	}
}

/** Source location of one skill: a GitHub repository subdirectory at an immutable commit. */
export interface RemoteSkillSource {
	readonly origin: "github";
	/** `owner/repo`. */
	readonly repository: string;
	/** Skill root relative to the repository root, POSIX separators (e.g. `skills/pdf`). */
	readonly directory: string;
	/** Resolved provider revision. Empty only for an unresolved descriptor (never persisted). */
	readonly commit: string;
}

/** Index entry: discovery metadata plus the pinned source. */
export interface RemoteSkillDescriptor extends RemoteSkillSource {
	readonly name: string;
	readonly description: string;
	/** Ref as configured (`main`, a tag, or a commit id). Re-resolved by `sync`. */
	readonly ref: string;
}

export interface RemoteSkillIndex {
	readonly version: 1;
	readonly skills: Readonly<Record<string, RemoteSkillDescriptor>>;
}

export const EMPTY_REMOTE_SKILL_INDEX: RemoteSkillIndex = { version: 1, skills: {} };
