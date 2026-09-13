import type { Model } from "@oh-my-pi/pi-ai";
import type { Dialect } from "@oh-my-pi/pi-ai/dialect";
import { FALLBACK_DIALECT, preferredDialect } from "@oh-my-pi/pi-catalog/identity";

/** Effective `tools.format` values: auto-detect, force native, or force a named owned dialect. */
export type DialectFormat = "auto" | "native" | Dialect;

/**
 * Resolves `tools.format` plus the active model into the agent's owned-dialect
 * field: `undefined` means provider-native tool calling.
 *
 * Lives in `config/` rather than beside its `sdk.ts` construction site because
 * the settings reconciliation in `AgentSession` must resolve the SAME way when
 * `tools.format` moves on disk, and importing `sdk.ts` from a session module
 * would close an import cycle.
 */
export function resolveDialect(
	format: DialectFormat,
	model: (Pick<Model, "supportsTools"> & Partial<Pick<Model, "id">>) | undefined,
): Dialect | undefined {
	if (format === "native") return undefined;
	if (format === "auto") {
		if (model?.supportsTools !== false) return undefined;
		if (!model.id) return "glm";
		const preferred = preferredDialect(model.id);
		return preferred === FALLBACK_DIALECT ? "glm" : preferred;
	}
	return format;
}
