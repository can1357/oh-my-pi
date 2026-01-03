/**
 * Subprocess execution for subagents.
 *
 * Spawns `pi` in JSON mode to execute tasks with isolated context.
 * Parses JSON events for progress tracking.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { ensureArtifactsDir, getArtifactPaths } from "./artifacts";
import { resolveModelPattern } from "./model-resolver";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import {
	type AgentDefinition,
	type AgentProgress,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	PI_BLOCKED_AGENT_ENV,
	type SingleResult,
} from "./types";

/** pi command: 'pi.cmd' on Windows, 'pi' elsewhere */
const PI_CMD = process.platform === "win32" ? "pi.cmd" : "pi";

/** Windows shell option for spawn */
const PI_SHELL_OPT = process.platform === "win32";

/** Options for subprocess execution */
export interface ExecutorOptions {
	cwd: string;
	agent: AgentDefinition;
	task: string;
	index: number;
	context?: string;
	modelOverride?: string;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	sessionFile?: string | null;
	persistArtifacts?: boolean;
	artifactsDir?: string;
}

/**
 * Truncate output to byte and line limits.
 */
function truncateOutput(output: string): { text: string; truncated: boolean } {
	let truncated = false;
	let byteBudget = MAX_OUTPUT_BYTES;
	let lineBudget = MAX_OUTPUT_LINES;

	let i = 0;
	let lastNewlineIndex = -1;
	while (i < output.length && byteBudget > 0) {
		const ch = output.charCodeAt(i);
		byteBudget--;

		if (ch === 10 /* \n */) {
			lineBudget--;
			lastNewlineIndex = i;
			if (lineBudget <= 0) {
				truncated = true;
				break;
			}
		}

		i++;
	}

	if (i < output.length) {
		truncated = true;
	}

	if (truncated && lineBudget <= 0 && lastNewlineIndex >= 0) {
		output = output.slice(0, lastNewlineIndex);
	} else {
		output = output.slice(0, i);
	}

	return { text: output, truncated };
}

/**
 * Extract a short preview from tool args for display.
 */
function extractToolArgsPreview(args: Record<string, unknown>): string {
	// Priority order for preview
	const previewKeys = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"];

	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return value.length > 60 ? `${value.slice(0, 57)}...` : value;
		}
	}

	return "";
}

/**
 * Run a single agent as a subprocess.
 */
