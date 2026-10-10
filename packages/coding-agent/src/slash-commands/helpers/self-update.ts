/**
 * In-session `/update`.
 *
 * The install itself stays in `omp update` (`runUpdateCommand`): that path already
 * replaces the on-PATH binary, bun/npm global, Homebrew, or mise install in place,
 * and refuses Nix and externally managed copies. This module runs that command in
 * a child so its `console` output and `process.exit` cannot take down the TUI, and
 * wraps it in two single-key prompts:
 *
 *   1. `omp update --check` → "Update omp 18.8.7 → 18.9.0?"  [y/n]
 *   2. `omp update`         → "Restart now?"                 [y/n]
 *
 * The restart always relaunches the `omp` PATH entry the updater targeted, never
 * this process's own entry: a source checkout, a different `omp` earlier on PATH,
 * a Homebrew Cellar path, or a bun/npm launcher replaced by the standalone binary
 * on a major bump would otherwise resume the old code. The entry is kept unresolved
 * so shims that dispatch on argv[0] (mise) still launch omp.
 */
import { $which } from "@oh-my-pi/pi-utils";
import { replaceTabs } from "@oh-my-pi/pi-tui/render/render-utils";
import { isSourceCheckout } from "../../cli/update-cli";
import { resolveCliEntryCmd, workerEnvFromParent } from "../../subprocess/worker-client";

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
/** Prefix `runUpdateCommand` puts on its last stderr line when it exits 1. */
const FAILURE_PREFIX = /^Update failed: /;

export const SESSION_UPDATE_USAGE = "Usage: /update [--check] [--force] [--canary|--stable]";

/** Single-key answers for a Yes/No dialog. */
export const YES_NO_PROMPT = {
	hotkeys: { y: "Yes", n: "No" },
	helpText: "y yes  n no  esc cancel",
} as const;

export interface InstallIdentity {
	sourceCheckout: boolean;
	/** The `omp` PATH entry the updater replaces, as found on PATH (not realpath'd). */
	pathEntry?: string;
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
	| { kind: "unverified" }
	| { kind: "installed" };

/** What `/update` needs from the interactive session. */
export interface SessionUpdateUi {
	status(message: string): void;
	/** Single-key Yes/No; resolves false on No or cancel. */
	confirm(title: string, message: string): Promise<boolean>;
	/** Whether a turn is running; restarting would tear it down. */
	busy(): boolean;
	/** Relaunch through `entry`, keeping launch flags and resuming this session. */
	restart(entry: string[]): Promise<void>;
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

/** Child output as display-safe lines: every ANSI/OSC sequence stripped, tabs expanded, blanks dropped. */
function plainLines(output: string): string[] {
	return replaceTabs(Bun.stripANSI(output).replace(/\r/g, ""))
		.split("\n")
		.map(line => line.trimEnd())
		.filter(line => line.trim().length > 0);
}

/**
 * Classify an `omp update` transcript from a `"check"` or `"install"` run.
 *
 * Only the managed-install refusal can appear on a check run: `runUpdateCommand`
 * returns from `--check` before it resolves the install target, so Nix and the
 * brew/mise canary refusal surface on the install run and land in `blocked` there.
 * A zero-exit install that was not refused or flagged is `installed` regardless of
 * how the success line is worded, so rewording it cannot drop the restart prompt.
 */
export function classifyUpdateTranscript(
	phase: "check" | "install",
	exitCode: number,
	output: string,
): UpdateTranscript {
	const lines = plainLines(output);
	const text = lines.join("\n");
	if (exitCode !== 0) {
		const last = lines.at(-1)?.trim().replace(FAILURE_PREFIX, "");
		return { kind: "failed", detail: last || `update exited ${exitCode}` };
	}
	if (
		/kept up to date by/.test(text) ||
		/cannot update itself/.test(text) ||
		/Canary updates are only supported/.test(text)
	) {
		return { kind: "blocked" };
	}
	if (/Already up to date/.test(text)) return { kind: "up-to-date" };
	if (phase === "install") return /Warning:/.test(text) ? { kind: "unverified" } : { kind: "installed" };
	const available = text.match(
		new RegExp(`(?:New version available:|Forcing reinstall of|Switching to (?:stable|canary)) ${VERSION}`),
	);
	if (!available) return { kind: "unverified" };
	return {
		kind: "available",
		version: available[1]!,
		current: text.match(new RegExp(`Current version: ${VERSION}`))?.[1],
	};
}

export function currentInstallIdentity(): InstallIdentity {
	return { sourceCheckout: isSourceCheckout(), pathEntry: $which("omp") ?? undefined };
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
 * `--check` stops after the first step. A managed install or an already-current
 * one is reported from the check and never prompts. Refusals only the install run
 * can detect (Nix, canary on brew/mise) and failures are reported after it and do
 * not offer a restart.
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
	const checked = classifyUpdateTranscript("check", checkRun.exitCode, checkRun.output);
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
	const installed = classifyUpdateTranscript("install", installRun.exitCode, installRun.output);
	ui.status(installed.kind === "failed" ? `Update failed: ${installed.detail}` : summarize(installRun.output));
	if (installed.kind !== "installed") return;

	const identity = options.identity ?? currentInstallIdentity();
	const later = `omp ${checked.version} is installed. Start omp again, or /restart when you're ready.`;
	if (!identity.pathEntry) {
		ui.status(`omp ${checked.version} is installed. Start omp again to use it.`);
		return;
	}
	if (ui.busy()) {
		ui.status(later);
		return;
	}
	const question = identity.sourceCheckout
		? `omp ${checked.version} is installed at ${identity.pathEntry}. This session runs from a source checkout; restart into the installed omp? This session resumes.`
		: `omp ${checked.version} is installed. Restart now? This session resumes.`;
	const title = identity.sourceCheckout ? "Restart into the installed omp?" : "Restart omp?";
	// The editor stays live while the dialog is open, so a turn may have started.
	if (!(await ui.confirm(title, question)) || ui.busy()) {
		ui.status(later);
		return;
	}
	await ui.restart([identity.pathEntry]);
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
