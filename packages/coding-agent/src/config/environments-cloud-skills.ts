/**
 * Session/skill routing to MSI-local environments-cloud (pkscloudenvs).
 *
 * Mesh/cloud skills (mesh-orchestrator, colab-warmup, …) live under the
 * external SoT checkout — not inside the OMPK monorepo. loadSkills() merges
 * that skills root into customDirectories when the directory exists.
 *
 * Canonical root: C:\dev\desktop-infra\environments-cloud
 * Override: OMPK_ENVIRONMENTS_CLOUD_ROOT or PKS_ENVIRONMENTS_CLOUD_ROOT
 *
 * Path resolution is pure (unit-testable). Presence is checked separately.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Literal MSI-local canonical root for pkscloudenvs. */
export const MSI_ENVIRONMENTS_CLOUD_ROOT = "C:\\dev\\desktop-infra\\environments-cloud";

export const ENVIRONMENTS_CLOUD_ROOT_ENV = "OMPK_ENVIRONMENTS_CLOUD_ROOT";
export const PKS_ENVIRONMENTS_CLOUD_ROOT_ENV = "PKS_ENVIRONMENTS_CLOUD_ROOT";

export type EnvironmentsCloudSkillsResolveOptions = {
	env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
	/** Explicit root; when set, skips env and MSI default. */
	root?: string;
};

function envLookup(env: NodeJS.ProcessEnv | Record<string, string | undefined>, key: string): string | undefined {
	const value = env[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve environments-cloud root.
 * Precedence: explicit root → OMPK_ENVIRONMENTS_CLOUD_ROOT → PKS_ENVIRONMENTS_CLOUD_ROOT → MSI path.
 */
export function resolveEnvironmentsCloudRoot(options: EnvironmentsCloudSkillsResolveOptions = {}): string {
	if (options.root !== undefined && options.root.trim().length > 0) {
		return path.resolve(options.root.trim());
	}
	const env = options.env ?? process.env;
	const override = envLookup(env, ENVIRONMENTS_CLOUD_ROOT_ENV) ?? envLookup(env, PKS_ENVIRONMENTS_CLOUD_ROOT_ENV);
	if (override) {
		return path.resolve(override);
	}
	return MSI_ENVIRONMENTS_CLOUD_ROOT;
}

/** `{root}/.agents/skills` under the resolved environments-cloud root. */
export function resolveEnvironmentsCloudSkillsRoot(options: EnvironmentsCloudSkillsResolveOptions = {}): string {
	return path.join(resolveEnvironmentsCloudRoot(options), ".agents", "skills");
}

/**
 * Merge configured customDirectories with auto-discovered environments-cloud skills roots.
 * Existing configured entries win order; auto entries are appended when not already present
 * (case-insensitive path compare on Windows-friendly normalized form).
 */
export function mergeEnvironmentsCloudSkillDirectories(
	configured: readonly string[],
	auto: readonly string[],
): string[] {
	const out = [...configured];
	const seen = new Set(configured.map(normalizeDirKey));
	for (const dir of auto) {
		const key = normalizeDirKey(dir);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(dir);
	}
	return out;
}

function normalizeDirKey(dir: string): string {
	return path.resolve(dir).replace(/\\/g, "/").toLowerCase();
}

/**
 * Return environments-cloud skills roots that currently exist on disk.
 * Pure path composition + one readdir/stat — empty when checkout is absent.
 */
export async function resolvePresentEnvironmentsCloudSkillDirectories(
	options: EnvironmentsCloudSkillsResolveOptions = {},
): Promise<string[]> {
	const skillsRoot = resolveEnvironmentsCloudSkillsRoot(options);
	try {
		const st = await fs.stat(skillsRoot);
		if (!st.isDirectory()) return [];
		return [skillsRoot];
	} catch {
		return [];
	}
}
