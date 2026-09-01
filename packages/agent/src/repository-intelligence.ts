import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";
import type { TaskComplexity, TaskRepositorySignals } from "./task-router";

export const REPOSITORY_INTELLIGENCE_SCHEMA_VERSION = 2;
export const REPOSITORY_INTELLIGENCE_CACHE_ENV = "PI_REPOSITORY_CACHE";

export type RepositoryDirectoryKind = "SOURCE" | "TEST" | "CONFIG" | "GENERATED" | "DEPENDENCY" | "DOCUMENTATION" | "BUILD_ARTIFACT" | "IGNORED" | "UNKNOWN";
export type RepositorySymbolKind = "function" | "class" | "interface" | "type" | "export" | "method" | "component" | "variable" | "unknown";

export interface RepositoryEntryPoint { path: string; confidence: number; evidence: string; }
export interface RepositoryWorkspacePackage { name: string; root: string; manifest?: string; packageManager?: string; scripts: Record<string, string>; dependencies: string[]; devDependencies: string[]; }
export interface RepositoryGitState { branch?: string; dirty: boolean; changedFiles: string[]; stagedFiles: string[]; unstagedFiles: string[]; untrackedFiles: string[]; mergeRebaseState?: "MERGING" | "REBASING" | "CHERRY_PICKING" | "REVERTING" | "UNKNOWN"; }
export interface RepositoryFileRecord { path: string; kind: RepositoryDirectoryKind; extension?: string; size: number; mtimeMs: number; hash?: string; }
export interface RepositoryDependencyEdge { from: string; to: string; kind: "import" | "require" | "dependency"; }
export interface RepositorySymbolRecord { name: string; path: string; line: number; kind: RepositorySymbolKind; source: "lsp" | "text"; }
export interface RepositorySymbolProvider { findSymbolDefinition?: (symbol: string) => Promise<RepositorySymbolRecord[]>; findSymbolReferences?: (symbol: string) => Promise<RepositorySymbolRecord[]>; indexFileSymbols?: (file: string) => Promise<RepositorySymbolRecord[]>; }

export interface RepositoryProfile {
	identity: { root: string; name?: string; confidence: number; evidence: string[] };
	languages: string[];
	frameworks: string[];
	packageManager?: string;
	buildSystem: string[];
	testFramework: string[];
	entryPoints: RepositoryEntryPoint[];
	sourceRoots: string[];
	testRoots: string[];
	configFiles: string[];
	generatedDirectories: string[];
	ignoredDirectories: string[];
	importantDirectories: string[];
	workspacePackages: RepositoryWorkspacePackage[];
	gitState: RepositoryGitState;
	lastIndexedState: { indexedAt: number; headRevision?: string; structuralFingerprint: string; fileCount: number; cacheHit: boolean; invalidations: string[] };
}
export interface RepositoryQueryResult { facts: string[]; files: string[]; workspaces: string[]; symbols: RepositorySymbolRecord[]; confidence: number; }
export interface RepositoryIntelligenceTelemetry { cacheHit: boolean; cacheMissReason?: string; initialIndexingTimeMs: number; incrementalIndexingTimeMs: number; filesIndexed: number; symbolsIndexed: number; dependencyEdges: number; invalidations: string[]; fallbacks: string[]; queries: number; queryLatencyMs: number; indexMode: "cache" | "incremental" | "full" | "fallback"; }
export interface RepositorySnapshot { root: string; files: string[]; rootFiles: string[]; packageManifests: Array<{ path: string; json: Record<string, unknown> }>; lockfiles: string[]; configFiles: string[]; branch?: string; git: RepositoryGitState; headRevision?: string; }
export interface RepositoryIntelligenceOptions { root?: string; cache?: boolean; maxIndexedFiles?: number; symbolProvider?: RepositorySymbolProvider; }
interface CachePayload { schemaVersion: number; profile: RepositoryProfile; files: RepositoryFileRecord[]; dependencies: RepositoryDependencyEdge[]; symbols: RepositorySymbolRecord[]; structuralInputs: string[]; }
interface GitSnapshot { state: RepositoryGitState; headRevision?: string; }

