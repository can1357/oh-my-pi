import { coreWeaveProjectHeaders } from "@oh-my-pi/pi-catalog/wire/coreweave";
import { $env } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";

const PROJECT_PERSIST_INSTRUCTIONS =
	"add export COREWEAVE_PROJECT=<team>/<project> to your shell startup file (for example ~/.zshrc, ~/.bashrc, or your shell's profile/rc file)";

export function requireCoreWeaveProjectHeaders(): Record<string, string> {
	const headers = coreWeaveProjectHeaders($env);
	if (!headers) {
		throw new AIError.ConfigurationError(
			`CoreWeave Serverless Inference requires OpenAI-Project. Set COREWEAVE_PROJECT=<team>/<project> before running /login coreweave. To persist it, ${PROJECT_PERSIST_INSTRUCTIONS}.`,
		);
	}
	return headers;
}
