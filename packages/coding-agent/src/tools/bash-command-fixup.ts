/**
 * Conservative transforms applied to a bash command before execution.
 *
 * Two fixups are applied, each anchored to the end of a top-level segment
 * (segments split on `;`, `&&`, `||`, and background `&`):
 *
 *  1. Trailing `| head [args]` / `| tail [args]` (and the `|&` variant) — these
 *     pipes exist purely to limit output length. The harness already truncates
 *     bash output and exposes the full result via an artifact, so they only
 *     hide content the agent wanted.
 *
 *  2. A redundant trailing `2>&1` left on a segment that has no remaining pipe
 *     or other redirect. The harness already merges stderr into stdout, so the
 *     duplication is purely cosmetic — and often a leftover after fixup (1)
 *     drops a downstream pipe.
 *
 * The heavy lifting (tokenization, quoting, heredoc handling, command
 * substitution, nested compound commands) lives in Rust under
 * `pi_shell::fixup`, driven by the real `brush-parser` AST. This module is a
 * thin sync wrapper plus user-facing notice formatting.
 */
import { applyBashFixups as nativeApplyBashFixups } from "@pk-nerdsaver-ai/pi-natives";
import type { ResolvedToolProfile } from "./tool-profiles";

export interface BashFixupResult {
	/** Possibly-rewritten command. */
	command: string;
	/** Substrings that were stripped, in the order they were removed. */
	stripped: string[];
}

/**
 * Apply both fixups to a bash command. On any parse failure, multi-line input,
 * or no-op transform, returns the input verbatim with `stripped: []`.
 */
export function applyBashFixups(command: string): BashFixupResult {
	return nativeApplyBashFixups(command);
}

export interface BashHeredocAdmissionResult {
	readonly allow: boolean;
	readonly reasonCode: "allow" | "windows-heredoc-rejected" | "soft-spot-unenforced";
	readonly recoveryHint?: string;
}

/**
 * Bound/procedural Windows profiles should reject confirmed heredocs before
 * execution with recovery guidance `write script file -> execute file`.
 */
export function shouldEnforceWindowsHeredocDiscipline(
	profile: ResolvedToolProfile | undefined | null,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "win32") return false;
	if (!profile) return false;
	return profile.autonomy === "bound" || profile.tier === "light" || profile.tier === "mid";
}

// SOFT-SPOT(WIN-HEREDOC-PARSER): native shell parser exposes fixup but no safe heredoc predicate; prompt guidance remains until the native API is extended.
export function admitWindowsHeredocCommand(
	_command: string,
	profile?: ResolvedToolProfile | null,
	platform: NodeJS.Platform = process.platform,
): BashHeredocAdmissionResult {
	if (!shouldEnforceWindowsHeredocDiscipline(profile, platform)) {
		return { allow: true, reasonCode: "allow" };
	}

	// Parser-backed rejection is unavailable on the owned native surface.
	// Unrestricted profiles and safe multiline commands remain unblocked.
	return {
		allow: true,
		reasonCode: "soft-spot-unenforced",
		recoveryHint: "write script file -> execute file",
	};
}