const SOURCE_DIR_NAMES = new Set(["src", "app", "lib", "cmd", "server", "client", "api", "services"]);
const TEST_DIR_NAMES = new Set(["test", "tests", "__tests__", "spec", "specs"]);
const GENERATED_DIR_NAMES = new Set(["generated", "gen", "codegen", ".next", ".nuxt", ".svelte-kit"]);
const BUILD_DIR_NAMES = new Set(["dist", "build", "out", "target", "coverage", ".turbo", ".cache", ".pytest_cache"]);
const DEPENDENCY_DIR_NAMES = new Set(["node_modules", "vendor", ".venv", "venv", ".tox"]);
const DOCUMENTATION_DIR_NAMES = new Set(["docs", "documentation"]);
const IGNORE_DIR_NAMES = new Set([".git", ".idea", ".vscode", ".worktrees", ".worktree"]);
const IMPORTANT_NAME = /^(auth|authentication|database|db|payment|payments|billing|api|server|worker|queue|config|configuration|cli|middleware|storage|models?|routes?|services?|core|domain|infra|infrastructure|adapters?|plugins?|extensions?)$/i;
const STRUCTURAL_FILE = /^(package\.json|(?:bun|pnpm|yarn|package-lock|Cargo|poetry|uv)\.lock(?:\.yaml)?|go\.mod|go\.sum|tsconfig(?:\..*)?\.json|vite\.config\..*|next\.config\..*|astro\.config\..*|svelte\.config\..*|pyproject\.toml|Cargo\.toml|BUILD\.bazel|Makefile|justfile|biome\.jsonc?|eslint(?:\.config)?\..*)$/i;
const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\"|\"$/g, "");
const ext = (file: string) => path.extname(file).toLowerCase();

function languageFor(file: string): string | undefined {
	const map: Record<string, string> = { ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".rs": "Rust", ".py": "Python", ".go": "Go", ".java": "Java", ".kt": "Kotlin", ".cs": "C#", ".cpp": "C++", ".cc": "C++", ".c": "C", ".h": "C/C++", ".rb": "Ruby", ".php": "PHP", ".swift": "Swift", ".dart": "Dart" };
	return map[ext(file)];
}

function classifyPath(file: string): RepositoryDirectoryKind {
	const parts = normalizePath(file).split("/");
	for (const part of parts) {
		if (IGNORE_DIR_NAMES.has(part)) return "IGNORED";
		if (DEPENDENCY_DIR_NAMES.has(part)) return "DEPENDENCY";
		if (GENERATED_DIR_NAMES.has(part)) return "GENERATED";
		if (BUILD_DIR_NAMES.has(part)) return "BUILD_ARTIFACT";
		if (TEST_DIR_NAMES.has(part)) return "TEST";
		if (DOCUMENTATION_DIR_NAMES.has(part)) return "DOCUMENTATION";
	}
	const base = parts.at(-1) ?? "";
	if (STRUCTURAL_FILE.test(base)) return "CONFIG";
	if (SOURCE_DIR_NAMES.has(parts.at(-2) ?? "") || languageFor(file)) return "SOURCE";
	return "UNKNOWN";
}

function stringRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => typeof item === "string")) as Record<string, string>;
}
function dependencyNames(manifest: Record<string, unknown>, key: string): string[] { return Object.keys(stringRecord(manifest[key])).sort(); }
function packageManagerFromLockfiles(files: readonly string[]): string | undefined {
	const names = new Set(files.map(file => path.basename(file)));
	if (names.has("bun.lock") || names.has("bun.lockb")) return "Bun";
	if (names.has("pnpm-lock.yaml")) return "pnpm";
	if (names.has("yarn.lock")) return "Yarn";
	if (names.has("package-lock.json")) return "npm";
	if (names.has("Cargo.lock")) return "Cargo";
	if (names.has("poetry.lock")) return "Poetry";
	if (names.has("uv.lock")) return "uv";
	if (names.has("go.mod")) return "Go modules";
	return undefined;
}
function detectFrameworks(manifests: readonly { json: Record<string, unknown> }[]): string[] {
	const deps = new Set<string>();
	for (const item of manifests) for (const name of [...dependencyNames(item.json, "dependencies"), ...dependencyNames(item.json, "devDependencies")]) deps.add(name);
	const pairs: Array<[string, string]> = [["next", "Next.js"], ["react", "React"], ["vue", "Vue"], ["svelte", "Svelte"], ["astro", "Astro"], ["django", "Django"], ["fastapi", "FastAPI"], ["rails", "Rails"]];
	return pairs.filter(([dependency]) => deps.has(dependency)).map(([, framework]) => framework).sort();
}
function detectTestFrameworks(manifests: readonly { json: Record<string, unknown> }[], files: readonly string[]): string[] {
	const deps = new Set<string>();
	for (const item of manifests) for (const name of [...dependencyNames(item.json, "dependencies"), ...dependencyNames(item.json, "devDependencies")]) deps.add(name);
	const result = new Set<string>();
	if (deps.has("vitest")) result.add("Vitest");
	if (deps.has("jest")) result.add("Jest");
	if (deps.has("mocha")) result.add("Mocha");
	if (deps.has("@playwright/test")) result.add("Playwright Test");
	if (files.some(file => path.basename(file) === "conftest.py" || path.basename(file) === "pytest.ini")) result.add("pytest");
	if (files.some(file => path.basename(file) === "go.mod")) result.add("go test");
	if (files.some(file => path.basename(file) === "Cargo.toml" || path.basename(file) === "Cargo.lock")) result.add("cargo test");
	return [...result].sort();
}
function detectSourceRoots(files: readonly string[]): string[] {
	const roots = new Set<string>();
	for (const file of files) {
		const parts = normalizePath(file).split("/");
		for (let i = 0; i < parts.length - 1; i++) if (SOURCE_DIR_NAMES.has(parts[i])) roots.add(parts.slice(0, i + 1).join("/"));
	}
	return [...roots].sort();
}
function detectTestRoots(files: readonly string[]): string[] {
	const roots = new Set<string>();
	for (const file of files) {
		const parts = normalizePath(file).split("/");
		for (let i = 0; i < parts.length - 1; i++) if (TEST_DIR_NAMES.has(parts[i])) roots.add(parts.slice(0, i + 1).join("/"));
		if (/(^|\/)[^/]+\.(test|spec)\.[^/]+$/i.test(file)) roots.add(path.posix.dirname(normalizePath(file)));
	}
	return [...roots].sort();
}
function detectImportantDirectories(files: readonly string[]): string[] {
	const result = new Set<string>();
	for (const file of files) {
		const parts = normalizePath(file).split("/");
		for (let i = 0; i < parts.length - 1; i++) if (IMPORTANT_NAME.test(parts[i])) result.add(parts.slice(0, i + 1).join("/"));
	}
	return [...result].sort().slice(0, 32);
}
function detectEntryPoints(files: readonly string[], manifests: readonly { path: string; json: Record<string, unknown> }[]): RepositoryEntryPoint[] {
	const result: RepositoryEntryPoint[] = [];
	const add = (file: string, confidence: number, evidence: string) => { const normalized = normalizePath(file); if (normalized && files.includes(normalized)) result.push({ path: normalized, confidence, evidence }); };
	for (const manifest of manifests) {
		const base = path.posix.dirname(normalizePath(manifest.path));
		const resolveValue = (value: unknown) => typeof value === "string" ? path.posix.join(base, value) : undefined;
		add(resolveValue(manifest.json.main) ?? "", 0.96, "package.json main");
		add(resolveValue(manifest.json.module) ?? "", 0.95, "package.json module");
		if (typeof manifest.json.exports === "string") add(resolveValue(manifest.json.exports) ?? "", 0.93, "package.json exports");
	}
	for (const [file, confidence, evidence] of [["src/main.ts", 0.72, "common TypeScript entrypoint"], ["src/index.ts", 0.7, "common TypeScript entrypoint"], ["main.py", 0.72, "common Python entrypoint"], ["src/main.rs", 0.76, "Cargo binary entrypoint"]] as const) add(file, confidence, evidence);
	return result.filter((entry, index, all) => all.findIndex(other => other.path === entry.path) === index).sort((a, b) => b.confidence - a.confidence);
}
function workspacePackages(files: readonly string[], manifests: readonly { path: string; json: Record<string, unknown> }[], lockfiles: readonly string[]): RepositoryWorkspacePackage[] {
	const declaredRoots = new Set<string>();
	for (const file of files) { const parts = normalizePath(file).split("/"); if (parts.length >= 2 && ["packages", "apps", "services"].includes(parts[0])) declaredRoots.add(`${parts[0]}/${parts[1]}`); }
	const monorepo = declaredRoots.size > 0;
	return manifests.filter(item => { const root = path.posix.dirname(item.path) || "."; return !monorepo || root === "." || declaredRoots.has(root); }).map(item => {
		const root = path.posix.dirname(item.path) || ".";
		const nestedLocks = lockfiles.filter(file => path.posix.dirname(file).startsWith(root));
		return { name: typeof item.json.name === "string" ? item.json.name : root, root, manifest: item.path, packageManager: packageManagerFromLockfiles(nestedLocks) ?? packageManagerFromLockfiles(lockfiles), scripts: stringRecord(item.json.scripts), dependencies: dependencyNames(item.json, "dependencies"), devDependencies: dependencyNames(item.json, "devDependencies") };
	});
}
function buildSystems(snapshot: RepositorySnapshot): string[] {
	const systems = new Set<string>();
	if (snapshot.rootFiles.includes("BUILD.bazel")) systems.add("Bazel");
	if (snapshot.rootFiles.includes("Makefile")) systems.add("Make");
	if (snapshot.rootFiles.some(file => file.toLowerCase() === "justfile")) systems.add("Just");
	if (snapshot.files.some(file => path.basename(file) === "Cargo.toml" || path.basename(file) === "Cargo.lock")) systems.add("Cargo");
	if (snapshot.files.some(file => path.basename(file) === "go.mod")) systems.add("Go modules");
	if (snapshot.files.some(file => /^tsconfig.*\.json$/.test(path.basename(file)))) systems.add("TypeScript");
	if (snapshot.packageManifests.some(item => stringRecord(item.json.scripts).build)) systems.add("package-script build");
	return [...systems].sort();
}

