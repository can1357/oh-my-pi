import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $which, isRecord, ptree, sanitizeText } from "@oh-my-pi/pi-utils";
import { CLEANSE_PARSER_KINDS, type CleanseParserKind, parseCleanseDiagnostics } from "./parsers";
import type { CleanseCheckResult, CleanseDiagnostic, CleanseDiagnosticReport, SkippedCleanseCheck } from "./types";

const IGNORED_DIRECTORIES: Record<string, true> = {
	".git": true,
	".hg": true,
	".svn": true,
	".terraform": true,
	".venv": true,
	build: true,
	coverage: true,
	dist: true,
	node_modules: true,
	target: true,
	vendor: true,
};
const MAX_FAILURE_OUTPUT = 12_000;
const DEFAULT_FLUSH_MS = 5_000;
const SHELLCHECK_BATCH_SIZE = 200;

interface CheckerPlan {
	id: string;
	label: string;
	language: string;
	cwd: string;
	executable: string;
	args: string[];
	parser: CleanseParserKind;
	command: string;
	mutates: boolean;
}

interface PlanRequest {
	id: string;
	label: string;
	language: string;
	root: string;
	binaries: string[];
	args: string[];
	parser: CleanseParserKind;
	executable?: string;
	mutates?: boolean;
	/** Skip silently instead of recording a skip when the binary is missing (alternative toolings). */
	optional?: boolean;
}

interface DiscoveryState {
	projectCwd: string;
	files: string[];
	plans: CheckerPlan[];
	skipped: SkippedCleanseCheck[];
	includeTests: boolean;
}

/** Optional checker families enabled for a cleanse run. */
export interface CleanseDiagnosticSuiteOptions {
	includeTests?: boolean;
}

/** Identity and display metadata for one runnable checker. */
export interface CleanseCheckerDescriptor {
	id: string;
	label: string;
	language: string;
	/** Project-relative working directory the checker command runs in. */
	cwd: string;
	command: string;
}

/** Lifecycle notifications for one {@link CleanseDiagnosticSuite.run} pass, used by the CLI status board. */
export interface CleanseCheckerRunEvents {
	onCheckerStart?(checker: CleanseCheckerDescriptor): void;
	/**
	 * New diagnostics parsed from streaming or final checker output. Each
	 * diagnostic is delivered exactly once per run; partial-output batches for
	 * long-running checkers arrive before {@link onCheckerEnd}.
	 */
	onDiagnostics?(checker: CleanseCheckerDescriptor, diagnostics: readonly CleanseDiagnostic[]): void;
	onCheckerEnd?(check: CleanseCheckResult, durationMs: number): void;
}
/** Inputs for one {@link CleanseDiagnosticSuite.run} pass. */
export interface CleanseSuiteRunOptions {
	signal?: AbortSignal;
	events?: CleanseCheckerRunEvents;
	/** Interval between partial-output parses for streaming checkers; default 5s. */
	flushMs?: number;
}

/** Re-runnable checker set discovered from one project snapshot. */
export interface CleanseDiagnosticSuite {
	/** Every discovered checker; unaffected by {@link CleanseDiagnosticSuite.select}. */
	readonly checkers: readonly CleanseCheckerDescriptor[];
	/** Checkers the next {@link CleanseDiagnosticSuite.run} will execute; narrowed by {@link CleanseDiagnosticSuite.select}. */
	readonly selected: readonly CleanseCheckerDescriptor[];
	readonly skipped: readonly SkippedCleanseCheck[];
	/** Narrow subsequent {@link CleanseDiagnosticSuite.run} calls to the named checker ids. */
	select(ids: readonly string[]): void;
	run(options?: CleanseSuiteRunOptions): Promise<CleanseDiagnosticReport>;
}

/** Discover configured language checkers without installing missing tools. */
export async function discoverCleanseDiagnosticSuite(
	projectCwd: string,
	options: CleanseDiagnosticSuiteOptions = {},
): Promise<CleanseDiagnosticSuite> {
	const absoluteCwd = path.resolve(projectCwd);
	const resolvedCwd = await fs.realpath(absoluteCwd).catch(() => absoluteCwd);
	const state: DiscoveryState = {
		projectCwd: resolvedCwd,
		files: await listProjectFiles(resolvedCwd),
		plans: [],
		skipped: [],
		includeTests: options.includeTests === true,
	};
	await discoverRust(state);
	discoverGo(state);
	await discoverPython(state);
	await discoverJavaScript(state);
	discoverRuby(state);
	discoverPhp(state);
	discoverSwift(state);
	discoverDart(state);
	discoverElixir(state);
	discoverShell(state);
	discoverHaskell(state);
	discoverTerraform(state);
	discoverLua(state);
	discoverCpp(state);
	discoverDotnet(state);
	discoverZig(state);
	discoverJvm(state);
	discoverGitHubActions(state);

	return createSuite(resolvedCwd, state.plans, state.skipped, new Set(state.files));
}

