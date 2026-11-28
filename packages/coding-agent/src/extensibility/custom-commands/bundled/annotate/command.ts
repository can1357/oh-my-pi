import type { CustomCommand, CustomCommandAPI, CustomCommandContext } from "../../types";
import type * as Runtime from "./index";

/** Metadata advertised at startup; the annotation UI loads on completion or execution. */
export class AnnotateCommand implements CustomCommand {
	readonly name = "annotate";
	readonly description = "Annotate a diff or text from a file, prompt, latest reply, or session";
	#runtime: Runtime.AnnotationRuntime | undefined;

	constructor(private readonly api: CustomCommandAPI) {}

	/** Complete annotation arguments using the command's file picker. */
	async getArgumentCompletions(argumentPrefix: string, cwd: string) {
		return this.#load().getArgumentCompletions(argumentPrefix, cwd);
	}

	/** Run annotation against the current session using the original argument text. */
	async execute(args: string[], ctx: CustomCommandContext, rawArgs?: string): Promise<string | undefined> {
		return this.#load().execute(args, ctx, rawArgs);
	}

	#load(): Runtime.AnnotationRuntime {
		if (!this.#runtime) {
			// A literal, lazy Bun require also keeps this command available in compiled builds.
			const { AnnotationRuntime }: typeof Runtime = require("./index");
			this.#runtime = new AnnotationRuntime(this.api);
		}
		return this.#runtime;
	}
}
