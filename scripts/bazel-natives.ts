#!/usr/bin/env bun
/**
 * Canonical Bazel driver for the shipping pi_natives addons.
 *
 * Usage: bun scripts/bazel-natives.ts <target>... [--dest <dir>] [--source <dir>] [-- <extra bazel args>]
 *
 * Targets are the //:natives-* names from BUILD.bazel (e.g. linux-x64-baseline,
 * darwin-arm64) plus three pseudo-targets:
 *   - host        the single addon matching this machine (x64 hosts pick
 *                 modern vs baseline via AVX2 detection)
 *   - linux-all   every addon buildable from a linux-x64 host (incl. win32)
 *   - darwin-all  both darwin addons (mac hosts only)
 *
 * One `bazel build` covers all requested targets; outputs are located via
 * `bazel cquery --output=files` (falling back to the bazel-bin path convention)
 * and copied dereferenced into --dest (default packages/natives/native).
 *
 * Extra args after `--` are passed to bazel verbatim (cache configs, endpoints,
 * headers — see .bazelrc for the cache-rw/cache-ro policy configs).
 *
 * The `host` pseudo-target builds through the local Cargo/N-API path
 * (packages/natives/scripts/build-bindings.ts) by default — no bazel needed
 * for plain host iteration. Bazel is opt-in for host via
 * `OMP_NATIVE_BUILD_BACKEND=bazel` or by passing extra bazel args after `--`;
 * explicit //:natives-* targets and aggregates always build through bazel.
 * Release CI uses that path except for Windows ARM64, which builds `host`
 * natively on its GitHub-hosted runner.
 *
 * Windows hosts: the msvc cc toolchain in bazel/toolchains/msvc only supports
 * linux/mac exec hosts (its clang-cl+xwin wrappers replace the MSVC a Windows
 * box already has), so a win32 host cannot run any bazel addon build. `host`
 * always uses the local napi build there (against installed VS Build Tools);
 * every other target on a win32 host fails fast with guidance.
 *
 * Note: musl addons intentionally reuse the plain linux-<arch> filenames, so a
 * `linux-all` copy overwrites the gnu addon with the musl one (and vice versa);
 * CI jobs that ship files always request an explicit disjoint target set.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { detectHostAvx2Support, resolveLocalHostAddon } from "./host-detect";

const repoRoot = path.join(import.meta.dir, "..");

/** //:natives-<name> → canonical addon filename (mirrors _ADDONS in BUILD.bazel). */
export const ADDON_OUTPUTS: Record<string, string> = {
	"linux-x64-baseline": "pi_natives.linux-x64-baseline.node",
	"linux-x64-modern": "pi_natives.linux-x64-modern.node",
	"linux-arm64": "pi_natives.linux-arm64.node",
	"linux-musl-x64-baseline": "pi_natives.linux-x64-baseline.node",
	"linux-musl-arm64": "pi_natives.linux-arm64.node",
	"darwin-x64-baseline": "pi_natives.darwin-x64-baseline.node",
	"darwin-arm64": "pi_natives.darwin-arm64.node",
	"win32-x64-baseline": "pi_natives.win32-x64-baseline.node",
};

/** Aggregate filegroups → their member addon targets (mirrors BUILD.bazel). */
export const AGGREGATE_TARGETS: Record<string, string[]> = {
	"linux-all": [
		"linux-arm64",
		"linux-musl-arm64",
		"linux-musl-x64-baseline",
		"linux-x64-baseline",
		"linux-x64-modern",
		"win32-x64-baseline",
	],
	"darwin-all": ["darwin-arm64", "darwin-x64-baseline"],
};

export interface HostInfo {
	platform: string;
	arch: string;
	avx2: boolean;
}

/** The single addon target matching the host CPU (modern iff x64 + AVX2). */
export function hostTargetName(host: HostInfo): string {
	if (host.platform === "darwin") {
		if (host.arch === "arm64") return "darwin-arm64";
		if (host.arch === "x64") return "darwin-x64-baseline";
	}
	if (host.platform === "linux") {
		if (host.arch === "arm64") return "linux-arm64";
		if (host.arch === "x64") return host.avx2 ? "linux-x64-modern" : "linux-x64-baseline";
	}
	if (host.platform === "win32" && host.arch === "x64") return "win32-x64-baseline";
	throw new Error(`No pi_natives addon target for host ${host.platform}-${host.arch}`);
}

/** Expand pseudo-targets and map names to //:natives-* labels (deduplicated). */
export function resolveTargetLabels(names: string[], host: HostInfo): string[] {
	const labels: string[] = [];
	for (const name of names) {
		const resolved = name === "host" ? hostTargetName(host) : name;
		if (!(resolved in AGGREGATE_TARGETS) && !(resolved in ADDON_OUTPUTS)) {
			const known = [...Object.keys(ADDON_OUTPUTS), ...Object.keys(AGGREGATE_TARGETS), "host"].join(", ");
			throw new Error(`Unknown native target "${name}". Known targets: ${known}`);
		}
		const label = `//:natives-${resolved}`;
		if (!labels.includes(label)) labels.push(label);
	}
	return labels;
}