function createSuite(
	projectCwd: string,
	plans: readonly CheckerPlan[],
	skipped: SkippedCleanseCheck[],
	allowedFiles: ReadonlySet<string>,
): CleanseDiagnosticSuite {
	let active = [...plans];
	const toDescriptor = (plan: CheckerPlan): CleanseCheckerDescriptor => ({
		id: plan.id,
		label: plan.label,
		language: plan.language,
		cwd: path.relative(projectCwd, plan.cwd) || ".",
		command: plan.command,
	});
	return {
		checkers: plans.map(toDescriptor),
		get selected(): readonly CleanseCheckerDescriptor[] {
			return active.map(toDescriptor);
		},
		skipped,
		select(ids: readonly string[]): void {
			const wanted = new Set(ids);
			active = plans.filter(plan => wanted.has(plan.id));
		},
		async run(options?: CleanseSuiteRunOptions): Promise<CleanseDiagnosticReport> {
			const { signal, events, flushMs = DEFAULT_FLUSH_MS } = options ?? {};
			const execute = async (
				plan: CheckerPlan,
				onDiagnostics?: (diagnostics: readonly CleanseDiagnostic[]) => void,
			): Promise<CleanseCheckResult> => {
				events?.onCheckerStart?.(toDescriptor(plan));
				const startedAt = Date.now();
				const check = await runChecker(plan, projectCwd, allowedFiles, { signal, flushMs, onDiagnostics });
				events?.onCheckerEnd?.(check, Date.now() - startedAt);
				return check;
			};
			// Mutating checkers rewrite files, so their diagnostics are held until
			// every mutator has finished; otherwise a repair worker could edit a
			// file a formatter is still rewriting.
			const mutating = active.filter(plan => plan.mutates);
			const mutatingChecks: CleanseCheckResult[] = [];
			for (const plan of mutating) mutatingChecks.push(await execute(plan));
			if (events?.onDiagnostics) {
				for (let index = 0; index < mutating.length; index += 1) {
					const check = mutatingChecks[index];
					if (check.diagnostics.length > 0) events.onDiagnostics(toDescriptor(mutating[index]), check.diagnostics);
				}
			}
			const parallelChecks = await Promise.all(
				active
					.filter(plan => !plan.mutates)
					.map(plan =>
						execute(
							plan,
							events?.onDiagnostics
								? diagnostics => events.onDiagnostics?.(toDescriptor(plan), diagnostics)
								: undefined,
						),
					),
			);
			const checks = [...mutatingChecks, ...parallelChecks];
			return {
				checks,
				diagnostics: deduplicateProjectDiagnostics(checks.flatMap(check => check.diagnostics)),
				skipped: [...skipped],
			};
		},
	};
}

/** One checker proposed by the prompted discovery agent. */
export interface CustomCleanseCheckerSpec {
	label: string;
	language?: string;
	cwd?: string;
	command: string[];
	parser?: string;
}

/** Build a runnable suite from discovery-agent checker specs, dropping unrunnable entries into `skipped`. */
export async function buildCustomCleanseSuite(
	projectCwd: string,
	specs: readonly CustomCleanseCheckerSpec[],
): Promise<CleanseDiagnosticSuite> {
	const absoluteCwd = path.resolve(projectCwd);
	const resolvedCwd = await fs.realpath(absoluteCwd).catch(() => absoluteCwd);
	const files = await listProjectFiles(resolvedCwd);
	const plans: CheckerPlan[] = [];
	const skipped: SkippedCleanseCheck[] = [];
	for (const [index, spec] of specs.entries()) {
		const [binary, ...args] = spec.command;
		const label = spec.label.trim() || `custom checker ${index + 1}`;
		const language = spec.language?.trim() || "Custom";
		if (!binary) {
			skipped.push({ label, language, reason: "empty command" });
			continue;
		}
		const root = normalizeCustomRoot(resolvedCwd, spec.cwd);
		if (root === undefined) {
			skipped.push({ label, language, reason: `working directory escapes the project: ${spec.cwd}` });
			continue;
		}
		let executable: string | undefined;
		if (/[\\/]/.test(binary)) {
			const candidate = path.resolve(resolvedCwd, root, binary);
			executable = (await Bun.file(candidate).exists()) ? candidate : undefined;
		} else {
			executable = resolveBinary(resolvedCwd, root, [binary]);
		}
		if (!executable) {
			skipped.push({ label, language, reason: `executable not found: ${binary}` });
			continue;
		}
		plans.push({
			id: `custom-${index + 1}`,
			label,
			language,
			cwd: path.resolve(resolvedCwd, root),
			executable,
			args,
			parser: CLEANSE_PARSER_KINDS.find(kind => kind === spec.parser) ?? "generic",
			command: formatCommand([path.basename(executable), ...args]),
			mutates: false,
		});
	}
	return createSuite(resolvedCwd, plans, skipped, new Set(files));
}

function normalizeCustomRoot(projectCwd: string, cwd: string | undefined): string | undefined {
	const trimmed = cwd?.trim();
	if (!trimmed || trimmed === ".") return ".";
	const relative = path.relative(projectCwd, path.resolve(projectCwd, trimmed));
	if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return relative.split(path.sep).join("/") || ".";
}

async function listProjectFiles(cwd: string): Promise<string[]> {
	try {
		const repository = vcs.require(cwd);
		const [tracked, untracked] = await Promise.all([
			repository.lsFiles(false, false),
			repository.lsFiles(true, true),
		]);
		return normalizeFiles([...tracked, ...untracked]);
	} catch {
		const files: string[] = [];
		for await (const entry of new Bun.Glob("**/*").scan({ cwd, absolute: false, dot: true, onlyFiles: true })) {
			const normalized = entry.split(path.sep).join("/");
			if (hasIgnoredDirectory(normalized)) continue;
			files.push(normalized);
		}
		return normalizeFiles(files);
	}
}

function normalizeFiles(files: string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const file of files) {
		const value = file.replaceAll("\\", "/").replace(/^\.\//, "");
		if (!value || hasIgnoredDirectory(value) || seen.has(value)) continue;
		seen.add(value);
		normalized.push(value);
	}
	return normalized.sort();
}
function hasIgnoredDirectory(file: string): boolean {
	for (const segment of file.split("/")) {
		if (IGNORED_DIRECTORIES[segment] || segment.startsWith("bazel-")) return true;
	}
	return false;
}

