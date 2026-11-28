/** Saved models were exhausted without permission to substitute another model. */
export class SessionModelRestoreError extends Error {
	constructor(modelSelector: string) {
		super(`Could not restore model ${modelSelector}`);
		this.name = "SessionModelRestoreError";
	}
}
