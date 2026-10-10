/**
 * In-session `/update`.
 *
 * The install itself stays in `omp update` (`runUpdateCommand`): that path already
 * replaces the on-PATH binary, bun/npm global, Homebrew, or mise install in place,
 * and refuses Nix and externally managed copies. This module runs that command in
 * a child so its `console` output and `process.exit` cannot take down the TUI, and
 * wraps it in two single-key prompts:
 *
 *   1. `omp update --check` → "Update 18.8.7 → 18.9.0?"  [y/n]
 *   2. `omp update`         → "Restart now?"             [y/n]
 *
 * Restart reuses `/restart`. A session started from a source checkout, or from a
 * compiled binary that is not the PATH entry, would relaunch itself rather than the
 * install that was just replaced, so the prompt relaunches the installed omp instead.
 */
import * as fs from "node:fs";
import { $which, isCompiledBinary } from "@oh-my-pi/pi-utils";
import { isSourceCheckout } from "../../cli/update-cli";
import { resolveCliEntryCmd, workerEnvFromParent } from "../../subprocess/worker-client";

const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;
const VERSION = String.raw`(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`;
const KNOWN_FLAGS: Record<string, true> = {
	"--check": true,
	"-c": true,
	"--force": true,
	"-f": true,
	"--canary": true,
	"--stable": true,
};
const SUMMARY_LINE_LIMIT = 6;
const SUMMARY_CHAR_LIMIT = 1_500;
/** The updater's own "restart" advice; `/update` asks instead of telling. */
const RESTART_ADVICE = /^Restart omp to use the new version$/;

export const SESSION_UPDATE_USAGE = "Usage: /update [--check] [--force] [--canary|--stable]";

/** Single-key answers for a Yes/No dialog. */
export const YES_NO_PROMPT = {
	hotkeys: { y: "Yes", n: "No" },
	helpText: "y yes  n no  esc cancel",
} as const;

export interface InstallIdentity {
	sourceCheckout: boolean;
	compiled: boolean;
	/** Real path of this process when it is a compiled binary. */
	selfPath?: string;
	/** Real path of the `omp` PATH entry the updater replaces. */
	installedPath?: string;
}

export interface UpdateSpawnResult {
	exitCode: number;
	output: string;
}

export type UpdateTranscript =
	| { kind: "failed"; detail: string }
	| { kind: "blocked" }
	| { kind: "up-to-date" }
	| { kind: "available"; version: string; current?: string }
	| { kind: "updated"; version: string }
	| { kind: "unverified" }
	| { kind: "finished" };

/** What `/update` needs from the interactive session. */
export interface SessionUpdateUi {
	status(message: string): void;
	/** Single-key Yes/No; resolves false on No or cancel. */
	confirm(title: string, message: string): Promise<boolean>;
	/** Relaunch resuming this session; `entry` replaces the command that re-enters the CLI. */
	restart(entry?: string[]): Promise<void>;
}

export function parseSessionUpdateArgs(args: string): { error: string } | { flags: string[] } {
	const tokens = args.trim() === "" ? [] : args.trim().split(/\s+/);
	for (const token of tokens) {
		if (KNOWN_FLAGS[token] !== true) return { error: `Unknown /update option "${token}". ${SESSION_UPDATE_USAGE}` };
	}
	if (tokens.includes("--canary") && tokens.includes("--stable")) {
		return { error: "--canary and --stable are mutually exclusive" };
	}
	return { flags: tokens };
}

function plainLines(output: string): string[] {
	return output
		.replace(ANSI_ESCAPE, "")
		.replace(/\r/g, "")
		.split("\n")
		.map(line => line.trimEnd())
		.filter(line => line.trim().length > 0);
}

/** Classify an `omp update` transcript. */
export function classifyUpdateTranscript(exitCode: number, output: string): UpdateTranscript {
	const lines = plainLines(output);
	const text = lines.join("\n");
	if (exitCode !== 0) {
		return {
			kind: "failed",
			detail: lines.length > 0 ? lines[lines.length - 1]!.trim() : `update exited ${exitCode}`,
		};
	}
	if (
		/kept up to date by/.test(text) ||
		/cannot update itself/.test(text) ||
		/Canary updates are only supported/.test(text) ||
		/Refusing to replace/.test(text)
	) {
		return { kind: "blocked" };
	}
	const updated = text.match(new RegExp(`Updated to ${VERSION}`));
	if (updated) return { kind: "updated", version: updated[1]! };
	if (/Warning:/.test(text)) return { kind: "unverified" };
	if (/Already up to date/.test(text)) return { kind: "up-to-date" };
	const available = text.match(
		new RegExp(`(?:New version available:|Forcing reinstall of|Switching to (?:stable|canary)) ${VERSION}`),
	);
	if (available) {
		return {
			kind: "available",
			version: available[1]!,
			current: text.match(new RegExp(`Current version: ${VERSION}`))?.[1],
		};
	}
	return { kind: "finished" };
}

