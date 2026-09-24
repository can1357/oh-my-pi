import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, isEnoent, ptree, withFileLock, writeRuntimeManifest } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { resolveExecutablePath } from "../../subprocess/worker-client";
import { normalizePackageRequirements } from "../package-requirements";

/** Filesystem target used for explicit JavaScript eval dependencies. */
export type JsPackageEnvironmentMode = "managed" | "project";

/** Resolved package-manager target and runtime module fallback. */
export interface JsPackageEnvironment {
	mode: JsPackageEnvironmentMode;
	/** Directory owning package.json, bun.lock, and node_modules. */
	root: string;
	/** Fallback module-resolution root consulted after the importing file's own project. */
	packageRoot?: string;
	description: string;
}

/** Inputs for one host-side Bun dependency reconciliation. */
export interface InstallJsPackagesOptions {
	cwd: string;
	packages: readonly string[];
	environment?: JsPackageEnvironmentMode;
	autoProvision: boolean;
	signal?: AbortSignal;
}

/** Selected environment plus an optional model-visible reconciliation notice. */
export interface JsPackageInstallResult {
	environment: JsPackageEnvironment;
	summary?: string;
}

const DEPENDENCY_SUMMARY_LIMIT = 32;
const LOCK_ATTEMPTS = 6_000;
const LOCK_RETRY_MS = 100;

function projectRoot(cwd: string): string {
	try {
		return fs.realpathSync(cwd);
	} catch {
		return path.resolve(cwd);
	}
}

function projectLockPath(cwd: string): string {
	const projectKey = Bun.hash(path.resolve(cwd)).toString(16).padStart(16, "0");
	return path.join(getAgentDir(), "cache", "eval-js", "project-locks", projectKey);
}

/** Resolve the shared project package root without creating files. */
export function resolveJsPackageEnvironment(
	cwd: string,
	mode: JsPackageEnvironmentMode = "managed",
): JsPackageEnvironment {
	const project = projectRoot(cwd);
	if (mode === "project") {
		return { mode, root: project, packageRoot: project, description: `project environment at ${project}` };
	}
	const key = Bun.hash(project).toString(16).padStart(16, "0");
	const root = path.join(getAgentDir(), "cache", "eval-js", "environments", key);
	return { mode, root, packageRoot: root, description: `OMP-managed environment at ${root}` };
}

async function ensureManagedManifest(
	environment: JsPackageEnvironment,
	autoProvision: boolean,
	signal: AbortSignal | undefined,
): Promise<void> {
	const manifest = path.join(environment.root, "package.json");
	try {
		await fs.promises.access(manifest);
		return;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if (!autoProvision) {
		throw new ToolError(
			`The ${environment.description} has not been provisioned and eval.autoProvision is disabled. ` +
				"Enable eval.autoProvision or explicitly select %environment project. " +
				"Any existing retained JS worker was left unchanged.",
		);
	}
	signal?.throwIfAborted();
	await writeRuntimeManifest(environment.root, { dependencies: {} });
}

async function currentDependencies(root: string): Promise<string> {
	try {
		const manifest: unknown = await Bun.file(path.join(root, "package.json")).json();
		if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return "none recorded";
		const dependencies = Reflect.get(manifest, "dependencies");
		if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) return "none recorded";
		const names: string[] = [];
		for (const name in dependencies) {
			if (typeof Reflect.get(dependencies, name) === "string") names.push(name);
		}
		names.sort((left, right) => left.localeCompare(right));
		if (names.length === 0) return "none recorded";
		const visible = names.slice(0, DEPENDENCY_SUMMARY_LIMIT).join(", ");
		const omitted = names.length - DEPENDENCY_SUMMARY_LIMIT;
		return omitted > 0 ? `${visible} (+${omitted} more)` : visible;
	} catch {
		return "unavailable (package.json could not be read)";
	}
}

function installFailure(
	environment: JsPackageEnvironment,
	stdout: string,
	stderr: string,
	exitCode: number | null,
): ToolError {
	const exactOutput = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");
	const detail = exactOutput || "Bun produced no diagnostic output.";
	return new ToolError(
		`Bun could not update the ${environment.description} (exit ${exitCode ?? "unknown"}). ` +
			"Any existing retained JS worker was not restarted. " +
			"Lifecycle scripts are disabled for eval installs; packages that require postinstall/native builds must be prepared explicitly outside eval.\n" +
			detail,
	);
}

/**
 * Reconcile explicit JavaScript requirements in a host-owned package
 * environment. The persistent eval worker is deliberately untouched: an
 * install failure or cancellation cannot discard its namespace.
 */
export async function installJsPackages(options: InstallJsPackagesOptions): Promise<JsPackageInstallResult> {
	const mode = options.environment ?? "managed";
	const environment = resolveJsPackageEnvironment(options.cwd, mode);
	const packages = normalizePackageRequirements(options.packages);
	if (packages.length === 0) return { environment };

	const lockPath = mode === "managed" ? `${environment.root}.install` : projectLockPath(environment.root);
	options.signal?.throwIfAborted();
	await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
	return await withFileLock(
		lockPath,
		async () => {
			options.signal?.throwIfAborted();
			if (mode === "managed") await ensureManagedManifest(environment, options.autoProvision, options.signal);
			const result = await ptree.exec(
				[resolveExecutablePath(), "add", "--cwd", environment.root, "--ignore-scripts", ...packages],
				{
					// In a compiled distribution the resolved executable is omp.
					// BUN_BE_BUN re-enters Bun's real package-manager
					// CLI instead of recursively dispatching omp's command parser.
					env: { ...Bun.env, BUN_BE_BUN: "1" },
					signal: options.signal,
					allowNonZero: true,
					stderr: "full",
				},
			);
			if (!result.ok) throw installFailure(environment, result.stdout, result.stderr, result.exitCode);
			options.signal?.throwIfAborted();
			const dependencies = await currentDependencies(environment.root);
			options.signal?.throwIfAborted();
			return {
				environment,
				summary:
					`Bun reconciled ${environment.description}. Current declared dependencies: ${dependencies}. ` +
					"Lifecycle scripts were disabled, so packages requiring native builds/postinstall may not work. " +
					"Already imported modules remain cached in this persistent runtime; use reset to load upgraded package code.",
			};
		},
		{ signal: options.signal, retries: LOCK_ATTEMPTS, retryDelayMs: LOCK_RETRY_MS },
	);
}
