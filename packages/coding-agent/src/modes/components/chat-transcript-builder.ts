/**
 * Builds transcript components from persisted session message entries — the
 * file/remote-backed counterpart to {@link UiHelpers.addMessageToChat} (which is
 * bound to the live InteractiveModeContext). Used by the fullscreen transcript
 * viewer ({@link AgentTranscriptViewer}) to render a parked subagent / advisor /
 * collab-guest transcript that has no live session.
 *
 * Unlike the old incremental hub sync, {@link ChatTranscriptBuilder.rebuild}
 * always discards prior components and rebuilds the whole transcript from the
 * supplied entries. Re-rendering a growing transcript is therefore O(n) in the
 * entry count, but it cannot duplicate or misorder rows the way incremental
 * component reuse could.
 */
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import type { AdvisorMessageDetails } from "../../advisor";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabPromptDetails } from "../../collab/protocol";
import { settings } from "../../config/settings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { LAUNCH_COMPLETION_MESSAGE_TYPE } from "../../session/launch-completion";
import {
	BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	type CustomMessage,
	isUserTurnInitiator,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "../../session/messages";
import type { SessionMessageEntry } from "../../session/session-entries";
import { theme } from "../theme/theme";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	buildAsyncResultBlock,
	buildFileMentionBlock,
	buildIrcMessageCard,
	buildLaunchCompletionBlock,
	normalizeToolArgs,
	resolveAssistantErrorPresentation,
	splitAssistantMessageToolTimeline,
} from "../utils/transcript-render-helpers";
import { createAdvisorMessageCard } from "./advisor-message";
import { AssistantMessageComponent } from "./assistant-message";
import { createBackgroundTanDispatchBlock } from "./background-tan-message";
import { BashExecutionComponent } from "./bash-execution";
import { detectCacheInvalidation } from "./cache-invalidation-marker";
import { CollabPromptMessageComponent } from "./collab-prompt-message";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	createHandoffSummaryMessageComponent,
} from "./compaction-summary-message";
import { CustomMessageComponent } from "./custom-message";
import { EvalExecutionComponent } from "./eval-execution";
import { type LateDiagnosticsFile, LateDiagnosticsMessageComponent } from "./late-diagnostics-message";
import { groupedReadUsageCallIds, ReadToolGroupComponent, readArgsCollapseIntoGroup } from "./read-tool-group";
import { SkillMessageComponent } from "./skill-message";
import { ToolExecutionComponent } from "./tool-execution";
import { TranscriptContainer } from "./transcript-container";
import { createUsageRowBlock, turnElapsedMs } from "./usage-row";
import { CollapsedSyntheticMessageComponent, UserMessageComponent } from "./user-message";

export interface ChatTranscriptBuilderDeps {
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	requestRender: () => void;
}

/** Extracts the plain-text content of a user message (string or text blocks). */
function userMessageText(message: Extract<AgentMessage, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("");
}

export class ChatTranscriptBuilder {
	readonly container = new TranscriptContainer();
	#pendingTools = new Map<string, ToolExecutionComponent | ReadToolGroupComponent>();
	#readArgs = new Map<string, Record<string, unknown>>();
	#readGroup: ReadToolGroupComponent | null = null;
	#pendingUsage: Usage | undefined;
	#pendingUsageDuration: number | undefined;
	#pendingUsageTtft: number | undefined;
	#pendingUsageTimestamp: number | undefined;
	#pendingReadUsageCallIds: string[] | undefined;
	#pendingUsageElapsedMs: number | undefined;
	#turnStartedAt: number | undefined;
	#lastAssistantUsage: Usage | undefined;
	#waitingPoll: ToolExecutionComponent | null = null;
	#todoSnapshot: ToolExecutionComponent | null = null;
	#expandables: Array<{ setExpanded(expanded: boolean): void }> = [];
	#expanded = false;
	#entryComponents = new Map<string, Component[]>();

	constructor(private readonly deps: ChatTranscriptBuilderDeps) {
		this.container.setToolActivityVisible(!settings.get("display.hideToolActivity"));
	}

	/** Whether the transcript currently holds any rendered rows. */
	get isEmpty(): boolean {
		return this.container.children.length === 0;
	}