function markerRoots(files: readonly string[], matches: (file: string, basename: string) => boolean): string[] {
	const roots: string[] = [];
	for (const file of files) {
		if (!matches(file, path.posix.basename(file))) continue;
		roots.push(path.posix.dirname(file));
	}
	return topmostRoots(roots);
}

function topmostRoots(roots: readonly string[]): string[] {
	const sorted = [...new Set(roots)].sort(
		(left, right) =>
			(left === "." ? 0 : left.split("/").length) - (right === "." ? 0 : right.split("/").length) ||
			left.localeCompare(right),
	);
	const selected: string[] = [];
	for (const root of sorted) {
		if (selected.some(parent => root === parent || (parent === "." ? true : root.startsWith(`${parent}/`)))) continue;
		selected.push(root);
	}
	return selected;
}

function containsExtension(files: readonly string[], extensions: readonly string[]): boolean {
	return files.some(file => extensions.some(extension => file.toLowerCase().endsWith(extension)));
}

function rootsForBasenames(files: readonly string[], basenames: Record<string, true>): string[] {
	return markerRoots(files, (_file, basename) => basenames[basename] === true);
}

function rootsForPattern(files: readonly string[], pattern: RegExp): string[] {
	return markerRoots(files, file => pattern.test(file));
}

function resolveBinary(projectCwd: string, root: string, names: readonly string[]): string | undefined {
	const cwd = path.resolve(projectCwd, root);
	const searchDirectories: string[] = [];
	let current = cwd;
	while (true) {
		searchDirectories.push(
			path.join(current, "node_modules", ".bin"),
			path.join(current, ".venv", process.platform === "win32" ? "Scripts" : "bin"),
			path.join(current, "venv", process.platform === "win32" ? "Scripts" : "bin"),
			path.join(current, "vendor", "bin"),
		);
		if (current === projectCwd) break;
		const parent = path.dirname(current);
		if (parent === current || (!parent.startsWith(`${projectCwd}${path.sep}`) && parent !== projectCwd)) break;
		current = parent;
	}
	const searchPath = [...new Set(searchDirectories), Bun.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
	for (const name of names) {
		const executable = $which(name, { cwd, PATH: searchPath });
		if (executable) return executable;
	}
	return undefined;
}

function addPlan(state: DiscoveryState, request: PlanRequest): void {
	const cwd = path.resolve(state.projectCwd, request.root);
	const executable = request.executable ?? resolveBinary(state.projectCwd, request.root, request.binaries);
	const rootLabel = request.root === "." ? "." : request.root;
	if (!executable) {
		if (request.optional) return;
		state.skipped.push({
			label: `${request.label} (${rootLabel})`,
			language: request.language,
			reason: `executable not found: ${request.binaries.join(" or ")}`,
		});
		return;
	}
	const displayExecutable = path.basename(executable);
	state.plans.push({
		id: `${request.id}:${request.root}`,
		label: `${request.label} (${rootLabel})`,
		language: request.language,
		cwd,
		executable,
		args: request.args,
		parser: request.parser,
		command: formatCommand([displayExecutable, ...request.args]),
		mutates: request.mutates ?? false,
	});
}

function formatCommand(argv: readonly string[]): string {
	return argv.map(arg => (/^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(" ");
}

async function discoverRust(state: DiscoveryState): Promise<void> {
	for (const root of rootsForBasenames(state.files, { "Cargo.toml": true })) {
		const cargo = resolveBinary(state.projectCwd, root, ["cargo"]);
		if (!cargo) {
			addPlan(state, {
				id: "clippy",
				label: "cargo clippy",
				language: "Rust",
				root,
				binaries: ["cargo"],
				args: [],
				parser: "rust",
			});
			continue;
		}
		let packages: string[];
		try {
			packages = await cargoWorkspacePackages(state, root, cargo);
		} catch (error) {
			state.skipped.push({
				label: `cargo clippy (${root})`,
				language: "Rust",
				reason: `cargo metadata failed: ${error instanceof Error ? error.message : String(error)}`,
			});
			continue;
		}
		if (packages.length === 0) {
			state.skipped.push({
				label: `cargo clippy (${root})`,
				language: "Rust",
				reason: "no first-party workspace packages found",
			});
			continue;
		}
		const packageArgs = packages.flatMap(packageName => ["--package", packageName]);
		addPlan(state, {
			id: "clippy",
			label: "cargo clippy",
			language: "Rust",
			root,
			binaries: ["cargo"],
			executable: cargo,
			args: [
				"clippy",
				"--fix",
				"--allow-dirty",
				"--all-targets",
				"--no-deps",
				"--allow-staged",
				"--broken-code",
				"--allow-no-vcs",
				...packageArgs,
				"--message-format=json",
				"--",
				"-D",
				"warnings",
			],
			parser: "rust",
			mutates: true,
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "cargo-test",
				label: "cargo test",
				language: "Rust",
				root,
				binaries: ["cargo"],
				executable: cargo,
				args: ["test", "--no-fail-fast", "--all-targets", ...packageArgs, "--message-format=json"],
				parser: "rust-test",
			});
		}
	}
}

async function cargoWorkspacePackages(state: DiscoveryState, root: string, cargo: string): Promise<string[]> {
	const manifest = path.resolve(state.projectCwd, root, "Cargo.toml");
	const result = await ptree.exec(
		[cargo, "metadata", "--no-deps", "--format-version=1", "--manifest-path", manifest],
		{
			cwd: path.resolve(state.projectCwd, root),
			stderr: "full",
			allowNonZero: true,
		},
	);
	if (!result.ok) {
		throw new Error(
			sanitizeText(result.stderr || result.stdout)
				.replace(/\s+/g, " ")
				.trim(),
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (error) {
		throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) throw new Error("metadata root is not an object");
	const workspaceMembers = new Set<string>();
	if (Array.isArray(parsed.workspace_members)) {
		for (const member of parsed.workspace_members) {
			if (typeof member === "string") workspaceMembers.add(member);
		}
	}
	const allowedFiles = new Set(state.files);
	const packages: string[] = [];
	if (!Array.isArray(parsed.packages)) return packages;
	for (const value of parsed.packages) {
		if (!isRecord(value) || typeof value.id !== "string" || !workspaceMembers.has(value.id)) continue;
		if (typeof value.name !== "string" || typeof value.manifest_path !== "string") continue;
		const relativeManifest = path.relative(state.projectCwd, value.manifest_path).split(path.sep).join("/");
		if (allowedFiles.has(relativeManifest)) packages.push(value.name);
	}
	return [...new Set(packages)].sort();
}

function discoverGo(state: DiscoveryState): void {
	const workRoots = rootsForBasenames(state.files, { "go.work": true });
	const roots = workRoots.length > 0 ? workRoots : rootsForBasenames(state.files, { "go.mod": true });
	for (const root of roots) {
		const prefix = root === "." ? "" : `${root}/`;
		addPlan(state, {
			id: "go-vet",
			label: "go vet",
			language: "Go",
			root,
			binaries: ["go"],
			args: ["vet", "-json", "./..."],
			parser: "go",
		});
		addPlan(state, {
			id: "staticcheck",
			label: "staticcheck",
			language: "Go",
			root,
			binaries: ["staticcheck"],
			args: ["-f", "json", "./..."],
			parser: "staticcheck",
			optional: !state.files.includes(`${prefix}staticcheck.conf`),
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "go-test",
				label: "go test",
				language: "Go",
				root,
				binaries: ["go"],
				args: ["test", "-json", "./..."],
				parser: "go-test",
			});
		}
	}
	for (const root of rootsForPattern(state.files, /(?:^|\/)\.golangci\.(?:ya?ml|toml|json)$/)) {
		addPlan(state, {
			id: "golangci",
			label: "golangci-lint",
			language: "Go",
			root,
			binaries: ["golangci-lint"],
			args: ["run"],
			parser: "golangci",
		});
	}
}

async function discoverPython(state: DiscoveryState): Promise<void> {
	if (!containsExtension(state.files, [".py", ".pyi"])) return;
	const roots = rootsForBasenames(state.files, {
		".ruff.toml": true,
		"pyproject.toml": true,
		"ruff.toml": true,
		"setup.cfg": true,
		"tox.ini": true,
	});
	for (const root of roots.length > 0 ? roots : ["."]) {
		addPlan(state, {
			id: "ruff",
			label: "ruff",
			language: "Python",
			root,
			binaries: ["ruff"],
			args: ["check", "--output-format=json", "."],
			parser: "ruff",
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "pytest",
				label: "pytest",
				language: "Python",
				root,
				binaries: ["pytest"],
				args: ["-q"],
				parser: "generic",
			});
		}
	}
	for (const root of rootsForBasenames(state.files, { "pyrightconfig.json": true })) {
		addPlan(state, {
			id: "pyright",
			label: "pyright",
			language: "Python",
			root,
			binaries: ["pyright", "basedpyright"],
			args: ["--outputjson"],
			parser: "pyright",
		});
	}
	const pyprojectRoots = rootsForBasenames(state.files, { "pyproject.toml": true });
	const pyprojectContent = new Map<string, string>();
	for (const root of pyprojectRoots) {
		const file = root === "." ? "pyproject.toml" : `${root}/pyproject.toml`;
		pyprojectContent.set(
			root,
			await Bun.file(path.resolve(state.projectCwd, file))
				.text()
				.catch(() => ""),
		);
	}
	const withSection = (section: string): string[] =>
		pyprojectRoots.filter(root => pyprojectContent.get(root)?.includes(section) === true);
	const toolRoots = (basenames: Record<string, true>, section: string): string[] =>
		topmostRoots([...rootsForBasenames(state.files, basenames), ...withSection(section)]);
	for (const root of toolRoots({ "mypy.ini": true, ".mypy.ini": true }, "[tool.mypy")) {
		addPlan(state, {
			id: "mypy",
			label: "mypy",
			language: "Python",
			root,
			binaries: ["mypy"],
			args: ["--no-error-summary", "--no-pretty", "."],
			parser: "mypy",
		});
	}
	for (const root of toolRoots({ ".pylintrc": true, pylintrc: true }, "[tool.pylint")) {
		addPlan(state, {
			id: "pylint",
			label: "pylint",
			language: "Python",
			root,
			binaries: ["pylint"],
			args: ["--output-format=json", "--recursive=y", "."],
			parser: "pylint",
		});
	}
	for (const root of rootsForBasenames(state.files, { ".flake8": true })) {
		addPlan(state, {
			id: "flake8",
			label: "flake8",
			language: "Python",
			root,
			binaries: ["flake8"],
			args: ["."],
			parser: "flake8",
		});
	}
	for (const root of toolRoots({ "ty.toml": true }, "[tool.ty")) {
		addPlan(state, {
			id: "ty",
			label: "ty check",
			language: "Python",
			root,
			binaries: ["ty"],
			args: ["check", "--output-format", "concise"],
			parser: "ty",
		});
	}
}

async function discoverJavaScript(state: DiscoveryState): Promise<void> {
	if (!containsExtension(state.files, [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"])) return;
	for (const root of rootsForBasenames(state.files, { "biome.json": true, "biome.jsonc": true })) {
		addPlan(state, {
			id: "biome",
			label: "biome check",
			language: "JavaScript/TypeScript",
			root,
			binaries: ["biome"],
			args: ["check", ".", "--reporter=json"],
			parser: "biome",
		});
	}
	const eslintConfig =
		/(?:^|\/)(?:eslint\.config\.(?:js|mjs|cjs|ts|mts|cts)|\.eslintrc(?:\.(?:js|cjs|json|yaml|yml))?)$/;
	for (const root of rootsForPattern(state.files, eslintConfig)) {
		addPlan(state, {
			id: "eslint",
			label: "eslint",
			language: "JavaScript/TypeScript",
			root,
			binaries: ["eslint"],
			args: [".", "--format=json"],
			parser: "eslint",
		});
	}
	for (const root of rootsForBasenames(state.files, { "tsconfig.json": true })) {
		const prefix = root === "." ? "" : `${root}/`;
		const hasVue = state.files.some(file => file.startsWith(prefix) && file.endsWith(".vue"));
		addPlan(state, {
			id: "typescript",
			label: hasVue ? "Vue TypeScript" : "TypeScript",
			language: "TypeScript",
			root,
			binaries: hasVue ? ["vue-tsc", "tsgo", "tsc"] : ["tsgo", "tsc"],
			args: ["--noEmit", "--pretty", "false"],
			parser: "generic",
		});
	}
	for (const root of rootsForBasenames(state.files, { ".oxlintrc.json": true })) {
		addPlan(state, {
			id: "oxlint",
			label: "oxlint",
			language: "JavaScript/TypeScript",
			root,
			binaries: ["oxlint"],
			args: ["--format=unix"],
			parser: "oxlint",
		});
	}
	for (const root of rootsForBasenames(state.files, { "deno.json": true, "deno.jsonc": true })) {
		addPlan(state, {
			id: "deno-lint",
			label: "deno lint",
			language: "JavaScript/TypeScript",
			root,
			binaries: ["deno"],
			args: ["lint", "--json"],
			parser: "deno-lint",
		});
	}
	const stylelintConfig =
		/(?:^|\/)(?:\.stylelintrc(?:\.(?:json|ya?ml|js|cjs|mjs))?|stylelint\.config\.(?:js|cjs|mjs|ts))$/;
	for (const root of rootsForPattern(state.files, stylelintConfig)) {
		addPlan(state, {
			id: "stylelint",
			label: "stylelint",
			language: "CSS",
			root,
			binaries: ["stylelint"],
			args: ["**/*.{css,scss,sass,less}", "--formatter", "json", "--allow-empty-input"],
			parser: "stylelint",
		});
	}
	if (state.includeTests) await discoverPackageTests(state);
}

async function discoverPackageTests(state: DiscoveryState): Promise<void> {
	const candidates: Array<{ root: string; manager: string }> = [];
	for (const file of state.files) {
		if (path.posix.basename(file) !== "package.json") continue;
		let manifest: unknown;
		try {
			manifest = await Bun.file(path.resolve(state.projectCwd, file)).json();
		} catch {
			continue;
		}
		if (!isRecord(manifest) || !isRecord(manifest.scripts)) continue;
		const testScript = manifest.scripts.test;
		if (
			typeof testScript !== "string" ||
			!testScript.trim() ||
			testScript.toLowerCase().includes("no test specified")
		) {
			continue;
		}
		const root = path.posix.dirname(file);
		let manager =
			typeof manifest.packageManager === "string" ? manifest.packageManager.split("@", 1)[0].toLowerCase() : "";
		const prefix = root === "." ? "" : `${root}/`;
		if (!["bun", "npm", "pnpm", "yarn"].includes(manager)) {
			if (state.files.includes(`${prefix}bun.lock`) || state.files.includes(`${prefix}bun.lockb`)) manager = "bun";
			else if (state.files.includes(`${prefix}pnpm-lock.yaml`)) manager = "pnpm";
			else if (state.files.includes(`${prefix}yarn.lock`)) manager = "yarn";
			else manager = "npm";
		}
		candidates.push({ root, manager });
	}
	const selectedRoots = new Set(topmostRoots(candidates.map(candidate => candidate.root)));
	for (const candidate of candidates) {
		if (!selectedRoots.has(candidate.root)) continue;
		addPlan(state, {
			id: `${candidate.manager}-test`,
			label: `${candidate.manager} test`,
			language: "JavaScript/TypeScript",
			root: candidate.root,
			binaries: [candidate.manager],
			args: ["run", "test"],
			parser: "generic",
		});
	}
}

function discoverRuby(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".rb", ".rake"])) return;
	for (const root of rootsForBasenames(state.files, { ".rubocop.yml": true, ".rubocop.yaml": true })) {
		addPlan(state, {
			id: "rubocop",
			label: "rubocop",
			language: "Ruby",
			root,
			binaries: ["rubocop"],
			args: ["--format", "json", "--force-exclusion"],
			parser: "rubocop",
		});
	}
	if (state.includeTests) {
		for (const root of rootsForPattern(state.files, /(?:^|\/)(?:\.rspec|Gemfile)$/)) {
			addPlan(state, {
				id: "rspec",
				label: "RSpec",
				language: "Ruby",
				root,
				binaries: ["rspec"],
				args: ["--format", "progress"],
				parser: "generic",
			});
		}
	}
}

function discoverPhp(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".php"])) return;
	for (const root of rootsForPattern(state.files, /(?:^|\/)phpstan\.neon(?:\.dist)?$/)) {
		addPlan(state, {
			id: "phpstan",
			label: "PHPStan",
			language: "PHP",
			root,
			binaries: ["phpstan"],
			args: ["analyse", "--error-format=json", "--no-progress"],
			parser: "phpstan",
		});
	}
	for (const root of rootsForPattern(state.files, /(?:^|\/)psalm(?:\.xml|\.xml\.dist)$/)) {
		addPlan(state, {
			id: "psalm",
			label: "Psalm",
			language: "PHP",
			root,
			binaries: ["psalm"],
			args: ["--output-format=json", "--no-progress"],
			parser: "psalm",
		});
	}
	if (state.includeTests) {
		for (const root of rootsForPattern(state.files, /(?:^|\/)phpunit\.xml(?:\.dist)?$/)) {
			addPlan(state, {
				id: "phpunit",
				label: "PHPUnit",
				language: "PHP",
				root,
				binaries: ["phpunit"],
				args: [],
				parser: "generic",
			});
		}
	}
}