/**
 * Workspace-relative output paths by bazel-bin convention:
 * bazel-bin/natives-<t>/<canonical>.node. Fallback when cquery is unavailable.
 */
export function conventionOutputPaths(names: string[], host: HostInfo): string[] {
	const paths: string[] = [];
	for (const name of names) {
		const resolved = name === "host" ? hostTargetName(host) : name;
		const members = AGGREGATE_TARGETS[resolved] ?? [resolved];
		for (const member of members) {
			const out = ADDON_OUTPUTS[member];
			if (!out) throw new Error(`Unknown native target "${name}"`);
			const p = `bazel-bin/natives-${member}/${out}`;
			if (!paths.includes(p)) paths.push(p);
		}
	}
	return paths;
}

/** Parse `bazel cquery --output=files` stdout into deduplicated .node paths. */
export function parseBazelFilesOutput(output: string): string[] {
	const files: string[] = [];
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.endsWith(".node")) continue;
		if (!files.includes(trimmed)) files.push(trimmed);
	}
	return files;
}

/** Parsed options for the native addon build and artifact install modes. */
export interface CliOptions {
	targets: string[];
	dest: string | null;
	source: string | null;
	bazelArgs: string[];
}

/** Parse target names and the mutually exclusive build or artifact source options. */
export function parseCliArgs(argv: string[]): CliOptions {
	const targets: string[] = [];
	let dest: string | null = null;
	let source: string | null = null;
	const bazelArgs: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			bazelArgs.push(...argv.slice(i + 1));
			break;
		}
		if (arg === "--dest" || arg === "--source") {
			const value = argv[++i];
			if (!value) throw new Error(`${arg} requires a directory argument`);
			if (arg === "--dest") {
				dest = value;
			} else {
				source = value;
			}
			continue;
		}
		if (arg.startsWith("-")) {
			throw new Error(`Unknown flag ${arg} (extra bazel args go after \`--\`)`);
		}
		targets.push(arg);
	}
	if (targets.length === 0) {
		throw new Error(
			"Usage: bun scripts/bazel-natives.ts <target>... [--dest <dir>] [--source <dir>] [-- <extra bazel args>]",
		);
	}
	if (source && bazelArgs.length > 0) {
		throw new Error("--source cannot be combined with extra bazel arguments");
	}
	return { targets, dest, source, bazelArgs };
}

function resolveBazelBinary(): string | null {
	return Bun.which("bazelisk") ?? Bun.which("bazel");
}

const STDERR_TAIL_LINES = 40;

/** Run a bazel command streaming stderr live while keeping a tail for the failure report. */
async function runBazel(
	bin: string,
	args: string[],
	stdout: "inherit" | "pipe",
): Promise<{ exitCode: number; stdout: string; stderrTail: string }> {
	const proc = Bun.spawn([bin, ...args], { cwd: repoRoot, stdout, stderr: "pipe" });
	const decoder = new TextDecoder();
	let tail = "";
	const pumpStderr = (async () => {
		for await (const chunk of proc.stderr) {
			const text = decoder.decode(chunk, { stream: true });
			process.stderr.write(text);
			tail = (tail + text)
				.split("\n")
				.slice(-STDERR_TAIL_LINES - 1)
				.join("\n");
		}
	})();
	const stdoutText = stdout === "pipe" ? await new Response(proc.stdout as ReadableStream).text() : "";
	const exitCode = await proc.exited;
	await pumpStderr;
	return { exitCode, stdout: stdoutText, stderrTail: tail };
}

async function installAddon(sourcePath: string, destPath: string): Promise<void> {
	const realSource = await fs.realpath(sourcePath); // bazel-bin outputs are symlink-reachable; copy the real bytes
	const tempPath = `${destPath}.tmp.${process.pid}`;
	await fs.copyFile(realSource, tempPath);
	await fs.chmod(tempPath, 0o644);
	try {
		await fs.rename(tempPath, destPath); // atomic even if dest is a loaded addon
	} catch (err) {
		await fs.unlink(tempPath).catch(() => {});
		throw err;
	}
}