	/** Discard all components and rebuild the whole transcript from `entries`. */
	rebuild(entries: SessionMessageEntry[]): void {
		this.reset();
		for (const entry of entries) this.#appendEntry(entry);
		// Flush the trailing turn's usage row only once its tools are materialized
		// (a read whose result has not arrived stays pending); otherwise the row
		// would sit above its tools. The drain happens here at the end of the pass.
		if (this.#readArgs.size === 0 && this.#pendingTools.size === 0) this.#flushPendingUsage();
	}

	/** Append newly persisted entries without rebuilding already rendered rows. */
	append(entries: SessionMessageEntry[]): void {
		for (const entry of entries) this.#appendEntry(entry);
		if (this.#readArgs.size === 0 && this.#pendingTools.size === 0) this.#flushPendingUsage();
	}

	/** Toggle tool-output expansion across every expandable component. */
	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		for (const component of this.#expandables) component.setExpanded(expanded);
	}

	get expanded(): boolean {
		return this.#expanded;
	}

	/** Rendered row where a persisted entry begins, after the container has painted once. */
	rowForEntry(entryId: string): number | undefined {
		for (const component of this.#entryComponents.get(entryId) ?? []) {
			const row = this.container.getChildStartRow(component);
			if (row !== undefined) return row;
		}
		return undefined;
	}

	/** Tear down components (sealing pending spinners) and clear build state. */
	reset(): void {
		for (const pending of this.#pendingTools.values()) pending.seal();
		this.#pendingTools.clear();
		this.#readArgs.clear();
		this.#readGroup = null;
		this.#pendingUsage = undefined;
		this.#pendingUsageDuration = undefined;
		this.#pendingUsageTtft = undefined;
		this.#pendingUsageTimestamp = undefined;
		this.#pendingReadUsageCallIds = undefined;
		this.#pendingUsageElapsedMs = undefined;
		this.#turnStartedAt = undefined;
		this.#lastAssistantUsage = undefined;
		this.#waitingPoll = null;
		this.#todoSnapshot = null;
		this.#expandables = [];
		this.#entryComponents.clear();
		this.container.dispose();
		this.container.clear();
	}

	dispose(): void {
		this.reset();
	}

	#appendEntry(entry: SessionMessageEntry): void {
		const before = this.container.children.length;
		this.#appendChatMessage(entry.message);
		const components = this.container.children.slice(before);
		if (components.length > 0) this.#entryComponents.set(entry.id, components);
	}

	#trackExpandable(component: { setExpanded(expanded: boolean): void }): void {
		component.setExpanded(this.#expanded);
		this.#expandables.push(component);
	}

	/** A `hub` wait showing all-running is displaced by the next `hub` call. */
	#resolveWaitingPoll(nextToolName?: string): void {
		const previous = this.#waitingPoll;
		if (!previous) return;
		this.#waitingPoll = null;
		if (nextToolName === "hub" && previous.isDisplaceableBlock() && this.container.canRemoveBlock(previous)) {
			this.container.removeChild(previous);
		}
		previous.seal();
	}

	#resolveTodoSnapshot(nextToolName?: string): void {
		const previous = this.#todoSnapshot;
		if (!previous) return;
		if (!previous.isDisplaceableBlock()) {
			this.#todoSnapshot = null;
			return;
		}
		if (previous.canBeDisplacedBy(nextToolName)) {
			this.#todoSnapshot = null;
			if (this.container.canRemoveBlock(previous)) {
				this.container.removeChild(previous);
			}
			previous.seal();
			return;
		}
		if (nextToolName !== undefined) return;
		this.#todoSnapshot = null;
		previous.seal();
	}

