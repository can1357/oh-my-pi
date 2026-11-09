/**
 * In-session `/update`.
 *
 * The install stays in `omp update`: that command already replaces the on-PATH
 * binary and refuses managed installs. This runs it in a child so its console
 * output and `process.exit` cannot take down the TUI, then asks before
 * installing and before restarting. The restart uses the unresolved `omp` PATH
 * entry, so shims that dispatch on argv[0] still launch omp.
 */
import { $which } from "@oh-my-pi/pi-utils";
import { replaceTabs } from "@oh-my-pi/pi-tui/render/render-utils";
import { isSourceCheckout, parseUpdateArgs } from "../../cli/update-cli";
import { resolveCliEntryCmd, workerEnvFromParent } from "../../subprocess/worker-client";

const VERSION = String.raw`(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`;
const SESSION_FLAGS = new Set(["--check", "-c", "--force", "-f", "--canary", "--stable"]);
const TERN_ENV = [
	"TERN_ACP",
	"TERN_BLOB_DIR",
	"TERN_COMPLETE",
	"TERN_IDENTITY",
	"TERN_LENSES",
	"TERN_PANE",
	"TERN_PANE_SOCKET",
	"TERN_WINDOW_KEY",
	"TERN_WINDOW_SOCKET",
] as const;
/** Lines the updater prints when it refused, rather than finished, an install. */
const REFUSED = /kept up to date by|cannot update itself|Canary updates are only supported/;
const OFFER = new RegExp(`(?:New version available:|Forcing reinstall of|Switching to (?:stable|canary)) ${VERSION}`);

export const SESSION_UPDATE_USAGE = "Usage: /update [--check] [--force] [--canary|--stable]";
export const TERN_UPDATE_DISABLED = "/update is disabled in Tern; Tern manages omp updates automatically.";
export const YES_NO_PROMPT = {
	hotkeys: { y: "Yes", n: "No" },
	helpText: "y yes  n no  esc cancel",
} as const;

export function isSessionUpdateManagedByTern(env: Record<string, string | undefined> = process.env): boolean {
	return TERN_ENV.some(name => env[name] !== undefined);
}

/** Session flags are the updater's flags minus plugin upgrades, which are not an omp self-update. */
export function parseSessionUpdateArgs(args: string): { error: string } | { flags: string[] } {
	const tokens = args.trim() === "" ? [] : args.trim().split(/\s+/);
	const unknown = tokens.find(token => !SESSION_FLAGS.has(token));
	if (unknown) return { error: `Unknown /update option "${unknown}". ${SESSION_UPDATE_USAGE}` };
	try {
		parseUpdateArgs(["update", ...tokens]);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
	return { flags: tokens };
}

export interface SessionUpdateUi {
	status(message: string): void;
	confirm(title: string, message: string): Promise<boolean>;
	busy(): boolean;
	restart(entry: string[]): Promise<void>;
}

/** Installer text safe for a status line: ANSI/OSC stripped, tabs expanded, restart advice removed. */
function statusText(output: string): string {
	const text = replaceTabs(Bun.stripANSI(output).replace(/\r/g, ""))
		.split("\n")
		.map(line => line.trimEnd())
		.filter(line => line.trim() && line.trim() !== "Restart omp to use the new version")
		.slice(-6)
		.join("\n");
	return text.length > 1_500 ? text.slice(text.length - 1_500) : text;
}

export async function runSessionUpdate(options: {
	flags: readonly string[];
	ui: SessionUpdateUi;
	env?: Record<string, string | undefined>;
	identity?: { sourceCheckout: boolean; pathEntry?: string };
	spawn?: (cmd: string[]) => Promise<{ exitCode: number; output: string }>;
}): Promise<void> {
	const { ui } = options;
	if (isSessionUpdateManagedByTern(options.env)) {
		ui.status(TERN_UPDATE_DISABLED);
		return;
	}
	if (ui.busy()) {
		ui.status("Wait for the current response to finish before updating.");
		return;
	}
	ui.status("Checking for omp updates…");
	const spawn = options.spawn ?? spawnInstalledUpdate;
	const checkOnly = options.flags.includes("--check") || options.flags.includes("-c");
	const installFlags = options.flags.filter(flag => flag !== "--check" && flag !== "-c");
	const argv = (flags: readonly string[]) => [...resolveCliEntryCmd(), "update", ...flags];

	const check = await spawn(argv([...installFlags, "--check"]));
	const offered = check.exitCode === 0 ? Bun.stripANSI(check.output).match(OFFER) : null;
	if (checkOnly || !offered || REFUSED.test(check.output)) {
		ui.status(
			check.exitCode === 0
				? statusText(check.output)
				: statusText(check.output) || `update exited ${check.exitCode}`,
		);
		return;
	}

	const version = offered[1]!;
	const current = Bun.stripANSI(check.output).match(new RegExp(`Current version: ${VERSION}`))?.[1];
	const wording = !current || current === version ? `Install omp ${version}?` : `Update omp ${current} → ${version}?`;
	if (!(await ui.confirm("Update omp?", wording))) {
		ui.status("Update skipped.");
		return;
	}

	ui.status(`Installing omp ${version}…`);
	const install = await spawn(argv(installFlags));
	const installed = install.exitCode === 0 && !REFUSED.test(install.output) && !/Warning:/.test(install.output);
	ui.status(
		install.exitCode === 0
			? statusText(install.output)
			: statusText(install.output) || `update exited ${install.exitCode}`,
	);
	if (!installed) return;

	const identity = options.identity ?? { sourceCheckout: isSourceCheckout(), pathEntry: $which("omp") ?? undefined };
	const later = `omp ${version} is installed. Start omp again, or /restart when you're ready.`;
	if (!identity.pathEntry) {
		ui.status(`omp ${version} is installed. Start omp again to use it.`);
		return;
	}
	if (ui.busy()) {
		ui.status(later);
		return;
	}
	const title = identity.sourceCheckout ? "Restart into the installed omp?" : "Restart omp?";
	const question = identity.sourceCheckout
		? `omp ${version} is installed at ${identity.pathEntry}. This session runs from a source checkout; restart into the installed omp? This session resumes.`
		: `omp ${version} is installed. Restart now? This session resumes.`;
	if (!(await ui.confirm(title, question)) || ui.busy()) {
		ui.status(later);
		return;
	}
	await ui.restart([identity.pathEntry]);
}

async function spawnInstalledUpdate(cmd: string[]): Promise<{ exitCode: number; output: string }> {
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
	// Success keeps stdout: Bun may write its own color-env warning to stderr.
	const gap = stdout.length > 0 && !stdout.endsWith("\n") ? "\n" : "";
	return { exitCode, output: exitCode === 0 ? stdout : `${stdout}${gap}${stderr}` };
}
