/**
 * Utilities for launching an external text editor ($VISUAL / $EDITOR).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, $which, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Returns the user's preferred editor command, or a platform default.
 *
 * Resolution order:
 *   1. `$VISUAL`
 *   2. `$EDITOR`
 *   3. `notepad` on Windows (always present in `%SystemRoot%\System32`)
 *
 * POSIX returns `undefined` when neither variable is set so the caller can
 * surface a warning that nudges the user to configure one.
 */
export function getEditorCommand(): string | undefined {
	const configured = $env.VISUAL?.trim() || $env.EDITOR?.trim();
	if (configured) return configured;
	if (process.platform === "win32") return "notepad";
	return undefined;
}

/**
 * Names the editor {@link getEditorCommand} launches for UI labels ("Edit in
 * Notepad", "Edit in nvim"): the command's program without its directory,
 * quotes or Windows executable extension. `undefined` when none is resolved.
 */
export function getEditorName(command = getEditorCommand()): string | undefined {
	if (!command) return undefined;
	const quote = command[0] === '"' || command[0] === "'" ? command[0] : undefined;
	const program = quote ? command.slice(1).split(quote)[0] : command.split(/\s+/)[0];
	const name = path.win32
		.basename(program ?? "")
		.replace(/\.(exe|cmd|bat|com)$/i, "")
		.trim();
	if (!name) return undefined;
	return name.toLowerCase() === "notepad" ? "Notepad" : name;
}

export interface OpenInEditorOptions {
	/** File extension for the temp file (default: ".md"). */
	extension?: string;
	/** Keep the file's trailing newline instead of trimming it from the returned text. */
	trimTrailingNewline?: boolean;
	/**
	 * Read-only reference text shown below a scissors line, like `git commit`'s
	 * diff. It is discarded from the returned text, so edits to it are ignored.
	 */
	context?: string;
}

const SCISSORS_LINE = `# ${"-".repeat(24)} >8 ${"-".repeat(24)}`;
const SCISSORS_HEADER = `${SCISSORS_LINE}
# Do not modify or remove the line above.
# Everything below it will be ignored.`;
const SCISSORS_LINE_PATTERN = new RegExp(`^${SCISSORS_LINE}[ \\t]*\\r?$`, "m");

/**
 * Cuts the scissors line and everything after it, along with the blank lines
 * that separated it from the draft. Text without the line is returned as-is:
 * removing it is a deliberate edit.
 */
export function stripEditorContext(text: string): string {
	const match = SCISSORS_LINE_PATTERN.exec(text);
	if (!match) return text;
	return text.slice(0, match.index).replace(/(?:\r?\n)+$/, "");
}

/** Subprocess argv and Windows quoting mode used to launch an external editor. */
export interface EditorSpawnCommand {
	cmd: string[];
	windowsVerbatimArguments: boolean;
}

/** Resolves shell argv without letting the host runtime re-quote the editor command. */
export function resolveEditorSpawnCommand(
	editorCmd: string,
	tmpFile: string,
	platform: NodeJS.Platform = process.platform,
): EditorSpawnCommand {
	const windows = platform === "win32";
	// cmd.exe strips the outer /s /c quote pair; Bun must pass the embedded
	// editor/path quotes verbatim instead of applying argv escaping to them.
	const cmd = windows
		? ["cmd.exe", "/d", "/s", "/c", `"${editorCmd} "${tmpFile}""`]
		: [$which("sh") ?? "sh", "-c", `${editorCmd} "$1"`, "sh", tmpFile];
	return { cmd, windowsVerbatimArguments: windows };
}

/**
 * Opens `content` in the user's external editor and returns the edited text.
 * Returns `null` if the editor exits with a non-zero code.
 *
 * With `options.context`, the reference text is appended below a scissors line
 * and cut from the result (see {@link stripEditorContext}); trailing newlines
 * of the draft are then always trimmed. A draft that already contains the
 * scissors line gets no context, so the cut can never truncate it.
 *
 * The caller is responsible for stopping/starting the TUI around this call.
 */
export async function openInEditor(
	editorCmd: string,
	content: string,
	options?: OpenInEditorOptions,
): Promise<string | null> {
	const ext = options?.extension ?? ".md";
	const tmpFile = path.join(os.tmpdir(), `omp-editor-${Snowflake.next()}${ext}`);
	const context = options?.context && !SCISSORS_LINE_PATTERN.test(content) ? options.context : undefined;

	try {
		await Bun.write(tmpFile, context ? `${content}\n\n${SCISSORS_HEADER}\n\n${context}\n` : content);
		const exitCode = await openEditorOnPath(editorCmd, tmpFile);
		if (exitCode === 0) {
			const raw = await Bun.file(tmpFile).text();
			const text = context ? stripEditorContext(raw) : raw;
			if (options?.trimTrailingNewline === false) {
				return text;
			}
			return text.replace(/\n$/, "");
		}
		return null;
	} finally {
		try {
			await fs.rm(tmpFile, { force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}

/**
 * Opens an existing file in the user's editor, which writes it in place, and
 * returns the editor's exit code. The file may have been saved even when the
 * code is non-zero, so callers that care re-read it.
 *
 * The caller is responsible for stopping/starting the TUI around this call.
 */
export async function openEditorOnPath(editorCmd: string, filePath: string): Promise<number> {
	const spawnCommand = resolveEditorSpawnCommand(editorCmd, filePath);
	// Inherit the real pane pty so terminal editors (including emacsclient,
	// which resolves the device via ttyname) render into the visible pane.
	const child = Bun.spawn(spawnCommand.cmd, {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		windowsVerbatimArguments: spawnCommand.windowsVerbatimArguments,
	});
	return child.exited;
}
