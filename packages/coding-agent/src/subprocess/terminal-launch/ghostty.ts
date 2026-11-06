import { hasTerminalMultiplexerSession } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { quotePosixArgvAsciiSafe } from "../../utils/shell-quote";
import { launchError } from "./shared";
import type {
	SupportedMultiplexerCapabilities,
	TerminalLaunchBackend,
	TerminalLaunchCliResult,
	TerminalLaunchCliRunner,
	TerminalLaunchProvider,
	TerminalLaunchRequest,
} from "./types";

const capabilities = {
	displayName: "Ghostty",
	supported: true,
	pane: {
		displayName: "pane",
		execution: ["shell-input"],
		direction: ["right", "left", "up", "down"],
		focus: true,
		shellGrammar: "posix",
	},
	window: {
		displayName: "tab",
		execution: ["shell-input"],
		focus: true,
		shellGrammar: "posix",
	},
} as const satisfies SupportedMultiplexerCapabilities;

type GhosttyLaunchRequest = Extract<TerminalLaunchRequest, { multiplexer: "ghostty" }>;

/**
 * Ghostty's AppleScript dictionary (`split`, `new tab`, surface configuration
 * records) ships with Ghostty 1.4.0; older builds cannot be scripted at all.
 */
const MINIMUM_GHOSTTY_VERSION = "1.4.0";

/** Parsed `Ghostty version` per CLI runner; the installed app does not change while omp runs. */
const ghosttyVersions = new WeakMap<TerminalLaunchCliRunner, readonly number[]>();

