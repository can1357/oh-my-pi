/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The Agent Hub's transcript viewer: the agent's meta (status, kind, model)
 * and Close, its transcript, a send failure, the message draft (revive or
 * steer the agent; advisors are read-only), its progress and the key hints.
 *
 * The terminal fills the screen (`styles/panels/agent-transcript-viewer.ts`):
 * rules around the header and the footer, the transcript scrolled between
 * them (j/k, g/G, PgUp/PgDn, the wheel) and following its end.
 */
import { For, type JSXNode, untrack } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { sanitizeErrorLine } from "../../../modes/view-model/chrome/error-block";
import { formatContextUsage } from "../../status/format";
import "../../styles/panels/agent-transcript-viewer";
import { AssistantMessageBlock } from "../../transcript/messages/assistant-message";
import { ParentIrcMessage } from "../../transcript/messages/async-cards";
import { TranscriptBlocks } from "../../transcript/messages/panel";
import { BranchSummaryBlock, CompactionSummaryBlock } from "../../transcript/messages/summaries";
import { SyntheticMessage, UserMessage } from "../../transcript/messages/user-message";
import { ToolBlock } from "../../transcript/tool-block";
import type { AgentTranscriptViewerModel, ViewerAgentStatus, ViewerBlock } from "./agent-transcript-viewer-model";
import { applyEdit, EscCloseButton, Hints, type KeyHint } from "./common";
import { actionKbd } from "../../keys/hints";

/** Width native terminals truncate notices at themselves (within the native truncate's range). */
const NATIVE_LINE_WIDTH = 0x7fff_ffff;
const SEP = " · ";

export const STATUS_TONE: Readonly<Record<ViewerAgentStatus, TspTone>> = {
	running: "success",
	idle: "accent",
	parked: "muted",
	aborted: "error",
};

function Block(props: { readonly model: AgentTranscriptViewerModel; readonly block: ViewerBlock }): JSXNode {
	const { model, block } = props;
	// The session's transcript controls: shown (and run) as on the session's own blocks.
	const actions = model.deps.actions;
	switch (block.kind) {
		case "user":
			return block.synthetic ? (
				<SyntheticMessage text={block.text} expanded={model.expanded} />
			) : (
				<UserMessage
					model={{
						text: block.text,
						images: block.images,
						liveSteered: block.liveSteered,
						timestamp: block.timestamp,
						hour12: model.deps.hour12,
						actions: actions !== undefined,
						onAction: act => actions?.prompt(act, block.text, block.timestamp),
					}}
				/>
			);
		case "parentIrc":
			return <ParentIrcMessage parentIrc={block.parentIrc} timestamp={block.timestamp} expanded={model.expanded} />;
		case "assistant":
			return (
				<AssistantMessageBlock
					model={{
						message: block.message,
						finalized: true,
						expandThinking: model.expanded,
						turnUsage: block.usage,
						actions: actions !== undefined,
						onAction: (act, copyText) => actions?.reply(act, block.message, copyText),
					}}
				/>
			);
		case "tool":
			return <ToolBlock call={block.call} />;
		case "compaction":
			return (
				<CompactionSummaryBlock
					message={{ summary: block.summary, tokensBefore: block.tokensBefore }}
					expanded={model.expanded}
				/>
			);
		case "branch":
			return <BranchSummaryBlock summary={block.summary} expanded={model.expanded} />;
	}
}