function discoverSwift(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".swift"])) return;
	const configured = rootsForBasenames(state.files, { ".swiftlint.yml": true });
	const roots = configured.length > 0 ? configured : rootsForBasenames(state.files, { "Package.swift": true });
	for (const root of roots) {
		addPlan(state, {
			id: "swiftlint",
			label: "SwiftLint",
			language: "Swift",
			root,
			binaries: ["swiftlint"],
			args: ["lint", "--reporter", "json", "--quiet"],
			parser: "swiftlint",
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "swift-test",
				label: "swift test",
				language: "Swift",
				root,
				binaries: ["swift"],
				args: ["test"],
				parser: "generic",
			});
		}
	}
}

function discoverDart(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".dart"])) return;
	for (const root of rootsForBasenames(state.files, { "pubspec.yaml": true })) {
		addPlan(state, {
			id: "dart-analyze",
			label: "dart analyze",
			language: "Dart",
			root,
			binaries: ["dart"],
			args: ["analyze", "--format", "machine"],
			parser: "dart",
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "dart-test",
				label: "dart test",
				language: "Dart",
				root,
				binaries: ["dart"],
				args: ["test", "--reporter", "json"],
				parser: "generic",
			});
		}
	}
}

function discoverElixir(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".ex", ".exs"])) return;
	for (const root of rootsForBasenames(state.files, { ".credo.exs": true })) {
		addPlan(state, {
			id: "credo",
			label: "Credo",
			language: "Elixir",
			root,
			binaries: ["mix"],
			args: ["credo", "--format=json"],
			parser: "credo",
		});
	}
	if (state.includeTests) {
		for (const root of rootsForBasenames(state.files, { "mix.exs": true })) {
			addPlan(state, {
				id: "mix-test",
				label: "mix test",
				language: "Elixir",
				root,
				binaries: ["mix"],
				args: ["test"],
				parser: "generic",
			});
		}
	}
}

