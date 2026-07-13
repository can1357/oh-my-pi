/**
 * MSI-local environments-cloud (pkscloudenvs) root resolution and mesh handoff.
 *
 * Phase-1 Docker remote-workspace remains the local sandbox job runner.
 * Cloud / mesh / auth / codespace-style launch SoT is the external checkout:
 *   C:\dev\desktop-infra\environments-cloud  (github.com/kingkillery/pkscloudenvs)
 *
 * Pure path logic is unit-testable without live mesh nodes. Shell execution is
 * left to the operator or `ompk-remote environments handoff` printouts.
 */

import * as path from "node:path";

/** Literal MSI-local canonical root for pkscloudenvs on this operator machine. */
export const MSI_ENVIRONMENTS_CLOUD_ROOT = "C:\\dev\\desktop-infra\\environments-cloud";

/** Override env for non-default checkouts or CI fixtures. */
export const ENVIRONMENTS_CLOUD_ROOT_ENV = "OMPK_ENVIRONMENTS_CLOUD_ROOT";

/** Secondary override accepted for scripts that already use the PKS prefix. */
export const PKS_ENVIRONMENTS_CLOUD_ROOT_ENV = "PKS_ENVIRONMENTS_CLOUD_ROOT";

/** Upstream orchestration SoT identity. */
export const ENVIRONMENTS_CLOUD_SOT = {
	name: "environments-cloud",
	repo: "pkscloudenvs",
	github: "https://github.com/kingkillery/pkscloudenvs",
	msiCanonicalRoot: MSI_ENVIRONMENTS_CLOUD_ROOT,
} as const;

/** Skills shipped under environments-cloud `.agents/skills/` for mesh/cloud work. */
export const ENVIRONMENTS_CLOUD_SKILLS = ["mesh-orchestrator", "colab-warmup"] as const;

export type EnvironmentsCloudSkillName = (typeof ENVIRONMENTS_CLOUD_SKILLS)[number] | (string & {});

/** Mesh / cloud CLI entrypoints under `.agents/bin/`. */
export const MESH_ENTRYPOINTS = {
	mesh: {
		bin: "mesh",
		description: "Interactive mesh status, warmup, and routing dashboard",
	},
	"mesh-run": {
		bin: "mesh-run",
		description: "Dispatch a command to a mesh node (msi-1, mac, pi, hetzner, colab)",
	},
	cloud: {
		bin: "cloud",
		description: "Cloud research, ultraresearch, verifier loops, status, logs, artifacts",
	},
	"mesh-sync": {
		bin: "mesh-sync",
		description: "Encrypted worktree archive push/pull/gc",
	},
	"mesh-ci": {
		bin: "mesh-ci",
		description: "Self-hosted polling CI for origin/main SHAs",
	},
	colab: {
		bin: "colab",
		description: "WSL-forwarded Google Colab CLI wrapper",
	},
	"colab-kill-all": {
		bin: "colab-kill-all",
		description: "Terminate all active Colab sessions",
	},
} as const;

export type MeshEntrypoint = keyof typeof MESH_ENTRYPOINTS;

export type EnvironmentsCloudResolveOptions = {
	/** Env map; defaults to `process.env`. Used for pure unit tests. */
	env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
	/** Explicit root; when set, skips env and MSI default. */
	root?: string;
	/** Platform for bin extension selection; defaults to `process.platform`. */
	platform?: NodeJS.Platform;
};

