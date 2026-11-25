/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The live transcript blocks the interactive mode presents: assistant
 * replies, tool calls (cards, read groups, reply writes) and user `!`/`$`
 * runs, each wired to the view's reactive display flags and to the extension
 * transcript presenters, plus a registry of what each block shows.
 *
 * Settle rules: a reply settles when its view is finalized; a card on its
 * final result (a parked background card keeps taking frames: natively they
 * repaint, a terminal retires it as it was) unless the result gives way to the
 * next call (a `wait` poll whose jobs still run, a `todo`
 * snapshot), which the event controller seals; a read group only when sealed;
 * a run once it completes.
 */
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	type Accessor,
	batch,
	computed,
	effect,
	type Host,
	type JSXNode,
	type Signal,
	signal,
	untrack,
} from "@oh-my-pi/pi-tui";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { TspText } from "@oh-my-pi/pi-wire";
import type {
	TranscriptPresentation,
	TranscriptPresenter as PresenterFn,
} from "../../extensibility/extensions/render-types";
import type { AgentViewSession } from "../../session/agent-session-handle";
import type { BashExecutionMessage, PythonExecutionMessage } from "../../session/transcript/messages";
import { isReplyWrite, replyDisplayMessage } from "../../session/transcript/reply-write";
import { messageBlock, readTranscriptPresentation } from "../../session/transcript/transcript-presentation";
import { capturePage } from "../../tools/browser/page-shot";
import { type SpotlightDetails, spotlightDetails } from "../../tools/details/spotlight";
import { isWaitingPollDetails } from "../../tools/details/wait";
import { presentShellInspector } from "../../ui/apps/shell-visualizer";
import "../../ui/tools";
// The terminal looks of what the presenter mounts (tool presenters register their own).
import "../../ui/styles/messages";
import "../../ui/styles/tools";
import "../../ui/styles/transcript/exec-run";
import "../../ui/styles/transcript/read-group";
import { defaultPresenter } from "../../ui/tools/default";
import { toolEditMode } from "../../ui/tools/edit";
import { legacyPresenter, type LegacyToolRenderer } from "../../ui/tools/legacy";
import { toolPresenter } from "../../ui/tools/registry";
import type { ToolCommandMounted } from "../../ui/tools/tool-command";
import type { BlockOptions, Shell, TranscriptBlock, ViewList } from "../../ui/shell";
import { mountNode } from "../../ui/shell";
import { type ExecRun, ExecRunBlock } from "../../ui/transcript/exec-run";
import { cardExpansion } from "../../ui/transcript/expansion";
import { PresentedBlock } from "../../ui/transcript/figures/presented-block";
import { SpotlightNotice } from "../../ui/transcript/figures/spotlight";
import type { FigureCell } from "../../ui/transcript/figures/svg";
import {
	AssistantMessageBlock,
	type AssistantMessageModel,
	thinkingTail,
	type ToolResultMedia,
} from "../../ui/transcript/messages/assistant-message";
import { ThinkingRateMeter } from "../../session/transcript/thinking-speed";
import { ReadGroup, ReadGroupBlock, type ReadResult } from "../../ui/transcript/read-group";
import { ToolBlock, ToolCall, type ToolCallResult, type ToolPresentation } from "../../ui/transcript/tool-block";
import { type MessageFaceEnv, type MessageFaceOptions, messageFace } from "./messages";
import type {
	AssistantView,
	ExecRunPresentation,
	PendingTool,
	PresentAssistantOptions,
	ToolCallSpec,
	TranscriptEntry,
} from "../types";

