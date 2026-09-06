/**
 * Shell environment snapshot for preserving user aliases, functions, and options.
 *
 * Creates a snapshot file that captures the user's shell environment from their
 * .bashrc/.zshrc, which can be sourced before each command to provide a familiar
 * shell experience.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSafeProjectCwd, logger, postmortem } from "@oh-my-pi/pi-utils";
import fnEnvHelper from "./shell-snapshot-fn-env.sh" with { type: "text" };

const cachedSnapshotPaths = new Map<string, string>();
const SNAPSHOT_TIMEOUT_MS = 2_000;

/**
 * Characters that force brush's primitive alias expander down a path it does
 * not implement. brush-core resolves aliases via `value.split_ascii_whitespace()`
 * (`crates/vendor/brush-core/src/interp.rs:1500`, tracking
 * https://github.com/reubeno/brush/issues/57): the resulting pieces are dropped
 * into argv verbatim instead of going through the shell parser. Any alias body
 * containing subshells `(...)`, pipes `|`, redirections `<` `>`, separators
 * `;` `&`, or command substitutions `` ` `` turns the first whitespace-split
 * piece into the command name and produces `command not found: (alias;` style
 * failures (issue #3234, Fedora's default `which` alias is the canonical case).
 *
 * Until brush implements proper alias parsing we drop these from the snapshot;
 * brush then falls through to whatever lives on `PATH`, which is what the user
 * actually expected when they invoked `which` / `ls` / etc.
 */
const BRUSH_INCOMPATIBLE_ALIAS_BODY = /[()|&;<>`]/;

/** Matches `alias -- NAME='VALUE'` lines emitted by `generateSnapshotScript`. */
const SNAPSHOT_ALIAS_LINE = /^alias -- ([^\s=]+)='(.*)'\s*$/;

/**
 * Strip alias definitions brush's whitespace-only expander cannot execute.
 *
 * Returns the rewritten snapshot plus the list of dropped alias names so the
 * caller can surface them in the debug log.
 */
export function sanitizeSnapshotForBrush(content: string): { content: string; dropped: string[] } {
	const dropped: string[] = [];
	const lines = content.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		const m = line.match(SNAPSHOT_ALIAS_LINE);
		if (m) {
			// Decode the bash-quoting escape `'\''` → `'` so we test the real value.
			const value = m[2].replace(/'\\''/g, "'");
			if (BRUSH_INCOMPATIBLE_ALIAS_BODY.test(value)) {
				dropped.push(m[1]);
				continue;
			}
		}
		out.push(line);
	}
	return { content: out.join("\n"), dropped };
}

/**
 * Apply {@link sanitizeSnapshotForBrush} to the freshly generated snapshot
 * file. Best-effort: I/O failures here must not poison `getOrCreateSnapshot`.
 */
function scrubSnapshotInPlace(snapshotPath: string): void {
	try {
		const raw = fs.readFileSync(snapshotPath, "utf8");
		const { content, dropped } = sanitizeSnapshotForBrush(raw);
		if (dropped.length === 0) return;
		fs.writeFileSync(snapshotPath, content);
		logger.debug("shell-snapshot: dropped brush-incompatible aliases", { dropped });
	} catch (err) {
		logger.debug("shell-snapshot: scrub failed", { err: String(err) });
	}
}

function sanitizeSnapshotEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	const sanitized = { ...env };
	delete sanitized.BASH_ENV;
	delete sanitized.ENV;
	return sanitized;
}

/**
 * Get the user's shell config file path.
 *
 * Honours `env.HOME` when present so a caller can target a sandboxed/test
 * home, falling back to `os.homedir()` (which Bun resolves once at startup
 * and caches — `process.env.HOME` overrides don't affect it).
 */
function getShellConfigFile(shell: string, env: Record<string, string | undefined>): string {
	const home = env.HOME || os.homedir();
	if (shell.includes("zsh")) return path.join(home, ".zshrc");
	if (shell.includes("bash")) return path.join(home, ".bashrc");
	return path.join(home, ".profile");
}

/**
 * Generate the snapshot creation script.
 * This script sources the user's rc file and extracts functions, aliases, and options.
 * Matches Claude Code's snapshot generation logic.
 */
