import type { MemoryBackend } from "./types";

/**
 * No-op memory backend.
 *
 * Selected when `memory.backend` is `"off"`.
 */
export const offBackend: MemoryBackend = {
	id: "off",
	async start() {},
	async buildDeveloperInstructions() {
		return undefined;
	},
	async clear() {},
	async enqueue() {},
	async status() {
		return {
			backend: "off" as const,
			active: false,
			writable: false,
			searchable: false,
			message: "Memory backend is off.",
		};
	},
};
