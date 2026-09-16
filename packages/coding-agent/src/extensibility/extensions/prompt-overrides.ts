/**
 * Process-wide registry for extension-provided prompt template overrides.
 *
 * Prompt templates (system prompt, subagent prompts, agent ROLE bodies, tool
 * descriptions) are model-facing content — deliberately kept separate from the
 * UI string registry. Extensions register a stable prompt ID (e.g. `system`,
 * `subagent.system`, `agent.task`, `tools.bash`) mapped to either:
 *
 * - `full`: a complete replacement template, or
 * - `transform`: a function applied to the built-in template text.
 *
 * `full` takes precedence over `transform` when both are registered for the
 * same ID; later registrations replace earlier ones. The resolver returns the
 * built-in text unchanged when nothing is registered, so the default pipeline
 * is untouched without plugins.
 */

/** One registered prompt override. */
export interface PromptOverride {
  id: string;
  /** Complete template replacement (applied verbatim before render). */
  full?: string;
  /** Text transformation applied to the built-in template. */
  transform?: (source: string) => string;
}

/** Internal registry shape: prompt ID -> override (full/transform). */
type StoredOverride = {
  full?: string;
  transform?: (source: string) => string;
};

const registry = new Map<string, StoredOverride>();

/** Per-extension tracking so one extension's contributions can be flushed atomically. */
const tracked = new Map<string /* extensionPath */, Set<string>>();

/**
 * Register prompt template overrides for one extension.
 *
 * Later registrations for the same prompt ID replace earlier ones (UI
 * registry convention). Empty IDs are skipped.
 */
export function registerPromptOverrides(registration: { overrides: PromptOverride[] }, extensionPath: string): void {
	const keys = tracked.get(extensionPath) ?? new Set<string>();
	for (const override of registration.overrides) {
		const { id, full, transform } = override;
		if (!id) continue;
		registry.set(id, { full, transform });
		keys.add(id);
	}
	tracked.set(extensionPath, keys);
}

/**
 * Clear every prompt override registered by one extension (reload/teardown).
 */
export function clearPromptOverridesFor(extensionPath: string): void {
	const keys = tracked.get(extensionPath);
	if (!keys) return;
	for (const key of keys) registry.delete(key);
	keys.clear();
	tracked.delete(extensionPath);
}

/** Clear the entire prompt override registry (global teardown). */
export function clearAllPromptOverrides(): void {
	registry.clear();
	tracked.clear();
}

/**
 * Resolve a prompt template source: look up the override first, fall back to
 * `builtin`. `full` wins over `transform`; a throwing transform degrades to
 * the built-in template.
 */
export function resolvePromptSource(id: string, builtin: string): string {
	const override = registry.get(id);
	if (!override) return builtin;
	if (override.full !== undefined) return override.full;
	if (override.transform) {
		try {
			return override.transform(builtin);
		} catch {
			return builtin;
		}
	}
	return builtin;
}

/** Whether a prompt override is registered for the given ID. */
export function hasPromptOverride(id: string): boolean {
	return registry.has(id);
}