function discoverShell(state: DiscoveryState): void {
	const shellFiles = state.files.filter(file => /\.(?:sh|bash|ksh|zsh)$/.test(file));
	if (shellFiles.length === 0) return;
	for (let index = 0; index < shellFiles.length; index += SHELLCHECK_BATCH_SIZE) {
		const batch = shellFiles.slice(index, index + SHELLCHECK_BATCH_SIZE);
		addPlan(state, {
			id: `shellcheck-${Math.floor(index / SHELLCHECK_BATCH_SIZE) + 1}`,
			label: "ShellCheck",
			language: "Shell",
			root: ".",
			binaries: ["shellcheck"],
			args: ["--format=json1", ...batch],
			parser: "shellcheck",
		});
	}
}

function discoverHaskell(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".hs", ".lhs"])) return;
	const roots = rootsForPattern(state.files, /(?:^|\/)(?:\.hlint\.yaml|stack\.yaml|cabal\.project|[^/]+\.cabal)$/);
	for (const root of roots.length > 0 ? roots : ["."]) {
		addPlan(state, {
			id: "hlint",
			label: "HLint",
			language: "Haskell",
			root,
			binaries: ["hlint"],
			args: ["--json", "."],
			parser: "hlint",
		});
		if (state.includeTests) {
			const prefix = root === "." ? "" : `${root}/`;
			const useStack = state.files.includes(`${prefix}stack.yaml`);
			addPlan(state, {
				id: useStack ? "stack-test" : "cabal-test",
				label: useStack ? "stack test" : "cabal test",
				language: "Haskell",
				root,
				binaries: [useStack ? "stack" : "cabal"],
				args: useStack ? ["test"] : ["test", "all"],
				parser: "generic",
			});
		}
	}
}