/** The view's display flags, as signals every block reads. */
export interface DisplayFlags {
	readonly toolOutputExpanded: Signal<boolean>;
	readonly hideToolActivity: Signal<boolean>;
	/** Thinking hidden (the effective state: the setting, or thinking off with nothing to reveal). */
	readonly hideThinking: Signal<boolean>;
	readonly proseOnlyThinking: Signal<boolean>;
	readonly expandThinkingBlocks: Signal<boolean>;
	/** `terminal.showImages`. */
	readonly showImages: Signal<boolean>;
	/** `tui.renderSvg`. */
	readonly renderSvg: Signal<boolean>;
	/** `tui.renderEmbeds`. */
	readonly renderEmbeds: Signal<boolean>;
	/** Cell size when the terminal supports inline pictures. */
	readonly figureCell: Signal<FigureCell | undefined>;
	/** Tables get charts (the main session's do, a focused subagent's do not). */
	readonly tableCharts: Accessor<boolean>;
	/** Show bash commands through the shell engine's presentation (`display.shellVisualization`). */
	readonly shellVisualization: Signal<boolean>;
	/** `mcp.renderMarkdownResults`. */
	readonly mcpMarkdown: Signal<boolean>;
	/** `read.toolResultPreview`. */
	readonly readPreview: Signal<boolean>;
}

/** What the presenter needs from the interactive mode. */
export interface PresenterHost {
	/**
	 * Where blocks mount (`transcript`), the host whose scrollback a changed presentation replays
	 * (none: no scrollback), and where a block opens a page of its own (a bash card's inspector).
	 */
	readonly shell: Pick<Shell, "transcript" | "host" | "overlays" | "size">;
	readonly viewSession: AgentViewSession;
	readonly display: DisplayFlags;
	/** The `pendingShell` slot's runs. */
	readonly pendingShellRuns: ViewList;
	/** Destinations of the viewed session's resolved prose links. */
	linkTargets(): ReadonlyMap<string, string>;
	/** Open the Spotlight sheet of a shaped tool result (its notice's action); `reduced` is the text the model saw. */
	openSpotlight?(spotlight: SpotlightDetails, reduced: string): void;
	/** A reply's transcript action (`retry`, `copy-answer`, …). */
	onAssistantAction?(act: string, message: AssistantMessage | undefined, copyText?: string): void;
	/** What message faces read (prompts, custom messages, summaries). */
	readonly messages: MessageFaceEnv;
}

const kEntry = Symbol("omp.transcriptEntry");

/** A block tagged with what it shows. */
interface EntryTagged extends TranscriptBlock {
	[kEntry]?: TranscriptEntry;
}

/** A deferred run and the block that shows it until the turn ends. */
interface PendingRun {
	readonly run: ExecRun;
	readonly message: Signal<BashExecutionMessage | PythonExecutionMessage>;
}

/** See the module docs. */
export class TranscriptPresenter {
	readonly #host: PresenterHost;
	readonly #presenters = signal<readonly PresenterFn[]>([]);
	/** Bumped to ask the presenters again. */
	readonly #presentationRevision = signal(0);
	/** Bumped when the extensions' assistant renderers change. */
	readonly #rendererRevision = signal(0);
	/** Per presented id: bumped when a refresh names it (see {@link refreshPresentation}). */
	readonly #idRevisions = new Map<string, Signal<number>>();
	/** A history replay asked for and not yet drawn (one per frame however many retired blocks changed). */
	#replayOwed = false;
	/** The host whose frames clear {@link #replayOwed}, and how to stop watching them. */
	#frameWatch: { readonly host: Host; readonly unwatch: () => void } | undefined;
	#pendingRuns: PendingRun[] = [];
	/** The last prompt drawn with no reply after it yet: the next reply's opening emoji reacts on it. */
	#reactionTarget: Signal<string | undefined> | undefined;

	constructor(host: PresenterHost) {
		this.#host = host;
	}

	/** Install the extension transcript presenters; true when the set changed. */
	setPresenters(presenters: readonly PresenterFn[]): boolean {
		const current = this.#presenters.peek();
		if (current.length === presenters.length && current.every((presenter, i) => presenter === presenters[i]))
			return false;
		this.#presenters.set(presenters);
		return true;
	}

	/**
	 * Hand every reply the extensions' current text and thinking renderers (a suspension, a resume or
	 * the `extensionRenderers.assistantText` toggle changed them); live replies redraw.
	 */
	refreshRenderers(): void {
		this.#rendererRevision.set(this.#rendererRevision.peek() + 1);
	}

