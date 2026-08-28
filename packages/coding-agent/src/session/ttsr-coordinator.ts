import * as os from "node:os";
import * as path from "node:path";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type Agent,
	type AgentEvent,
	type AgentMessage,
	createToolScopedAbortReason,
} from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { isRecord, prompt, relativePathWithinRoot } from "@oh-my-pi/pi-utils";
import type { Rule } from "../capability/rule";
import type { Settings } from "../config/settings";
import type { TtsrManager, TtsrMatchContext } from "../export/ttsr";
import ttsrInterruptTemplate from "../prompts/system/ttsr-interrupt.md" with { type: "text" };
import ttsrToolReminderTemplate from "../prompts/system/ttsr-tool-reminder.md" with { type: "text" };
import type { AgentSessionEvent } from "./agent-session-events";
import type { SessionManager } from "./session-manager";

interface TtsrContinueOptions {
	source: string;
	delayMs?: number;
	generation?: number;
	shouldContinue?: () => boolean;
	onSkip?: () => void;
	onError?: () => void;
}

/** Capabilities the TTSR coordinator borrows from its owning session. */
export interface TtsrCoordinatorHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	schedulePostPromptTask(task: (signal: AbortSignal) => Promise<void>, options?: { delayMs?: number }): void;
	scheduleAgentContinue(options: TtsrContinueOptions): void;
	promptGeneration(): number;
}

/** Coordinates TTSR stream matching, interruption, injection, and resume gates. */
export class TtsrCoordinator {
	readonly #host: TtsrCoordinatorHost;
	readonly #manager: TtsrManager | undefined;
	#pendingInjections: Rule[] = [];
	#perToolInjections = new Map<string, Rule[]>();
	#abortPending = false;
	#retryToken = 0;
	#resumePromise: Promise<void> | undefined;
	#resumeResolve: (() => void) | undefined;

	constructor(host: TtsrCoordinatorHost, manager: TtsrManager | undefined) {
		this.#host = host;
		this.#manager = manager;
	}

	/** Configured TTSR manager, when stream rules are enabled. */
	get manager(): TtsrManager | undefined {
		return this.#manager;
	}

	/** Whether a TTSR-triggered stream abort is awaiting its continuation. */
	get abortPending(): boolean {
		return this.#abortPending;
	}

	/** Current resume gate awaited by post-prompt recovery. */
	get resumeGate(): Promise<void> | undefined {
		return this.#resumePromise;
	}

	/** Resets stream buffers at turn start. */
	onTurnStart(): void {
		this.#manager?.resetBuffer();
	}

	/** Advances repeat-after-gap tracking at turn end. */
	onTurnEnd(): void {
		this.#manager?.incrementMessageCount();
	}