function buildProfile(root: string, snapshot: RepositorySnapshot): { profile: RepositoryProfile; records: RepositoryFileRecord[] } {
	const languages = new Set<string>(), generated = new Set<string>(), ignored = new Set<string>();
	const records = snapshot.files.map(file => {
		const normalized = normalizePath(file); const kind = classifyPath(normalized); const language = languageFor(normalized); if (language) languages.add(language);
		for (const part of normalized.split("/")) { if (GENERATED_DIR_NAMES.has(part)) generated.add(part); if (IGNORE_DIR_NAMES.has(part)) ignored.add(part); }
		return { path: normalized, kind, extension: ext(normalized) || undefined, size: 0, mtimeMs: 0 };
	});
	const rootManifest = snapshot.packageManifests.find(item => item.path === "package.json");
	const profile: RepositoryProfile = {
		identity: { root, name: typeof rootManifest?.json.name === "string" ? rootManifest.json.name : path.basename(root), confidence: rootManifest ? 0.99 : 0.65, evidence: rootManifest ? ["package.json name"] : ["directory basename"] },
		languages: [...languages].sort(),
		frameworks: detectFrameworks(snapshot.packageManifests),
		packageManager: packageManagerFromLockfiles(snapshot.lockfiles),
		buildSystem: buildSystems(snapshot),
		testFramework: detectTestFrameworks(snapshot.packageManifests, snapshot.files),
		entryPoints: detectEntryPoints(snapshot.files, snapshot.packageManifests),
		sourceRoots: detectSourceRoots(snapshot.files),
		testRoots: detectTestRoots(snapshot.files),
		configFiles: [...snapshot.configFiles].sort(),
		generatedDirectories: [...generated].sort(),
		ignoredDirectories: [...ignored].sort(),
		importantDirectories: detectImportantDirectories(snapshot.files),
		workspacePackages: workspacePackages(snapshot.files, snapshot.packageManifests, snapshot.lockfiles),
		gitState: snapshot.git,
		lastIndexedState: { indexedAt: Date.now(), headRevision: snapshot.headRevision, structuralFingerprint: structuralFingerprint(snapshot), fileCount: snapshot.files.length, cacheHit: false, invalidations: [] },
	};
	return { profile, records };
}

function structuralFingerprint(snapshot: RepositorySnapshot): string {
	const inputs = [...snapshot.configFiles, ...snapshot.lockfiles, ...snapshot.files.filter(file => file.split("/").length <= 2), ...snapshot.packageManifests.map(item => `${item.path}:${JSON.stringify(item.json.workspaces ?? null)}:${JSON.stringify(item.json.name ?? null)}`)];
	return crypto.createHash("sha256").update(inputs.sort().join("\n")).digest("hex");
}
async function discoverGit(root: string): Promise<GitSnapshot> {
	const status = await gitCommand(root, ["status", "--porcelain=v1", "-b", "-uall"]);
	if (status.code !== 0) return { state: { dirty: false, changedFiles: [], stagedFiles: [], unstagedFiles: [], untrackedFiles: [] } };
	const changed = new Set<string>(), staged = new Set<string>(), unstaged = new Set<string>(), untracked = new Set<string>();
	let branch: string | undefined;
	for (const line of status.stdout.split(/\r?\n/)) {
		if (!line) continue;
		if (line.startsWith("## ")) { branch = line.slice(3).split("...")[0].replace(/^HEAD detached at /, "HEAD"); continue; }
		if (line.length < 4) continue;
		const code = line.slice(0, 2); const file = normalizePath((line.slice(3).split(/\s+->\s+/).at(-1) ?? line.slice(3)));
		if (!file) continue; changed.add(file); if (code[0] && code[0] !== " ") staged.add(file); if (code[1] && code[1] !== " ") unstaged.add(file); if (code === "??") untracked.add(file);
	}
	const head = await gitCommand(root, ["rev-parse", "HEAD"]);
	let mergeRebaseState: RepositoryGitState["mergeRebaseState"];
	for (const [file, state] of [["MERGE_HEAD", "MERGING"], ["CHERRY_PICK_HEAD", "CHERRY_PICKING"], ["REVERT_HEAD", "REVERTING"]] as const) { try { await fs.stat(path.join(root, ".git", file)); mergeRebaseState = state; break; } catch {} }
	if (!mergeRebaseState) for (const dir of ["rebase-merge", "rebase-apply"]) { try { await fs.stat(path.join(root, ".git", dir)); mergeRebaseState = "REBASING"; break; } catch {} }
	return { state: { branch, dirty: changed.size > 0, changedFiles: [...changed].sort(), stagedFiles: [...staged].sort(), unstagedFiles: [...unstaged].sort(), untrackedFiles: [...untracked].sort(), mergeRebaseState }, headRevision: head.code === 0 ? head.stdout.trim() : undefined };
}
async function gitCommand(root: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	try { const result = await ptree.exec(["git", ...args], { cwd: root, allowNonZero: true, allowAbort: true, stderr: "full" }); return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.exitCode ?? 0 }; } catch (error) { return { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: -1 }; }
}
async function statRecord(root: string, record: RepositoryFileRecord): Promise<RepositoryFileRecord> { try { const stat = await fs.stat(path.join(root, record.path)); return { ...record, size: stat.size, mtimeMs: stat.mtimeMs }; } catch { return record; } }
async function fullFiles(root: string, maxFiles: number): Promise<string[] | undefined> { const result = await gitCommand(root, ["ls-files", "-co", "--exclude-standard"]); if (result.code !== 0) return undefined; return result.stdout.split(/\r?\n/).map(normalizePath).filter(Boolean).slice(0, maxFiles); }
async function readManifest(root: string, file: string): Promise<Record<string, unknown> | undefined> { try { const value = JSON.parse(await fs.readFile(path.join(root, file), "utf8")) as unknown; return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; } catch { return undefined; } }
async function readText(root: string, file: string): Promise<string | undefined> { try { const stat = await fs.stat(path.join(root, file)); if (!stat.isFile() || stat.size > 1_000_000) return undefined; return await fs.readFile(path.join(root, file), "utf8"); } catch { return undefined; } }