	/**
	 * Ask the presenters again for the blocks `ids` names, every block without `ids`. A changed block
	 * on screen repaints; one with rows in scrollback replays history (once per frame).
	 */
	refreshPresentation(ids?: Iterable<string>): void {
		if (!ids) {
			this.#presentationRevision.set(this.#presentationRevision.peek() + 1);
			return;
		}
		batch(() => {
			for (const id of ids) {
				const revision = this.#idRevisions.get(id);
				revision?.set(revision.peek() + 1);
			}
		});
	}

	#revisionOf(id: string): number {
		let revision = this.#idRevisions.get(id);
		if (!revision) {
			revision = signal(0);
			this.#idRevisions.set(id, revision);
		}
		return revision();
	}

	/**
	 * Watch `presentation` for the life of the current owner (a block's mount): when its answer changes
	 * while `block` has rows in scrollback, history replays (coalesced to one per frame).
	 */
	#watchPresentation(block: () => TranscriptBlock | undefined, presentation: Accessor<unknown>): void {
		let last: string | undefined;
		effect(() => {
			const key = JSON.stringify(presentation() ?? null);
			if (last !== undefined && key !== last) {
				const shown = untrack(block);
				if (shown && untrack(() => this.#host.shell.transcript.retired(shown))) this.#oweReplay();
			}
			last = key;
		});
	}

	/** Replay history before the next frame, once however many changes ask for it before then. */
	#oweReplay(): void {
		if (this.#replayOwed) return;
		const host = this.#host.shell.host;
		if (!host) return;
		if (this.#frameWatch?.host !== host) {
			this.#frameWatch?.unwatch();
			this.#frameWatch = {
				host,
				unwatch: host.onFrame(() => {
					this.#replayOwed = false;
				}),
			};
		}
		this.#replayOwed = true;
		host.replayHistory();
	}

	/** The presenters' answer for `block` (the first other than `undefined`); `undefined` draws it in full. */
	presentationOf(block: Parameters<PresenterFn>[0]): TranscriptPresentation {
		this.#presentationRevision();
		this.#revisionOf(block.id);
		for (const presenter of this.#presenters()) {
			let answer: TranscriptPresentation | null;
			try {
				answer = readTranscriptPresentation(presenter(block));
			} catch {
				continue;
			}
			if (answer === null) return "full";
			if (answer !== undefined) return answer;
		}
		return undefined;
	}

	/** What `block` shows, undefined for static blocks. */
	transcriptEntry(block: TranscriptBlock): TranscriptEntry | undefined {
		return (block as EntryTagged)[kEntry];
	}

	/** Record what a block the mode mounted itself shows. */
	register(block: TranscriptBlock, entry: TranscriptEntry): void {
		(block as EntryTagged)[kEntry] = entry;
	}

	// ─── Assistant replies ──────────────────────────────────────────────────

	presentAssistant(message?: AssistantMessage, options?: PresentAssistantOptions): AssistantView {
		const { display } = this.#host;
		// A reply reacts on the prompt right above it; a later reply has another before it.
		const reactionTarget = this.#reactionTarget;
		this.#reactionTarget = undefined;
		const signals = {
			message: signal<AssistantMessage | undefined>(message),
			transient: signal(false),
			finalized: signal(message !== undefined),
			linkTargets: signal<ReadonlyMap<string, string>>(options?.linkTargets ?? this.#host.linkTargets()),
			toolResultMedia: signal<ReadonlyMap<string, ToolResultMedia>>(new Map()),
			cacheInvalidation: signal<AssistantView["cacheInvalidation"] extends Signal<infer T> ? T : never>(undefined),
			servedModelMismatch:
				signal<AssistantView["servedModelMismatch"] extends Signal<infer T> ? T : never>(undefined),
			turnUsage: signal<AssistantView["turnUsage"] extends Signal<infer T> ? T : never>(undefined),
			rewound: signal(false),
			errorPinned: signal(false),
			errorExpanded: signal(false),
		};
		const thinkingRate = signal(0);
		const sessionManager = this.#host.viewSession.sessionManager;
		const model: AssistantMessageModel = {
			message: signals.message,
			transient: signals.transient,
			finalized: signals.finalized,
			hideThinking: display.hideThinking,
			expandThinking: display.expandThinkingBlocks,
			proseOnlyThinking: display.proseOnlyThinking.peek(),
			showImages: display.showImages,
			renderSvg: display.renderSvg,
			renderEmbeds: display.renderEmbeds,
			figureCell: display.figureCell,
			embedHost: { cwd: () => sessionManager.getCwd(), capturePage },
			showToolResultImages: () => !display.hideToolActivity(),
			tableCharts: display.tableCharts,
			toolResultMedia: signals.toolResultMedia,
			linkTargets: signals.linkTargets,
			...(options?.tone ? { tone: options.tone } : {}),
			errorExpanded: () => signals.errorExpanded() || display.toolOutputExpanded(),
			errorPinned: signals.errorPinned,
			cacheInvalidation: signals.cacheInvalidation,
			servedModelMismatch: signals.servedModelMismatch,
			turnUsage: signals.turnUsage,
			rewound: signals.rewound,
			thinkingRate,
			actions: this.#host.onAssistantAction !== undefined,
			textRenderers: () => {
				this.#rendererRevision();
				return this.#host.viewSession.extensionRunner?.getAssistantTextRenderers() ?? [];
			},
			thinkingRenderers: () => {
				this.#rendererRevision();
				return this.#host.viewSession.extensionRunner?.getAssistantThinkingRenderers() ?? [];
			},
			...(options?.contentOffset !== undefined ? { contentOffset: options.contentOffset } : {}),
			// A reply reacts only on the prompt right above it; a later one keeps its opening emoji.
			...(reactionTarget
				? { onReaction: (emoji: string | undefined) => reactionTarget.set(emoji) }
				: { reacts: false }),
			...(this.#host.onAssistantAction
				? {
						onAction: (act: string, copyText?: string) =>
							this.#host.onAssistantAction?.(act, signals.message.peek(), copyText),
					}
				: {}),
		};
		const factory = () => {
			// The reply settles once nothing streams into it any more.
			effect(() => {
				if (signals.finalized()) this.#settleSoon(() => view.block);
			});
			// The live thinking speed: sampled from streamed updates while the reply's tail is thinking
			// (a final update's usage jump is no stream sample); back to 0 once the thinking stops.
			const meter = new ThinkingRateMeter();
			let thinking = false;
			effect(() => {
				const current = signals.message();
				const live =
					current !== undefined &&
					signals.transient() &&
					!signals.finalized() &&
					thinkingTail(current) !== undefined;
				untrack(() => {
					if (live) {
						thinking = true;
						thinkingRate.set(meter.sample(current.usage.reasoningTokens ?? current.usage.output));
					} else if (thinking) {
						thinking = false;
						meter.stop();
						thinkingRate.set(0);
					}
				});
			});
			return <AssistantMessageBlock model={model} />;
		};
		const block = this.#mount(factory, options?.before);
		const view: AssistantView = {
			block,
			model,
			...signals,
			setToolResultMedia: (toolCallId, media) =>
				signals.toolResultMedia.update(current => new Map(current).set(toolCallId, media)),
		};
		this.register(block, { kind: "assistant", view });
		return view;
	}

	// ─── Other messages ─────────────────────────────────────────────────────

	/**
	 * Mount `message` (a prompt, summary, file mention or custom message); undefined when it draws
	 * nothing. Settled at once unless `live` (an optimistic prompt that may still be withdrawn).
	 */
	presentMessage(
		message: AgentMessage,
		options?: MessageFaceOptions & { readonly live?: boolean; readonly before?: TranscriptBlock },
	): TranscriptBlock | undefined {
		const face = messageFace(message, this.#host.messages, options);
		if (!face) return undefined;
		const { display } = this.#host;
		if (face.reaction) this.#reactionTarget = face.reaction;
		const presented = face.presented;
		const factory = presented
			? () => {
					const fold = cardExpansion(display.toolOutputExpanded);
					const presentation = computed(() => this.presentationOf(messageBlock(presented)));
					this.#watchPresentation(() => block, presentation);
					return (
						<PresentedBlockNode
							block={() => messageBlock(presented)}
							presentation={presentation}
							expanded={fold.expanded}
							onToggle={fold.toggle}
							activityVisible={() => !display.hideToolActivity()}
						>
							{face.face({ expanded: fold.expanded, onToggle: expanded => fold.toggle(!expanded) })}
						</PresentedBlockNode>
					);
				}
			: face.face;
		const block = this.#mount(factory, options?.before, face.compact ? { compact: face.compact } : undefined);
		this.register(block, { kind: "message", message });
		if (!options?.live) this.#settle(block);
		return block;
	}

	// ─── Tool calls ─────────────────────────────────────────────────────────

	presentToolCall(spec: ToolCallSpec, options?: { readonly before?: TranscriptBlock }): PendingTool {
		const builtIn = this.#host.viewSession.hasBuiltInTool(spec.name);
		const pending =
			builtIn && isReplyWrite(spec.name, spec.args) === true
				? this.#presentReplyWrite(spec, options?.before)
				: this.#presentCard(spec, builtIn, options?.before);
		this.register(pending.block, { kind: "tool", tool: pending });
		return pending;
	}

	#presentCard(spec: ToolCallSpec, builtIn: boolean, before: TranscriptBlock | undefined): PendingTool {
		const { display } = this.#host;
		const renderer = builtIn ? undefined : legacyRenderer(spec.tool);
		// A same-named tool that is not the built-in (an extension's) without hooks draws the
		// generic card, never the built-in's presenter.
		const registered = toolPresenter(spec.name);
		const presenter = renderer
			? legacyPresenter(renderer, registered ?? defaultPresenter)
			: !builtIn && registered
				? defaultPresenter
				: undefined;
		const call = new ToolCall({
			id: spec.id,
			name: spec.name,
			...(spec.tool?.label ? { label: spec.tool.label } : {}),
			args: spec.args,
			...(presenter ? { presenter } : {}),
			resolveToolCommand: toolCommandResolver(spec.tool),
			shellVisualization: display.shellVisualization.peek(),
			inspectShell: source => presentShellInspector(this.#host.shell, source),
			mcpMarkdown: display.mcpMarkdown.peek(),
		});
		const editMode = toolEditMode(spec.name, spec.tool);
		if (editMode) call.setRenderContext({ editMode });
		const presentedId = signal(spec.id);
		const block = this.#mount(() => {
			effect(() => {
				const value = display.toolOutputExpanded();
				untrack(() => call.setExpanded(value));
			});
			effect(() => {
				const value = !display.hideToolActivity();
				untrack(() => call.setActivityVisible(value));
			});
			effect(() => {
				const value = display.showImages();
				untrack(() => call.setShowImages(value));
			});
			const answer = computed(() => {
				const result = call.facts.result();
				return this.presentationOf({
					type: "toolCall",
					id: presentedId(),
					toolName: call.name,
					args: call.facts.args(),
					...(result ? { result } : {}),
					isError: result?.isError === true,
					isPartial: result === undefined || call.facts.partial(),
				});
			});
			effect(() => {
				const presentation = toolPresentation(answer());
				untrack(() => call.setPresentation(presentation));
			});
			this.#watchPresentation(() => block, answer);
			// The Spotlight notice of a shaped result rides after its card (native only: the terminal draws nothing).
			const notice = (): JSXNode => {
				const result = call.facts.result();
				return result && !call.facts.partial() ? this.#spotlightNotice(call.id, result) : undefined;
			};
			return [<ToolBlock call={call} />, notice];
		}, before);
		const settleIfFinal = (result: ToolCallResult, partial: boolean): void => {
			if (partial) return;
			if (result.isError !== true) {
				if (spec.name === "wait" && isWaitingPollDetails(result.details)) return;
				if (spec.name === "todo" && hasTodoPhases(result.details)) return;
			}
			this.#settle(block);
		};
		return {
			block,
			call,
			updateArgs: args => call.updateArgs(args),
			updateStreamPreview: preview => call.updateStreamPreview(preview),
			updateResult: (result, partial) => {
				call.updateResult(result, partial);
				settleIfFinal(result, partial);
			},
			setArgsComplete: () => call.setArgsComplete(),
			setExecutionStarted: () => call.setExecutionStarted(),
			parkAsBackground: () => {},
			seal: () => {
				call.seal();
				this.#settle(block);
			},
			rename: newId => presentedId.set(newId),
		};
	}

	/** A built-in `write` to a reply URL: its content drawn as assistant prose. */
	#presentReplyWrite(spec: ToolCallSpec, before: TranscriptBlock | undefined): PendingTool {
		const view = this.presentAssistant(undefined, before ? { before } : {});
		const show = (args: unknown) => {
			const content = isRecord(args) && typeof args.content === "string" ? args.content : "";
			view.message.set(replyDisplayMessage(content));
		};
		show(spec.args);
		view.transient.set(true);
		return {
			block: view.block,
			reply: view,
			updateArgs: show,
			updateStreamPreview: () => {},
			updateResult: (result, partial) => {
				if (partial) return;
				view.transient.set(false);
				if (result.isError) {
					const text = result.content.map(part => part.text ?? "").join("");
					const current = view.message.peek();
					view.message.set(replyDisplayMessage(textOf(current), text || "Write failed"));
				}
				view.finalized.set(true);
			},
			setArgsComplete: () => view.transient.set(false),
			setExecutionStarted: () => {},
			parkAsBackground: () => {},
			seal: () => {
				view.transient.set(false);
				view.finalized.set(true);
			},
		};
	}

	/** The Spotlight notice of call `toolCallId`'s final result, when shaping cut or held it back. */
	#spotlightNotice(toolCallId: string, result: ToolCallResult): JSXNode {
		const spotlight = spotlightDetails(result.details);
		if (!spotlight || !(spotlight.original || spotlight.holdout || spotlight.gated)) return undefined;
		const reduced = result.content.map(part => part.text ?? "").join("");
		return (
			<SpotlightNotice
				toolCallId={toolCallId}
				spotlight={spotlight}
				hidden={() => this.#host.display.hideToolActivity()}
				onOpen={() => this.#host.openSpotlight?.(spotlight, reduced)}
			/>
		);
	}

	presentReadGroup(options?: { readonly before?: TranscriptBlock }): PendingTool {
		const { display } = this.#host;
		const group = new ReadGroup({ showContentPreview: display.readPreview.peek() });
		// Final results by read id: their Spotlight notices follow the group.
		const finals = signal<ReadonlyMap<string, ToolCallResult>>(new Map());
		// The last answer per read: one changing while the group has rows in scrollback replays history.
		const answers = new Map<string, string>();
		group.setPresenter(read => {
			const answer = this.presentationOf(read);
			const key = JSON.stringify(answer ?? null);
			const last = answers.get(read.id);
			answers.set(read.id, key);
			if (last !== undefined && last !== key && untrack(() => this.#host.shell.transcript.retired(block)))
				this.#oweReplay();
			return toolPresentation(answer);
		});
		const block = this.#mount(() => {
			effect(() => {
				const value = display.toolOutputExpanded();
				untrack(() => group.setExpanded(value));
			});
			effect(() => {
				const value = !display.hideToolActivity();
				untrack(() => group.setActivityVisible(value));
			});
			effect(() => {
				this.#presentationRevision();
				this.#presenters();
				untrack(() => group.refreshPresentation());
			});
			const notices = (): JSXNode[] =>
				[...finals().entries()].map(([id, result]) => this.#spotlightNotice(id, result));
			return [ReadGroupBlock({ group }), notices];
		}, options?.before);
		const pending: PendingTool = {
			block,
			group,
			updateArgs: (args, id) => group.updateArgs(isRecord(args) ? args : {}, id),
			updateStreamPreview: () => {},
			updateResult: (result, partial, id) => {
				group.updateResult(result as ReadResult, partial, id);
				if (!partial && id !== undefined) finals.set(new Map(finals.peek()).set(id, result));
			},
			// A group shows each read's state through its result.
			setArgsComplete: () => {},
			setExecutionStarted: () => {},
			parkAsBackground: () => {},
			seal: () => {
				group.seal();
				this.#settle(block);
			},
		};
		this.register(block, { kind: "tool", tool: pending });
		return pending;
	}

	// ─── `!` / `$` runs ─────────────────────────────────────────────────────

	presentExecRun(
		run: ExecRun,
		options?: { readonly deferred?: boolean; readonly recorded?: BashExecutionMessage | PythonExecutionMessage },
	): ExecRunPresentation {
		// A replayed run is drawn as recorded from the start (presenters see its id once).
		const message = signal<BashExecutionMessage | PythonExecutionMessage>(
			options?.recorded ?? provisionalMessage(run),
		);
		let block: TranscriptBlock | undefined;
		if (options?.deferred) {
			this.#pendingRuns.push({ run, message });
			this.#host.pendingShellRuns.push(
				mountNode(
					() => <col role="omp.pending-run">{this.#runFace(run, message, () => undefined)}</col>,
					"A shell run",
				),
			);
		} else {
			block = this.#mountRun(run, message);
		}
		return { block, record: recorded => message.set(recorded) };
	}

	/** Move the runs deferred while the agent streamed into the transcript. */
	flushPendingExecRuns(): void {
		const runs = this.#pendingRuns;
		this.#pendingRuns = [];
		this.#host.pendingShellRuns.clear();
		for (const { run, message } of runs) this.#mountRun(run, message);
	}

	/** Drop the deferred runs (a session switch). */
	clearPendingExecRuns(): void {
		this.#pendingRuns = [];
		this.#host.pendingShellRuns.clear();
	}

	get hasPendingExecRuns(): boolean {
		return this.#pendingRuns.length > 0;
	}

	#mountRun(run: ExecRun, message: Signal<BashExecutionMessage | PythonExecutionMessage>): TranscriptBlock {
		const block = this.#mount(() => {
			effect(() => {
				if (run.status() !== "running") this.#settleSoon(() => block);
			});
			return this.#runFace(run, message, () => block);
		}, undefined);
		this.register(block, { kind: "exec", run });
		return block;
	}

	/** A `!`/`$` run's face; `block` is its transcript block once mounted (none while deferred). */
	#runFace(
		run: ExecRun,
		message: Signal<BashExecutionMessage | PythonExecutionMessage>,
		block: () => TranscriptBlock | undefined,
	): JSXNode {
		const { display } = this.#host;
		effect(() => {
			const value = display.toolOutputExpanded();
			untrack(() => run.setExpanded(value));
		});
		const presented = computed(() => messageBlock(message()));
		const presentation = computed(() => this.presentationOf(presented()));
		this.#watchPresentation(block, presentation);
		return (
			<PresentedBlockNode
				block={presented}
				presentation={presentation}
				expanded={run.expanded}
				onToggle={collapsed => run.toggle(collapsed)}
				activityVisible={() => !display.hideToolActivity()}
			>
				<ExecRunBlock run={run} />
			</PresentedBlockNode>
		);
	}

	#mount(factory: () => JSXNode, before: TranscriptBlock | undefined, options?: BlockOptions): TranscriptBlock {
		const transcript = this.#host.shell.transcript;
		return before ? transcript.insertBefore(before, factory, options) : transcript.append(factory, options);
	}

	#settle(block: TranscriptBlock): void {
		this.#host.shell.transcript.settle(block);
	}

	/** Settle a block from inside its own factory, where it is not assigned yet. */
	#settleSoon(block: () => TranscriptBlock): void {
		queueMicrotask(() => this.#settle(block()));
	}
}