	/** Checks one streamed message update and reports whether TTSR consumed it by aborting. */
	async checkMessageUpdate(event: AgentEvent): Promise<boolean> {
		if (event.type !== "message_update" || !this.#manager?.hasRules()) return false;
		const assistantEvent = event.assistantMessageEvent;
		let matchContext: TtsrMatchContext | undefined;
		let streamingToolCall: ToolCall | undefined;
		if (assistantEvent.type === "text_delta") {
			matchContext = { source: "text" };
		} else if (assistantEvent.type === "thinking_delta") {
			matchContext = { source: "thinking" };
		} else if (assistantEvent.type === "toolcall_delta") {
			streamingToolCall = this.#getStreamingToolCallBlock(event.message, assistantEvent.contentIndex);
			matchContext = this.#getToolMatchContext(streamingToolCall, assistantEvent.contentIndex);
		}
		if (!matchContext || !("delta" in assistantEvent)) return false;
		const targetMessageTimestamp = event.message.role === "assistant" ? event.message.timestamp : undefined;
		const matches = this.#checkStream(assistantEvent.delta, matchContext, streamingToolCall);
		if (matches.length > 0 && this.#handleMatches(matches, matchContext, targetMessageTimestamp)) return true;
		// AST rules use the reconstructed edit/write snapshot and are awaited so
		// the manager self-throttles native matching.
		if (matchContext.source === "tool" && this.#manager.hasAstRules()) {
			const astMatches = await this.#checkAstStream(matchContext, streamingToolCall);
			if (astMatches.length > 0 && this.#handleMatches(astMatches, matchContext, targetMessageTimestamp))
				return true;
		}
		return false;
	}

	/** Settles the previous resume gate and queues any deferred injection. */
	onAssistantMessageEnd(message: AssistantMessage): void {
		// Gate on abortPending, not stopReason: unrelated aborts have no TTSR continuation.
		if (!this.#abortPending) this.resolveResume();
		this.#queueDeferredInjectionIfNeeded(message);
	}

	/** Marks names persisted with a delivered TTSR injection as injected. */
	markInjectedFromDetails(details: unknown): void {
		if (!details || typeof details !== "object" || Array.isArray(details)) return;
		const rules = "rules" in details ? details.rules : undefined;
		if (!Array.isArray(rules)) return;
		this.#markInjected(rules.filter((ruleName): ruleName is string => typeof ruleName === "string"));
	}

	/** Folds per-tool reminders into the matched tool's result. */
	afterToolCall(ctx: AfterToolCallContext): AfterToolCallResult | undefined {
		const rules = this.#perToolInjections.get(ctx.toolCall.id);
		if (!rules || rules.length === 0) return undefined;
		this.#perToolInjections.delete(ctx.toolCall.id);
		const reminder = rules
			.map(rule =>
				prompt.render(ttsrToolReminderTemplate, {
					name: rule.name,
					path: this.#displayRulePath(rule.path),
					content: rule.content,
				}),
			)
			.join("\n\n");
		const ruleNames = rules.map(rule => rule.name.trim()).filter(name => name.length > 0);
		if (ruleNames.length > 0) this.#host.sessionManager.appendTtsrInjection(ruleNames);
		return { content: [{ type: "text", text: reminder }, ...ctx.result.content] };
	}

	/** Resolves and clears the current resume gate. */
	resolveResume(): void {
		if (!this.#resumeResolve) return;
		this.#resumeResolve();
		this.#resumeResolve = undefined;
		this.#resumePromise = undefined;
	}

	#ensureResumePromise(): void {
		if (this.#resumePromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#resumePromise = promise;
		this.#resumeResolve = resolve;
	}

	#formatAbortReason(rules: Rule[]): string {
		const label = rules.length === 1 ? "rule" : "rules";
		return `TTSR matched ${label}: ${rules.map(rule => rule.name).join(", ")}`;
	}

	#getInjectionContent(): { content: string; rules: Rule[] } | undefined {
		if (this.#pendingInjections.length === 0) return undefined;
		const rules = this.#pendingInjections;
		const content = rules
			.map(rule =>
				prompt.render(ttsrInterruptTemplate, {
					name: rule.name,
					path: this.#displayRulePath(rule.path),
					content: rule.content,
				}),
			)
			.join("\n\n");
		this.#pendingInjections = [];
		return { content, rules };
	}

	#displayRulePath(rulePath: string): string {
		const cwd = this.#host.sessionManager.getCwd();
		const cwdRelative = relativePathWithinRoot(cwd, rulePath) ?? this.#displayPathWithinRoot(cwd, rulePath);
		if (cwdRelative) return cwdRelative;
		const homeRelative = relativePathWithinRoot(os.homedir(), rulePath);
		if (homeRelative) return `~/${homeRelative}`;
		return rulePath;
	}

	#displayPathWithinRoot(root: string, candidate: string): string | null {
		const relative = path.relative(path.resolve(root), path.resolve(candidate));
		return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : null;
	}

	#addPendingInjections(rules: Rule[]): void {
		const seen = new Set(this.#pendingInjections.map(rule => rule.name));
		for (const rule of rules) {
			if (seen.has(rule.name)) continue;
			this.#pendingInjections.push(rule);
			seen.add(rule.name);
		}
	}

	#extractToolCallId(matchContext: TtsrMatchContext): string | undefined {
		if (matchContext.source !== "tool") return undefined;
		const key = matchContext.streamKey;
		if (typeof key !== "string" || !key.startsWith("toolcall:")) return undefined;
		const id = key.slice("toolcall:".length);
		return id.length > 0 ? id : undefined;
	}

	#addPerToolInjections(toolCallId: string, rules: Rule[]): void {
		const bucket = this.#perToolInjections.get(toolCallId) ?? [];
		const seen = new Set(bucket.map(rule => rule.name));
		const claimedElsewhere = new Set<string>();
		for (const [otherId, otherBucket] of this.#perToolInjections) {
			if (otherId === toolCallId) continue;
			for (const rule of otherBucket) claimedElsewhere.add(rule.name);
		}
		const newlyAdded: string[] = [];
		for (const rule of rules) {
			if (seen.has(rule.name) || claimedElsewhere.has(rule.name)) continue;
			bucket.push(rule);
			seen.add(rule.name);
			newlyAdded.push(rule.name);
		}
		if (bucket.length === 0) return;
		this.#perToolInjections.set(toolCallId, bucket);
		if (newlyAdded.length > 0) this.#manager?.markInjectedByNames(newlyAdded);
	}

