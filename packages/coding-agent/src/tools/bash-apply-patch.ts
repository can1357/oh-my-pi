const APPLY_PATCH_COMMAND = /^\s*apply_patch(?:\s|$)/;
const HEREDOC = /^\s*apply_patch\s*<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*\s*$/;
const SINGLE_QUOTED = /^\s*apply_patch\s+'([^']*)'\s*$/;
const DOUBLE_QUOTED = /^\s*apply_patch\s+"((?:[^"\\]|\\[\s\S])*)"\s*$/;

/**
 * The patch text of a Codex-style `apply_patch` shell call: `apply_patch <<'EOF' … EOF` or
 * `apply_patch '<patch>'`. `null` for any other `apply_patch` command, `undefined` when the
 * command does not run `apply_patch`. The text is taken literally, as Codex's own shell does.
 */
export function applyPatchShellInput(command: string): string | null | undefined {
	if (!APPLY_PATCH_COMMAND.test(command)) return undefined;
	const heredoc = HEREDOC.exec(command);
	if (heredoc) return heredoc[3];
	const single = SINGLE_QUOTED.exec(command);
	if (single) return single[1];
	const double = DOUBLE_QUOTED.exec(command);
	if (double) return double[1].replace(/\\([\\"$`\n])/g, (_, escaped: string) => (escaped === "\n" ? "" : escaped));
	return null;
}
