import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import backgroundTanDispatchPrompt from "../../prompts/system/background-tan-dispatch.md" with { type: "text" };
import tanContextSwitchPrompt from "../../prompts/system/tan-context-switch.md" with { type: "text" };
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import * as sdk from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE } from "../../session/messages";
import { SessionManager } from "../../session/session-manager";
import { createMCPProxyTools, createSubagentSettings } from "../../task/executor";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../../tools/todo";
import type { InteractiveModeContext } from "../types";

const TAN_LABEL_PREVIEW_LENGTH = 80;

function previewWork(work: string): string {
	const singleLine = work.trim().replace(/\s+/g, " ");
	if (singleLine.length <= TAN_LABEL_PREVIEW_LENGTH) return singleLine;
	return `${singleLine.slice(0, TAN_LABEL_PREVIEW_LENGTH - 1)}…`;
}

function extractAssistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

async function removeCloneSession(cloneFile: string): Promise<void> {
	await Promise.allSettled([
		fs.rm(cloneFile, { force: true }),
		fs.rm(cloneFile.slice(0, -6), { recursive: true, force: true }),
	]);
}

export class TanCommandController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	async start(work: string): Promise<void> {
		const trimmedWork = work.trim();
		if (!trimmedWork) {
			this.ctx.showStatus("Usage: /tan <work>");
			return;
		}

		const session = this.ctx.session;

		const model = session.model;
		if (!model) {
			this.ctx.showError("No active model available for /tan.");
			return;
		}

		const manager = session.asyncJobManager;
		if (!manager) {
			this.ctx.showError("Background jobs are disabled; enable async jobs to use /tan.");
			return;
		}

		const parentFile = this.ctx.sessionManager.getSessionFile();
		if (!parentFile) {
			this.ctx.showError("/tan requires a persisted session.");
			return;
		}

		const parentSessionId = session.sessionId;
		// Providers route on `promptCacheKey ?? sessionId`, so the parent's live
		// requests may cache under a pinned key that differs from its session id
		// (the parent being itself a fork/tan). Mirror exactly what the parent
		// populated the cache under — same rule as advisor and handoff calls.
		const parentPromptCacheKey = session.agent.promptCacheKey ?? parentSessionId;
		const thinkingLevel = session.configuredThinkingLevel();
		const systemPrompt = [...session.systemPrompt];
		const toolNames = session.getEnabledToolNames();
		const modelRegistry = session.modelRegistry;
		const ownerId = session.getAgentId() ?? MAIN_AGENT_ID;
		const mcpManager = this.ctx.mcpManager;
		const cwd = this.ctx.sessionManager.getCwd();
		const parentArtifactsDir = this.ctx.sessionManager.getArtifactsDir();
		// Snapshot the parent session's local:// mapping when dispatching. The
		// interactive SessionManager is mutable and may switch transcripts while
		// this background tan is still running. Use the session-manager id (not
		// `session.sessionId`, which can diverge after `/fresh` or a provider
		// session override) so the tan resolves the same local root the parent's
		// large-paste writes and `local://` reads use — notably the Windows
		// short-root fallback keys `%TEMP%/omp-local/<id>` off this id.
		const parentLocalSessionId = this.ctx.sessionManager.getSessionId();
		const localProtocolOptions = {
			getArtifactsDir: () => parentArtifactsDir,
			getSessionId: () => parentLocalSessionId,
		};
		// Nest the clone inside the parent's artifact directory (like a subagent
		// session) rather than as a top-level sibling, so it shares the parent's
		// artifacts in place — no copy needed.
		const sessionDir = parentFile.slice(0, -6);
		const settings = createSubagentSettings(this.ctx.settings);
		const customTools = mcpManager ? createMCPProxyTools(mcpManager) : undefined;
		const enableLsp = this.ctx.settings.get("task.enableLsp") !== false;
		const agentRegistry = AgentRegistry.global();
		const cloneId = `Tan-${Snowflake.next()}`;
		const cloneFile = path.join(sessionDir, `${cloneId}.jsonl`);
		const label = `/tan ${previewWork(trimmedWork)}`;

		await this.ctx.sessionManager.ensureOnDisk();
		await this.ctx.sessionManager.flush();

