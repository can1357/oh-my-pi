import type { TaskToolDetails } from "./types";

export function isTaskToolDetails(value: unknown): value is TaskToolDetails {
	return value !== null && typeof value === "object" && "results" in value && Array.isArray(value.results);
}