/** Build and install the host addon through the local Cargo/N-API path. */
async function buildLocalHostAddon(host: HostInfo, destDir: string): Promise<void> {
	const script = path.join(repoRoot, "packages/natives/scripts/build-bindings.ts");
	console.log(`local host build: using ${path.relative(repoRoot, script)}`);
	const proc = Bun.spawn([process.execPath, script], {
		cwd: repoRoot,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) process.exit(exitCode || 1);

	const filename = resolveLocalHostAddon(host).filename;
	const builtPath = path.join(repoRoot, "packages/natives/native", filename);
	if (path.dirname(builtPath) !== destDir) {
		await fs.mkdir(destDir, { recursive: true });
		await installAddon(builtPath, path.join(destDir, filename));
	}
	console.log(`installed ${filename} → ${path.join(destDir, filename)}`);
}

async function main(): Promise<void> {
	const options = parseCliArgs(process.argv.slice(2));
	const host: HostInfo = { platform: process.platform, arch: process.arch, avx2: detectHostAvx2Support() };
	const destDir = options.dest ? path.resolve(options.dest) : path.join(repoRoot, "packages/natives/native");

	const backend = Bun.env.OMP_NATIVE_BUILD_BACKEND?.trim();
	if (backend && backend !== "cargo" && backend !== "bazel") {
		throw new Error(`Unknown OMP_NATIVE_BUILD_BACKEND "${backend}" (expected "cargo" or "bazel")`);
	}
	const hostOnly = options.targets.length === 1 && options.targets[0] === "host";
	// Backend selection: the host build defaults to the local Cargo/N-API
	// path; bazel is opt-in for host via OMP_NATIVE_BUILD_BACKEND=bazel or
	// extra bazel args after `--`. Explicit //:natives-* targets always go
	// through bazel. win32 hosts can only build `host`, locally (see the msvc
	// toolchain note in the header).
	const cargoBackend =
		backend === "cargo" ||
		host.platform === "win32" ||
		(backend !== "bazel" && hostOnly && options.bazelArgs.length === 0);
	if (cargoBackend && !options.source) {
		if (!hostOnly) {
			if (host.platform === "win32") {
				throw new Error(
					`Cannot bazel-build [${options.targets.join(", ")}] on a Windows host: the msvc cross ` +
						"toolchain (bazel/toolchains/msvc) only runs on linux/mac exec hosts. Use `host` here " +
						"(local napi build via VS Build Tools), or run this script from WSL/linux for cross targets.",
				);
			}
			throw new Error("OMP_NATIVE_BUILD_BACKEND=cargo supports only the host target");
		}
		await buildLocalHostAddon(host, destDir);
		return;
	}
	let outputs: string[];

	if (options.source) {
		const sourceDir = path.resolve(options.source);
		outputs = conventionOutputPaths(options.targets, host).map(output =>
			path.join(sourceDir, path.relative("bazel-bin", output)),
		);
	} else {
		const labels = resolveTargetLabels(options.targets, host);
		const bazel = resolveBazelBinary();
		if (!bazel) {
			if (options.targets.length !== 1 || options.targets[0] !== "host") {
				throw new Error(
					`Neither \`bazelisk\` nor \`bazel\` found on PATH; Cargo fallback supports only the host target, not [${options.targets.join(", ")}]. ` +
						"Install bazelisk or request `host` for a local Cargo/N-API build.",
				);
			}
			console.log("bazelisk/bazel not found; falling back to the local Cargo/N-API host build");
			await buildLocalHostAddon(host, destDir);
			return;
		}
		// CI hands cache wiring (remote or disk) through a bazelrc fragment so
		// endpoint composition stays in .github/actions/bazel-cache.
		const rcPath = Bun.env.OMP_BAZEL_RC?.trim();
		const startupArgs = rcPath ? [`--bazelrc=${rcPath}`] : [];

		const buildArgs = [...startupArgs, "build", ...options.bazelArgs, "--", ...labels];
		console.log(`$ ${path.basename(bazel)} ${buildArgs.join(" ")}`);
		const build = await runBazel(bazel, buildArgs, "inherit");
		if (build.exitCode !== 0) {
			console.error(`\nbazel build failed (exit ${build.exitCode}). stderr tail:\n${build.stderrTail}`);
			process.exit(build.exitCode || 1);
		}

		// Same flags as the build so cquery resolves the identical configuration.
		// cquery takes exactly one query expression, so multiple targets join
		// into a single union rather than positional args.
		const cquery = await runBazel(
			bazel,
			[...startupArgs, "cquery", ...options.bazelArgs, "--output=files", labels.join(" + ")],
			"pipe",
		);
		if (cquery.exitCode === 0) {
			outputs = parseBazelFilesOutput(cquery.stdout);
		} else {
			console.warn(`bazel cquery failed (exit ${cquery.exitCode}); falling back to bazel-bin path convention`);
			outputs = conventionOutputPaths(options.targets, host);
		}
		if (outputs.length === 0) {
			console.error("bazel build succeeded but no .node outputs were located");
			process.exit(1);
		}
	}

	const seen = new Map<string, string>();
	for (const output of outputs) {
		const base = path.basename(output);
		const prior = seen.get(base);
		if (prior) {
			// gnu and musl x64/arm64 addons share canonical basenames by design;
			// installing both into one dest would silently clobber.
			console.error(
				`refusing to install ${output}: ${base} already provided by ${prior}. ` +
					"Build gnu and musl targets in separate invocations with separate --dest dirs.",
			);
			process.exit(1);
		}
		seen.set(base, output);
	}
	await fs.mkdir(destDir, { recursive: true });
	for (const output of outputs) {
		const absolute = path.isAbsolute(output) ? output : path.join(repoRoot, output);
		const destPath = path.join(destDir, path.basename(output));
		await installAddon(absolute, destPath);
		console.log(`installed ${path.basename(output)} → ${destPath}`);
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