function discoverTerraform(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".tf"])) return;
	const configured = rootsForBasenames(state.files, { ".tflint.hcl": true });
	const roots = configured.length > 0 ? configured : rootsForPattern(state.files, /\.tf$/);
	for (const root of roots) {
		addPlan(state, {
			id: "tflint",
			label: "TFLint",
			language: "Terraform",
			root,
			binaries: ["tflint"],
			args: ["--format=json", "--recursive"],
			parser: "tflint",
		});
		addPlan(state, {
			id: "terraform-validate",
			label: "terraform validate",
			language: "Terraform",
			root,
			binaries: ["terraform"],
			args: ["validate", "-json"],
			parser: "terraform",
		});
	}
}

function discoverLua(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".lua"])) return;
	const configured = rootsForBasenames(state.files, { ".luacheckrc": true });
	for (const root of configured.length > 0 ? configured : ["."]) {
		addPlan(state, {
			id: "luacheck",
			label: "Luacheck",
			language: "Lua",
			root,
			binaries: ["luacheck"],
			args: ["."],
			parser: "generic",
		});
	}
	if (state.includeTests && state.files.some(file => /(?:^|\/)(?:spec|test)\/.*_spec\.lua$/.test(file))) {
		addPlan(state, {
			id: "busted",
			label: "Busted",
			language: "Lua",
			root: ".",
			binaries: ["busted"],
			args: [],
			parser: "generic",
		});
	}
}