		let jobId = "";
		try {
			const cloneManager = await SessionManager.forkFrom(parentFile, cwd, sessionDir, undefined, {
				copyArtifacts: false,
				suppressBreadcrumb: true,
				sessionFile: cloneFile,
			});

			jobId = manager.register(
				"task",
				label,
				async ({ signal }) => {
					if (signal.aborted) throw new Error("Aborted before execution");

					let clone: AgentSession | undefined;
					try {
						const created = await sdk.createAgentSession({
							cwd,
							sessionManager: cloneManager,
							model,
							thinkingLevel,
							systemPrompt,
							toolNames,
							providerSessionId: `${parentSessionId}:tan:${Snowflake.next()}`,
							providerPromptCacheKey: parentPromptCacheKey,
							modelRegistry,
							authStorage: modelRegistry.authStorage,
							settings,
							hasUI: false,
							enableMCP: false,
							customTools,
							enableLsp,
							agentId: cloneId,
							agentDisplayName: "tan",
							parentTaskPrefix: cloneId,
							parentAgentId: ownerId,
							agentRegistry,
							disableExtensionDiscovery: true,
							localProtocolOptions,
						});
						clone = created.session;
						clone.sessionManager?.appendSessionInit?.({
							systemPrompt: clone.systemPrompt ? clone.systemPrompt.join("\n\n") : systemPrompt.join("\n\n"),
							task: trimmedWork,
							tools: clone.getEnabledToolNames(),
						});
						const abortClone = () => {
							void clone?.abort();
						};
						signal.addEventListener("abort", abortClone, { once: true });
						// The fork inherits the parent's todo list via session entries;
						// its reminders would drag the tan back onto the parent's task.
						// Clear runtime state and persist an empty edit so reloads agree.
						clone.setTodoPhases([]);
						cloneManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
						const injectContextSwitch = () => {
							clone?.agent.appendMessage({
								role: "developer",
								content: tanContextSwitchPrompt,
								attribution: "agent",
								timestamp: Date.now(),
							});
						};
						// Compaction summarizes the fork notice away with the rest of the
						// history, after which the clone re-adopts the parent's task as its
						// own (the summary blends both). Re-inject after every successful
						// compaction so the fork boundary survives summarization.
						const unsubscribeCompaction = clone.subscribe(event => {
							if (event.type === "auto_compaction_end" && event.result && !event.aborted) {
								injectContextSwitch();
							}
						});
						try {
							if (signal.aborted) {
								abortClone();
								throw new Error("Aborted before execution");
							}
							// Inject a context-switch developer message so the clone knows
							// it is a tangential fork — its parent owns the prior conversation;
							// this agent must focus exclusively on the user's request.
							injectContextSwitch();
							await clone.prompt(trimmedWork, { attribution: "user" });
							await clone.waitForIdle();
							return extractAssistantText(clone.getLastAssistantMessage()) || "(no output)";
						} finally {
							unsubscribeCompaction();
							signal.removeEventListener("abort", abortClone);
						}
					} finally {
						// Keep the finished tan in the Agent Hub instead of unregistering it:
						// flip the ref to parked BEFORE dispose so the sdk dispose wrapper
						// skips its unregister, then null the disposed session so the hub
						// treats it as a transcript-only parked agent. An aborted tan is
						// terminal — let dispose unregister it.
						if (clone) {
							if (signal.aborted) {
								agentRegistry.setStatus(cloneId, "aborted");
								await clone.dispose();
							} else {
								agentRegistry.setStatus(cloneId, "parked");
								await clone.dispose();
								agentRegistry.detachSession(cloneId);
							}
						}
					}
				},
				{ ownerId, agentId: cloneId },
			);
		} catch (error) {
			if (cloneFile) await removeCloneSession(cloneFile);
			this.ctx.showError(error instanceof Error ? error.message : String(error));
			return;
		}

		const content = prompt.render(backgroundTanDispatchPrompt, { jobId, work: trimmedWork });
		// /tan is meant to run alongside an active session. While the parent turn is
		// still streaming, queue the dispatch breadcrumb for the next turn rather than
		// steering the in-flight response; when idle this same call appends + persists
		// the entry immediately (identical to omitting deliverAs).
		const wasStreaming = session.isStreaming;
		await session.sendCustomMessage(
			{
				customType: BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
				content,
				display: true,
				attribution: "user",
				details: { jobId, work: trimmedWork, sessionFile: cloneFile },
			},
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);
		if (!wasStreaming) this.ctx.rebuildChatFromMessages();
		this.ctx.showStatus(`Dispatched background tan ${jobId}`);
	}
}