/** `PresentedBlock` over a block that may change (a run the session records later). */
function PresentedBlockNode(props: {
	readonly block: () => Parameters<typeof PresentedBlock>[0]["block"];
	readonly presentation: () => TranscriptPresentation;
	readonly expanded: () => boolean;
	readonly onToggle: (collapsed: boolean) => void;
	readonly activityVisible: () => boolean;
	readonly children: JSXNode;
}): JSXNode {
	return () => (
		<PresentedBlock
			block={props.block()}
			presentation={props.presentation}
			expanded={props.expanded}
			onToggle={props.onToggle}
			activityVisible={props.activityVisible}
		>
			{props.children}
		</PresentedBlock>
	);
}

/** A presenters' answer as a tool card's presentation. */
function toolPresentation(answer: TranscriptPresentation): ToolPresentation {
	if (answer === undefined || answer === "full") return "full";
	if (answer === "hidden" || answer === "compact") return answer;
	const { label, rows } = answer.compact;
	return {
		compact: {
			...(label !== undefined ? { label: spanText(label) } : {}),
			...(rows ? { rows: rows.map(spanText) } : {}),
		},
	};
}

function spanText(text: TspText): string {
	return typeof text === "string" ? stripEscapes(text) : text.map(part => part.t).join("");
}

function textOf(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).map(part => (part.type === "text" ? part.text : "")).join("");
}