function discoverCpp(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"])) return;
	for (const root of rootsForBasenames(state.files, { "compile_commands.json": true })) {
		addPlan(state, {
			id: "clang-tidy",
			label: "clang-tidy",
			language: "C/C++",
			root: ".",
			binaries: ["run-clang-tidy", "run-clang-tidy.py"],
			args: ["-quiet", "-p", path.resolve(state.projectCwd, root)],
			parser: "generic",
		});
	}
}

function discoverDotnet(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".cs", ".fs", ".vb"])) return;
	const solutions = rootsForPattern(state.files, /\.(?:sln|slnx)$/i);
	const roots = solutions.length > 0 ? solutions : rootsForPattern(state.files, /\.(?:csproj|fsproj|vbproj)$/i);
	for (const root of roots) {
		addPlan(state, {
			id: "dotnet-build",
			label: "dotnet build",
			language: ".NET",
			root,
			binaries: ["dotnet"],
			args: ["build", "--no-restore", "--nologo", "--verbosity", "quiet"],
			parser: "generic",
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "dotnet-test",
				label: "dotnet test",
				language: ".NET",
				root,
				binaries: ["dotnet"],
				args: ["test", "--no-restore", "--nologo", "--verbosity", "quiet"],
				parser: "generic",
			});
		}
	}
}

function discoverZig(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".zig"])) return;
	for (const root of rootsForBasenames(state.files, { "build.zig": true })) {
		addPlan(state, {
			id: "zig-build",
			label: "zig build",
			language: "Zig",
			root,
			binaries: ["zig"],
			args: ["build"],
			parser: "generic",
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "zig-test",
				label: "zig build test",
				language: "Zig",
				root,
				binaries: ["zig"],
				args: ["build", "test"],
				parser: "generic",
			});
		}
	}
}

function discoverJvm(state: DiscoveryState): void {
	if (!containsExtension(state.files, [".java", ".kt", ".kts", ".scala"])) return;
	const gradleRoots = rootsForBasenames(state.files, {
		"build.gradle": true,
		"build.gradle.kts": true,
		"settings.gradle": true,
		"settings.gradle.kts": true,
	});
	for (const root of gradleRoots) {
		const unixWrapper = path.posix.join(root, "gradlew");
		const windowsWrapper = path.posix.join(root, "gradlew.bat");
		const wrapper = state.files.includes(unixWrapper)
			? path.resolve(state.projectCwd, unixWrapper)
			: state.files.includes(windowsWrapper)
				? path.resolve(state.projectCwd, windowsWrapper)
				: undefined;
		addPlan(state, {
			id: "gradle-check",
			label: "Gradle check",
			language: "JVM",
			root,
			binaries: ["gradle"],
			executable: wrapper,
			args: ["check", "-x", "test", "--console=plain", "--no-daemon"],
			parser: "generic",
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "gradle-test",
				label: "Gradle test",
				language: "JVM",
				root,
				binaries: ["gradle"],
				executable: wrapper,
				args: ["test", "--console=plain", "--no-daemon"],
				parser: "generic",
			});
		}
	}
	for (const root of rootsForBasenames(state.files, { "pom.xml": true })) {
		const unixWrapper = path.posix.join(root, "mvnw");
		const windowsWrapper = path.posix.join(root, "mvnw.cmd");
		const wrapper = state.files.includes(unixWrapper)
			? path.resolve(state.projectCwd, unixWrapper)
			: state.files.includes(windowsWrapper)
				? path.resolve(state.projectCwd, windowsWrapper)
				: undefined;
		addPlan(state, {
			id: "maven-verify",
			label: "Maven verify",
			language: "JVM",
			root,
			binaries: ["mvn"],
			executable: wrapper,
			args: ["-q", "-DskipTests", "-DskipITs", "verify"],
			parser: "generic",
		});
		if (state.includeTests) {
			addPlan(state, {
				id: "maven-test",
				label: "Maven test",
				language: "JVM",
				root,
				binaries: ["mvn"],
				executable: wrapper,
				args: ["-q", "test"],
				parser: "generic",
			});
		}
	}
}

function discoverGitHubActions(state: DiscoveryState): void {
	const roots = new Set<string>();
	for (const file of state.files) {
		const match = /^(?:(.*)\/)?\.github\/workflows\/[^/]+\.ya?ml$/.exec(file);
		if (match) roots.add(match[1] ?? ".");
	}
	for (const root of topmostRoots([...roots])) {
		addPlan(state, {
			id: "actionlint",
			label: "actionlint",
			language: "GitHub Actions",
			root,
			binaries: ["actionlint"],
			args: ["-format", "{{json .}}"],
			parser: "actionlint",
			optional: true,
		});
	}
}

