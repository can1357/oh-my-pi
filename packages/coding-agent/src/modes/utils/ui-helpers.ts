import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Usage } from "@oh-my-pi/pi-ai";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { providerActiveNotice } from "@oh-my-pi/pi-catalog/compat/auth";
import { jsx } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { settings } from "../../config/settings";
import { InternalUrlRouter } from "../../internal-urls";
import type { CustomMessage } from "../../session/messages";
import { isUserTurnInitiator } from "../../session/messages";
import type { SessionContext, StrippedToolCallsMarker } from "../../session/session-context";
import { listSessionRecaps } from "../../session/session-index";
import { detectCacheInvalidation } from "../../session/transcript/cache-invalidation-marker";
import {
	assistantMessageLinkTargets,
	getAssistantMessageLinkTargets,
	refreshAssistantMessageLinkTargets,
} from "../../session/transcript/link-targets";
import { groupedReadUsageCallIds, readArgsCollapseIntoGroup } from "../../session/transcript/read-tool-group";
import { replyDisplayMessage, toolResultReplies } from "../../session/transcript/reply-write";
import { ServedModelTracker } from "../../session/transcript/served-model-marker";
import {
	followsViewportOnly,
	isSettledJobFrame,
	parksAsBackground,
	readMediaPath,
	settleWithJobFrame,
	toolRenderName,
} from "../../session/transcript/tool-execution";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	normalizeToolArgs,
	resolveAssistantErrorPresentation,
	splitAssistantMessageToolTimeline,
} from "../../session/transcript/transcript-render-helpers";
import { executeBuiltinSlashCommand, lookupBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import { parseSlashCommand } from "../../slash-commands/helpers/parse";
import type { Shell, TranscriptBlock } from "../../ui/shell";
import { NoticeLine, StatusBlock, StatusNotice, StrippedToolCalls } from "../../ui/transcript/messages/notices";
import { ToolActivity } from "../../ui/transcript/messages/panel";
import { normalizeBlobExtension } from "../../utils/image-format";
import { imageAttachmentSource } from "../../utils/image-source";
import { previewLine, TRUNCATE_LENGTHS } from "../../utils/render-utils";
import { decodeStreamedToolArgs, streamingStringKeysForTool } from "../controllers/tool-args-reveal";
import { recapBlock, usageRowBlock } from "../controllers/event-blocks";
import { extractVisibleAssistantText } from "../rpc/rpc-live";
import {
	cfgComposerRecallClearedDrafts,
	cfgDisplayCacheMissMarker,
	cfgDisplayCollapseCompacted,
	cfgDisplayShowTokenUsage,
	cfgDisplayShowTurnTime,
	cfgTerminalShowImages,
} from "../settings";
import { buildSkillCommandPrompt, invokeSkillCommandFromText, isKnownSkillCommand } from "../skill-command";
import type {
	AssistantView,
	CompactionQueuedMessage,
	InteractiveModeContext,
	PendingTool,
	RenderInitialMessagesOptions,
	RenderSessionContextOptions,
	ShowStatusOptions,
} from "../types";
import { TurnUsageTally, turnElapsedMs } from "../view-model/overlays/usage-row";
import {
	materializeImageReferenceLinks,
	materializeImageReferenceLinksSync,
} from "../view-model/prompt/image-references";
import { ExecRun } from "../../ui/transcript/exec-run";
import { continuesConversation } from "./conversation-position";
import { displaceableBy } from "./displaceable";
import { UpdateNotice } from "../interactive/update-notice";

/** What a history replay draws into and reads: the live mode, or a replica with a transcript of its own. */
export type ReplayTarget = Pick<
	InteractiveModeContext,
	| "pendingTools"
	| "viewSession"
	| "lastAssistantUsage"
	| "servedModelTracker"
	| "statusLine"
	| "updateEditorBorderColor"
	| "settings"
	| "toolActivity"
	| "transcriptBlocks"
	| "present"
	| "presentAssistant"
	| "presentMessage"
	| "presentToolCall"
	| "presentReadGroup"
	| "presentExecRun"
> & {
	readonly shell: Pick<Shell, "transcript" | "native">;
	/** Takes over the live state a mid-turn rebuild leaves; a replica has none. */
	readonly eventController?: InteractiveModeContext["eventController"];
};

/** What a history replay reads of a session context. */
export type ReplayContext = Pick<SessionContext, "messages" | "cacheMissExplainedAt" | "nextCacheMissExplained"> & {
	/**
	 * The messages are a later part of the session (a branch's tail, a sibling branch below its
	 * fork): the run they open in may have started above them.
	 */
	readonly clipped?: boolean;
};

const TRANSCRIPT_RENDER_CHUNK_MESSAGES = 32;
const TRANSCRIPT_RENDER_CHUNK_MS = 8;
/**
 * Upper bound on full-transcript replay restarts inside
 * {@link UiHelpers.renderInitialMessages}. Each restart discards the staged
 * tree and replays every message from scratch, so on a large resumed session
 * (issue #7811: ~6k entries) a single pass takes longer than the interval
 * between entries persisted by background sources — the restart condition
 * becomes permanently true and an unbounded loop livelocks at 100% CPU.
 * Entries that land after the final accepted pass are
 * durable in the session file and reach the display on the next rebuild.
 */
const TRANSCRIPT_REPLAY_MAX_ATTEMPTS = 5;

/** The assistant replies of `context` (their prose links resolve before a replay). */
function assistantMessages(context: SessionContext): AssistantMessage[] {
	return context.messages.filter((message): message is AssistantMessage => message.role === "assistant");
}

function waitForImmediate(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

type QueuedMessages = {
	steering: string[];
	followUp: string[];
	liveSteered: number;
};
type AddMessageOptions = {
	imageLinks?: readonly (string | undefined)[];
	live?: boolean;
};

type ImageChipSessionManager = Pick<
	InteractiveModeContext["sessionManager"],
	"putBlob" | "putBlobSync" | "getArtifactsDir" | "getSessionId"
>;

/** Where an image chip's bytes live: a file the chip opens directly, or the file behind an internal URL. */
type ImageChipSource = { kind: "file"; path: string } | { kind: "internal"; path: string };

/**
 * Internal URLs (`local://`) stay on the image for the model but resolve against the
 * session root, which `/move` relocates, so a chip cannot point at them. Their backing
 * file holds the original pasted bytes (the payload may be auto-resized), so the chip
 * opens a stable blob copy of that file. Undefined when no file backs the image.
 */
function imageChipSource(image: ImageContent, sessionManager: ImageChipSessionManager): ImageChipSource | undefined {
	const sourcePath = imageAttachmentSource(image)?.path;
	if (!sourcePath) return undefined;
	const router = InternalUrlRouter.instance();
	if (!router.canHandle(sourcePath)) return { kind: "file", path: sourcePath };
	try {
		const located = router.locateSync(sourcePath, {
			localProtocolOptions: {
				getArtifactsDir: () => sessionManager.getArtifactsDir(),
				getSessionId: () => sessionManager.getSessionId(),
			},
		});
		return located === undefined ? undefined : { kind: "internal", path: located };
	} catch {
		return undefined;
	}
}

/** Chip targets for attached images: each file on disk, else a blob copy of the original bytes (or the payload). */
export async function materializeImageChipLinks(
	images: readonly ImageContent[],
	sessionManager: ImageChipSessionManager,
): Promise<(string | undefined)[]> {
	const putBlob = sessionManager.putBlob.bind(sessionManager);
	return Promise.all(
		images.map(async image => {
			const source = imageChipSource(image, sessionManager);
			if (source?.kind === "file") return source.path;
			if (source) {
				try {
					const bytes = await fs.promises.readFile(source.path);
					return (await putBlob(bytes, { extension: normalizeBlobExtension(path.extname(source.path)) }))
						.displayPath;
				} catch (error) {
					logger.warn("Failed to copy original image for its chip", {
						path: source.path,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			return (await materializeImageReferenceLinks([image], putBlob))?.[0];
		}),
	);
}

/** Synchronous {@link materializeImageChipLinks} for transcript rebuilds. */
export function imageLinksForMessage(
	images: readonly ImageContent[],
	sessionManager: ImageChipSessionManager,
): (string | undefined)[] | undefined {
	if (images.length === 0) return undefined;
	const putBlobSync = sessionManager.putBlobSync.bind(sessionManager);
	return images.map(image => {
		const source = imageChipSource(image, sessionManager);
		if (source?.kind === "file") return source.path;
		if (source) {
			try {
				const bytes = fs.readFileSync(source.path);
				return putBlobSync(bytes, { extension: normalizeBlobExtension(path.extname(source.path)) }).displayPath;
			} catch (error) {
				logger.warn("Failed to copy original image for its chip", {
					path: source.path,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return materializeImageReferenceLinksSync([image], putBlobSync)?.[0];
	});
}

export class UiHelpers {
	/**
	 * Tail of the transcript-replay chain. A replay stages the transcript and swaps the live block
	 * maps for its whole duration, so two overlapping replays would capture each other's staged
	 * state as "visible" and commit interleaved trees.
	 */
	#replayTail: Promise<void> = Promise.resolve();
	/** Bumped by every replay request; a queued or in-flight replay is stale once it moves on. */
	#replayGeneration = 0;
	/** Requested replays that have not settled yet. */
	#replaysInFlight = 0;
	/** `initialChatRendered` to restore when the latest replay ends without committing. */
	#chatRenderedBeforeReplay = false;
	/** Bumped by {@link restartTranscriptReplay}; a replay pass that saw it move rebuilds again. */
	#textRendererSetVersion = 0;
	/** The text renderer set changed while a replay was in flight; the commit retires stale scrollback. */
	#textRendererSetChangedDuringReplay = false;
	/** The latest line of each keyed status ({@link ShowStatusOptions.key}). */
	readonly #keyedStatuses = new Map<string, TranscriptBlock>();
	/** The last collapsible status line and its text: the next one rewrites it while it is the transcript's tail. */
	#lastStatus: { readonly block: TranscriptBlock; readonly message: string } | undefined;
	/** Status, warning and error lines: a keyed status updates in place only with these below it. */
	readonly #notices = new WeakSet<TranscriptBlock>();
	/** Session and model the last active-model notice named; cleared while no declaring provider serves. */
	#activeModelNoticeKey: string | undefined;

	constructor(private ctx: InteractiveModeContext) {}

	/**
	 * Show a status message in the chat.
	 *
	 * Back-to-back statuses (nothing else added in between) replace the previous line instead of
	 * stacking, to avoid log spam; a repeat of the same text shows as a fresh notice (a native
	 * toast that expired shows again). `key` and `collapse` opt out of that positional merge; see
	 * {@link ShowStatusOptions}. Lines already in terminal scrollback are never rewritten.
	 */
	showStatus(message: string, options?: ShowStatusOptions): void {
		const transcript = this.ctx.shell.transcript;
		const action = options?.action;
		const factory = () =>
			jsx(StatusNotice, {
				message,
				...(options?.dim === false ? {} : { color: "dim" }),
				...(options?.toast === false ? { toast: false } : {}),
				...(action
					? {
							action: { act: action.act, label: action.label },
							onAction: (act: string) => {
								if (act === action.act) action.run();
							},
						}
					: {}),
			});

		const key = options?.key;
		if (key !== undefined) {
			const keyed = this.#keyedStatuses.get(key);
			const replaceable = keyed !== undefined && transcript.blocks().includes(keyed) && !transcript.retired(keyed);
			const block =
				replaceable && this.#onlyNoticesBelow(keyed) ? this.#replace(keyed, factory) : this.#presentNotice(factory);
			this.#keyedStatuses.set(key, block);
			return;
		}

		const collapse = options?.collapse ?? true;
		if (collapse) this.#withdrawLastStatus();
		const block = this.#presentNotice(factory);
		this.#lastStatus = collapse ? { block, message } : undefined;
	}

	/** Withdraw the last collapsible status (a progress line such as "Transcribing...") once it is moot. */
	clearStatus(): void {
		this.#withdrawLastStatus();
		this.#lastStatus = undefined;
	}

	/** Remove the last collapsible status while nothing came after it in the transcript. */
	#withdrawLastStatus(): void {
		const transcript = this.ctx.shell.transcript;
		const last = this.#lastStatus;
		if (last && transcript.blocks().at(-1) === last.block && !transcript.retired(last.block)) {
			transcript.remove(last.block);
		}
	}

	#presentNotice(factory: () => ReturnType<typeof jsx>): TranscriptBlock {
		const block = this.ctx.present(factory);
		this.#notices.add(block);
		return block;
	}

	/** Put a fresh notice in `block`'s place. */
	#replace(block: TranscriptBlock, factory: () => ReturnType<typeof jsx>): TranscriptBlock {
		const transcript = this.ctx.shell.transcript;
		const blocks = transcript.blocks();
		const next = blocks[blocks.indexOf(block) + 1];
		const fresh = next ? this.ctx.present(factory, { before: next }) : this.ctx.present(factory);
		this.#notices.add(fresh);
		transcript.remove(block);
		return fresh;
	}

	/** Whether nothing but notices follows `block`. */
	#onlyNoticesBelow(block: TranscriptBlock): boolean {
		const blocks = this.ctx.shell.transcript.blocks();
		const index = blocks.indexOf(block);
		if (index === -1) return false;
		return blocks.slice(index + 1).every(below => this.#notices.has(below));
	}

	/**
	 * Mount the blocks drawing `message` and record the message's block in `transcriptBlocks`.
	 * Assistant replies draw their pre-tool text only; tool calls and later segments are the
	 * replay's ({@link renderSessionContext}) or the event controller's.
	 */
	addMessageToChat(
		message: AgentMessage,
		options?: AddMessageOptions,
		ctx: ReplayTarget = this.ctx,
	): TranscriptBlock[] {
		switch (message.role) {
			case "bashExecution":
			case "pythonExecution": {
				const run = new ExecRun({
					kind: message.role === "bashExecution" ? "bash" : "eval",
					source: message.role === "bashExecution" ? message.command : message.code,
					excluded: message.excludeFromContext === true,
				});
				if (message.output) run.appendOutput(message.output);
				run.setComplete(message.exitCode, message.cancelled, {
					truncation: message.meta?.truncation,
					artifactError: message.meta?.artifactError,
					...(message.role === "bashExecution"
						? {
								minimized: message.meta?.minimized,
								images: message.images,
								showImages: cfgTerminalShowImages.get(settings),
							}
						: {}),
				});
				ctx.presentExecRun(run, { recorded: message });
				const block = ctx.shell.transcript.blocks().at(-1);
				if (block) ctx.transcriptBlocks.set(message, block);
				return block ? [block] : [];
			}
			case "assistant": {
				const view = ctx.presentAssistant(splitAssistantMessageToolTimeline(message).beforeTools);
				ctx.transcriptBlocks.set(message, view.block);
				return [view.block];
			}
			case "toolResult":
				// Drawn with their calls.
				return [];
			default: {
				const block = ctx.presentMessage(message, options);
				if (!block) return [];
				ctx.transcriptBlocks.set(message, block);
				return [block];
			}
		}
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 */
	renderSessionContext(sessionContext: SessionContext, options: RenderSessionContextOptions = {}): void {
		const steps = this.#renderSessionContextSteps(sessionContext, options);
		while (!steps.next().done) {}
	}

	/** Build a session context in bounded chunks so terminal input runs between event-loop turns. */
	async renderSessionContextIncrementally(
		sessionContext: SessionContext,
		options: RenderSessionContextOptions,
		renderChunk?: () => void,
	): Promise<void> {
		const steps = this.#renderSessionContextSteps(sessionContext, options);
		let messagesSinceYield = 0;
		let chunkStartedAt = performance.now();
		while (!steps.next().done) {
			messagesSinceYield++;
			if (
				messagesSinceYield < TRANSCRIPT_RENDER_CHUNK_MESSAGES &&
				performance.now() - chunkStartedAt < TRANSCRIPT_RENDER_CHUNK_MS
			) {
				continue;
			}
			renderChunk?.();
			await waitForImmediate();
			messagesSinceYield = 0;
			chunkStartedAt = performance.now();
		}
	}

	/** The steps of a history replay into `target`'s own transcript (a replica of the session's). */
	replaySteps(target: ReplayTarget, sessionContext: ReplayContext): Generator<void, void, void> {
		return this.#renderSessionContextSteps(sessionContext, {}, target, true);
	}

	*#renderSessionContextSteps(
		sessionContext: ReplayContext,
		options: RenderSessionContextOptions = {},
		ctx: ReplayTarget = this.ctx,
		replica = false,
	): Generator<void, void, void> {
		const transcript = ctx.shell.transcript;
		// Preserved: message_start handler owns this lifecycle (see #783)
		ctx.pendingTools.clear();
		const activeToolExecutionUpdates = ctx.viewSession.activeToolExecutionUpdates?.() ?? [];
		const runningAsyncJobs = ctx.viewSession.getAsyncJobSnapshot?.()?.running ?? [];
		// Reseed the cache-invalidation baseline: this rebuild re-derives every
		// turn's marker from usage, and the last turn becomes the live baseline.
		ctx.lastAssistantUsage = undefined;
		// Same for the served-model tracker: replaying history re-flags the first
		// occurrence of each substitution and carries the memory forward live.
		ctx.servedModelTracker = new ServedModelTracker();

		if (options.updateFooter) {
			ctx.statusLine.refresh();
			ctx.updateEditorBorderColor();
		}

		const linkTargets = getAssistantMessageLinkTargets(ctx);
		let readGroup: PendingTool | null = null;
		const sealReadGroup = (): void => {
			readGroup?.seal();
			readGroup = null;
		};
		const ensureReadGroup = (): PendingTool => {
			readGroup ??= ctx.presentReadGroup();
			return readGroup;
		};
		const readToolCallArgs = new Map<string, Record<string, unknown>>();
		const readToolCallAssistants = new Map<string, AssistantView>();
		// Defer per-turn metrics until the turn's tool results have materialized.
		// Read-only invisible turns attach the metrics to their shared compact
		// group; every other turn keeps the standalone row below its tool blocks.
		let pendingUsage: Usage | undefined;
		let pendingUsageDuration: number | undefined;
		let pendingUsageTtft: number | undefined;
		let pendingUsageTimestamp: number | undefined;
		let pendingReadUsageCallIds: string[] | undefined;
		let pendingUsageTurnElapsed: number | undefined;
		let turnStartedAt: number | undefined;
		// Rebuild-time mirror of the controller's turn tally: the message that ends
		// a run gets the turn's totals, and with them the native footer under its
		// answer (`⧉ · 12.4s · 19K tok this turn`) whose Copy copies the answer.
		const turnUsage = new TurnUsageTally();
		// A clipped replay can open partway through a run: until a run starts in view, the tally would
		// cover only the replayed part, so that run gets no totals.
		let runStartUnseen = sessionContext.clipped === true;
		const flushPendingUsage = () => {
			if (!pendingUsage) return;
			const usage = pendingUsage;
			const usageAttached =
				pendingReadUsageCallIds !== undefined &&
				(readGroup?.group?.attachUsage(
					pendingReadUsageCallIds,
					usage,
					pendingUsageDuration,
					pendingUsageTtft,
					pendingUsageTimestamp,
					pendingUsageTurnElapsed,
				) ??
					false);
			if (!usageAttached) {
				sealReadGroup();
				// A usage row closes the displacement window: the poll above it stays, sealed (#12248).
				resolveWaitingPoll();
				const durationMs = pendingUsageDuration;
				const ttftMs = pendingUsageTtft;
				const timestamp = pendingUsageTimestamp;
				const turnElapsed = pendingUsageTurnElapsed;
				ctx.present(() => usageRowBlock({ usage, durationMs, ttftMs, timestamp, turnElapsedMs: turnElapsed }));
			}
			pendingUsage = undefined;
			pendingUsageDuration = undefined;
			pendingUsageTtft = undefined;
			pendingUsageTimestamp = undefined;
			pendingReadUsageCallIds = undefined;
			pendingUsageTurnElapsed = undefined;
		};
		// Rebuild-time mirror of the event controller's displaceable-poll
		// bookkeeping: a `wait` that found every watched job still running is
		// superseded by the next `wait` call, so a rebuilt transcript collapses a
		// repeated-poll run to its final snapshot instead of replaying the spam.
		let waitingPoll: PendingTool | null = null;
		const resolveWaitingPoll = (nextToolName?: string) => {
			const previous = waitingPoll;
			if (!previous) return;
			waitingPoll = null;
			if (nextToolName === "wait" && displaceableBy(previous) === "wait" && !transcript.retired(previous.block)) {
				transcript.remove(previous.block);
			}
			// Sealing finalizes the block and stops the waiting-poll spinner.
			previous.seal();
		};
		let todoSnapshot: PendingTool | null = null;
		const resolveTodoSnapshot = (nextToolName?: string) => {
			const previous = todoSnapshot;
			if (!previous) return;
			if (displaceableBy(previous) !== "todo") {
				todoSnapshot = null;
				return;
			}
			if (nextToolName === "todo") {
				todoSnapshot = null;
				previous.seal();
				// One a live update found in scrollback stayed there as history: the rebuild keeps it too.
				const kept =
					previous.call !== undefined && ctx.eventController?.keptTodoSnapshot(previous.call.id) === true;
				if (!kept) transcript.remove(previous.block);
				return;
			}
			if (nextToolName !== undefined) return;
			todoSnapshot = null;
			previous.seal();
		};
		// Background job calls persist their initial `async.state === "running"`
		// result, but the job keeps streaming progress afterwards. Parked here
		// (not finalized) so replayed and live frames still route to the card;
		// the ids are handed back to the controller after the loop (#10447).
		const backgroundCallIds = new Set<string>();
		const native = ctx.shell.native();
		const messages = sessionContext.messages;
		const count = messages.length;
		for (let i = 0; i < count; i++) {
			// Yield BEFORE each message (except the first) rather than after: the
			// per-message body has several early `continue` paths (preserved live
			// results, image-only and grouped `read` results), and a trailing yield
			// is skipped by all of them. Yielding at the top of the next iteration
			// is reached no matter how the prior message exited.
			if (i > 0) yield;
			const message = messages[i]!;
			if (message.role !== "toolResult") flushPendingUsage();
			if (message.role === "assistant") {
				const timeline = splitAssistantMessageToolTimeline(message);
				const assistant = ctx.presentAssistant(timeline.beforeTools, {
					linkTargets: assistantMessageLinkTargets(message, linkTargets),
				});
				ctx.transcriptBlocks.set(message, assistant.block);
				const usage = message.usage;
				const explained = sessionContext.cacheMissExplainedAt?.[i] ?? false;
				if (cfgDisplayCacheMissMarker.get(ctx.settings) && !explained) {
					const invalidation = detectCacheInvalidation(ctx.lastAssistantUsage, usage);
					if (invalidation) assistant.cacheInvalidation.set(invalidation);
				}
				if (usage.cacheRead + usage.cacheWrite + usage.input > 0) ctx.lastAssistantUsage = usage;
				assistant.servedModelMismatch.set(ctx.servedModelTracker.check(message));
				// Rebuild reconstructs immutable history; seal (not finalize) because
				// a pending entry otherwise keeps the group active indefinitely.
				if (assistantHasVisibleContent(message)) sealReadGroup();
				const errorPresentation = resolveAssistantErrorPresentation(message, ctx.viewSession.retryAttempt);
				const errorMessage = errorPresentation.kind === "full" ? errorPresentation.text : null;
				// The turn's footer goes under the last answer drawn, as live.
				let lastSegment: AssistantView | undefined;
				const appendAssistantSegment = (toolCallId: string) => {
					const segment = timeline.afterToolCalls.get(toolCallId);
					if (!segment || !assistantHasVisibleContent(segment)) return;
					const offset = timeline.contentOffsets.get(toolCallId);
					lastSegment = ctx.presentAssistant(segment, {
						linkTargets: assistantMessageLinkTargets(segment, linkTargets),
						...(offset !== undefined ? { contentOffset: offset } : {}),
					});
				};

				for (const content of message.content) {
					if (content.type !== "toolCall") continue;
					const afterToolSegment = timeline.afterToolCalls.get(content.id);
					if (options.preservedLiveToolCallIds?.has(content.id)) {
						appendAssistantSegment(content.id);
						continue;
					}
					const tool = ctx.viewSession.getToolByName(content.name);
					const renderToolName = toolRenderName(content.name, tool);
					resolveWaitingPoll(renderToolName);

					if (renderToolName === "read" && readArgsCollapseIntoGroup(content.arguments)) {
						if (errorMessage) {
							const group = ensureReadGroup();
							group.updateArgs(content.arguments, content.id, message.timestamp);
							group.updateResult(
								{ content: [{ type: "text", text: errorMessage }], isError: true },
								false,
								content.id,
							);
						} else if (afterToolSegment) {
							const group = ensureReadGroup();
							group.updateArgs(content.arguments, content.id, message.timestamp);
							ctx.pendingTools.set(content.id, group);
							readToolCallAssistants.set(content.id, assistant);
							if (ctx.viewSession.isStreaming)
								ctx.eventController?.inheritReadToolAssistant(content.id, assistant);
						} else {
							readToolCallArgs.set(content.id, normalizeToolArgs(content.arguments));
							readToolCallAssistants.set(content.id, assistant);
						}
						appendAssistantSegment(content.id);
						continue;
					}

					sealReadGroup();
					const partialJson = getStreamingPartialJson(content);
					// Mid-stream rebuild (theme change, settings, focus replay): decode
					// display args from the raw stream exactly like the live reveal path.
					// The provider-parsed `arguments` lag the stream by up to a throttled
					// parse window, so spreading them alone would freeze a long write/edit
					// preview at its last full parse.
					const rawInput = content.customWireName !== undefined;
					const renderArgs = partialJson
						? decodeStreamedToolArgs(partialJson, {
								rawInput,
								fullArgs: content.arguments,
								streamingStringKeys: streamingStringKeysForTool(renderToolName, rawInput),
							})
						: content.arguments;
					const pending = ctx.presentToolCall({
						name: renderToolName,
						args: renderArgs,
						tool,
						id: content.id,
						cwd: ctx.viewSession.sessionManager.getCwd(),
						timestamp: message.timestamp,
					});
					// Persisted args are final: settle a reply's text now. Cards keep their own args-complete timing.
					if (!partialJson && pending.reply) pending.setArgsComplete(content.id);
					if (errorMessage) {
						pending.updateResult(
							{ content: [{ type: "text", text: errorMessage }], isError: true },
							false,
							content.id,
						);
					} else {
						ctx.pendingTools.set(content.id, pending);
					}
					appendAssistantSegment(content.id);
				}
				// Dangling toolCalls (no result on the resolved path — failed or
				// retried turns, results on sibling branches) were stripped by the
				// context build; a placeholder shows the turn's activity was elided
				// instead of leaving bare thinking lines.
				const strippedToolCalls = (message as AgentMessage & StrippedToolCallsMarker).strippedToolCalls ?? 0;
				if (strippedToolCalls > 0) {
					ctx.present(() =>
						jsx(StrippedToolCalls, { count: strippedToolCalls, visible: () => ctx.toolActivity !== "hidden" }),
					);
				}
				const turnSummary = turnUsage.add(message, turnStartedAt);
				if (turnSummary && !runStartUnseen) (lastSegment ?? assistant).turnUsage.set(turnSummary);
				// The tally starts over after a run's last reply, so the next run counts whole even when nothing
				// marks its start (an agent-attributed custom message resets nothing below).
				if (message.stopReason !== "toolUse") runStartUnseen = false;
				pendingUsage =
					cfgDisplayShowTokenUsage.get(ctx.settings) && assistantUsageIsBilled(message.usage)
						? message.usage
						: undefined;
				pendingUsageDuration = message.duration;
				pendingUsageTtft = message.ttft;
				pendingUsageTimestamp = message.timestamp;
				pendingReadUsageCallIds = pendingUsage ? groupedReadUsageCallIds(message) : undefined;
				pendingUsageTurnElapsed = cfgDisplayShowTurnTime.get(ctx.settings)
					? turnElapsedMs(turnStartedAt, message)
					: undefined;
			} else if (message.role === "toolResult") {
				if (options.preservedLiveToolCallIds?.has(message.toolCallId)) continue;
				const pendingRead = ctx.pendingTools.get(message.toolCallId);
				// Mirror the call side: resolve the wire toolName through the registry
				// so aliased results route under the canonical name their call used.
				const tool = ctx.viewSession.getToolByName(message.toolName);
				const renderToolName = toolRenderName(message.toolName, tool);
				if (renderToolName === "read" && (!pendingRead || pendingRead.group)) {
					const assistant = readToolCallAssistants.get(message.toolCallId);
					if (ctx.viewSession.isStreaming)
						ctx.eventController?.inheritReadToolAssistant(message.toolCallId, undefined);
					const images: ImageContent[] = message.content.filter(
						(content): content is ImageContent => content.type === "image",
					);
					const mediaPath = readMediaPath(message.details);
					if (images.length > 0 || mediaPath)
						assistant?.setToolResultMedia(message.toolCallId, { images, mediaPath });
					if (assistant && images.length > 0) {
						const hasText = message.content.some(content => content.type === "text");
						if (!hasText && cfgTerminalShowImages.get(settings)) {
							if (pendingRead) {
								pendingRead.updateResult(message, false, message.toolCallId);
								ctx.pendingTools.delete(message.toolCallId);
							}
							readToolCallArgs.delete(message.toolCallId);
							readToolCallAssistants.delete(message.toolCallId);
							continue;
						}
					}
					let pending = ctx.pendingTools.get(message.toolCallId);
					if (!pending) {
						const group = ensureReadGroup();
						const args = readToolCallArgs.get(message.toolCallId);
						// The read joins the group with its result: dated by the result.
						if (args) group.updateArgs(args, message.toolCallId, message.timestamp);
						pending = group;
					}
					pending.updateResult(message, false, message.toolCallId);
					ctx.pendingTools.delete(message.toolCallId);
					readToolCallArgs.delete(message.toolCallId);
					readToolCallAssistants.delete(message.toolCallId);
					continue;
				}

				const pending = ctx.pendingTools.get(message.toolCallId);
				if (pending) {
					const jobId = (message.details as { async?: { jobId?: string } } | undefined)?.async?.jobId;
					const frame = activeToolExecutionUpdates.find(
						event => event.toolCallId === message.toolCallId,
					)?.partialResult;
					const isBackground =
						parksAsBackground(message.toolName, message.details, native) &&
						(frame !== undefined || runningAsyncJobs.some(job => job.id === jobId));
					const settled = isBackground && frame !== undefined && isSettledJobFrame(frame.details);
					const partial = isBackground && !followsViewportOnly(message.toolName, native);
					// The persisted result is the job's first snapshot; restore its latest frame
					// and keep routing updates if the job is still running.
					if (settled) {
						settleWithJobFrame(pending, frame, message.toolCallId);
					} else {
						pending.updateResult(isBackground && frame ? frame : message, partial, message.toolCallId);
					}
					if (isBackground && !settled) {
						pending.parkAsBackground();
						if (partial) transcript.settle(pending.block);
						backgroundCallIds.add(message.toolCallId);
					} else {
						ctx.pendingTools.delete(message.toolCallId);
						if (renderToolName === "wait" && displaceableBy(pending) === "wait") {
							waitingPoll = pending;
						} else if (renderToolName === "todo" && displaceableBy(pending) === "todo") {
							// A successful todo result supersedes the prior live snapshot; a failed
							// follow-up is no snapshot, so the last good panel stays.
							resolveTodoSnapshot("todo");
							todoSnapshot = pending;
						}
					}
				}
				for (const reply of toolResultReplies(message.details)) {
					ctx.presentAssistant(replyDisplayMessage(reply));
				}
			} else {
				sealReadGroup();
				// A user prompt closes the displacement window, same as the live path.
				if (message.role === "user") {
					resolveWaitingPoll();
					resolveTodoSnapshot();
				}
				// Only genuinely user-attributed prompts anchor the delta; a mid-run
				// agent-attributed `user` message (advisor tool-loop redirect) must not.
				if (message.role === "user" && message.attribution !== "agent") {
					turnStartedAt = message.timestamp;
					turnUsage.reset();
					runStartUnseen = false;
				}
				// A synthetic developer message initiates a fresh run (auto-continue,
				// /goal, approved plan): replay must not inherit the preceding user
				// prompt's timestamp, mirroring the live agent_start clear. Same-turn
				// continuation reminders (todo, plan) are persisted developer messages
				// WITHOUT the synthetic marker, so their anchor survives the rebuild.
				if (message.role === "developer" && message.synthetic) {
					// A deliberate operator action (`.`, `c` continue shortcut) is the
					// turn's own prompt: anchor the delta to it instead of clearing.
					turnStartedAt = message.userInitiated ? message.timestamp : undefined;
					turnUsage.reset();
					runStartUnseen = false;
				}
				if (message.role === "custom" && isUserTurnInitiator(message as CustomMessage)) {
					turnStartedAt = message.timestamp;
					turnUsage.reset();
					runStartUnseen = false;
				}
				this.addMessageToChat(message, undefined, ctx);
			}
		}
		flushPendingUsage();

		// The trailing read run has no following break to close it; seal so the
		// rebuilt group can retire as history even with a never-persisted result.
		sealReadGroup();
		// A trailing waiting poll is final history on rebuild.
		resolveWaitingPoll();
		// A trailing todo snapshot may still be replaced: when the rebuild runs
		// mid-turn, hand it back to the controller so a follow-up `todo` update
		// keeps displacing instead of stacking. Idle rebuilds (resume /
		// compaction) seal it as final.
		if (todoSnapshot && ctx.viewSession.isStreaming) {
			ctx.eventController?.inheritDisplaceableTodo(todoSnapshot);
			todoSnapshot = null;
		} else {
			resolveTodoSnapshot();
		}
		// Same mid-turn handoff for the prompt→yield delta (see inheritDisplaceableTodo).
		if (ctx.viewSession.isStreaming) ctx.eventController?.inheritTurnStart(turnStartedAt);
		// Re-register parked background cards with the controller: focus attach
		// resets its background ids before replaying, and a background job keeps
		// running while the main session sits idle (#10447).
		if (backgroundCallIds.size > 0) ctx.eventController?.markBackgroundCalls(backgroundCallIds);
		// The idle recap is journaled only in history.db, never in the session file, so a replay
		// (resume, /restart, rebuild) would drop it. Re-show the newest one while the conversation
		// has not moved since it was recorded and the view still stands at that point.
		const sessionManager = ctx.viewSession.sessionManager;
		// A replica shows history only.
		const tip = replica || ctx.viewSession.isStreaming ? undefined : sessionManager.getConversationTip();
		if (tip) {
			const [recap] = listSessionRecaps({ sessionIds: [sessionManager.getSessionId()], limit: 1 });
			// `createdAt` has second precision; a recap lands at least a second after the turn it follows.
			if (recap && recap.createdAt * 1000 > Date.parse(tip.timestamp)) {
				const text = previewLine(recap.recap, TRUNCATE_LENGTHS.RECAP);
				if (text) ctx.present(() => recapBlock(text));
			}
		}
		// A compaction (or model/plan-mode switch) after the last assistant turn
		// rewrote the prompt prefix: the next live turn's miss is expected.
		if (sessionContext.nextCacheMissExplained) ctx.lastAssistantUsage = undefined;

		// Entries still in `pendingTools` are toolCalls whose result never landed
		// during the replay — with `keepInFlightToolCalls` exactly the turn's
		// in-flight calls. While the viewed session streams, keep them tracked so
		// the live events route into the rebuilt blocks; their args are final.
		// Idle rebuilds have no result coming: seal so the blocks can retire as
		// history, then forget them.
		if (ctx.viewSession.isStreaming) {
			for (const [toolCallId, pending] of ctx.pendingTools) {
				pending.setArgsComplete(toolCallId);
				if (ctx.eventController?.hasToolExecutionStarted(toolCallId)) pending.setExecutionStarted(toolCallId);
			}
		} else {
			for (const [toolCallId, pending] of ctx.pendingTools) {
				// A parked background job keeps running while the main session is idle (#10447).
				if (backgroundCallIds.has(toolCallId)) {
					pending.setArgsComplete(toolCallId);
					continue;
				}
				pending.seal();
				ctx.pendingTools.delete(toolCallId);
			}
		}
	}

	/**
	 * Fast-path history rewind (esc-esc branch, /tree rewind to an ancestor): drop the blocks
	 * at/after `message` in place instead of the destructive full replay. Rows already in
	 * terminal scrollback cannot change, so this works only while every dropped block is still on
	 * screen; returns false when the caller must fall back to
	 * `renderInitialMessages({ clearTerminalHistory: true })`.
	 *
	 * Callers must have already rewound the session so that `message` and everything after it
	 * are no longer part of the view session's transcript.
	 */
	truncateTranscriptFromMessage(message: AgentMessage): boolean {
		const ctx = this.ctx;
		if (!ctx.initialChatRendered || ctx.focusedAgentId || ctx.viewSession.isStreaming) return false;
		// In-flight blocks route future events; a rewind with any of them live takes the full replay.
		if (ctx.pendingTools.size > 0) return false;
		const cut = ctx.transcriptBlocks.get(message);
		if (!cut || !ctx.shell.transcript.blocks().includes(cut)) return false;
		// The cut message still present means the session was not actually rewound past it.
		const context = ctx.viewSession.buildTranscriptSessionContext({
			collapseCompactedHistory: cfgDisplayCollapseCompacted.get(settings),
		});
		if (context.messages.includes(message)) return false;
		if (!ctx.shell.transcript.truncate(cut, { replay: false })) return false;
		// Reseed the cache-invalidation baseline from the surviving transcript
		// (mirrors the replay path's billed-usage rule).
		let baseline: Usage | undefined;
		for (let i = context.messages.length - 1; i >= 0; i--) {
			const candidate = context.messages[i]!;
			if (candidate.role !== "assistant") continue;
			const usage = candidate.usage;
			if (usage.cacheRead + usage.cacheWrite + usage.input > 0) {
				baseline = usage;
				break;
			}
		}
		ctx.lastAssistantUsage = baseline;
		ctx.statusLine.refresh();
		ctx.updateEditorBorderColor();
		return true;
	}

	/**
	 * Rebuild the transcript from the view session. Calls run one at a time; a call
	 * superseded by a newer one before or during its replay rolls back without
	 * committing or clearing terminal history, so only the latest request paints.
	 */
	renderInitialMessages(options: RenderInitialMessagesOptions = {}): Promise<void> {
		const generation = ++this.#replayGeneration;
		// Close the display gate at request time, not when the queued replay starts:
		// a display message persisted in between must reach the chat only through
		// the replay, never also live (issue #1955).
		if (this.#replaysInFlight++ === 0) this.#chatRenderedBeforeReplay = this.ctx.initialChatRendered;
		this.ctx.initialChatRendered = false;
		const run = this.#replayTail
			.then(() => this.#renderInitialMessages(options, generation))
			.catch((error: unknown) => {
				// A replay that throws before its rollback (building the transcript context)
				// must not leave live display closed until some later replay.
				if (generation === this.#replayGeneration) this.ctx.initialChatRendered = this.#chatRenderedBeforeReplay;
				throw error;
			})
			.finally(() => {
				this.#replaysInFlight--;
			});
		this.#replayTail = run.catch(() => {});
		return run;
	}

	/**
	 * Make a transcript replay still in flight rebuild its blocks with the current extension text
	 * renderers and link schemes before it commits. Returns whether a replay was in flight; the
	 * caller then leaves the redraw to it.
	 */
	restartTranscriptReplay(): boolean {
		if (this.#replaysInFlight === 0) return false;
		this.#textRendererSetVersion++;
		this.#textRendererSetChangedDuringReplay = true;
		return true;
	}

	async #renderInitialMessages(options: RenderInitialMessagesOptions, generation: number): Promise<void> {
		if (generation !== this.#replayGeneration) return;
		const ctx = this.ctx;
		const transcript = ctx.shell.transcript;
		// Collapsed replay keeps in-flight calls so pending tools remain routable during mid-turn rebuilds.
		const buildContext = (): SessionContext =>
			ctx.viewSession.buildTranscriptSessionContext({
				collapseCompactedHistory: cfgDisplayCollapseCompacted.get(settings),
				keepInFlightToolCalls: ctx.viewSession.isStreaming,
			});
		let context = buildContext();
		let replayEntryCount = ctx.viewSession.sessionManager.getEntries().length;

		// Build off-screen: incremental construction still yields to terminal input, while the
		// shown transcript keeps drawing until the replacement is ready to swap in.
		const previousTranscriptBlocks = ctx.transcriptBlocks;
		const previousPendingTools = ctx.pendingTools;
		const previousLastAssistantUsage = ctx.lastAssistantUsage;
		const previousServedModelTracker = ctx.servedModelTracker;
		const renderOptions = { updateFooter: true };
		let committed = false;
		let replayAttempts = 0;
		try {
			// Resolve before replacing live block maps: streaming events may arrive during filesystem I/O.
			await refreshAssistantMessageLinkTargets(ctx, assistantMessages(context));
			if (generation !== this.#replayGeneration) return;

			transcript.stage();
			ctx.transcriptBlocks = new WeakMap();
			ctx.pendingTools = new Map();
			// Drops deferred `!`/`$` runs with the old transcript, then repaints the queued-message
			// bar from the live session queue: a mid-turn rebuild (rewind, /tree) keeps the queue,
			// so it must stay visible and editable.
			ctx.clearPendingExecRuns();
			ctx.updatePendingMessagesDisplay();
			while (true) {
				const passRendererSetVersion = this.#textRendererSetVersion;
				if (ctx.viewSession.isStreaming) {
					// Live events mutate the same maps; keep their replay atomic so a delta cannot
					// land halfway through rebuilding its pending tool block.
					ctx.renderSessionContext(context, renderOptions);
				} else {
					await ctx.renderSessionContextIncrementally(context, renderOptions);
				}
				if (generation !== this.#replayGeneration) return;
				const entriesChanged = ctx.viewSession.sessionManager.getEntries().length !== replayEntryCount;
				if (!entriesChanged && passRendererSetVersion === this.#textRendererSetVersion) break;
				replayAttempts++;
				if (replayAttempts >= TRANSCRIPT_REPLAY_MAX_ATTEMPTS) {
					// A source keeps persisting entries faster than a full replay pass
					// completes. Accept the transcript just replayed instead of
					// restarting forever (see TRANSCRIPT_REPLAY_MAX_ATTEMPTS).
					logger.warn("renderInitialMessages: transcript replay did not converge; accepting current replay", {
						attempts: replayAttempts,
						replayEntryCount,
						currentEntryCount: ctx.viewSession.sessionManager.getEntries().length,
					});
					break;
				}
				// An extension persisted a display message, or the extension text renderer set
				// changed, while the transcript replay yielded. The display callback stayed gated by
				// initialChatRendered; discard the stale partial tree and replay the current session
				// once more instead of letting a reentrant synchronous rebuild interleave.
				context = buildContext();
				replayEntryCount = ctx.viewSession.sessionManager.getEntries().length;
				await refreshAssistantMessageLinkTargets(ctx, assistantMessages(context));
				if (generation !== this.#replayGeneration) return;
				transcript.abort();
				transcript.stage();
				ctx.transcriptBlocks = new WeakMap();
				ctx.pendingTools.clear();
			}

			// Rows drawn with the old text renderer set are already in scrollback; retire them as
			// the direct renderer-change rebuild does.
			const staleRendererRows = this.#textRendererSetChangedDuringReplay && this.#chatRenderedBeforeReplay;
			this.#textRendererSetChangedDuringReplay = false;
			transcript.commit({
				preserve: options.preserveExistingChat === true,
				history: options.clearTerminalHistory === true || staleRendererRows,
			});
			this.#lastStatus = undefined;
			committed = true;
			options.onCommit?.(context);

			// Show compaction info if session was compacted.
			let compactionCount = 0;
			for (const entry of ctx.viewSession.sessionManager.getEntries()) {
				if (entry.type === "compaction") compactionCount++;
			}
			if (compactionCount > 0) {
				const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
				ctx.showStatus(`Session compacted ${times}`);
			}
		} finally {
			if (!committed) {
				transcript.abort();
				ctx.transcriptBlocks = previousTranscriptBlocks;
				ctx.pendingTools = previousPendingTools;
				ctx.lastAssistantUsage = previousLastAssistantUsage;
				ctx.servedModelTracker = previousServedModelTracker;
			}
			// A superseded replay leaves the gate closed for the newer one still queued.
			if (committed) this.#chatRenderedBeforeReplay = true;
			ctx.initialChatRendered = generation === this.#replayGeneration && this.#chatRenderedBeforeReplay;
		}
	}

	clearEditor(): void {
		this.ctx.composer.clearDraft({ recall: cfgComposerRecallClearedDrafts.get(this.ctx.settings) });
	}

	showError(errorMessage: string): void {
		this.#presentNotice(() => jsx(NoticeLine, { tone: "error", message: errorMessage }));
	}

	/**
	 * The line a provider declares for its models (`active-notice`), such as "Using your Acme Pro
	 * plan · Acme 2", once per model the viewed session switches to or first runs.
	 */
	showActiveModelNotice(): void {
		const session = this.ctx.viewSession;
		const model = session.model;
		const notice = model ? providerActiveNotice(model.provider) : undefined;
		const key =
			model && notice ? `${session.sessionManager.getSessionId()}\n${model.provider}/${model.id}` : undefined;
		if (key === this.#activeModelNoticeKey) return;
		this.#activeModelNoticeKey = key;
		if (!model || !notice) return;
		const text = `${notice} · ${model.name}`;
		this.#presentNotice(() =>
			jsx(StatusBlock, {
				rows: [
					{
						parts: [{ text, color: "dim" }],
						native: { tone: "info", icon: `provider:${model.provider}`, message: [{ t: text, s: "dim" }] },
					},
				],
			}),
		);
	}

	showWarning(warningMessage: string, options?: { hideWithToolActivity?: boolean }): void {
		const line = () => jsx(NoticeLine, { tone: "warning", message: warningMessage });
		this.#presentNotice(
			options?.hideWithToolActivity
				? () => jsx(ToolActivity, { visible: () => this.ctx.toolActivity !== "hidden", children: line() })
				: line,
		);
	}

	showNewVersionNotification(newVersion: string): void {
		this.ctx.present(() => jsx(UpdateNotice, { version: newVersion }));
	}

	/** Feed the queued-message band: the session's steering and follow-ups, plus the compaction queue. */
	updatePendingMessagesDisplay(): void {
		const queuedMessages = this.ctx.viewSession.getQueuedMessages() as QueuedMessages;
		const steeringMessages = [...queuedMessages.steering];
		const followUpMessages = [...queuedMessages.followUp];
		if (!this.ctx.focusedAgentId) {
			if (this.ctx.yieldCompaction) followUpMessages.push(this.ctx.yieldCompaction.text);
			for (const entry of this.ctx.compactionQueuedMessages as CompactionQueuedMessage[]) {
				if (entry.mode === "steer") steeringMessages.push(entry.text);
				else followUpMessages.push(entry.text);
			}
		}
		const queue = this.ctx.hud.queue;
		queue.dequeueKey.set(this.ctx.keybindings.keysFor("app.message.dequeue")[0] ?? "alt+up");
		queue.onEdit = () => this.ctx.handleDequeue();
		queue.groups.set(
			[
				{ label: "Steering", messages: steeringMessages },
				{ label: "After yield", messages: followUpMessages },
			].filter(group => group.messages.length > 0),
		);
	}

	queueCompactionMessage(
		text: string,
		mode: "steer" | "followUp",
		images?: ImageContent[],
		options?: { preserveDraft?: boolean },
	): void {
		const queuedImages = images && images.length > 0 ? images : undefined;
		this.ctx.compactionQueuedMessages.push({ text, mode, images: queuedImages } as CompactionQueuedMessage);
		if (options?.preserveDraft) this.ctx.composer.addToHistory(text);
		else {
			this.ctx.composer.addToHistory(text);
			this.ctx.composer.clearDraft({ recall: false });
		}
		this.ctx.updatePendingMessagesDisplay();
		this.ctx.showStatus(
			queuedImages ? "Queued message with image for after compaction" : "Queued message for after compaction",
		);
	}

	/**
	 * Park the loop when drain dispatch consumes the armed body locally (void
	 * custom command) instead of starting a turn. The drain otherwise discards
	 * prompt()'s result, and the next idle tick would resubmit a local action.
	 */
	#parkLoopOnLocalConsume(text: string, forwarded: boolean): void {
		if (!forwarded && this.ctx.loopPrompt === text) this.ctx.pauseLoop();
	}

	/** Deliver one compaction-queued message; `onQueued` receives what it pushes onto the session queues. */
	async #deliverQueuedMessage(
		message: CompactionQueuedMessage,
		onQueued: (queued: readonly AgentMessage[]) => void,
	): Promise<void> {
		const builtin = await executeBuiltinSlashCommand(message.text, {
			ctx: this.ctx,
			input: message.images ? { images: message.images } : undefined,
		});
		if (builtin === true) {
			this.#parkLoopOnLocalConsume(message.text, false);
			return;
		}
		if (typeof builtin === "string") {
			const forwarded = await this.ctx.session.prompt(builtin, {
				streamingBehavior: message.mode,
				images: message.images,
				onPromptQueued: onQueued,
			});
			this.#parkLoopOnLocalConsume(message.text, forwarded);
			return;
		}
		if (
			await invokeSkillCommandFromText(this.ctx, message.text, message.mode, {
				propagateErrors: true,
				queueOnly: true,
				images: message.images,
				onPromptQueued: onQueued,
			})
		) {
			return;
		}
		if (this.ctx.isKnownSlashCommand(message.text)) {
			// No `streamingBehavior`: this prompt never queues (a busy session rejects it).
			const forwarded = await this.ctx.session.prompt(message.text);
			this.#parkLoopOnLocalConsume(message.text, forwarded);
			return;
		}
		await this.ctx.withLocalSubmission(
			message.text,
			() =>
				message.mode === "followUp"
					? this.ctx.session.followUp(message.text, message.images, { onPromptQueued: onQueued })
					: this.ctx.session.steer(message.text, message.images, { onPromptQueued: onQueued }),
			{ imageCount: message.images?.length ?? 0 },
		);
	}

	isKnownSlashCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;
		const parsed = parseSlashCommand(text);
		const builtin = parsed && lookupBuiltinSlashCommand(parsed.name);
		if (builtin && (builtin.allowArgs || !parsed.args)) return true;
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		if (!commandName) return false;

		if (this.ctx.session.extensionRunner?.getCommand(commandName)) {
			return true;
		}

		for (const command of this.ctx.session.customCommands) {
			if (command.command.name === commandName) {
				return true;
			}
		}

		return this.ctx.fileSlashCommands.has(commandName);
	}

	async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		// Follow-ups queued behind a yield compaction wait for it, not for a pass that lands first.
		if (this.ctx.yieldCompaction) return;
		const origin = this.ctx.compactionQueueOrigin;
		this.ctx.compactionQueueOrigin = undefined;
		if (this.ctx.compactionQueuedMessages.length === 0) return;
		// Held behind the queued compaction that just ran: a switch or tree move while it summarized
		// means they belong to a conversation that is no longer live, so they go back to the editor.
		if (origin && !continuesConversation(this.ctx.sessionManager, origin)) {
			this.ctx.restoreCompactionQueueToEditor();
			return;
		}

		const queuedMessages = [...(this.ctx.compactionQueuedMessages as CompactionQueuedMessage[])];
		this.ctx.compactionQueuedMessages = [] as CompactionQueuedMessage[];
		this.ctx.updatePendingMessagesDisplay();
		// On failure the batch goes back to the compaction queue, so the messages this flush pushed
		// onto the session queues must leave them. Only those: what other sources queue (an
		// extension's message, input sent through other paths), before, during or after the flush,
		// stays queued.
		const deliveredByFlush: AgentMessage[] = [];
		const onDelivered = (queued: readonly AgentMessage[]) => {
			deliveredByFlush.push(...queued);
		};
		let restored = false;
		// The fire-and-forget first prompt belongs to the session once admitted (queued, or its turn
		// started): a restore then leaves it out of the batch, and keeps its queued messages, instead
		// of sending it again on the next flush — unless the prompt itself fails.
		let firstPrompt: CompactionQueuedMessage | undefined;
		/** Set once the first prompt is admitted: the messages it queued, or none if its turn started. */
		let firstAdmitted: readonly AgentMessage[] | undefined;
		let firstQueued: readonly AgentMessage[] = [];
		let firstFailed = false;
		let firstLeftOut = false;

		const reportFailure = (count: number, error: unknown) => {
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.showError(
				`Failed to send queued message${count > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		const restoreQueue = (error: unknown) => {
			// A `rest` delivery and the fire-and-forget first prompt can both fail; restore once.
			if (restored) return;
			restored = true;
			firstLeftOut = firstAdmitted !== undefined && !firstFailed;
			this.ctx.session.dropQueuedMessages(firstLeftOut ? deliveredByFlush : [...deliveredByFlush, ...firstQueued]);
			const batch = firstLeftOut ? queuedMessages.filter(message => message !== firstPrompt) : queuedMessages;
			this.ctx.compactionQueuedMessages = batch;
			reportFailure(batch.length, error);
		};

		try {
			if (options?.willRetry) {
				for (const message of queuedMessages) {
					await this.#deliverQueuedMessage(message, onDelivered);
				}
				this.ctx.updatePendingMessagesDisplay();
				return;
			}

			let firstPromptIndex = -1;
			for (let i = 0; i < queuedMessages.length; i++) {
				if (!this.ctx.isKnownSlashCommand(queuedMessages[i].text)) {
					firstPromptIndex = i;
					break;
				}
			}
			if (firstPromptIndex === -1) {
				for (const message of queuedMessages) {
					await this.#deliverQueuedMessage(message, onDelivered);
				}
				return;
			}

			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const first = queuedMessages[firstPromptIndex];
			firstPrompt = first;
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				// preCommands are all slash commands; #deliverQueuedMessage handles
				// that branch (no local-submission marking needed since slash
				// commands don't generate a matching user message_start).
				await this.#deliverQueuedMessage(message, onDelivered);
			}

			const onFirstQueued = (queued: readonly AgentMessage[]) => {
				firstQueued = queued;
			};
			const onFirstAdmitted = () => {
				firstAdmitted = firstQueued;
				// Admitted after the batch was already restored with it: the session must not send
				// it as well. Take a queued prompt back out (the batch keeps it); a prompt whose turn
				// already started leaves the batch instead.
				if (!restored || firstLeftOut) return;
				if (firstAdmitted.length > 0) {
					this.ctx.session.dropQueuedMessages(firstAdmitted);
				} else {
					firstLeftOut = true;
					this.ctx.compactionQueuedMessages = this.ctx.compactionQueuedMessages.filter(m => m !== first);
					this.ctx.updatePendingMessagesDisplay();
				}
			};
			/** Put the first prompt back into the batch, after the slash commands that preceded it. */
			const putFirstBack = () => {
				firstLeftOut = false;
				const current = this.ctx.compactionQueuedMessages;
				let at = 0;
				for (let i = 0; i < current.length; i++) if (preCommands.includes(current[i])) at = i + 1;
				this.ctx.compactionQueuedMessages = [...current.slice(0, at), first, ...current.slice(at)];
			};
			const onFirstFailed = (error: unknown) => {
				firstFailed = true;
				if (!firstLeftOut) {
					restoreQueue(error);
					return;
				}
				// A restore left the admitted first prompt out of the batch, but it failed after all.
				putFirstBack();
				reportFailure(1, error);
			};
			// A skill prompt the session dropped before sending it (usage preflight, cost cap, an
			// interrupt) resolves `false` even after admission, and nothing hands a custom prompt
			// back to the editor: the session does not own it after all, so a restore keeps it in
			// the batch, or puts it back if one already left it out.
			const onFirstDropped = () => {
				firstAdmitted = undefined;
				if (!firstLeftOut) return;
				putFirstBack();
				this.ctx.updatePendingMessagesDisplay();
			};

			// First prompt is fire-and-forget — its rejection is funneled through
			// `onFirstFailed` rather than rethrown. Plain prompts use primitive
			// recordLocalSubmission and dispose manually in the catch. Skill prompts
			// are rebuilt as user-attributed custom messages so queued `/skill:` text
			// is not sent as a literal prompt after compaction.
			let promptPromise: Promise<unknown>;
			if (isKnownSkillCommand(this.ctx, first.text)) {
				const built = await buildSkillCommandPrompt(this.ctx, first.text, first.mode, first.images);
				promptPromise = built
					? this.ctx.session
							.promptCustomMessage(built.message, {
								...built.options,
								onPromptQueued: onFirstQueued,
								onPromptAdmitted: onFirstAdmitted,
							})
							.then(sent => {
								if (sent === false) onFirstDropped();
							}, onFirstFailed)
					: Promise.resolve();
			} else {
				const disposeFirstPrompt = this.ctx.recordLocalSubmission(first.text, first.images?.length ?? 0);
				promptPromise = this.ctx.session
					.prompt(first.text, {
						streamingBehavior: first.mode === "followUp" ? "followUp" : "steer",
						images: first.images,
						onPromptQueued: onFirstQueued,
						onPromptAdmitted: onFirstAdmitted,
					})
					.catch((error: unknown) => {
						disposeFirstPrompt();
						onFirstFailed(error);
					});
			}

			for (const message of rest) {
				await this.#deliverQueuedMessage(message, onDelivered);
				// The first prompt failed while the rest was still being delivered: the whole batch is
				// back in the compaction queue, so take back what was delivered since and stop.
				if (restored) {
					this.ctx.session.dropQueuedMessages(deliveredByFlush);
					return;
				}
			}
			this.ctx.updatePendingMessagesDisplay();
			// The dispatch above bypasses `getUserInput`, so nothing would schedule
			// the next loop iteration for a prompt queued during compaction.
			if (this.ctx.loopModeEnabled) this.ctx.armLoopAutoSubmit();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		for (let i = this.ctx.viewSession.messages.length - 1; i >= 0; i--) {
			const message = this.ctx.viewSession.messages[i];
			if (message?.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	extractAssistantText(message: AssistantMessage): string {
		return extractVisibleAssistantText(message);
	}
}
