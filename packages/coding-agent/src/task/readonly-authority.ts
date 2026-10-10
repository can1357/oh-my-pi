import type { Tool } from "../tools";

/** Issued by a trusted parent hook, never by task arguments or serialized history. */
export interface ReadonlySubagentGrant {
	readonly parentSessionId: string;
	readonly scopeRoot: string;
	/** The host supplies the actual child session binding, not model metadata. */
	authorize(binding: ReadonlySubagentBinding): Promise<boolean>;
}

export interface ReadonlySubagentBinding {
	readonly parentSessionId: string;
	readonly childSessionId: string;
	readonly scopeRoot: string;
}

/** Only these native tools can be constructed under delegated read authority. */
export const READONLY_SUBAGENT_TOOLS: Readonly<Record<string, true>> = { bash: true, eval: true, yield: true };

export interface BoundReadonlySubagent {
	readonly binding: ReadonlySubagentBinding;
	validate(): Promise<boolean>;
	createTools(names: readonly string[]): Promise<Tool[]>;
	dispose(): Promise<void>;
}