/**
 * Whether relaunching this process loads the install `omp update` replaced.
 * Package-manager sessions re-enter their installed entry; a source checkout and a
 * compiled binary that is not the PATH entry do not.
 */
export function restartLoadsUpdate(identity: InstallIdentity): boolean {
	if (identity.sourceCheckout) return false;
	if (!identity.compiled) return true;
	return (
		identity.selfPath !== undefined &&
		identity.installedPath !== undefined &&
		identity.selfPath === identity.installedPath
	);
}

export function currentInstallIdentity(): InstallIdentity {
	const installed = $which("omp") ?? undefined;
	const compiled = isCompiledBinary();
	return {
		sourceCheckout: isSourceCheckout(),
		compiled,
		selfPath: compiled ? existingRealPath(process.execPath) : undefined,
		installedPath: installed ? existingRealPath(installed) : undefined,
	};
}

/** The updater's last few lines, without its own restart advice. */
function summarize(output: string): string {
	const tail = plainLines(output)
		.filter(line => !RESTART_ADVICE.test(line.trim()))
		.slice(-SUMMARY_LINE_LIMIT)
		.join("\n");
	return tail.length > SUMMARY_CHAR_LIMIT ? tail.slice(tail.length - SUMMARY_CHAR_LIMIT) : tail;
}

/**
 * Run `/update`: check, ask, install, ask whether to restart.
 *
 * `--check` stops after the first step. Every refusal (managed install, Nix, already
 * current) and failure is reported verbatim and never prompts.
 */
export async function runSessionUpdate(options: {
	flags: readonly string[];
	ui: SessionUpdateUi;
	identity?: InstallIdentity;
	spawn?: (cmd: string[]) => Promise<UpdateSpawnResult>;
}): Promise<void> {
	const { ui } = options;
	const spawn = options.spawn ?? spawnInstalledUpdate;
	const checkOnly = options.flags.includes("--check") || options.flags.includes("-c");
	const installFlags = options.flags.filter(flag => flag !== "--check" && flag !== "-c");
	const argv = (flags: readonly string[]) => [...resolveCliEntryCmd(), "update", ...flags];

	const checkRun = await spawn(argv([...installFlags, "--check"]));
	const checked = classifyUpdateTranscript(checkRun.exitCode, checkRun.output);
	if (checkOnly || checked.kind !== "available") {
		ui.status(checked.kind === "failed" ? `Update check failed: ${checked.detail}` : summarize(checkRun.output));
		return;
	}

	const wording =
		checked.current === checked.version || checked.current === undefined
			? `Install omp ${checked.version}?`
			: `Update omp ${checked.current} → ${checked.version}?`;
	if (!(await ui.confirm("Update omp?", wording))) {
		ui.status("Update skipped.");
		return;
	}

	ui.status(`Installing omp ${checked.version}…`);
	const installRun = await spawn(argv(installFlags));
	const installed = classifyUpdateTranscript(installRun.exitCode, installRun.output);
	ui.status(installed.kind === "failed" ? `Update failed: ${installed.detail}` : summarize(installRun.output));
	if (installed.kind !== "updated") return;

	const identity = options.identity ?? currentInstallIdentity();
	if (restartLoadsUpdate(identity)) {
		if (
			await ui.confirm("Restart omp?", `omp ${installed.version} is installed. Restart now? This session resumes.`)
		) {
			await ui.restart();
			return;
		}
		ui.status("Still running the old version. /restart when you're ready.");
		return;
	}
	if (identity.installedPath === undefined) return;
	const origin = identity.sourceCheckout ? "a source checkout" : "a different binary than the one on PATH";
	const question = `omp ${installed.version} is installed at ${identity.installedPath}, but this session runs from ${origin}. Restart into the installed omp? This session resumes.`;
	if (await ui.confirm("Restart into the installed omp?", question)) {
		await ui.restart([identity.installedPath]);
		return;
	}
	ui.status("Staying on this process.");
}

async function spawnInstalledUpdate(cmd: string[]): Promise<UpdateSpawnResult> {
	const child = Bun.spawn(cmd, {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: workerEnvFromParent(),
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	// Bun writes its own color-env warning to stderr even when the updater succeeds.
	// Failures exit non-zero and print the reason on stderr.
	const failed = exitCode !== 0 && stderr.length > 0;
	const gap = failed && stdout.length > 0 && !stdout.endsWith("\n") ? "\n" : "";
	return { exitCode, output: failed ? `${stdout}${gap}${stderr}` : stdout };
}

function existingRealPath(filePath: string): string {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return filePath;
	}
}