function fallbackProfile(root: string, git: RepositoryGitState): RepositoryProfile {
	return { identity: { root, name: path.basename(root), confidence: 0.1, evidence: ["repository indexing unavailable"] }, languages: [], frameworks: [], buildSystem: [], testFramework: [], entryPoints: [], sourceRoots: [], testRoots: [], configFiles: [], generatedDirectories: [], ignoredDirectories: [], importantDirectories: [], workspacePackages: [], gitState: git, lastIndexedState: { indexedAt: Date.now(), fileCount: 0, structuralFingerprint: "", cacheHit: false, invalidations: ["index unavailable"] } };
}

function queryProfile(profile: RepositoryProfile, task: string, complexity: TaskComplexity, files: readonly RepositoryFileRecord[]): RepositoryQueryResult {
	const terms = task.toLowerCase().split(/[^a-z0-9_$.-]+/).filter(term => term.length >= 3);
	const score = (value: string) => terms.reduce((sum, term) => sum + (value.toLowerCase().includes(term) ? 1 : 0), 0);
	const candidates = [...profile.entryPoints.map(item => item.path), ...profile.configFiles, ...profile.sourceRoots, ...profile.testRoots, ...profile.importantDirectories, ...files.filter(item => item.kind === "SOURCE" || item.kind === "TEST").map(item => item.path)];
	const selected = [...new Set(candidates)].sort((a, b) => score(b) - score(a)).slice(0, complexity === "SIMPLE" ? 6 : complexity === "NORMAL" ? 12 : 24);
	const facts = [profile.identity.name ? `project: ${profile.identity.name}` : undefined, profile.languages.length ? `languages: ${profile.languages.join(", ")}` : undefined, profile.packageManager ? `package manager: ${profile.packageManager}` : undefined, profile.frameworks.length ? `frameworks: ${profile.frameworks.join(", ")}` : undefined, profile.testFramework.length ? `test framework: ${profile.testFramework.join(", ")}` : undefined, profile.buildSystem.length ? `build system: ${profile.buildSystem.join(", ")}` : undefined, ...profile.workspacePackages.slice(0, complexity === "SIMPLE" ? 2 : 8).map(item => `workspace: ${item.name} at ${item.root}`)].filter((value): value is string => Boolean(value));
	return { facts, files: selected, workspaces: profile.workspacePackages.map(item => item.root), symbols: [], confidence: profile.identity.confidence };
}