function envLookup(env: NodeJS.ProcessEnv | Record<string, string | undefined>, key: string): string | undefined {
	const value = env[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the environments-cloud (pkscloudenvs) root.
 *
 * Precedence: explicit `root` option → `OMPK_ENVIRONMENTS_CLOUD_ROOT` →
 * `PKS_ENVIRONMENTS_CLOUD_ROOT` → MSI canonical path.
 */
export function resolveEnvironmentsCloudRoot(options: EnvironmentsCloudResolveOptions = {}): string {
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

/** `.agents/skills` under the resolved environments-cloud root. */
export function resolveEnvironmentsCloudSkillsRoot(options: EnvironmentsCloudResolveOptions = {}): string {
	return path.join(resolveEnvironmentsCloudRoot(options), ".agents", "skills");
}

/** `.agents/bin` under the resolved environments-cloud root. */
export function resolveEnvironmentsCloudBinRoot(options: EnvironmentsCloudResolveOptions = {}): string {
	return path.join(resolveEnvironmentsCloudRoot(options), ".agents", "bin");
}

/**
 * Session/skill routing target for `skills.customDirectories` (and agent skill sync).
 * Point OMPK skill discovery at environments-cloud skills so mesh-orchestrator / colab-warmup
 * are findable without guessing a path.
 */
export function environmentsCloudSkillCustomDirectories(options: EnvironmentsCloudResolveOptions = {}): string[] {
	return [resolveEnvironmentsCloudSkillsRoot(options)];
}

export type EnvironmentsCloudSkillRoute = {
	root: string;
	skillsRoot: string;
	skillName: string;
	skillDir: string;
	skillMd: string;
	/** True when this is a known environments-cloud mesh/cloud skill name. */
	known: boolean;
};

/**
 * Resolve a mesh/cloud skill directory under environments-cloud.
 * Does not read the filesystem — pure path composition for routing and tests.
 */
export function resolveEnvironmentsCloudSkill(
	skillName: string,
	options: EnvironmentsCloudResolveOptions = {},
): EnvironmentsCloudSkillRoute {
	const name = skillName.trim();
	if (!name) {
		throw new Error("skillName must be non-empty");
	}
	const root = resolveEnvironmentsCloudRoot(options);
	const skillsRoot = resolveEnvironmentsCloudSkillsRoot(options);
	const skillDir = path.join(skillsRoot, name);
	return {
		root,
		skillsRoot,
		skillName: name,
		skillDir,
		skillMd: path.join(skillDir, "SKILL.md"),
		known: (ENVIRONMENTS_CLOUD_SKILLS as readonly string[]).includes(name),
	};
}

export type MeshHandoff = {
	root: string;
	entrypoint: MeshEntrypoint;
	description: string;
	/** Absolute path to the preferred launcher under `.agents/bin`. */
	binPath: string;
	/** Absolute path to the Python implementation (always present for mesh/cloud tools). */
	scriptPath: string;
	/** Suggested argv for spawning (Windows: `.cmd`; elsewhere: `python` + `.py`). */
	argv: string[];
	/** Working directory for handoff processes. */
	cwd: string;
	/** Operator-facing purpose of this handoff (auth / launch / status). */
	purpose: string;
};

const HANDOFF_PURPOSE: Record<MeshEntrypoint, string> = {
	mesh: "mesh status, interactive routing, and Colab warmup menu",
	"mesh-run": "codespace-style remote command dispatch on a mesh node",
	cloud: "cloud auth/status, research loops, and artifact inspection",
	"mesh-sync": "encrypted workspace sync for remote agent worktrees",
	"mesh-ci": "local mesh CI against origin/main",
	colab: "Colab session auth and lifecycle (WSL on Windows)",
	"colab-kill-all": "tear down all Colab sessions",
};

function isMeshEntrypoint(value: string): value is MeshEntrypoint {
	return Object.hasOwn(MESH_ENTRYPOINTS, value);
}

/**
 * Build a thin handoff descriptor for pkscloudenvs mesh/cloud entrypoints.
 * Callers print or spawn `argv`; this function does not execute anything.
 */
export function resolveMeshHandoff(
	entrypoint: string,
	args: readonly string[] = [],
	options: EnvironmentsCloudResolveOptions = {},
): MeshHandoff {
	const key = entrypoint.trim();
	if (!isMeshEntrypoint(key)) {
		const known = Object.keys(MESH_ENTRYPOINTS).join(", ");
		throw new Error(`Unknown mesh entrypoint "${entrypoint}". Known: ${known}`);
	}
	const root = resolveEnvironmentsCloudRoot(options);
	const binRoot = resolveEnvironmentsCloudBinRoot(options);
	const meta = MESH_ENTRYPOINTS[key];
	const platform = options.platform ?? process.platform;
	const scriptPath = path.join(binRoot, `${meta.bin}.py`);
	const cmdPath = path.join(binRoot, `${meta.bin}.cmd`);
	const binPath = platform === "win32" ? cmdPath : scriptPath;
	const argv = platform === "win32" ? [cmdPath, ...args] : ["python3", scriptPath, ...args];
	return {
		root,
		entrypoint: key,
		description: meta.description,
		binPath,
		scriptPath,
		argv,
		cwd: root,
		purpose: HANDOFF_PURPOSE[key],
	};
}

export type EnvironmentsCloudRouteSummary = {
	sot: typeof ENVIRONMENTS_CLOUD_SOT;
	root: string;
	skillsRoot: string;
	binRoot: string;
	skillCustomDirectories: string[];
	skills: EnvironmentsCloudSkillRoute[];
	entrypoints: MeshEntrypoint[];
	/** Reminder: phase-1 Docker remote-workspace is not the mesh orchestrator. */
	localSandboxNote: string;
};

/** Aggregate discovery summary for CLI and session routing dumps. */
export function summarizeEnvironmentsCloudRoute(
	options: EnvironmentsCloudResolveOptions = {},
): EnvironmentsCloudRouteSummary {
	const root = resolveEnvironmentsCloudRoot(options);
	return {
		sot: ENVIRONMENTS_CLOUD_SOT,
		root,
		skillsRoot: resolveEnvironmentsCloudSkillsRoot(options),
		binRoot: resolveEnvironmentsCloudBinRoot(options),
		skillCustomDirectories: environmentsCloudSkillCustomDirectories(options),
		skills: ENVIRONMENTS_CLOUD_SKILLS.map(name => resolveEnvironmentsCloudSkill(name, options)),
		entrypoints: Object.keys(MESH_ENTRYPOINTS) as MeshEntrypoint[],
		localSandboxNote:
			"OMPK packages/remote-workspace phase-1 Docker jobs are local sandboxes only; mesh/cloud/auth/launch SoT is environments-cloud (pkscloudenvs).",
	};
}