function generateSnapshotScript(shell: string, snapshotPath: string, rcFile: string): string {
	const hasRcFile = fs.existsSync(rcFile);
	const isZsh = shell.includes("zsh");
	const commonToolsRegex =
		"^(ls|dir|vdir|cat|head|tail|less|more|grep|egrep|fgrep|rg|find|fd|locate|sed|awk|perl|cp|mv|rm|mkdir|rmdir|touch|chmod|chown|ln|pwd|readlink|stat|cut|sort|uniq|xargs|tee|tr|basename|dirname)$";

	// Escape the snapshot path for shell
	const escapedPath = snapshotPath.replace(/'/g, "'\\''");

	// Function extraction differs between bash and zsh. Each form prints function
	// bodies on stdout so we can both persist them AND scan their bodies for
	// referenced env vars (issue #3470).
	const functionExtractor = isZsh
		? `# Force autoload all functions first
typeset -f > /dev/null 2>&1
# Get user function names - filter system/private ones
typeset +f 2>/dev/null | grep -vE '^(_|__)' | grep -vE '${commonToolsRegex}' | while read func; do
   typeset -f "$func" 2>/dev/null
done`
		: `# Force autoload all functions first
declare -f > /dev/null 2>&1
# Get user function names - filter system/private ones
declare -F 2>/dev/null | cut -d' ' -f3 | grep -vE '^(_|__)' | grep -vE '${commonToolsRegex}' | while read func; do
   declare -f "$func" 2>/dev/null
done`;

	// Shell options extraction
	const optionsScript = isZsh
		? `
echo "# Shell Options" >> "$SNAPSHOT_FILE"
setopt 2>/dev/null | sed 's/^/setopt /' | head -n 1000 >> "$SNAPSHOT_FILE"
`
		: `
echo "# Shell Options" >> "$SNAPSHOT_FILE"
shopt -p 2>/dev/null | head -n 1000 >> "$SNAPSHOT_FILE"
set -o 2>/dev/null | awk '$2 == "on" && $1 !~ /^(onecmd|monitor|restricted)$/ {print "set -o " $1}' | head -n 1000 >> "$SNAPSHOT_FILE"
echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"
`;

	return `
SNAPSHOT_FILE='${escapedPath}'

# Snapshot may inline env-var values referenced by captured functions (#3470).
# Defence in depth: (a) JS caller pre-creates the file at 0600 so the shell's
# \`>|\`/\`>>\` redirections truncate/append without changing the inode mode,
# (b) we \`umask 077\` before AND after sourcing the rc so any other file the
# script creates is private even when the rc resets umask to 022, (c) JS
# caller chmods file + dir after the script exits.
umask 077

# Source user's rc file if it exists
${hasRcFile ? `source "${rcFile}" < /dev/null 2>/dev/null` : "# No user config file to source"}

# Re-tighten umask in case the rc reset it (common \`.bashrc\`/\`.zshrc\` set
# \`umask 022\` for the interactive shell).
umask 077

# Create/clear the snapshot file
echo "# Shell snapshot - generated by omp agent" >| "$SNAPSHOT_FILE"

# Unalias everything first to avoid conflicts when sourced
echo "unalias -a 2>/dev/null || true" >> "$SNAPSHOT_FILE"

# Capture function definitions into a variable so we can both persist them
# and scan their bodies for env-var references (issue #3470).
__omp_funcs=$(
${functionExtractor}
)
echo "# Functions" >> "$SNAPSHOT_FILE"
printf '%s\\n' "$__omp_funcs" >> "$SNAPSHOT_FILE"

# Re-export uppercase identifiers referenced by snapshotted functions whose
# value is set in the rc-sourced shell. Without this, activation idioms like
# mise's \`mise()\` -> \`command "$__MISE_EXE" "$@"\` blow up because the helper
# var is lost (issue #3470). Helper definitions are POSIX-shell so the same
# block works for both bash and zsh.
echo "# Captured function environment" >> "$SNAPSHOT_FILE"
${fnEnvHelper}
printf '%s\\n' "$__omp_funcs" | __omp_emit_referenced_exports >> "$SNAPSHOT_FILE"
unset -f __omp_sq_quote __omp_emit_export_for __omp_emit_referenced_exports 2>/dev/null
unset __omp_funcs __omp_qbuf __omp_qout __omp_sq __omp_xv __omp_name 2>/dev/null

${optionsScript}

# Export aliases (limit to 1000)
echo "# Aliases" >> "$SNAPSHOT_FILE"
# Filter out winpty aliases on Windows to avoid "stdin is not a tty" errors
if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
   alias 2>/dev/null | grep -v "='winpty " | grep -vE '^alias (${commonToolsRegex})=' | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"
else
   alias 2>/dev/null | grep -vE '^alias (${commonToolsRegex})=' | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"
fi

# Export PATH
echo "export PATH='$PATH'" >> "$SNAPSHOT_FILE"

# Verify snapshot was created
if [ ! -f "$SNAPSHOT_FILE" ]; then
   echo "Error: Snapshot file was not created" >&2
   exit 1
fi
`.trim();
}

/**
 * Create a shell snapshot, caching the result.
 * Returns the path to the snapshot file, or null if creation failed.
 *
 * `timeoutMs` is configurable so callers exercising failure handling do not
 * have to wait out the production startup budget.
 */
export async function getOrCreateSnapshot(
	shell: string,
	env: Record<string, string | undefined>,
	timeoutMs = SNAPSHOT_TIMEOUT_MS,
): Promise<string | null> {
	const cacheKey = shell;
	// Return cached snapshot if valid
	const cached = cachedSnapshotPaths.get(cacheKey);
	if (cached && fs.existsSync(cached)) {
		return cached;
	}
	if (cached) {
		cachedSnapshotPaths.delete(cacheKey);
	}

	// Skip on Windows (no .bashrc in standard location)
	if (process.platform === "win32") {
		return null;
	}

	const rcFile = getShellConfigFile(shell, env);

	// Snapshot dir is per-uid. `os.tmpdir()` is shared between accounts on Linux and
	// this dir is 0700 because the script may inline env-var values referenced by
	// captured functions (#3470), so a single shared name hands the first account an
	// exclusive dir and every other account's pre-create write below fails with
	// EACCES — which used to escape into `executeBash` and break every bash call.
	const uid = process.getuid?.();
	const snapshotDir = path.join(os.tmpdir(), uid === undefined ? "omp-shell-snapshots" : `omp-shell-snapshots-${uid}`);

	// Generate unique snapshot path
	const shellName = shell.includes("zsh") ? "zsh" : shell.includes("bash") ? "bash" : "sh";
	const snapshotPath = path.join(snapshotDir, `snapshot-${shellName}-${crypto.randomUUID()}.sh`);

	try {
		fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
		// `mode` only applies to a fresh mkdir; an existing dir keeps its mode, so
		// chmod it defensively. Ignore EPERM (dir owned by another account).
		try {
			fs.chmodSync(snapshotDir, 0o700);
		} catch {
			// best-effort
		}
		// Pre-create the snapshot file at 0600 so the shell's `>|` (truncate) and
		// `>>` (append) redirections inside `generateSnapshotScript` operate on an
		// existing inode and preserve the private mode, regardless of the umask
		// state inside the spawned shell. Without this, a `.bashrc` that sets
		// `umask 022` (the typical interactive default) before the script's first
		// redirection would create the file world-readable; the JS-side post-spawn
		// chmod would tighten it, but only after the shell finished writing every
		// captured env value to disk.
		fs.writeFileSync(snapshotPath, "", { mode: 0o600 });
	} catch (err) {
		// Unusable snapshot dir (foreign owner, read-only or full /tmp): run without
		// a snapshot instead of failing the caller's command.
		logger.debug("shell-snapshot: snapshot dir unusable", { dir: snapshotDir, err: String(err) });
		return null;
	}

	// Generate and execute snapshot script
	const script = generateSnapshotScript(shell, snapshotPath, rcFile);

	let succeeded = false;
	try {
		const snapshotEnv = sanitizeSnapshotEnv(env);
		const spawnEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(snapshotEnv)) {
			if (value !== undefined) {
				spawnEnv[key] = value;
			}
		}
		const child = Bun.spawn([shell, "-c", script], {
			cwd: getSafeProjectCwd(),
			env: spawnEnv,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});

		await child.exited;
		if (child.exitCode === 0 && fs.existsSync(snapshotPath)) {
			// Defence-in-depth: the script's `umask 077` already locks the file at
			// first write, but chmod again in case the umask didn't take (exotic
			// shells) or a postmortem-restored file ended up looser.
			try {
				fs.chmodSync(snapshotPath, 0o600);
			} catch {
				// best-effort
			}
			scrubSnapshotInPlace(snapshotPath);
			cachedSnapshotPaths.set(cacheKey, snapshotPath);
			succeeded = true;
			return snapshotPath;
		}
	} catch {
		// Snapshot creation failed, proceed without it
	} finally {
		if (!succeeded) {
			try {
				fs.rmSync(snapshotPath, { force: true });
			} catch {
				// best-effort cleanup; force: true ignores ENOENT
			}
		}
	}

	return null;
}

postmortem.register("shell-snapshot", () => {
	for (const snapshotPath of cachedSnapshotPaths.values()) {
		fs.unlinkSync(snapshotPath);
	}
	cachedSnapshotPaths.clear();
});
