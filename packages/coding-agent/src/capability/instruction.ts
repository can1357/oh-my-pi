/**
 * Instructions Capability
 *
 * GitHub Copilot-style instructions with optional file pattern matching.
 */

import { defineCapability } from "./index";
import type { SourceMeta } from "./types";

/**
 * An instruction with optional file pattern matching.
 */
export interface Instruction {
	/** Instruction name (derived from filename) */
	name: string;
	/** Absolute path to instruction file */
	path: string;
	/** Instruction content (markdown) */
	content: string;
	/** Glob pattern for files this applies to */
	applyTo?: string;
	/** Source metadata */
	_source: SourceMeta;
}

export const instructionCapability = defineCapability<Instruction>({
	id: "instructions",
	displayName: "Instructions",
	description: "File-specific instructions with glob pattern matching (GitHub Copilot format)",
	key: (inst) => inst.name,
	validate: (inst) => {
		if (!inst.name) return "Missing name";
		if (!inst.path) return "Missing path";
		if (inst.content === undefined) return "Missing content";
		return undefined;
	},
});
