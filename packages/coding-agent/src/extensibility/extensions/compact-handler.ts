/**
 * Helper for wiring the `compact` action of an {@link ExtensionContext}.
 *
 * Extension-facing APIs accept `string | CompactOptions`, but `AgentSession.compact`
 * takes two positional arguments `(instructions, options)`. This helper splits the
 * union so the same adapter can be reused by print-mode, rpc-mode, and the executor.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { CompactOptions, SetModelOptions } from "./types";

interface CompactableSession {
	compact(instructions?: string, options?: CompactOptions): Promise<unknown>;
}

export async function runExtensionCompact(
	session: CompactableSession,
	instructionsOrOptions: string | CompactOptions | undefined,
): Promise<void> {
	const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
	const options =
		instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
	await session.compact(instructions, options);
}

interface SetModelCapableSession {
	modelRegistry: { getApiKey(model: Model): Promise<string | undefined> };
	setModel(model: Model, role?: string): Promise<unknown>;
	setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void>;
}

/**
 * Helper for wiring the `setModel` action of an {@link ExtensionContext}.
 *
 * Returns false when no API key is available for the requested model.
 */
export async function runExtensionSetModel(
	session: SetModelCapableSession,
	model: Model,
	options?: SetModelOptions,
): Promise<boolean> {
	const key = await session.modelRegistry.getApiKey(model);
	if (!key) return false;
	if (options?.ephemeral) {
		await session.setModelTemporary(model, undefined, { ephemeral: true });
	} else {
		await session.setModel(model, options?.role ?? "default");
	}
	return true;
}
