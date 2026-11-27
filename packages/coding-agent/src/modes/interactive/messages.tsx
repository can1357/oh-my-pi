/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Transcript faces of the session's non-assistant messages: prompts, summaries,
 * file mentions, and the custom messages extensions and omp itself persist
 * (background job events, IRC traffic, advisor notes, skill prompts, collab
 * prompts, handoffs). Assistant replies and `!`/`$` runs have their own
 * presenters.
 */
import type { GlowingKeyword } from "../../ui/composer/magic-keywords";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type Accessor, type JSXNode, type Signal, signal } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { AdvisorMessageDetails } from "../../advisor";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "../../collab/protocol";
import type { MessageRenderer } from "../../extensibility/extensions/render-types";
import { LAUNCH_COMPLETION_MESSAGE_TYPE } from "../../session/launch-completion";
import {
	BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
	TAN_RESULT_MESSAGE_TYPE,
	type TanResultDetails,
} from "../../session/messages";
import type { LateDiagnosticsFile } from "../../session/transcript/late-diagnostics-message";
import {
	ASYNC_NOTIFY_MESSAGE_TYPE,
	type AsyncNotifyDetails,
	type CustomMessage,
} from "../../session/transcript/messages";
import { imageContent, textContent } from "../../session/transcript/transcript-entry";
import { extensionTheme, isCompactOutput, renderExtension } from "../../ui/extensions/render-output";
import { CollabPrompt } from "../../ui/transcript/figures/collab";
import { AdvisorMessage } from "../../ui/transcript/messages/advisor-message";
import {
	AsyncNotify,
	AsyncResult,
	IrcMessageBlock,
	isIrcMessageType,
	LaunchCompletion,
	type LaunchCompletionDetails,
	ParentIrcMessage,
} from "../../ui/transcript/messages/async-cards";
import { FileMentions } from "../../ui/transcript/messages/file-mention";
import { CustomMessageBlock, type FrameRenderer, HookMessageBlock } from "../../ui/transcript/messages/frame";
import { LateDiagnostics } from "../../ui/transcript/messages/late-diagnostics";
import { ToolActivity } from "../../ui/transcript/messages/panel";
import { TangentDispatch, TangentResult } from "../../ui/transcript/messages/notices";
import { SkillMessage } from "../../ui/transcript/messages/skill-message";
import {
	BranchSummaryBlock,
	CompactionSummaryBlock,
	HandoffSummaryBlock,
} from "../../ui/transcript/messages/summaries";
import { UserMessage } from "../../ui/transcript/messages/user-message";

export type CustomOrHookMessage = Extract<AgentMessage, { role: "custom" | "hookMessage" }>;

/** What the faces read from the transcript and the session. */
export interface MessageFaceEnv {
	/** The transcript-wide expansion (`ctrl+o`). */
	readonly expanded: Accessor<boolean>;
	/** Tool activity shown (`display.toolActivity` other than `hidden`). */
	readonly activityVisible: Accessor<boolean>;
	/** Most note rows a collapsed advisor card shows (`display.advisorCollapsedLines`; 0: no cap). */
	readonly advisorCollapsedLines: Accessor<number>;
	/** The extension renderer of a custom message type. */
	renderer(customType: string): MessageRenderer | undefined;
	/** An extension renderer threw. */
	onRenderError(customType: string, error: unknown): void;
	/** Files of a prompt's attached images (chips and thumbnails open them). */
	imageLinks(message: AgentMessage, images: readonly ImageContent[]): (string | undefined)[] | undefined;
	/** SKILL.md of a skill chip. */
	skillPath(name: string): string | undefined;
	/** Whether a host handles transcript actions (the prompt's copy/edit controls). */
	readonly actions: Accessor<boolean>;
	/** The terminal's clock (`hour12`) prompt times follow; the locale default when undefined. */
	readonly hour12: Accessor<boolean | undefined>;
	/** Mark prompts as shell prompt zones (OSC 133). */
	readonly promptZones: Accessor<boolean>;
	/** The enabled magic keywords a sent prompt glows. */
	readonly magicKeywords: Accessor<readonly GlowingKeyword[]>;
	/** A prompt's transcript action (`copy-message`, `edit-turn`, `rewind-turn`, …). */
	onUserAction(act: string, text: string, timestamp: number): void;
}

