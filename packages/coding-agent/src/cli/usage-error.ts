/** Command-line input error that should be rendered without a stack trace. */
export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}