function hasTodoPhases(details: unknown): boolean {
	return isRecord(details) && Array.isArray(details.phases);
}

/** An extension tool's render hooks, when it has any. */
function legacyRenderer(tool: AgentTool | undefined): LegacyToolRenderer | undefined {
	const hooks = tool as (AgentTool & Partial<LegacyToolRenderer>) | undefined;
	if (!hooks?.renderCall && !hooks?.renderResult) return undefined;
	return {
		...(hooks.renderCall ? { renderCall: hooks.renderCall.bind(hooks) } : {}),
		...(hooks.renderResult ? { renderResult: hooks.renderResult.bind(hooks) } : {}),
		...(hooks.mergeCallAndResult !== undefined ? { mergeCallAndResult: hooks.mergeCallAndResult } : {}),
	};
}

/** Lookup of the tools a bash run's tool commands dispatch to (the tool's session state). */
function toolCommandResolver(
	tool: AgentTool | undefined,
): ((name: string) => ToolCommandMounted | undefined) | undefined {
	const session = (tool as { session?: { toolCommands?: { resolve?: (name: string) => unknown } } } | undefined)
		?.session;
	const resolve = session?.toolCommands?.resolve;
	if (!resolve) return undefined;
	return name => {
		const mounted = resolve(name) as (Partial<LegacyToolRenderer> & { label?: string }) | undefined;
		if (!mounted) return undefined;
		const legacy = mounted.renderCall || mounted.renderResult ? legacyRenderer(mounted as AgentTool) : undefined;
		const presenter = toolPresenter(name);
		return {
			...(mounted.label ? { label: mounted.label } : {}),
			...(presenter ? { presenter } : {}),
			...(legacy ? { legacy } : {}),
		};
	};
}

/** The message a run stands for until the session records it. */
function provisionalMessage(run: ExecRun): BashExecutionMessage | PythonExecutionMessage {
	return run.kind === "bash"
		? {
				role: "bashExecution",
				command: run.source,
				output: "",
				exitCode: undefined,
				cancelled: false,
				truncated: false,
				timestamp: Date.now(),
				excludeFromContext: run.excluded,
			}
		: {
				role: "pythonExecution",
				code: run.source,
				output: "",
				exitCode: undefined,
				cancelled: false,
				truncated: false,
				timestamp: Date.now(),
				excludeFromContext: run.excluded,
			};
}
