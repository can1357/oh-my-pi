import type { TaskToolDetails } from "./task";

/**
 * Tests whether a persisted tool result carries a task snapshot. Kept apart from
 * `./task` so session export can check details without loading the renderer.
 */
export function isTaskToolDetails(value: unknown): value is TaskToolDetails {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		"results" in (value as TaskToolDetails) &&
		Array.isArray((value as TaskToolDetails).results)
	);
}