/** The stats row: context use as a bar, then tools, time and cost. */
function Stats(props: { readonly model: AgentTranscriptViewerModel }): JSXNode {
	const progress = props.model.progress();
	if (!progress) return null;
	const windowed = !!progress.contextTokens && progress.contextTokens > 0 && !!progress.contextWindow;
	const spans: TspSpan[] = [];
	const push = (span: TspSpan) => {
		if (spans.length > 0) spans.push({ s: "dim", t: SEP });
		spans.push(span);
	};
	if (progress.toolCount > 0)
		push({
			s: "dim",
			t: `${formatNumber(progress.toolCount)} ${currentTheme().symbols.symbol("icon.extensionTool")}`,
		});
	if (progress.contextTokens && progress.contextTokens > 0 && !windowed)
		push({ s: "dim", t: formatNumber(progress.contextTokens) });
	if (progress.durationMs > 0) push({ s: "dim", t: formatDuration(progress.durationMs) });
	if (progress.cost > 0) push({ s: "statusLineCost", t: `$${progress.cost.toFixed(2)}` });
	if (!windowed && spans.length === 0) return null;
	const fraction = windowed ? progress.contextTokens! / progress.contextWindow! : 0;
	return (
		<row key="stats" gap="md" align="center">
			{windowed && (
				<progress
					value={Math.min(1, fraction)}
					label={formatContextUsage(fraction * 100, progress.contextWindow!, progress.contextTokens!)}
					max={{ w: "24ch" }}
				/>
			)}
			{spans.length > 0 && <text spans={spans} truncate="end" />}
		</row>
	);
}

export function AgentTranscriptViewer(props: { readonly model: AgentTranscriptViewerModel }): JSXNode {
	const { model } = props;
	const id = model.deps.agentId;
	const transcript = (
		<col key="transcript" grow={1}>
			<TranscriptBlocks>
				<For each={model.blocks}>{block => <Block model={model} block={block} />}</For>
			</TranscriptBlocks>
		</col>
	);
	const editor = (
		<editor
			key="input"
			text={() => (model.rev(), model.draft.text)}
			cursor={() => (model.rev(), model.draft.cursor)}
			maxLines={4}
			sendable={false}
			onEdit={event => {
				const next = applyEdit(model.draft, event);
				if (!next) return;
				model.draft = next;
				model.touch();
			}}
		/>
	);
	const field = <col role="omp.field">{editor}</col>;
	/** A part of the card rebuilt whenever the model changes. */
	const part = (build: () => JSXNode) => () => {
		model.rev();
		return untrack(build);
	};
	return (
		<card
			role="omp.hub.transcript"
			head={[
				{ s: "accent", t: "Agent Hub" },
				{ s: "dim", t: ` ${SEP} ` },
				{ s: "accent", t: id },
			]}
			term={() => ({ model, rev: model.rev() })}
			onKey={key => model.key(key.id, key.text)}
			onAction={act => {
				if (act === "close") model.escape();
			}}
		>
			{part(() => {
				const ref = model.ref();
				return (
					<row key="top" gap="md" align="center">
						{ref ? (
							<row key="meta" gap="sm" align="center" grow={1} min={{ w: 0 }}>
								<text spans={[{ s: "strong", t: id }]} />
								<badge text={ref.status} tone={STATUS_TONE[ref.status]} />
								<text
									spans={[{ s: "dim", t: ref.parentId ? `${ref.kind} ${SEP} of ${ref.parentId}` : ref.kind }]}
									truncate="end"
								/>
								{model.model && <text spans={[{ s: "muted", t: model.model }]} truncate="end" />}
							</row>
						) : (
							<spacer grow={1} />
						)}
						<EscCloseButton />
					</row>
				);
			})}
			{() =>
				model.blocks().length > 0
					? transcript
					: part(() => (
							<text
								key="placeholder"
								spans={[{ s: "dim", t: sanitizeErrorLine(model.placeholder(), NATIVE_LINE_WIDTH) }]}
								wrap="word"
							/>
						))
			}
			{part(() => {
				const notice = model.shownNotice();
				return (
					notice && (
						<text key="notice" text={sanitizeErrorLine(notice, NATIVE_LINE_WIDTH)} tone="error" truncate="end" />
					)
				);
			})}
			{part(() => model.sendable && field)}
			{part(() => (
				<Stats model={model} />
			))}
			{part(() => {
				const hints: KeyHint[] = [];
				if (model.sendable) hints.push({ keys: actionKbd("tui.input.submit", "enter"), label: "send" });
				hints.push({ keys: (model.deps.expandKeys[0] ?? "ctrl+o").split("+"), label: "expand" });
				return <Hints hints={hints} />;
			})}
		</card>
	);
}
