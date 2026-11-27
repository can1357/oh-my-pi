import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { isEnoent, logger, prompt, Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import tanContextSwitchPrompt from "../../prompts/system/tan-context-switch.md" with { type: "text" };
import tanNamePrompt from "../../prompts/system/tan-name.md" with { type: "text" };
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import * as sdk from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE, buildTitleDriftTurns } from "../../session/messages";
import { isHiddenUserCompanion } from "../../session/queued-messages";
import { TAN_FORK_BOUNDARY_CUSTOM_TYPE } from "../../session/session-entries";
import { SessionManager } from "../../session/session-manager";
import type { SessionStorage } from "../../session/session-storage";
import { createSubagentSettings, followMCPTools } from "../../task/executor";
import { generateTaskName } from "../../task/name-generator";
import { AgentOutputManager } from "../../task/output-manager";
import { cleanTinyMessage, formatTitleConversationContext, MAX_TINY_MESSAGE_CHARS } from "../../tiny/message-preproc";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../../tools/todo";
import type { TodoPhase } from "../../tools/details/todo";
import type { InteractiveModeContext } from "../types";

import { cfgTaskEnableLsp } from "../../task/settings";

const TAN_LABEL_PREVIEW_LENGTH = 80;
const TAN_NAME_SYSTEM_PROMPT = prompt.render(tanNamePrompt);
/** How long dispatch waits on the small model for a name before falling back to a random one. */
const TAN_NAME_TIMEOUT_MS = 30_000;
/** Longest generated name, the task tool's bound on agent names. */
const TAN_NAME_MAX_CHARS = 32;
/** `<chat>` scaffolding around the name context's turns. */
const CHAT_ENVELOPE_CHARS = "<chat>\n\n</chat>".length;
/** Scaffolding one turn adds at most: the longest role's tags plus the turn separator. */
const CHAT_TURN_TAG_CHARS = "<assistant>\n\n</assistant>\n\n".length;

function previewWork(work: string): string {
	const singleLine = work.trim().replace(/\s+/g, " ");
	if (singleLine.length <= TAN_LABEL_PREVIEW_LENGTH) return singleLine;
	return `${singleLine.slice(0, TAN_LABEL_PREVIEW_LENGTH - 1)}…`;
}

/**
 * What the small model names a tan from: its request as the final `<user>`
 * turn, after the newest parent turns that fit the tiny-model window beside it.
 */
function tanNameContext(work: string, messages: readonly AgentMessage[]): string {
	const request = cleanTinyMessage(work);
	let budget = MAX_TINY_MESSAGE_CHARS - CHAT_ENVELOPE_CHARS - CHAT_TURN_TAG_CHARS - request.length;
	const recent = buildTitleDriftTurns(messages);
	let start = recent.length;
	while (start > 0) {
		const cost = recent[start - 1]!.text.length + CHAT_TURN_TAG_CHARS;
		if (cost > budget) break;
		budget -= cost;
		start--;
	}
	return formatTitleConversationContext([...recent.slice(start), { role: "user", text: request }]);
}

/** PascalCase agent id of a generated title (`Flaky retry test` → `FlakyRetryTest`): whole words, at most {@link TAN_NAME_MAX_CHARS}. */
function tanNameFromTitle(title: string): string | undefined {
	let name = "";
	for (const word of title.split(/[^A-Za-z0-9]+/)) {
		if (!word) continue;
		const part = word.charAt(0).toUpperCase() + word.slice(1);
		if (name.length + part.length > TAN_NAME_MAX_CHARS) break;
		name += part;
	}
	return name || undefined;
}

/**
 * The small model's name for a tan, from its request and the parent's latest
 * turns; `undefined` when it names none, fails, or misses {@link TAN_NAME_TIMEOUT_MS}.
 */
async function generateTanName(session: AgentSession, work: string): Promise<string | undefined> {
	const timeout = AbortSignal.timeout(TAN_NAME_TIMEOUT_MS);
	try {
		const context = tanNameContext(work, session.messages);
		// The race bounds the wait even where a request path ignores the signal.
		const title = await untilAborted(timeout, () => session.generateTitle(context, TAN_NAME_SYSTEM_PROMPT, timeout));
		return title ? tanNameFromTitle(title) : undefined;
	} catch (error) {
		logger.debug("tan: name generation failed", { error: error instanceof Error ? error.message : String(error) });
		return undefined;
	}
}

function extractAssistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

