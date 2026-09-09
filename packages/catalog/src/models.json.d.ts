import type { Api } from "./types";

/** Typed declaration for the generated models.json — only the `api` field matters for type inference. */
declare const models: {
	[provider: string]: {
		[modelId: string]: { readonly api: Api; [key: string]: unknown };
	};
};
export default models;