export async function runSubprocess(options: ExecutorOptions): Promise<SingleResult> {
	const { cwd, agent, task, index, context, modelOverride, signal, onProgress } = options;
	const startTime = Date.now();

	// Initialize progress
	const progress: AgentProgress = {
		index,
		agent: agent.name,
		agentSource: agent.source,
		status: "running",
		task,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		modelOverride,
	};

	// Check if already aborted
	if (signal?.aborted) {
		return {
			index,
			agent: agent.name,
			agentSource: agent.source,
			task,
			exitCode: 1,
			output: "",
			stderr: "Aborted before start",
			truncated: false,
			durationMs: 0,
			tokens: 0,
			modelOverride,
			error: "Aborted",
		};
	}

	// Write system prompt to temp file
	const tempDir = os.tmpdir();
	const promptFile = path.join(
		tempDir,
		`pi-agent-${agent.name}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
	);

	try {
		fs.writeFileSync(promptFile, agent.systemPrompt, "utf-8");
	} catch (err) {
		return {
			index,
			agent: agent.name,
			agentSource: agent.source,
			task,
			exitCode: 1,
			output: "",
			stderr: `Failed to write prompt file: ${err}`,
			truncated: false,
			durationMs: Date.now() - startTime,
			tokens: 0,
			modelOverride,
			error: `Failed to write prompt file: ${err}`,
		};
	}

	// Build full task with context
	const fullTask = context ? `${context}\n\n${task}` : task;

	// Set up artifact paths and write input file upfront if artifacts dir provided
	let artifactPaths: { inputPath: string; outputPath: string; jsonlPath: string } | undefined;
	let subtaskSessionFile: string | undefined;

	if (options.artifactsDir) {
		ensureArtifactsDir(options.artifactsDir);
		artifactPaths = getArtifactPaths(options.artifactsDir, agent.name, index);
		subtaskSessionFile = artifactPaths.jsonlPath;

		// Write input file immediately (real-time visibility)
		try {
			fs.writeFileSync(artifactPaths.inputPath, fullTask, "utf-8");
		} catch {
			// Non-fatal, continue without input artifact
		}
	}

	// Build args
	const args: string[] = ["--mode", "json", "--non-interactive"];

	// Add system prompt
	args.push("--append-system-prompt", promptFile);

	// Add tools if specified
	if (agent.tools && agent.tools.length > 0) {
		args.push("--tools", agent.tools.join(","));
	}

	// Resolve and add model
	const resolvedModel = resolveModelPattern(modelOverride || agent.model);
	if (resolvedModel) {
		args.push("--model", resolvedModel);
	}

	// Add session options - use subtask-specific session file for real-time streaming
	if (subtaskSessionFile) {
		args.push("--session", subtaskSessionFile);
	} else if (options.sessionFile) {
		args.push("--session", options.sessionFile);
	} else {
		args.push("--no-session");
	}

	// Add task as prompt
	args.push("--prompt", fullTask);

	// Set up environment - block same-agent recursion unless explicitly recursive
	const env = { ...process.env };
	if (!agent.recursive) {
		env[PI_BLOCKED_AGENT_ENV] = agent.name;
	}

	// Spawn subprocess
	const proc = spawn(PI_CMD, args, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		shell: PI_SHELL_OPT,
		env,
	});

	let output = "";
	let stderr = "";
	let finalOutput = "";
	let resolved = false;
	let pendingTermination = false; // Set when shouldTerminate fires, wait for message_end
	const jsonlEvents: string[] = [];

	// Handle abort signal
	const onAbort = () => {
		if (!resolved) {
			proc.kill("SIGTERM");
		}
	};
	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	// Parse JSON events from stdout
	const rl = readline.createInterface({ input: proc.stdout! });

	rl.on("line", (line) => {
		if (resolved) return;

		try {
			const event = JSON.parse(line);
			jsonlEvents.push(line);
			const now = Date.now();

			switch (event.type) {
				case "tool_execution_start":
					progress.toolCount++;
					progress.currentTool = event.toolName;
					progress.currentToolArgs = extractToolArgsPreview(event.toolArgs || event.args || {});
					progress.currentToolStartMs = now;
					break;

				case "tool_execution_end": {
					if (progress.currentTool) {
						progress.recentTools.unshift({
							tool: progress.currentTool,
							args: progress.currentToolArgs || "",
							endMs: now,
						});
						// Keep only last 5
						if (progress.recentTools.length > 5) {
							progress.recentTools.pop();
						}
					}
					progress.currentTool = undefined;
					progress.currentToolArgs = undefined;
					progress.currentToolStartMs = undefined;

					// Check for registered subprocess tool handler
					const handler = subprocessToolRegistry.getHandler(event.toolName);
					if (handler) {
						// Extract data using handler
						if (handler.extractData) {
							const data = handler.extractData({
								toolName: event.toolName,
								toolCallId: event.toolCallId,
								args: event.args,
								result: event.result,
								isError: event.isError,
							});
							if (data !== undefined) {
								progress.extractedToolData = progress.extractedToolData || {};
								progress.extractedToolData[event.toolName] = progress.extractedToolData[event.toolName] || [];
								progress.extractedToolData[event.toolName].push(data);
							}
						}

						// Check if handler wants to terminate subprocess
						if (
							handler.shouldTerminate?.({
								toolName: event.toolName,
								toolCallId: event.toolCallId,
								args: event.args,
								result: event.result,
								isError: event.isError,
							})
						) {
							// Don't kill immediately - wait for message_end to get token counts
							pendingTermination = true;
							// Safety timeout in case message_end never arrives
							setTimeout(() => {
								if (!resolved) {
									proc.kill("SIGTERM");
									resolved = true;
								}
							}, 2000);
						}
					}
					break;
				}

				case "message_update": {
					// Extract text for progress display only (replace, don't accumulate)
					const updateContent = event.message?.content || event.content;
					if (updateContent && Array.isArray(updateContent)) {
						const allText: string[] = [];
						for (const block of updateContent) {
							if (block.type === "text" && block.text) {
								const lines = block.text.split("\n").filter((l: string) => l.trim());
								allText.push(...lines);
							}
						}
						// Show last 8 lines from current state (not accumulated)
						progress.recentOutput = allText.slice(-8).reverse();
					}
					break;
				}

				case "message_end": {
					// Extract final text content from completed message
					const messageContent = event.message?.content || event.content;
					if (messageContent && Array.isArray(messageContent)) {
						for (const block of messageContent) {
							if (block.type === "text" && block.text) {
								output += block.text;
							}
						}
					}
					// Extract usage (prefer message.usage, fallback to event.usage)
					const messageUsage = event.message?.usage || event.usage;
					if (messageUsage) {
						// Accumulate tokens across messages (not overwrite)
						progress.tokens += (messageUsage.input_tokens || 0) + (messageUsage.output_tokens || 0);
					}
					// If pending termination, now we have tokens - terminate
					if (pendingTermination && !resolved) {
						proc.kill("SIGTERM");
						resolved = true;
					}
					break;
				}

				case "agent_end":
					// Extract final content from messages array
					if (event.messages && Array.isArray(event.messages)) {
						for (const msg of event.messages) {
							if (msg.content && Array.isArray(msg.content)) {
								for (const block of msg.content) {
									if (block.type === "text" && block.text) {
										finalOutput += block.text;
									}
								}
							}
						}
					}
					break;
			}

			progress.durationMs = now - startTime;
			onProgress?.(progress);
		} catch {
			// Ignore non-JSON lines
		}
	});

	// Capture stderr
	const stderrDecoder = new TextDecoder();
	proc.stderr?.on("data", (chunk: Buffer) => {
		stderr += stderrDecoder.decode(chunk, { stream: true });
	});

	// Wait for process to exit
	const exitCode = await new Promise<number>((resolve) => {
		proc.on("close", (code) => {
			resolved = true;
			resolve(code ?? 1);
		});
		proc.on("error", (err) => {
			resolved = true;
			stderr += `\nProcess error: ${err.message}`;
			resolve(1);
		});
	});

	// Cleanup
	if (signal) {
		signal.removeEventListener("abort", onAbort);
	}

	try {
		fs.unlinkSync(promptFile);
	} catch {
		// Ignore cleanup errors
	}

	// Use final output if available, otherwise accumulated output
	const rawOutput = finalOutput || output;
	const { text: truncatedOutput, truncated } = truncateOutput(rawOutput);

	// Write output artifact (input and jsonl already written in real-time)
	// Compute output metadata for Output tool integration
	let outputMeta: { lineCount: number; charCount: number } | undefined;
	if (artifactPaths) {
		try {
			fs.writeFileSync(artifactPaths.outputPath, rawOutput, "utf-8");
			outputMeta = {
				lineCount: rawOutput.split("\n").length,
				charCount: rawOutput.length,
			};
		} catch {
			// Non-fatal
		}
	}

	// Update final progress
	const wasAborted = signal?.aborted ?? false;
	progress.status = wasAborted ? "aborted" : exitCode === 0 ? "completed" : "failed";
	progress.durationMs = Date.now() - startTime;
	onProgress?.(progress);

	return {
		index,
		agent: agent.name,
		agentSource: agent.source,
		task,
		exitCode,
		output: truncatedOutput,
		stderr,
		truncated,
		durationMs: Date.now() - startTime,
		tokens: progress.tokens,
		modelOverride,
		error: exitCode !== 0 && stderr ? stderr : undefined,
		aborted: wasAborted,
		jsonlEvents,
		artifactPaths,
		extractedToolData: progress.extractedToolData,
		outputMeta,
	};
}