/**
 * Remove a clone whose dispatch failed. Its manager is sealed first, so
 * closing it writes nothing more and only gives up the clone's ownership lease
 * and writer. Then its transcript goes from the storage the fork wrote it to
 * (the parent session's; a row under `session.storage: sql`), with its local
 * artifacts directory. A fork that failed before writing leaves only the
 * directory, if anything.
 *
 * Both removals are always attempted, as the pair of `fs.rm` calls this
 * replaced were: a transcript the storage refuses to delete must not also
 * strand the clone's artifacts directory on disk.
 */
async function removeCloneSession(
	cloneFile: string,
	clone: SessionManager | undefined,
	storage: SessionStorage,
): Promise<void> {
	if (clone) {
		clone.seal();
		await clone.close().catch((error: unknown) => {
			logger.warn("/tan: failed to close the clone of a failed dispatch", { cloneFile, error: String(error) });
		});
	}
	let artifactsRemoved = false;
	try {
		await storage.deleteSessionWithArtifacts(cloneFile);
		artifactsRemoved = true;
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("/tan: failed to remove the clone of a failed dispatch", { cloneFile, error: String(error) });
		}
	}
	if (artifactsRemoved) return;
	await fs.rm(cloneFile.slice(0, -".jsonl".length), { recursive: true, force: true }).catch(error => {
		logger.warn("/tan: failed to remove the clone's artifacts", { cloneFile, error: String(error) });
	});
}