	#ensureReadGroup(): ReadToolGroupComponent {
		if (!this.#readGroup) {
			this.#readGroup = new ReadToolGroupComponent({
				showContentPreview: settings.get("read.toolResultPreview"),
			});
			this.#trackExpandable(this.#readGroup);
			this.container.addChild(this.#readGroup);
		}
		return this.#readGroup;
	}

	// Defer per-turn metrics until the turn's tool results have materialized.
	// Read-only invisible turns attach the metrics to their shared compact
	// group; every other turn keeps the standalone row below its tool blocks.
	#flushPendingUsage(): void {
		if (!this.#pendingUsage) return;
		const usageAttached =
			this.#pendingReadUsageCallIds !== undefined &&
			(this.#readGroup?.attachUsage(
				this.#pendingReadUsageCallIds,
				this.#pendingUsage,
				this.#pendingUsageDuration,
				this.#pendingUsageTtft,
				this.#pendingUsageTimestamp,
				this.#pendingUsageElapsedMs,
			) ??
				false);
		if (!usageAttached) {
			this.#readGroup?.seal();
			this.#readGroup = null;
			this.container.addChild(
				createUsageRowBlock(
					this.#pendingUsage,
					this.#pendingUsageDuration,
					this.#pendingUsageTtft,
					this.#pendingUsageTimestamp,
					this.#pendingUsageElapsedMs,
				),
			);
		}
		this.#pendingUsage = undefined;
		this.#pendingUsageDuration = undefined;
		this.#pendingUsageTtft = undefined;
		this.#pendingUsageTimestamp = undefined;
		this.#pendingReadUsageCallIds = undefined;
		this.#pendingUsageElapsedMs = undefined;
	}

	#appendChatMessage(message: AgentMessage): void {
		if (message.role !== "toolResult") this.#flushPendingUsage();
		if (message.role !== "assistant" && message.role !== "toolResult") {
			this.#readGroup?.seal();
			this.#readGroup = null;
		}
		switch (message.role) {
			case "assistant":
				this.#appendAssistantMessage(message);
				break;
			case "toolResult":
				this.#appendToolResult(message);
				break;
			case "user":
			case "developer": {
				// Only genuinely user-attributed prompts anchor the delta; a mid-run
				// agent-attributed `user` message (advisor tool-loop redirect) must not.
				if (message.role === "user" && message.attribution !== "agent") {
					this.#turnStartedAt = message.timestamp;
				} else if (message.role === "developer" && message.synthetic) {
					// A synthetic developer message initiates a fresh run (auto-
					// continue, /goal, approved plan): replay must not inherit the
					// preceding user prompt's timestamp, mirroring the live
					// agent_start clear. Same-turn continuation reminders (todo, plan)
					// are persisted developer messages WITHOUT the synthetic marker,
					// so their anchor survives the rebuild.
					// A deliberate operator action (`.`, `c` continue shortcut) is the turn's
					// own prompt: anchor the delta to it instead of clearing.
					if (message.userInitiated) this.#turnStartedAt = message.timestamp;
					else this.#turnStartedAt = undefined;
				}
				// A user prompt closes the poll-displacement window, same as the live path.
				if (message.role === "user") this.#resolveWaitingPoll();
				if (message.role === "user") this.#resolveTodoSnapshot();
				const textContent = message.role === "user" ? userMessageText(message) : "";
				if (textContent) {
					const isSynthetic = message.role === "developer" ? true : (message.synthetic ?? false);
					// Synthetic (agent-attributed) inputs — chiefly the advisor's `Session
					// update` replay dumps — can be hundreds of KiB of Markdown each.
					// Rendering their full body on cold open blocked the TUI (issue #6308);
					// collapse them behind a compact summary that builds Markdown only on
					// ctrl+o expand. Real user prompts stay fully rendered.
					if (isSynthetic) {
						const collapsed = new CollapsedSyntheticMessageComponent(textContent);
						this.#trackExpandable(collapsed);
						this.container.addChild(collapsed);
					} else {
						this.container.addChild(new UserMessageComponent(textContent, false));
					}
				}
				break;
			}
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.deps.ui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, { truncation: message.meta?.truncation });
				this.container.addChild(component);
				break;
			}
			case "pythonExecution": {
				const component = new EvalExecutionComponent(message.code, this.deps.ui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, { truncation: message.meta?.truncation });
				this.container.addChild(component);
				break;
			}
			case "hookMessage":
			case "custom":
				// A directly-invoked `/skill:` custom prompt is the run's initiator
				// (user attribution), so it seeds the prompt→yield delta like a user
				// message does.
				if (message.role === "custom" && isUserTurnInitiator(message as CustomMessage)) {
					this.#turnStartedAt = message.timestamp;
				}
				this.#appendCustomMessage(message);
				break;
			case "compactionSummary": {
				const component = new CompactionSummaryMessageComponent(message);
				this.#trackExpandable(component);
				this.container.addChild(component);
				break;
			}
			case "branchSummary": {
				const component = new BranchSummaryMessageComponent(message);
				this.#trackExpandable(component);
				this.container.addChild(component);
				break;
			}
			case "fileMention": {
				// Indent one column to match the transcript's other rows (the viewer renders
				// body rows without an outer gutter; rows own their left pad).
				const block = buildFileMentionBlock(message.files, 1);
				if (block.children.length > 0) this.container.addChild(block);
				break;
			}
			default:
				message satisfies never;
		}
	}

	/** Prompt→yield wall time for the current turn, or undefined when unknown. */
	#turnElapsedMs(message: Extract<AgentMessage, { role: "assistant" }>): number | undefined {
		return turnElapsedMs(this.#turnStartedAt, message);
	}

	#appendAssistantMessage(message: Extract<AgentMessage, { role: "assistant" }>): void {
		const hideThinkingBlock = this.deps.hideThinkingBlock?.() ?? false;
		const proseOnlyThinking = this.deps.proseOnlyThinking ? this.deps.proseOnlyThinking() : true;
		const timeline = splitAssistantMessageToolTimeline(message);
		const assistantComponent = new AssistantMessageComponent(
			timeline.beforeTools,
			hideThinkingBlock,
			() => this.deps.requestRender(),
			this.deps.getMessageRenderer ? undefined : [], // placeholder for thinkingRenderers
			this.deps.ui.imageBudget,
			proseOnlyThinking,
		);
		assistantComponent.setImagesVisible(settings.get("terminal.showImages"));
		assistantComponent.setToolResultImagesVisible(!settings.get("display.hideToolActivity"));
		this.#trackExpandable(assistantComponent);
		assistantComponent.pickReactionTarget(this.container.children);
		this.container.addChild(assistantComponent);

		if (settings.get("display.cacheMissMarker")) {
			const invalidation = detectCacheInvalidation(this.#lastAssistantUsage, message.usage);
			if (invalidation) assistantComponent.setCacheInvalidation(invalidation);
		}
		if (message.usage.cacheRead + message.usage.cacheWrite + message.usage.input > 0) {
			this.#lastAssistantUsage = message.usage;
		}

		const hasVisibleAssistantContent = assistantHasVisibleContent(message);
		if (hasVisibleAssistantContent) {
			// New visible turn content closes the current read run (mirrors rebuild).
			this.#readGroup?.seal();
			this.#readGroup = null;
		}

		const errorPresentation = resolveAssistantErrorPresentation(message);
		const hasErrorStop = errorPresentation.kind === "full";
		const errorMessage = hasErrorStop ? errorPresentation.text : null;
		const appendAssistantSegment = (segment: Extract<AgentMessage, { role: "assistant" }> | undefined) => {
			if (!segment || !assistantHasVisibleContent(segment)) return;
			const component = new AssistantMessageComponent(
				segment,
				hideThinkingBlock,
				() => this.deps.requestRender(),
				this.deps.getMessageRenderer ? undefined : [],
				undefined,
				proseOnlyThinking,
			);
			component.setImagesVisible(settings.get("terminal.showImages"));
			component.setToolResultImagesVisible(!settings.get("display.hideToolActivity"));
			this.#trackExpandable(component);
			this.container.addChild(component);
		};

		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			this.#resolveWaitingPoll(content.name);

			const afterToolSegment = timeline.afterToolCalls.get(content.id);
			if (content.name === "read" && readArgsCollapseIntoGroup(content.arguments)) {
				if (hasErrorStop && errorMessage) {
					const group = this.#ensureReadGroup();
					group.updateArgs(content.arguments, content.id);
					group.updateResult(
						{ content: [{ type: "text", text: errorMessage }], isError: true },
						false,
						content.id,
					);
				} else if (afterToolSegment) {
					const group = this.#ensureReadGroup();
					group.updateArgs(content.arguments, content.id);
					this.#pendingTools.set(content.id, group);
				} else {
					const normalizedArgs = normalizeToolArgs(content.arguments);
					this.#readArgs.set(content.id, normalizedArgs);
				}
				appendAssistantSegment(afterToolSegment);
				continue;
			}

			this.#readGroup?.seal();
			this.#readGroup = null;
			const component = new ToolExecutionComponent(
				content.name,
				content.arguments,
				{
					useBuiltInRenderer: this.deps.isBuiltInTool?.(content.name) ?? true,
					// Stable ids and Kitty placeholder cells keep images anchored
					// while the transcript viewport scrolls and reflows.
					showImages: settings.get("terminal.showImages"),
				},
				this.deps.getTool?.(content.name),
				this.deps.ui,
				this.deps.cwd,
				content.id,
			);
			this.#trackExpandable(component);
			this.container.addChild(component);

			if (hasErrorStop && errorMessage) {
				component.updateResult(
					{ content: [{ type: "text", text: errorMessage }], isError: true },
					false,
					content.id,
				);
			} else {
				this.#pendingTools.set(content.id, component);
			}
			appendAssistantSegment(afterToolSegment);
		}

		this.#pendingUsage =
			settings.get("display.showTokenUsage") && assistantUsageIsBilled(message.usage) ? message.usage : undefined;
		this.#pendingUsageDuration = message.duration;
		this.#pendingUsageTtft = message.ttft;
		this.#pendingUsageTimestamp = message.timestamp;
		this.#pendingReadUsageCallIds = this.#pendingUsage ? groupedReadUsageCallIds(message) : undefined;
		this.#pendingUsageElapsedMs =
			this.#pendingUsage && settings.get("display.showTurnTime") ? this.#turnElapsedMs(message) : undefined;
	}

	#appendToolResult(message: Extract<AgentMessage, { role: "toolResult" }>): void {
		const pending = this.#pendingTools.get(message.toolCallId);
		const isReadGroupResult = message.toolName === "read" && (!pending || pending instanceof ReadToolGroupComponent);
		if (isReadGroupResult) {
			let component = pending;
			if (!component) {
				const group = this.#ensureReadGroup();
				const args = this.#readArgs.get(message.toolCallId);
				if (args) group.updateArgs(args, message.toolCallId);
				component = group;
			}
			component.updateResult(message, false, message.toolCallId);
			this.#pendingTools.delete(message.toolCallId);
			this.#readArgs.delete(message.toolCallId);
			return;
		}
		if (!pending) return;
		pending.updateResult(message, false, message.toolCallId);
		this.#pendingTools.delete(message.toolCallId);
		if (message.toolName === "hub" && pending instanceof ToolExecutionComponent && pending.isDisplaceableBlock()) {
			this.#waitingPoll = pending;
		} else if (
			message.toolName === "todo" &&
			pending instanceof ToolExecutionComponent &&
			pending.canBeDisplacedBy("todo")
		) {
			// A successful todo result supersedes the prior live snapshot. Failed
			// follow-ups return false from canBeDisplacedBy("todo"), so the
			// last-good panel stays on screen.
			this.#resolveTodoSnapshot("todo");
			this.#todoSnapshot = pending;
		}
	}
	#appendCustomMessage(message: Extract<AgentMessage, { role: "custom" | "hookMessage" }>): void {
		if (!message.display) return;
		if (message.customType === "async-result") {
			const component = buildAsyncResultBlock(message);
			this.container.addChild(component);
			return;
		}
		if (message.customType === LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE) {
			const details = (message as CustomMessage<{ files?: LateDiagnosticsFile[] }>).details;
			const component = new LateDiagnosticsMessageComponent(details?.files ?? []);
			this.#trackExpandable(component);
			this.container.addChild(component);
			return;
		}
		if (message.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
			this.container.addChild(new CollabPromptMessageComponent(message as CustomMessage<CollabPromptDetails>));
			return;
		}
		if (message.customType === SKILL_PROMPT_MESSAGE_TYPE) {
			const component = new SkillMessageComponent(message as CustomMessage<SkillPromptDetails>);
			this.#trackExpandable(component);
			this.container.addChild(component);
			return;
		}
		if (
			message.customType === "irc:incoming" ||
			message.customType === "irc:autoreply" ||
			message.customType === "irc:relay" ||
			message.customType === "irc:workpool"
		) {
			this.container.addChild(buildIrcMessageCard(message, () => this.#expanded));
			return;
		}
		if (message.customType === "advisor") {
			const details = (message as CustomMessage<AdvisorMessageDetails>).details;
			this.container.addChild(createAdvisorMessageCard(details, () => this.#expanded, theme));
			return;
		}
		if (message.customType === LAUNCH_COMPLETION_MESSAGE_TYPE) {
			this.container.addChild(buildLaunchCompletionBlock(message));
			return;
		}
		if (message.customType === BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE) {
			this.container.addChild(createBackgroundTanDispatchBlock(message as CustomMessage<unknown>));
			return;
		}
		const handoffComponent = createHandoffSummaryMessageComponent(message as CustomMessage<unknown>, this.#expanded);
		if (handoffComponent) {
			this.#trackExpandable(handoffComponent);
			this.container.addChild(handoffComponent);
			return;
		}
		const component = new CustomMessageComponent(
			message as CustomMessage<unknown>,
			this.deps.getMessageRenderer?.(message.customType),
		);
		this.#trackExpandable(component);
		this.container.addChild(component);
	}
}