/** A message's face and how the transcript mounts it. */
export interface MessageFace {
	/** Presented cards share their fold with the compact row that opens the card. */
	readonly face: (fold?: { expanded: Accessor<boolean>; onToggle: (expanded: boolean) => void }) => JSXNode;
	/** The message the extension transcript presenters see: the face is drawn as they ask (in full, a compact row, or hidden). */
	readonly presented?: CustomOrHookMessage;
	/** Packs against compact neighbours (an extension renderer's one-row output). */
	readonly compact?: Accessor<boolean>;
	/** A prompt bubble's reaction: the next reply's opening emoji lands here. */
	readonly reaction?: Signal<string | undefined>;
}

/** `explicit` options for a prompt (live submissions know the chip links already). */
export interface MessageFaceOptions {
	readonly imageLinks?: readonly (string | undefined)[];
}

/** The face of `message`, or undefined when it draws nothing (tool results, hidden custom messages). */
export function messageFace(
	message: AgentMessage,
	env: MessageFaceEnv,
	options?: MessageFaceOptions,
): MessageFace | undefined {
	switch (message.role) {
		case "custom":
		case "hookMessage":
			return message.display ? customFace(message, env) : undefined;
		case "compactionSummary":
			return {
				face: () => <CompactionSummaryBlock message={message} expanded={env.expanded} />,
			};
		case "branchSummary":
			return {
				face: () => <BranchSummaryBlock summary={message.summary} expanded={env.expanded} />,
			};
		case "fileMention":
			return message.files.length > 0
				? { face: () => <FileMentions files={message.files} indent={0} /> }
				: undefined;
		case "user":
		case "developer":
			return promptFace(message, env, options);
		default:
			return undefined;
	}
}