export class TanCommandController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	/** Dispatch `work` to a background clone of this session; resolves `false` when nothing was dispatched. */
	async start(work: string, images?: ImageContent[]): Promise<boolean> {
		const trimmedWork = work.trim();
		if (!trimmedWork) {
			this.ctx.showStatus("Usage: /tan <work>");
			return false;
		}

		const session = this.ctx.session;

		const model = session.model;
		if (!model) {
			this.ctx.showError("No active model available for /tan.");
			return false;
		}

		const manager = session.asyncJobManager;
		if (!manager) {
			this.ctx.showError("Background jobs are disabled; enable async jobs to use /tan.");
			return false;
		}

		const parentFile = this.ctx.sessionManager.getSessionFile();
		if (!parentFile) {
			this.ctx.showError("/tan requires a persisted session.");
			return false;
		}

		const parentSessionId = session.sessionId;
		// Explicit keys stay pinned; automatic candidates must remain model-gated
		// if the clone later switches models or falls back during authentication.
		const taskPromptCacheKey = this.ctx.sessionManager.getHeader()?.taskPromptCacheKey;
		const parentPromptCacheKey =
			session.agent.promptCacheKey ?? (taskPromptCacheKey === undefined ? parentSessionId : undefined);
		const thinkingLevel = session.configuredThinkingLevel();
		const systemPrompt = [...session.systemPrompt];
		// The copied prompt carries the parent's memory recall; the clone inherits it as delivered.
		const parentMnemopiSessionState = session.getMnemopiSessionState?.();
		const toolNames = session.getEnabledToolNames();
		const activeToolNames = session.getActiveToolNames();
		const mountedToolNames = session.getMountedToolCommandNames();
		const modelRegistry = session.modelRegistry;
		// Snapshot the parent's rebindable extensions and root policy at dispatch.
		// The child rebinds these (skipping discovery) so it re-registers the
		// parent's runtime providers on the shared model registry before the SDK's
		// syncExtensionSources prune runs — without this the child builds an empty
		// extension set and unregisters the parent's provider auth (no-key error).
		const parentPreparedExtensions = session.preparedExtensions;
		// Path-list fallback for the (rare) parent build path that produced no
		// prepared factories; the child rebinds from paths so it still re-registers
		// providers rather than pruning the shared registry from an empty set.
		const parentExtensionPaths = session.extensionPaths;
		const parentExtensionRoots = session.effectiveExtensionRoots;
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
		const enableLsp = cfgTaskEnableLsp.get(this.ctx.settings) !== false;
		const agentRegistry = AgentRegistry.global();
		const label = `/tan ${previewWork(trimmedWork)}`;
		const naming = generateTanName(session, trimmedWork);
		this.ctx.showStatus("Naming background tan…");

		await this.ctx.sessionManager.ensureOnDisk();
		await this.ctx.sessionManager.flush();

		// The clone lives where this session lives, so a failed dispatch removes it from there.
		const parentStorage = this.ctx.sessionManager.getStorage();
		// The clone's transcript nests beside the parent's task subagents, so its id
		// comes from the same allocator; registry ids cover agents not yet on disk.
		const name = (await naming) ?? generateTaskName();
		const ids =
			session.agentOutputManager ??
			new AgentOutputManager(() => sessionDir, { settings: this.ctx.settings, storage: parentStorage });
		await ids.reserve(agentRegistry.list().map(ref => ref.id));
		const cloneId = await ids.allocate(name);
		const cloneFile = path.join(sessionDir, `${cloneId}.jsonl`);
		let jobId = "";
		let forkedClone: SessionManager | undefined;
		try {
			const cloneManager = await SessionManager.forkFrom(parentFile, cwd, sessionDir, parentStorage, {
				copyArtifacts: false,
				suppressBreadcrumb: true,
				sessionFile: cloneFile,
				// A tan is a fresh agent forking the parent's transcript only for
				// context; its cost must reflect its own work, not the parent's
				// accumulated spend that session cost is otherwise derived from.
				resetInheritedCost: true,
				// The parent may be mid-turn: pair any tool call it left unresolved
				// with an unknown-outcome result (the parent may still be running it)
				// so the clone inherits a terminal transcript instead of rendering the
				// parent's in-flight call as its own pending work (issue #11118).
				repairInterruptedTail: true,
			});
			forkedClone = cloneManager;
			cloneManager.appendCustomEntry(TAN_FORK_BOUNDARY_CUSTOM_TYPE, cloneManager.getSessionId());

			jobId = manager.register(
				"task",
				label,
				async ({ signal }) => {
					if (signal.aborted) throw new Error("Aborted before execution");

					let clone: AgentSession | undefined;
					// Mint proxies at clone time (not dispatch time) and subscribe first,
					// so the clone follows MCP reloads for its whole run. A fork of the owner
					// starts from the owner's view, so it renders the owner's exact tools.
					const mcpFollower = mcpManager
						? followMCPTools(mcpManager, { scope: cloneManager.getSessionId() })
						: undefined;
					try {
						try {
							const created = await sdk.createAgentSession({
								cwd,
								costGate: session.costGate,
								sessionManager: cloneManager,
								model,
								thinkingLevel,
								systemPrompt,
								toolNames,
								mountedToolNames,
								advertiseHeadlessAsk: activeToolNames.includes("ask"),
								providerSessionId: `${parentSessionId}:tan:${Snowflake.next()}`,
								providerPromptCacheKey: parentPromptCacheKey,
								taskPromptCacheKey,
								modelRegistry,
								authStorage: modelRegistry.authStorage,
								settings,
								hasUI: false,
								enableMCP: false,
								mcpTools: mcpFollower?.proxyTools(),
								mcpToolScope: mcpFollower?.scope,
								enableLsp,
								agentId: cloneId,
								agentDisplayName: "tan",
								parentTaskPrefix: cloneId,
								tanFork: true,
								asyncJobManager: manager,
								parentAgentId: ownerId,
								agentRegistry,
								disableExtensionDiscovery: true,
								// `[]` is truthy and would make the child pick bindPreparedExtensions([])
								// over a populated path fallback, so collapse an empty list to undefined.
								preloadedPreparedExtensions: parentPreparedExtensions?.length
									? parentPreparedExtensions
									: undefined,
								preloadedExtensionPaths: parentExtensionPaths?.length ? [...parentExtensionPaths] : undefined,
								extensionRoots: () => parentExtensionRoots,
								localProtocolOptions,
								parentMnemopiSessionState,
							});
							clone = created.session;
							await clone.setActiveToolPresentation(toolNames, mountedToolNames);
						} catch (error) {
							mcpFollower?.dispose();
							throw error;
						}
						mcpFollower?.bind(clone);
						clone.sessionManager?.appendSessionInit?.({
							systemPrompt: clone.systemPrompt ?? systemPrompt,
							task: trimmedWork,
							tools: clone.getEnabledToolNames(),
							mountedTools: clone.getMountedToolCommandNames(),
						});
						const abortClone = () => {
							void clone?.abort();
						};
						signal.addEventListener("abort", abortClone, { once: true });
						// The fork inherits the parent's todo list via session entries;
						// its reminders would drag the tan back onto the parent's task.
						// Replace it with the assignment as the only item, so todo
						// reminders point at the tan's own work, and persist the edit so
						// reloads agree.
						const assignment: TodoPhase[] = [
							{ name: "Assignment", tasks: [{ content: previewWork(trimmedWork), status: "in_progress" }] },
						];
						clone.setTodoPhases(assignment);
						cloneManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: assignment });
						const injectContextSwitch = () => {
							const fork = clone;
							if (!fork) return;
							const tools = fork.getEnabledToolNames();
							fork.agent.appendMessage({
								role: "developer",
								content: prompt.render(tanContextSwitchPrompt, {
									name: cloneId,
									todoTool: tools.includes("todo"),
									waitTool: tools.includes("wait"),
								}),
								attribution: "agent",
								timestamp: Date.now(),
							});
						};
						// The fork's request enters the transcript only once the initial
						// prompt dispatches (its first `agent_start`). Compaction that
						// fires before then is the pre-prompt pass on the inherited
						// context: the pending request has not been appended yet and the
						// dispatch adds it immediately after, so restoring it here would
						// send the assignment twice — re-inject only the notice above it.
						// Once the request is in history, restore the notice and request
						// together only when summarization actually dropped the request:
						// the notice must never claim a request that no longer follows it,
						// and a request the summarizer kept (a recent turn within
						// `compaction.keepRecentTokens`, or a prior re-injection still
						// live) must not be duplicated onto the tail, which would present
						// the same assignment again and risk restarting completed work.
						// The restore replays the request as the clone admitted it (normalized
						// images, hidden companions), matched by the text of the turn's first
						// user message: a prompt template may have expanded the `/tan` work.
						let requestDispatched = false;
						let requestText: string | undefined;
						let admittedRequest: AgentMessage[] | undefined;
						const isRequest = (message: AgentMessage) => {
							if (message.role !== "user") return false;
							const text = requestText ?? trimmedWork;
							const content = message.content;
							return typeof content === "string"
								? content === text
								: content.some(part => part.type === "text" && part.text === text);
						};
						const textRequest: AgentMessage = {
							role: "user",
							content: [{ type: "text", text: trimmedWork }],
							attribution: "user",
							timestamp: 0,
						};
						const unsubscribeCompaction = clone.subscribe(event => {
							if (event.type === "agent_start") {
								requestDispatched = true;
								return;
							}
							if (event.type === "message_end") {
								const message = event.message;
								if (!requestDispatched || requestText !== undefined || message.role !== "user") return;
								const content = message.content;
								requestText =
									typeof content === "string"
										? content
										: content.find((part): part is TextContent => part.type === "text")?.text;
								return;
							}
							const messages = clone?.agent.state.messages ?? [];
							if (event.type === "auto_compaction_start") {
								const end = messages.findLastIndex(isRequest);
								if (!requestDispatched || end === -1) return;
								let start = end;
								while (start > 0 && isHiddenUserCompanion(messages[start - 1]!)) start--;
								admittedRequest = messages.slice(start, end + 1);
								return;
							}
							if (event.type !== "auto_compaction_end" || !event.result || event.aborted) return;
							if (!requestDispatched) {
								injectContextSwitch();
								return;
							}
							if (messages.some(isRequest)) return;
							injectContextSwitch();
							for (const message of admittedRequest ?? [textRequest]) {
								clone?.agent.appendMessage({ ...message, timestamp: Date.now() });
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
							await clone.prompt(trimmedWork, { attribution: "user", images });
							await clone.waitForIdle();
							// Descendant work (jobs, child agents) keeps the run open; the tan answers once it ends.
							if (clone.isRunActive) await untilAborted(signal, clone.waitForRunEnd());
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
				{ ownerId, agentId: cloneId, request: trimmedWork },
			);
		} catch (error) {
			await removeCloneSession(cloneFile, forkedClone, parentStorage);
			this.ctx.showError(error instanceof Error ? error.message : String(error));
			return false;
		}

		// A breadcrumb for the user only. Kept out of the model's context: shown the
		// user's work mid-turn, the agent reads it as an instruction or as its own job.
		// Mid-run it is drawn when the run ends; idle, it is appended and painted now.
		// Its completion reaches the agent only as a record (see `buildTanResultMessages`).
		await session.sendCustomMessage({
			customType: BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
			content: trimmedWork,
			display: true,
			excludeFromContext: true,
			attribution: "agent",
			details: { jobId, work: trimmedWork, sessionFile: cloneFile },
		});
		this.ctx.showStatus(`Dispatched background tan ${jobId}`);
		return true;
	}
}