	#markInjected(ruleNames: string[]): void {
		const uniqueRuleNames = Array.from(
			new Set(ruleNames.map(ruleName => ruleName.trim()).filter(ruleName => ruleName.length > 0)),
		);
		if (uniqueRuleNames.length === 0) return;
		this.#manager?.markInjectedByNames(uniqueRuleNames);
		this.#host.sessionManager.appendTtsrInjection(uniqueRuleNames);
	}

	#findAssistantIndex(targetTimestamp: number | undefined): number {
		const messages = this.#host.agent.state.messages;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message.role === "assistant" && (targetTimestamp === undefined || message.timestamp === targetTimestamp)) {
				return index;
			}
		}
		return -1;
	}

	#shouldInterrupt(matches: Rule[], matchContext: TtsrMatchContext): boolean {
		const globalMode = this.#manager?.getSettings().interruptMode ?? "always";
		for (const rule of matches) {
			const mode = rule.interruptMode ?? globalMode;
			if (mode === "never") continue;
			if (mode === "prose-only" && (matchContext.source === "text" || matchContext.source === "thinking")) {
				return true;
			}
			if (mode === "tool-only" && matchContext.source === "tool") return true;
			if (mode === "always") return true;
		}
		return false;
	}

	#queueDeferredInjectionIfNeeded(message: AssistantMessage): void {
		if (message.stopReason === "aborted" || message.stopReason === "error") this.#perToolInjections.clear();
		if (this.#abortPending || this.#pendingInjections.length === 0) return;
		if (message.stopReason === "aborted" || message.stopReason === "error") {
			this.#pendingInjections = [];
			return;
		}
		const injection = this.#getInjectionContent();
		if (!injection) return;
		this.#host.agent.followUp({
			role: "custom",
			customType: "ttsr-injection",
			content: injection.content,
			display: false,
			details: { rules: injection.rules.map(rule => rule.name) },
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#ensureResumePromise();
		this.#host.scheduleAgentContinue({
			source: "ttsr-injection",
			delayMs: 1,
			generation: this.#host.promptGeneration(),
			onSkip: () => this.resolveResume(),
			shouldContinue: () => {
				if (this.#host.agent.state.isStreaming || !this.#host.agent.hasQueuedMessages()) {
					this.resolveResume();
					return false;
				}
				return true;
			},
			onError: () => this.resolveResume(),
		});
	}

	#getStreamingToolCallBlock(message: AgentMessage, contentIndex: number): ToolCall | undefined {
		if (message.role !== "assistant") return undefined;
		const content = message.content;
		if (!Array.isArray(content) || contentIndex < 0 || contentIndex >= content.length) return undefined;
		const block = content[contentIndex];
		return block && typeof block === "object" && block.type === "toolCall" ? (block as ToolCall) : undefined;
	}

	#getToolMatchContext(toolCall: ToolCall | undefined, contentIndex: number): TtsrMatchContext {
		const context: TtsrMatchContext = { source: "tool" };
		if (!toolCall) return context;
		context.toolName = toolCall.name;
		context.streamKey = toolCall.id ? `toolcall:${toolCall.id}` : `tool:${toolCall.name}:${contentIndex}`;
		context.filePaths = this.#extractToolFilePaths(toolCall);
		return context;
	}

	#extractToolFilePaths(toolCall: ToolCall): string[] | undefined {
		const args = toolCall.arguments ?? {};
		const tool = this.#resolveTool(toolCall);
		const toolPaths = tool?.matcherPaths?.(args);
		if (toolPaths && toolPaths.length > 0) {
			const normalized = toolPaths.flatMap(filePath => this.#normalizePathCandidates(filePath));
			if (normalized.length > 0) return Array.from(new Set(normalized));
		}
		return this.#extractFilePathsFromArgs(args);
	}

	#checkStream(delta: string, matchContext: TtsrMatchContext, toolCall: ToolCall | undefined): Rule[] {
		if (!this.#manager) return [];
		const entries = this.#resolveMatcherEntries(toolCall);
		if (entries) {
			const matches: Rule[] = [];
			for (const entry of entries) {
				matches.push(...this.#manager.checkSnapshot(entry.digest, this.#perFileContext(matchContext, entry.path)));
			}
			return matches;
		}
		const digest = this.#resolveMatcherDigest(toolCall);
		return digest !== undefined
			? this.#manager.checkSnapshot(digest, matchContext)
			: this.#manager.checkDelta(delta, matchContext);
	}

	#resolveMatcherDigest(toolCall: ToolCall | undefined): string | undefined {
		const tool = this.#resolveTool(toolCall);
		return tool?.matcherDigest?.(toolCall?.arguments ?? {});
	}

	#resolveMatcherEntries(toolCall: ToolCall | undefined): readonly { path: string; digest: string }[] | undefined {
		const tool = this.#resolveTool(toolCall);
		const entries = tool?.matcherEntries?.(toolCall?.arguments ?? {});
		return entries && entries.length > 0 ? entries : undefined;
	}

	#resolveTool(toolCall: ToolCall | undefined) {
		if (!toolCall) return undefined;
		const tools = this.#host.agent.state.tools;
		return (
			tools.find(tool => tool.name === toolCall.name) ??
			tools.find(tool => tool.customWireName !== undefined && tool.customWireName === toolCall.name)
		);
	}

	#perFileContext(base: TtsrMatchContext, filePath: string): TtsrMatchContext {
		const filePaths = this.#normalizePathCandidates(filePath);
		return {
			...base,
			filePaths: filePaths.length > 0 ? filePaths : [filePath],
			streamKey: base.streamKey ? `${base.streamKey}#${filePath}` : undefined,
		};
	}

	async #checkAstStream(matchContext: TtsrMatchContext, toolCall: ToolCall | undefined): Promise<Rule[]> {
		if (!this.#manager) return [];
		const entries = this.#resolveMatcherEntries(toolCall);
		if (entries) {
			const matches: Rule[] = [];
			for (const entry of entries) {
				matches.push(
					...(await this.#manager.checkAstSnapshot(entry.digest, this.#perFileContext(matchContext, entry.path))),
				);
			}
			return matches;
		}
		const digest = this.#resolveMatcherDigest(toolCall);
		return digest === undefined ? [] : this.#manager.checkAstSnapshot(digest, matchContext);
	}

	#handleMatches(matches: Rule[], matchContext: TtsrMatchContext, targetTimestamp: number | undefined): boolean {
		const shouldInterrupt = this.#shouldInterrupt(matches, matchContext);
		const matchedToolId = this.#extractToolCallId(matchContext);
		const perToolId = shouldInterrupt ? undefined : matchedToolId;
		if (perToolId) {
			this.#addPerToolInjections(perToolId, matches);
			this.#host.emitSessionEvent({ type: "ttsr_triggered", rules: matches }).catch(() => {});
			return false;
		}
		this.#addPendingInjections(matches);
		if (!shouldInterrupt) return false;

		this.#abortPending = true;
		this.#ensureResumePromise();
		const abortReason = this.#formatAbortReason(matches);
		this.#host.agent.abort(
			matchedToolId
				? createToolScopedAbortReason(
						abortReason,
						{ [matchedToolId]: abortReason },
						"TTSR interrupt on another tool call",
					)
				: abortReason,
		);
		this.#host.emitSessionEvent({ type: "ttsr_triggered", rules: matches }).catch(() => {});
		const retryToken = ++this.#retryToken;
		const generation = this.#host.promptGeneration();
		this.#host.schedulePostPromptTask(
			async () => {
				if (this.#retryToken !== retryToken) {
					this.resolveResume();
					return;
				}
				const targetAssistantIndex = this.#findAssistantIndex(targetTimestamp);
				if (!this.#abortPending || this.#host.promptGeneration() !== generation || targetAssistantIndex === -1) {
					this.#abortPending = false;
					this.#pendingInjections = [];
					this.#perToolInjections.clear();
					this.resolveResume();
					return;
				}
				this.#abortPending = false;
				this.#perToolInjections.clear();
				if (this.#manager?.getSettings().contextMode === "discard") {
					this.#host.agent.replaceMessages(this.#host.agent.state.messages.slice(0, targetAssistantIndex));
				}
				const injection = this.#getInjectionContent();
				if (injection) {
					const details = { rules: injection.rules.map(rule => rule.name) };
					this.#host.agent.appendMessage({
						role: "custom",
						customType: "ttsr-injection",
						content: injection.content,
						display: false,
						details,
						attribution: "agent",
						timestamp: Date.now(),
					});
					this.#host.sessionManager.appendCustomMessageEntry(
						"ttsr-injection",
						injection.content,
						false,
						details,
						"agent",
					);
					this.#markInjected(details.rules);
				}
				try {
					await this.#host.agent.continue();
				} catch {
					this.resolveResume();
				}
			},
			{ delayMs: 50 },
		);
		return true;
	}

	#extractFilePathsFromArgs(args: unknown): string[] | undefined {
		if (!isRecord(args)) return undefined;
		const rawPaths: string[] = [];
		for (const key in args) {
			const value = args[key];
			const normalizedKey = key.toLowerCase();
			if (typeof value === "string" && (normalizedKey === "path" || normalizedKey.endsWith("path"))) {
				rawPaths.push(value);
				continue;
			}
			if (Array.isArray(value) && (normalizedKey === "paths" || normalizedKey.endsWith("paths"))) {
				for (const candidate of value) if (typeof candidate === "string") rawPaths.push(candidate);
			}
		}
		const normalizedPaths = rawPaths.flatMap(filePath => this.#normalizePathCandidates(filePath));
		return normalizedPaths.length === 0 ? undefined : Array.from(new Set(normalizedPaths));
	}

	#normalizePathCandidates(rawPath: string): string[] {
		const trimmed = rawPath.trim();
		if (trimmed.length === 0) return [];
		const normalizedInput = trimmed.replaceAll("\\", "/");
		const candidates = new Set<string>([normalizedInput]);
		if (normalizedInput.startsWith("./")) candidates.add(normalizedInput.slice(2));
		const cwd = this.#host.sessionManager.getCwd();
		const absolutePath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
		candidates.add(absolutePath.replaceAll("\\", "/"));
		const relative = path.relative(cwd, absolutePath).replaceAll("\\", "/");
		if (relative && relative !== "." && !relative.startsWith("../") && relative !== "..") candidates.add(relative);
		return Array.from(candidates);
	}
}