function customFace(message: CustomOrHookMessage, env: MessageFaceEnv): MessageFace | undefined {
	const customType = message.customType;
	if (customType === "async-result") {
		const renderer = env.renderer(customType);
		const output = signal<unknown>(undefined);
		const frameRenderer = renderer ? extensionFace(message, renderer, env, output) : undefined;
		return {
			face: fold => (
				<AsyncResult
					message={message}
					{...(fold ?? { expanded: env.expanded })}
					visible={env.activityVisible}
					{...(frameRenderer ? { renderer: frameRenderer } : {})}
				/>
			),
			presented: message,
			...(renderer ? { compact: () => isCompactOutput(output()) } : {}),
		};
	}
	if (customType === LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE) {
		const files = (message as CustomMessage<{ files?: LateDiagnosticsFile[] }>).details?.files ?? [];
		if (files.length === 0) return undefined;
		return {
			face: fold => (
				<ToolActivity visible={env.activityVisible}>
					<LateDiagnostics files={files} {...(fold ?? { expanded: env.expanded })} />
				</ToolActivity>
			),
			presented: message,
		};
	}
	if (customType === LAUNCH_COMPLETION_MESSAGE_TYPE) {
		const details = (message as CustomMessage<LaunchCompletionDetails>).details;
		return {
			face: () => <LaunchCompletion details={details} content={message.content} visible={env.activityVisible} />,
			presented: message,
		};
	}
	if (customType === ASYNC_NOTIFY_MESSAGE_TYPE) {
		const details = (message as CustomMessage<AsyncNotifyDetails>).details;
		return { face: () => <AsyncNotify details={details} visible={env.activityVisible} />, presented: message };
	}
	if (customType === COLLAB_PROMPT_MESSAGE_TYPE) {
		const prompt = message as CustomMessage<{ from?: string }>;
		return { face: () => <CollabPrompt message={prompt} /> };
	}
	if (customType === SKILL_PROMPT_MESSAGE_TYPE) {
		const skill = message as CustomMessage<SkillPromptDetails>;
		return {
			face: fold => (
				<SkillMessage content={skill.content} details={skill.details} {...(fold ?? { expanded: env.expanded })} />
			),
			presented: message,
		};
	}
	if (isIrcMessageType(customType)) {
		return {
			face: () => <IrcMessageBlock message={message} expanded={env.expanded} visible={env.activityVisible} />,
		};
	}
	if (customType === "advisor") {
		const details = (message as CustomMessage<AdvisorMessageDetails>).details;
		return {
			face: fold => (
				<AdvisorMessage
					details={details}
					{...(fold ?? { expanded: env.expanded })}
					collapsedLines={env.advisorCollapsedLines}
				/>
			),
			presented: message,
		};
	}
	if (customType === BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE) {
		const details = (message as CustomMessage<Record<string, unknown>>).details;
		return { face: () => <TangentDispatch details={details} /> };
	}
	if (customType === TAN_RESULT_MESSAGE_TYPE) {
		const details = (message as CustomMessage<Partial<TanResultDetails>>).details;
		return { face: () => <TangentResult details={details} /> };
	}
	if (customType === "handoff") {
		return { face: () => <HandoffSummaryBlock content={message.content} expanded={env.expanded} /> };
	}
	const renderer = env.renderer(customType);
	const output = signal<unknown>(undefined);
	const frameRenderer = renderer ? extensionFace(message, renderer, env, output) : undefined;
	const compact = () => isCompactOutput(output());
	if (message.role === "hookMessage") {
		return {
			face: () => (
				<HookMessageBlock
					message={message}
					expanded={env.expanded}
					{...(frameRenderer ? { renderer: frameRenderer } : {})}
				/>
			),
			compact,
		};
	}
	return {
		face: () => (
			<CustomMessageBlock
				message={message}
				expanded={env.expanded}
				{...(frameRenderer ? { renderer: frameRenderer } : {})}
			/>
		),
		compact,
	};
}

/** An extension's message renderer as a frame renderer; `output` keeps its last raw output (compactness). */
function extensionFace(
	message: CustomOrHookMessage,
	renderer: MessageRenderer,
	env: MessageFaceEnv,
	output: Signal<unknown>,
): FrameRenderer {
	return expanded =>
		renderExtension(
			() => {
				const raw = renderer(message as CustomMessage<unknown>, { expanded }, extensionTheme(currentTheme()));
				output.set(raw);
				return raw;
			},
			{ onError: error => env.onRenderError(message.customType, error) },
		);
}

function promptFace(
	message: Extract<AgentMessage, { role: "user" | "developer" }>,
	env: MessageFaceEnv,
	options: MessageFaceOptions | undefined,
): MessageFace | undefined {
	if (message.role === "user" && message.parentIrc) {
		const parentIrc = message.parentIrc;
		return {
			face: () => <ParentIrcMessage parentIrc={parentIrc} timestamp={message.timestamp} expanded={env.expanded} />,
		};
	}
	const text = message.role === "user" ? textContent(message.content) : "";
	if (!text) return undefined;
	const images = imageContent(message.content);
	const imageLinks = options?.imageLinks ?? env.imageLinks(message, images);
	const reaction = signal<string | undefined>(undefined);
	const synthetic = message.role === "developer" ? true : (message.synthetic ?? false);
	return {
		face: () => (
			<UserMessage
				model={{
					text,
					images,
					...(imageLinks ? { imageLinks } : {}),
					synthetic,
					liveSteered: message.role === "user" && message.liveSteered === true,
					skillPath: env.skillPath,
					timestamp: message.timestamp,
					hour12: env.hour12,
					reaction,
					actions: env.actions,
					promptZones: env.promptZones,
					promptZoneKey: message,
					magicKeywords: env.magicKeywords,
					onAction: act => env.onUserAction(act, text, message.timestamp),
				}}
			/>
		),
		reaction,
	};
}
