import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Subprocess } from "bun";
import { getShellConfig, killProcessTree } from "../../utils/shell.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

/**
 * Generate a unique temp file path for bash output
 */
function getTempFilePath(): string {
	const randomId = crypto.getRandomValues(new Uint8Array(8));
	const id = Array.from(randomId, (b) => b.toString(16).padStart(2, "0")).join("");
	return join(tmpdir(), `pi-bash-${id}.log`);
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export function createBashTool(cwd: string): AgentTool<typeof bashSchema> {
	return {
		name: "bash",
		label: "Bash",
		description: `Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use \`ls\` to verify the parent directory exists and is the correct location
   - For example, before running "mkdir foo/bar", first use \`ls foo\` to check that "foo" exists and is the intended parent directory

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., cd "path with spaces/file.txt")
   - Examples of proper quoting:
     - cd "/Users/name/My Documents" (correct)
     - cd /Users/name/My Documents (incorrect - will fail)
     - python "/path/with spaces/script.py" (correct)
     - python /path/with spaces/script.py (incorrect - will fail)
   - After ensuring proper quoting, execute the command.
   - Capture the output of the command.

Usage notes:
  - The command argument is required.
  - You can specify an optional timeout in seconds.
  - It is very helpful if you write a clear, concise description of what this command does in 5-10 words.
  - If the output exceeds 50KB characters, output will be truncated before being returned to you.
  - Avoid using Bash with the \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:
    - File search: Use find (NOT find or ls)
    - Content search: Use grep (NOT grep or rg)
    - Read files: Use read (NOT cat/head/tail)
    - Edit files: Use edit (NOT sed/awk)
    - Write files: Use write (NOT echo >/cat <<EOF)
    - Communication: Output text directly (NOT echo/printf)
  - When issuing multiple commands:
    - If the commands are independent and can run in parallel, make multiple bash tool calls in a single message. For example, if you need to run "git status" and "git diff", send a single message with two bash tool calls in parallel.
    - If the commands depend on each other and must run sequentially, use a single bash call with '&&' to chain them together (e.g., \`git add . && git commit -m "message" && git push\`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead.
    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail
    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)`,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
		) => {
			const { shell, args } = getShellConfig();
			const child: Subprocess = Bun.spawn([shell, ...args, command], {
				cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});

			// We'll stream to a temp file if output gets large
			let tempFilePath: string | undefined;
			let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
			let totalBytes = 0;

			// Keep a rolling buffer of the last chunks for tail truncation
			const chunks: Buffer[] = [];
			let chunksBytes = 0;
			const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

			let timedOut = false;
			let aborted = false;

			// Handle abort signal
			const onAbort = () => {
				aborted = true;
				if (child.pid) {
					killProcessTree(child.pid);
				}
			};

			if (signal) {
				if (signal.aborted) {
					child.kill();
					throw new Error("Command aborted");
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}

			// Set timeout if provided
			let timeoutHandle: Timer | undefined;
			if (timeout !== undefined && timeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					onAbort();
				}, timeout * 1000);
			}

			const handleData = (data: Buffer) => {
				totalBytes += data.length;

				// Start writing to temp file once we exceed the threshold
				if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
					tempFilePath = getTempFilePath();
					tempFileStream = createWriteStream(tempFilePath);
					for (const chunk of chunks) {
						tempFileStream.write(chunk);
					}
				}

				if (tempFileStream) {
					tempFileStream.write(data);
				}

				// Keep rolling buffer of recent data
				chunks.push(data);
				chunksBytes += data.length;

				while (chunksBytes > maxChunksBytes && chunks.length > 1) {
					const removed = chunks.shift()!;
					chunksBytes -= removed.length;
				}

				// Stream partial output to callback
				if (onUpdate) {
					const fullBuffer = Buffer.concat(chunks);
					const fullText = fullBuffer.toString("utf-8");
					const truncation = truncateTail(fullText);
					onUpdate({
						content: [{ type: "text", text: truncation.content || "" }],
						details: {
							truncation: truncation.truncated ? truncation : undefined,
							fullOutputPath: tempFilePath,
						},
					});
				}
			};

			// Read streams using Bun's ReadableStream API
			const stdoutReader = (child.stdout as ReadableStream<Uint8Array>).getReader();
			const stderrReader = (child.stderr as ReadableStream<Uint8Array>).getReader();

			await Promise.all([
				(async () => {
					while (true) {
						const { done, value } = await stdoutReader.read();
						if (done) break;
						handleData(Buffer.from(value));
					}
				})(),
				(async () => {
					while (true) {
						const { done, value } = await stderrReader.read();
						if (done) break;
						handleData(Buffer.from(value));
					}
				})(),
			]);

			const exitCode = await child.exited;

			// Cleanup
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (signal) signal.removeEventListener("abort", onAbort);
			if (tempFileStream) tempFileStream.end();

			// Combine all buffered chunks
			const fullBuffer = Buffer.concat(chunks);
			const fullOutput = fullBuffer.toString("utf-8");

			if (aborted && !timedOut) {
				let output = fullOutput;
				if (output) output += "\n\n";
				output += "Command aborted";
				throw new Error(output);
			}

			if (timedOut) {
				let output = fullOutput;
				if (output) output += "\n\n";
				output += `Command timed out after ${timeout} seconds`;
				throw new Error(output);
			}

			// Apply tail truncation
			const truncation = truncateTail(fullOutput);
			let outputText = truncation.content || "(no output)";

			let details: BashToolDetails | undefined;

			if (truncation.truncated) {
				details = {
					truncation,
					fullOutputPath: tempFilePath,
				};

				const startLine = truncation.totalLines - truncation.outputLines + 1;
				const endLine = truncation.totalLines;

				if (truncation.lastLinePartial) {
					const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"));
					outputText += `\n\n[Showing last ${formatSize(
						truncation.outputBytes,
					)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
				} else if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
				} else {
					outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(
						DEFAULT_MAX_BYTES,
					)} limit). Full output: ${tempFilePath}]`;
				}
			}

			if (exitCode !== 0 && exitCode !== null) {
				outputText += `\n\nCommand exited with code ${exitCode}`;
				throw new Error(outputText);
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	};
}

/** Default bash tool using process.cwd() - for backwards compatibility */
export const bashTool = createBashTool(process.cwd());
