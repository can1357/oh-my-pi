/**
 * Error raised for invalid, unsupported, or unsafe archive input. The message
 * is safe to surface directly to users/models; callers that need a different
 * error taxonomy (e.g. the coding agent's `ToolError`) match on this class.
 */
export class ArchiveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArchiveError";
	}
}
