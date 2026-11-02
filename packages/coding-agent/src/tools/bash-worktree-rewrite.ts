import { extractFlatShellCommandSegments, tokenizeShellSegments } from "./shell-tokenize";

const SHELL_EXPANSION = /[$`~*?[\]{}<>]/;
const BARE_SAFE = /^[A-Za-z0-9_./:@%+=,-]+$/;

function shellQuote(value: string): string {
	return BARE_SAFE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function rewriteSegment(text: string, ompCmd: readonly string[]): string | undefined {
	if (SHELL_EXPANSION.test(text)) return undefined;
	const tokenLists = tokenizeShellSegments(text);
	if (tokenLists.length !== 1) return undefined;
	const tokens = tokenLists[0];
	if (tokens[0] !== "git") return undefined;

	let index = 1;
	let cwd: string | undefined;
	if (tokens[index] === "-C") {
		cwd = tokens[index + 1];
		if (!cwd) return undefined;
		index += 2;
	}
	if (tokens[index] !== "worktree" || tokens[index + 1] !== "add") return undefined;
	index += 2;

	let branchFlag: "-b" | "-B" | undefined;
	let branch: string | undefined;
	let detach = false;
	let quiet = false;
	let flagsEnded = false;
	const positionals: string[] = [];
	while (index < tokens.length) {
		const token = tokens[index++];
		if (!flagsEnded && token === "--") {
			flagsEnded = true;
			continue;
		}
		if (!flagsEnded && (token === "-b" || token === "-B")) {
			if (branchFlag) return undefined;
			const value = tokens[index++];
			if (!value) return undefined;
			branchFlag = token;
			branch = value;
			continue;
		}
		if (!flagsEnded && (token === "--detach" || token === "-d")) {
			detach = true;
			continue;
		}
		if (!flagsEnded && (token === "-q" || token === "--quiet")) {
			quiet = true;
			continue;
		}
		if (!flagsEnded && token.startsWith("-")) return undefined;
		positionals.push(token);
	}
	if (positionals.length < 1 || positionals.length > 2) return undefined;

	const argv = [...ompCmd, "worktree", "add"];
	if (cwd) argv.push("-C", cwd);
	if (branchFlag && branch) argv.push(branchFlag, branch);
	if (detach) argv.push("--detach");
	if (quiet) argv.push("-q");
	argv.push("--", ...positionals);
	return argv.map(shellQuote).join(" ");
}

/**
 * Rewrites supported `git worktree add` shell segments through omp so worktree
 * creation uses clone-first materialization. Unsupported shell syntax and git
 * flags are deliberately left for git to handle unchanged.
 */
export function rewriteGitWorktreeAdd(command: string, ompCmd: readonly string[]): string {
	const segments = extractFlatShellCommandSegments(command);
	if (segments.length === 0 || segments.some(segment => segment.pipedStdin)) return command;

	let cursor = 0;
	let result = "";
	for (const segment of segments) {
		const start = command.indexOf(segment.text, cursor);
		if (start < 0) return command;
		result += command.slice(cursor, start);
		result += rewriteSegment(segment.text, ompCmd) ?? segment.text;
		cursor = start + segment.text.length;
	}
	return result + command.slice(cursor);
}