function parseVersion(text: string): readonly number[] | undefined {
	const match = /(\d+)\.(\d+)\.(\d+)/u.exec(text);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function isAtLeast(version: readonly number[], minimum: readonly number[]): boolean {
	for (let index = 0; index < minimum.length; index++) {
		if (version[index] !== minimum[index]) return version[index]! > minimum[index]!;
	}
	return true;
}

async function runGhosttyStep(
	request: GhosttyLaunchRequest,
	operation: string,
	argv: readonly string[],
	runCli: TerminalLaunchCliRunner,
): Promise<string> {
	let result: TerminalLaunchCliResult;
	try {
		result = await runCli(argv, request.cwd);
	} catch {
		throw launchError(request, operation, `ghostty ${operation} could not start its CLI.`);
	}
	if (result.exitCode !== 0) {
		const exit = result.exitCode === null ? "did not exit successfully" : `failed (exit ${result.exitCode})`;
		throw launchError(request, operation, `ghostty ${operation} ${exit}.`, result.exitCode);
	}
	return result.stdout;
}

// Older Ghostty has no scripting dictionary; name the required version instead
// of failing later with an AppleScript compile error.
async function requireGhosttyVersion(request: GhosttyLaunchRequest, runCli: TerminalLaunchCliRunner): Promise<void> {
	let version = ghosttyVersions.get(runCli);
	if (!version) {
		const output = await runGhosttyStep(
			request,
			"version",
			["osascript", "-e", 'tell application "Ghostty" to return version'],
			runCli,
		);
		version = parseVersion(output);
		if (version) ghosttyVersions.set(runCli, version);
	}
	if (!version) {
		throw launchError(
			request,
			"version",
			`Ghostty terminal launches require Ghostty ${MINIMUM_GHOSTTY_VERSION} or newer (the first release with its AppleScript dictionary), and the installed version could not be determined. Update Ghostty.`,
		);
	}
	if (!isAtLeast(version, parseVersion(MINIMUM_GHOSTTY_VERSION)!)) {
		throw launchError(
			request,
			"version",
			`Ghostty terminal launches require Ghostty ${MINIMUM_GHOSTTY_VERSION} or newer (the first release with its AppleScript dictionary); found ${version.join(".")}. Update Ghostty.`,
		);
	}
}

interface GhosttyTerminal {
	readonly id: string;
	readonly windowId: string;
	readonly pid: number;
	readonly tty: string;
}

/**
 * Escape a value as an AppleScript string literal. Control characters have no
 * literal form, so they fail instead of being embedded in a script.
 */
function appleScriptString(request: GhosttyLaunchRequest, operation: string, value: string): string {
	if (/[\u0000-\u001f\u007f]/u.test(value)) {
		throw launchError(request, operation, "ghostty launch values cannot contain control characters.");
	}
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * One row per terminal Ghostty hosts, as `terminal id | pid | tty | window id`.
 * Enumeration is windows-then-terminals; resolution happens in TypeScript so
 * ancestor order, not window order, decides which terminal hosts this process.
 */
const LIST_TERMINALS_SCRIPT = [
	'tell application "Ghostty"',
	"\tset rows to {}",
	"\trepeat with w in windows",
	"\t\trepeat with t in terminals of w",
	'\t\t\tset end of rows to (id of t as text) & "|" & (pid of t as text) & "|" & (tty of t) & "|" & (id of w as text)',
	"\t\tend repeat",
	"\tend repeat",
	"\tset AppleScript's text item delimiters to linefeed",
	"\treturn rows as text",
	"end tell",
].join("\n");

function parseTerminalList(request: GhosttyLaunchRequest, stdout: string): GhosttyTerminal[] {
	const terminals: GhosttyTerminal[] = [];
	for (const line of stdout.split(/\r?\n/u)) {
		if (!line.trim()) continue;
		const [id, pid, tty, windowId] = line.split("|");
		const pidNumber = Number(pid);
		// A surface whose foreground process is gone reports `pid` 0 or `missing
		// value` (Ghostty keeps windows open after `wait after command:false`
		// commands exit). Such a surface cannot host this process, so skip it
		// instead of failing the whole listing.
		if (!id || !windowId || !Number.isSafeInteger(pidNumber) || pidNumber <= 0) continue;
		terminals.push({ id, windowId, pid: pidNumber, tty: tty ?? "" });
	}
	return terminals;
}

interface ProcessInfo {
	readonly ppid: number;
	readonly tty: string;
}

/** Parse `ps -axo pid=,ppid=,tty=` output into a pid-indexed process table. */
function parseProcessTable(request: GhosttyLaunchRequest, stdout: string): Map<number, ProcessInfo> {
	const table = new Map<number, ProcessInfo>();
	for (const line of stdout.split(/\r?\n/u)) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(line);
		if (!match) continue;
		table.set(Number(match[1]), { ppid: Number(match[2]), tty: match[3]! });
	}
	if (!table.has(process.pid)) {
		throw launchError(request, "process table", "ghostty launch could not read the process table.");
	}
	return table;
}

/** This process's pid followed by its ancestors, nearest first. */
function ancestorPids(table: Map<number, ProcessInfo>): number[] {
	const chain: number[] = [];
	const seen = new Set<number>();
	let current: number | undefined = process.pid;
	while (current !== undefined && current > 0 && !seen.has(current)) {
		seen.add(current);
		chain.push(current);
		current = table.get(current)?.ppid;
	}
	return chain;
}

function normalizeTty(tty: string): string {
	return tty.startsWith("/dev/") ? tty.slice("/dev/".length) : tty;
}

/**
 * The terminal hosting this process: the first ancestor (nearest first) that
 * Ghostty hosts — `GHOSTTY_SURFACE_ID` is deliberately not used, it does not
 * equal the AppleScript terminal id. When no ancestor matches (reparented
 * helpers can sever the chain), fall back to the process's controlling tty.
 */
function resolveHostTerminal(
	request: GhosttyLaunchRequest,
	terminals: readonly GhosttyTerminal[],
	table: Map<number, ProcessInfo>,
): GhosttyTerminal {
	const byPid = new Map(terminals.map(terminal => [terminal.pid, terminal]));
	for (const pid of ancestorPids(table)) {
		const host = byPid.get(pid);
		if (host) return host;
	}
	const ownTty = table.get(process.pid)?.tty;
	if (ownTty && ownTty !== "??" && ownTty !== "-") {
		const host = terminals.find(terminal => normalizeTty(terminal.tty) === normalizeTty(ownTty));
		if (host) return host;
	}
	throw launchError(
		request,
		"resolve host terminal",
		"ghostty launch could not find the terminal hosting this process; it may have been started outside Ghostty or headless.",
	);
}

function buildPlacementScript(request: GhosttyLaunchRequest, host: GhosttyTerminal): string {
	const configuration = [
		`command:${appleScriptString(request, "placement", quotePosixArgvAsciiSafe(request.command))}`,
		`initial working directory:${appleScriptString(request, "placement", request.cwd)}`,
		"wait after command:false",
	].join(", ");
	const lines = [
		'tell application "Ghostty"',
		"\tset hostWindow to missing value",
		"\tset hostTerm to missing value",
		"\trepeat with w in windows",
		`\t\tif hostWindow is missing value and (id of w as text) is ${appleScriptString(request, "placement", host.windowId)} then set hostWindow to w`,
		"\tend repeat",
		'\tif hostWindow is missing value then return "NOHOST"',
		"\trepeat with t in terminals of hostWindow",
		`\t\tif hostTerm is missing value and (id of t as text) is ${appleScriptString(request, "placement", host.id)} then set hostTerm to t`,
		"\tend repeat",
		'\tif hostTerm is missing value then return "NOHOST"',
		`\tset cfg to {${configuration}}`,
	];
	if (request.placement === "pane") {
		lines.push(`\tset newTerm to split hostTerm direction ${request.direction ?? "right"} with configuration cfg`);
	} else {
		// A created tab's result may be the tab or its terminal depending on the
		// dictionary revision; normalize to the terminal either way.
		lines.push("\tset created to new tab in hostWindow with configuration cfg");
		lines.push("\tif class of created is tab then");
		lines.push("\t\tset newTerm to first terminal of created");
		lines.push("\telse");
		lines.push("\t\tset newTerm to created");
		lines.push("\tend if");
	}
	if (request.focus === true) lines.push("\tfocus newTerm");
	if (request.focus === false) lines.push("\tfocus hostTerm");
	lines.push('\treturn "OK|" & (id of newTerm as text)', "end tell");
	return [
		"try",
		...lines,
		"on error errMessage number errNumber",
		'\treturn "ERR|" & errNumber & "|" & errMessage',
		"end try",
	].join("\n");
}

function parsePlacementResult(request: GhosttyLaunchRequest, stdout: string): string {
	const line = stdout.trim();
	if (line === "NOHOST") {
		throw launchError(
			request,
			"resolve host terminal",
			"ghostty launch could not find the terminal hosting this process; it may have been started outside Ghostty or headless.",
		);
	}
	if (line.startsWith("OK|")) {
		const id = line.slice("OK|".length);
		if (id && !/[\r\n]/u.test(id)) return id;
		throw launchError(request, "placement", "ghostty placement did not return a valid terminal ID.");
	}
	if (line.startsWith("ERR|")) {
		const [, code] = line.split("|");
		if (code === "-1743") {
			throw launchError(
				request,
				"placement",
				"ghostty placement was denied Automation permission. Allow it in System Settings → Privacy & Security → Automation; the first launch prompts once.",
			);
		}
		if (code === "-2700") {
			throw launchError(
				request,
				"resolve host terminal",
				"ghostty launch could not find the terminal hosting this process; it may have been started outside Ghostty or headless.",
			);
		}
		throw launchError(request, "placement", `ghostty placement failed (AppleScript error ${code ?? "unknown"}).`);
	}
	throw launchError(request, "placement", "ghostty placement returned an unexpected response.");
}

const launchGhostty: TerminalLaunchBackend<"ghostty", typeof capabilities> = async (
	request,
	{ environment: env, platform, runCli },
) => {
	if (platform !== "darwin") {
		throw launchError(request, "capability", "Ghostty launches are only supported on macOS (AppleScript).");
	}
	if (!hasTerminalMultiplexerSession("ghostty", env)) {
		throw launchError(request, "capability", "Ghostty launch requires an active Ghostty terminal.");
	}
	await requireGhosttyVersion(request, runCli);
	const table = parseProcessTable(
		request,
		await runGhosttyStep(request, "process table", ["ps", "-axo", "pid=,ppid=,tty="], runCli),
	);
	const terminals = parseTerminalList(
		request,
		await runGhosttyStep(request, "list terminals", ["osascript", "-e", LIST_TERMINALS_SCRIPT], runCli),
	);
	if (terminals.length === 0) {
		throw launchError(
			request,
			"resolve host terminal",
			"ghostty launch could not find the terminal hosting this process; it may have been started outside Ghostty or headless.",
		);
	}
	const host = resolveHostTerminal(request, terminals, table);
	const output = await runGhosttyStep(
		request,
		"placement",
		["osascript", "-e", buildPlacementScript(request, host)],
		runCli,
	);
	const id = parsePlacementResult(request, output);
	return { multiplexer: "ghostty", placement: request.placement, id };
};

export const ghosttyLaunchProvider: TerminalLaunchProvider<"ghostty", typeof capabilities> = {
	capabilities,
	launch: launchGhostty,
};
