/**
 * A session cannot start in an isolation workspace that nothing would keep
 * for it: one being torn down, or one whose owner marker cannot be read. The
 * message names the workspace and what the user can do, and the CLI prints it
 * without a stack trace. Kept free of imports so the CLI entry can recognise
 * it without loading the isolation graph.
 */
export class IsolationWorkspaceUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IsolationWorkspaceUnavailableError";
	}
}