interface RunCheckerOptions {
	signal?: AbortSignal;
	/** New diagnostics parsed from partial or final output; each delivered exactly once. */
	onDiagnostics?: (diagnostics: readonly CleanseDiagnostic[]) => void;
	/** Interval between partial-output parses; only used with `onDiagnostics`. */
	flushMs?: number;
}

async function runChecker(
	plan: CheckerPlan,
	projectCwd: string,
	allowedFiles: ReadonlySet<string>,
	options: RunCheckerOptions = {},
): Promise<CleanseCheckResult> {
	const { signal, onDiagnostics, flushMs = DEFAULT_FLUSH_MS } = options;
	const emitted = new Set<string>();
	const emit = (diagnostics: readonly CleanseDiagnostic[]): void => {
		if (!onDiagnostics) return;
		const fresh = diagnostics.filter(diagnostic => {
			const key = diagnosticKey(diagnostic);
			if (emitted.has(key)) return false;
			emitted.add(key);
			return true;
		});
		if (fresh.length > 0) onDiagnostics(fresh);
	};
	const parse = (stdout: string, stderr: string): CleanseDiagnostic[] =>
		parseCleanseDiagnostics(plan.parser, {
			checker: plan.label,
			projectCwd,
			checkerCwd: plan.cwd,
			stdout,
			stderr,
		});
	const inProject = (diagnostics: CleanseDiagnostic[]): CleanseDiagnostic[] =>
		diagnostics.filter(diagnostic => diagnostic.file === undefined || allowedFiles.has(diagnostic.file));
	const result = (exitCode: number | null, diagnostics: CleanseDiagnostic[]): CleanseCheckResult => ({
		id: plan.id,
		label: plan.label,
		language: plan.language,
		cwd: path.relative(projectCwd, plan.cwd) || ".",
		command: plan.command,
		exitCode,
		diagnostics,
	});
	try {
		using child = ptree.spawn([plan.executable, ...plan.args], { cwd: plan.cwd, signal, stderr: "full" });
		const stdout: OutputAccumulator = { text: "" };
		const stderr: OutputAccumulator = { text: "" };
		const pumps = Promise.all([pumpStream(child.stdout, stdout), pumpStream(child.stderr, stderr)]);
		let running = true;
		// Mutating checkers rewrite files while running; only stream partials
		// from read-only checkers so repair work never races an in-flight edit.
		const poller =
			onDiagnostics && !plan.mutates
				? (async () => {
						while (running) {
							await Bun.sleep(flushMs);
							if (!running) break;
							// Cut at the last newline: truncated trailing lines and
							// unterminated JSON documents parse as garbage or nothing.
							emit(inProject(parse(completeLines(stdout.text), completeLines(stderr.text))));
						}
					})()
				: undefined;
		let exitCode: number | null;
		try {
			exitCode = await child.exited;
		} finally {
			running = false;
		}
		await pumps;
		await poller;
		const parsedDiagnostics = parse(stdout.text, stderr.text);
		const diagnostics = inProject(parsedDiagnostics);
		if (exitCode !== 0 && parsedDiagnostics.length === 0) {
			diagnostics.push(checkerFailureDiagnostic(plan, exitCode, stdout.text, stderr.text));
		}
		emit(diagnostics);
		return result(exitCode, diagnostics);
	} catch (error) {
		if (signal?.aborted) throw error;
		const failure = checkerFailureDiagnostic(plan, null, "", error instanceof Error ? error.message : String(error));
		emit([failure]);
		return result(null, [failure]);
	}
}

interface OutputAccumulator {
	text: string;
}

async function pumpStream(stream: ReadableStream<Uint8Array> | undefined, into: OutputAccumulator): Promise<void> {
	if (!stream) return;
	const decoder = new TextDecoder();
	for await (const chunk of stream) into.text += decoder.decode(chunk, { stream: true });
	into.text += decoder.decode();
}

/** Truncate to the last complete line so partial parses never see a torn record. */
function completeLines(text: string): string {
	const cut = text.lastIndexOf("\n");
	return cut < 0 ? "" : text.slice(0, cut + 1);
}

/** Identity key matching {@link deduplicateProjectDiagnostics}; used for exactly-once streaming emission. */
export function diagnosticKey(diagnostic: CleanseDiagnostic): string {
	return [
		diagnostic.file ?? "",
		diagnostic.line ?? "",
		diagnostic.column ?? "",
		diagnostic.code ?? "",
		diagnostic.message,
	].join("\u0000");
}

function checkerFailureDiagnostic(
	plan: CheckerPlan,
	exitCode: number | null,
	stdout: string,
	stderr: string,
): CleanseDiagnostic {
	const output = sanitizeText([stderr, stdout].filter(Boolean).join("\n")).trim();
	const suffix = output ? `: ${output.slice(0, MAX_FAILURE_OUTPUT)}` : "";
	return {
		checker: plan.label,
		severity: "error",
		message: `${plan.label} failed${exitCode === null ? "" : ` with exit code ${exitCode}`}${suffix}`,
	};
}

function deduplicateProjectDiagnostics(diagnostics: CleanseDiagnostic[]): CleanseDiagnostic[] {
	const seen = new Set<string>();
	const unique: CleanseDiagnostic[] = [];
	for (const diagnostic of diagnostics) {
		const key = diagnosticKey(diagnostic);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(diagnostic);
	}
	return unique.sort(
		(left, right) =>
			(left.file ?? "").localeCompare(right.file ?? "") ||
			(left.line ?? 0) - (right.line ?? 0) ||
			left.message.localeCompare(right.message),
	);
}
