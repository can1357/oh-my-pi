import { flagConsumesValue } from "../cli/flag-tables";

function launchArgs(argv: readonly string[]): readonly string[] {
	return argv[0] === "launch" ? argv.slice(1) : argv;
}

const NON_INTERACTIVE_COMMANDS: Record<string, true> = {
	acp: true,
	"auth-broker": true,
	"auth-gateway": true,
	agents: true,
	bench: true,
	commit: true,
	completions: true,
	__complete: true,
	config: true,
	"dry-balance": true,
	gc: true,
	grep: true,
	gallery: true,
	grievances: true,
	install: true,
	join: true,
	models: true,
	plugin: true,
	say: true,
	setup: true,
	shell: true,
	read: true,
	ssh: true,
	stats: true,
	update: true,
	usage: true,
	"tiny-models": true,
	token: true,
	ttsr: true,
	worktree: true,
	wt: true,
	search: true,
	q: true,
};

const NON_INTERACTIVE_FLAGS: Record<string, true> = {
	"--help": true,
	"-h": true,
	"--version": true,
	"-v": true,
	"--print": true,
	"-p": true,
};

/**
 * Return whether argv can enter the default interactive launch path.
 *
 * This classifier deliberately stays independent from the full argument parser:
 * importing that graph eagerly loads optional native-backed modules, even for
 * ordinary paths such as `--version` that must work under `bun --no-addons`.
 */
export function isDefaultInteractiveArgv(argv: readonly string[]): boolean {
	const first = argv[0];
	if (
		first !== undefined &&
		first !== "launch" &&
		!first.startsWith("-") &&
		Object.hasOwn(NON_INTERACTIVE_COMMANDS, first)
	)
		return false;

	const args = launchArgs(argv);
	let mode: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") break;
		if (arg === "--no-daemon" || Object.hasOwn(NON_INTERACTIVE_FLAGS, arg)) return false;
		if (arg === "--export" || arg.startsWith("--export=")) return false;
		if (arg.startsWith("--mode=")) {
			mode = arg.slice("--mode=".length);
			continue;
		}
		if (arg === "--mode") {
			mode = args[++index];
			continue;
		}
		if (arg === "--profile" || arg === "--alias" || flagConsumesValue(arg, args[index + 1])) index++;
	}
	return mode === undefined || mode === "text";
}