export class RepositoryIntelligence {
	readonly root: string;
	readonly #cacheEnabled: boolean;
	readonly #maxIndexedFiles: number;
	readonly #symbolProvider?: RepositorySymbolProvider;
	#profile?: RepositoryProfile;
	#files: RepositoryFileRecord[] = [];
	#dependencies: RepositoryDependencyEdge[] = [];
	#symbols: RepositorySymbolRecord[] = [];
	#telemetry: RepositoryIntelligenceTelemetry = { cacheHit: false, initialIndexingTimeMs: 0, incrementalIndexingTimeMs: 0, filesIndexed: 0, symbolsIndexed: 0, dependencyEdges: 0, invalidations: [], fallbacks: [], queries: 0, queryLatencyMs: 0, indexMode: "fallback" };
	constructor(options: RepositoryIntelligenceOptions = {}) { this.root = path.resolve(options.root ?? process.cwd()); this.#cacheEnabled = options.cache !== false && process.env[REPOSITORY_INTELLIGENCE_CACHE_ENV] !== "0"; this.#maxIndexedFiles = options.maxIndexedFiles ?? 20_000; this.#symbolProvider = options.symbolProvider; }
	get profile() { return this.#profile; }
	get dependencies() { return this.#dependencies as readonly RepositoryDependencyEdge[]; }
	get symbols() { return this.#symbols as readonly RepositorySymbolRecord[]; }
	get telemetry() { return { ...this.#telemetry, invalidations: [...this.#telemetry.invalidations], fallbacks: [...this.#telemetry.fallbacks] }; }

	async refresh(mode: "auto" | "full" | "incremental" = "auto"): Promise<RepositoryProfile> {
		const started = performance.now(); const file = cachePath(this.root); let cached: CachePayload | undefined;
		if (this.#cacheEnabled && mode !== "full") { try { const value = JSON.parse(await fs.readFile(file, "utf8")) as CachePayload; if (value.schemaVersion === REPOSITORY_INTELLIGENCE_SCHEMA_VERSION && path.resolve(value.profile.identity.root) === this.root) cached = value; } catch { this.#telemetry.cacheMissReason = "cache unavailable"; } }
		const git = await discoverGit(this.root);
		if (cached && mode === "auto" && !git.state.dirty && git.headRevision && cached.profile.lastIndexedState.headRevision === git.headRevision) {
			this.#profile = { ...cached.profile, gitState: git.state, lastIndexedState: { ...cached.profile.lastIndexedState, cacheHit: true, indexedAt: Date.now(), invalidations: [] } };
			this.#files = cached.files; this.#dependencies = cached.dependencies; this.#symbols = cached.symbols;
			this.#telemetry = { ...this.#telemetry, cacheHit: true, incrementalIndexingTimeMs: performance.now() - started, filesIndexed: 0, symbolsIndexed: cached.symbols.length, dependencyEdges: cached.dependencies.length, indexMode: "cache", invalidations: [] };
			return this.#profile;
		}
		if (!cached && !git.state.branch && git.state.changedFiles.length === 0) { this.#profile = fallbackProfile(this.root, git.state); this.#telemetry = { ...this.#telemetry, indexMode: "fallback", fallbacks: [...this.#telemetry.fallbacks, "not a git repository"] }; return this.#profile; }
		const changed = new Set(git.state.changedFiles.map(normalizePath));
		const structuralChange = !cached || mode === "full" || git.state.changedFiles.length > Math.max(25, Math.floor((cached.profile.lastIndexedState.fileCount || 1) * 0.15)) || [...changed].some(item => STRUCTURAL_FILE.test(path.posix.basename(item)));
		let files: string[];
		let manifests: Array<{ path: string; json: Record<string, unknown> }>;
		let invalidations: string[] = [];
		if (cached && !structuralChange) {
			const retained = new Set(cached.files.map(item => item.path));
			for (const item of changed) retained.add(item);
			const deleted = git.state.changedFiles.filter(item => (git.state.stagedFiles.includes(item) || git.state.unstagedFiles.includes(item)) && !git.state.untrackedFiles.includes(item));
			for (const item of deleted) { try { await fs.stat(path.join(this.root, item)); } catch { retained.delete(item); } }
			files = [...retained].sort().slice(0, this.#maxIndexedFiles);
			manifests = cached.profile.workspacePackages.filter(item => item.manifest).map(item => ({ path: item.manifest!, json: { name: item.name, scripts: item.scripts, dependencies: Object.fromEntries(item.dependencies.map(name => [name, "cached"])), devDependencies: Object.fromEntries(item.devDependencies.map(name => [name, "cached"])) } }));
			if (git.state.changedFiles.length) invalidations.push("changed-file metadata");
		} else {
			const listed = await fullFiles(this.root, this.#maxIndexedFiles);
			if (!listed) { this.#profile = cached?.profile ?? fallbackProfile(this.root, git.state); this.#telemetry = { ...this.#telemetry, indexMode: "fallback", fallbacks: [...this.#telemetry.fallbacks, "git ls-files unavailable"] }; return this.#profile; }
			files = listed; manifests = [];
			for (const manifest of files.filter(item => path.posix.basename(item) === "package.json")) { const json = await readManifest(this.root, manifest); if (json) manifests.push({ path: manifest, json }); }
			if (cached) invalidations.push("structural repository state changed");
		}
		const snapshot: RepositorySnapshot = { root: this.root, files, rootFiles: files.filter(item => !item.includes("/")), packageManifests: manifests, lockfiles: files.filter(item => /(?:^|\/)(bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|Cargo\.lock|poetry\.lock|uv\.lock|go\.mod|go\.sum)$/.test(item)), configFiles: files.filter(item => classifyPath(item) === "CONFIG"), branch: git.state.branch, git: git.state, headRevision: git.headRevision };
		const built = cached && !structuralChange ? { profile: { ...cached.profile, gitState: git.state }, records: cached.files.filter(item => files.includes(item.path)) } : buildProfile(this.root, snapshot);
		const indexFiles = structuralChange ? files : [...changed].filter(item => files.includes(item)); const known = new Set(files);
		const oldDependencies = cached?.dependencies.filter(edge => files.includes(edge.from) && files.includes(edge.to) && !indexFiles.includes(edge.from)) ?? [];
		const oldSymbols = cached?.symbols.filter(symbol => files.includes(symbol.path) && !indexFiles.includes(symbol.path)) ?? [];
		const dependencies = [...oldDependencies], symbols = [...oldSymbols]; let indexed = 0;
		for (const item of indexFiles.filter(value => Boolean(languageFor(value)))) {
			const content = await readText(this.root, item); if (content === undefined) continue; indexed++;
			const dir = path.posix.dirname(item); const add = (specifier: string, kind: "import" | "require") => { if (!specifier.startsWith(".")) return; const base = normalizePath(path.posix.normalize(path.posix.join(dir, specifier))); const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`, `${base}/index.ts`, `${base}/index.js`]; const target = candidates.find(candidate => known.has(candidate)); if (target && target !== item) dependencies.push({ from: item, to: target, kind }); };
			for (const match of content.matchAll(/\bimport\s+(?:type\s+)?(?:[^"']+from\s+)?["']([^"']+)["']/g)) add(match[1], "import");
			for (const match of content.matchAll(/\bexport\s+[^"']*?from\s+["']([^"']+)["']/g)) add(match[1], "import");
			for (const match of content.matchAll(/\b(?:require|import)\(\s*["']([^"']+)["']\s*\)/g)) add(match[1], "require");
			const provided = this.#symbolProvider?.indexFileSymbols ? await this.#symbolProvider.indexFileSymbols(item).catch(() => []) : [];
			if (provided.length) symbols.push(...provided);
			else {
				const patterns: Array<[RegExp, RepositorySymbolKind]> = [[/\b(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g, "class"], [/\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g, "interface"], [/\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/g, "type"], [/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, "function"], [/\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g, "function"]];
				for (const [pattern, kind] of patterns) for (const match of content.matchAll(pattern)) symbols.push({ name: match[1], path: item, line: content.slice(0, match.index ?? 0).split("\n").length, kind, source: "text" });
			}
		}
		const records = await Promise.all(built.records.map(record => indexFiles.includes(record.path) ? statRecord(this.root, record) : Promise.resolve(record)));
		const profile = built.profile; profile.gitState = git.state; profile.lastIndexedState = { indexedAt: Date.now(), headRevision: git.headRevision, structuralFingerprint: structuralFingerprint(snapshot), fileCount: files.length, cacheHit: Boolean(cached && !structuralChange), invalidations };
		this.#profile = profile; this.#files = records; this.#dependencies = dependencies.filter((edge, i, all) => all.findIndex(other => other.from === edge.from && other.to === edge.to && other.kind === edge.kind) === i); this.#symbols = symbols.filter((item, i, all) => all.findIndex(other => other.name === item.name && other.path === item.path && other.line === item.line) === i);
		const elapsed = performance.now() - started; this.#telemetry = { ...this.#telemetry, cacheHit: Boolean(cached && !structuralChange), initialIndexingTimeMs: cached ? this.#telemetry.initialIndexingTimeMs : elapsed, incrementalIndexingTimeMs: cached ? elapsed : 0, filesIndexed: indexed, symbolsIndexed: this.#symbols.length, dependencyEdges: this.#dependencies.length, invalidations, indexMode: structuralChange ? "full" : "incremental" };
		if (this.#cacheEnabled) { const payload: CachePayload = { schemaVersion: REPOSITORY_INTELLIGENCE_SCHEMA_VERSION, profile, files: records, dependencies: this.#dependencies, symbols: this.#symbols, structuralInputs: [...snapshot.configFiles, ...snapshot.lockfiles] }; try { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(payload), "utf8"); } catch { this.#telemetry.fallbacks.push("cache write failed"); } }
		return profile;
	}

	findProjectFacts(task = "", complexity: TaskComplexity = "NORMAL"): RepositoryQueryResult { const started = performance.now(); this.#telemetry.queries++; const result = this.#profile ? queryProfile(this.#profile, task, complexity, this.#files) : { facts: [], files: [], workspaces: [], symbols: [], confidence: 0 }; this.#telemetry.queryLatencyMs += performance.now() - started; return result; }
	findFileOwners(files: readonly string[]) { if (!this.#profile) return []; const normalized = files.map(normalizePath); return this.#profile.workspacePackages.filter(workspace => workspace.root === "." || normalized.some(file => file === workspace.root || file.startsWith(`${workspace.root}/`))); }
	findWorkspaceForFile(file: string) { return this.findFileOwners([file]).sort((a, b) => b.root.length - a.root.length)[0]; }
	findLikelyEntryPoints(task = "") { if (!this.#profile) return []; const terms = task.toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean); return [...this.#profile.entryPoints].sort((a, b) => (terms.some(term => b.path.toLowerCase().includes(term)) ? 1 : 0) + b.confidence - ((terms.some(term => a.path.toLowerCase().includes(term)) ? 1 : 0) + a.confidence)); }
	findRelevantTests(files: readonly string[], task = "") { if (!this.#profile) return []; const names = files.map(file => path.posix.basename(normalizePath(file)).replace(/\.[^.]+$/, "").toLowerCase()); return this.#files.filter(item => item.kind === "TEST").map(item => item.path).sort((a, b) => { const score = (file: string) => names.reduce((sum, name) => sum + (file.toLowerCase().includes(name) ? 3 : 0), 0) + (task && file.toLowerCase().includes(task.toLowerCase().split(/\s+/)[0] ?? "") ? 1 : 0); return score(b) - score(a); }).slice(0, 20); }
	findDependencies(file: string) { const normalized = normalizePath(file); return this.#dependencies.filter(edge => edge.from === normalized).map(edge => edge.to); }
	findDependents(file: string) { const normalized = normalizePath(file); return this.#dependencies.filter(edge => edge.to === normalized).map(edge => edge.from); }
	async findSymbolDefinition(symbol: string) { return this.#symbolProvider?.findSymbolDefinition ? this.#symbolProvider.findSymbolDefinition(symbol) : this.#symbols.filter(item => item.name === symbol); }
	async findSymbolReferences(symbol: string) { return this.#symbolProvider?.findSymbolReferences ? this.#symbolProvider.findSymbolReferences(symbol) : this.#symbols.filter(item => item.name === symbol); }
	getTaskRepositorySignals(task = ""): TaskRepositorySignals { if (!this.#profile) return { knownUncertainty: true }; const facts = queryProfile(this.#profile, task, "NORMAL", this.#files); const size = this.#profile.lastIndexedState.fileCount < 500 ? "small" : this.#profile.lastIndexedState.fileCount < 5000 ? "medium" : "large"; return { repositorySize: size, projectType: this.#profile.languages.length > 1 ? `${this.#profile.languages.join("/")} repository` : this.#profile.languages[0], framework: this.#profile.frameworks[0], hasTests: this.#profile.testRoots.length > 0 || this.#profile.testFramework.length > 0, relevantFileCount: facts.files.length, subsystemCount: this.#profile.importantDirectories.length, crossesSubsystems: this.#profile.importantDirectories.length > 3 && facts.files.length > 2, knownUncertainty: this.#profile.languages.length === 0 }; }
	getRelevantFacts(task: string, complexity: TaskComplexity) { if (!this.#profile) return ""; const result = queryProfile(this.#profile, task, complexity, this.#files); const tests = result.files.flatMap(file => this.findRelevantTests([file], task)).slice(0, 6); return [...result.facts, ...(result.files.length ? [`relevant: ${result.files.slice(0, 12).join(", ")}`] : []), ...(tests.length ? [`tests: ${tests.join(", ")}`] : [])].slice(0, complexity === "SIMPLE" ? 8 : complexity === "NORMAL" ? 14 : 24).join("\n"); }
}

function cachePath(root: string): string { const digest = crypto.createHash("sha256").update(root).digest("hex").slice(0, 24); const base = process.env.XDG_CACHE_HOME || process.env.LOCALAPPDATA || path.join(os.homedir(), ".cache"); return path.join(base, "omp-ultra", "repositories", digest, "repository-index.json"); }
export function createRepositoryIntelligence(options: RepositoryIntelligenceOptions = {}) { return new RepositoryIntelligence(options); }
