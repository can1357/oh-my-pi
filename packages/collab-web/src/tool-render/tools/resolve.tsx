/**
 * `resolve` / `reject` / `propose` — finalize a staged preview (apply/discard)
 * or submit a plan for approval.
 *
 * In collab-web these arrive as `write xd://<device>` calls that `ToolView`
 * unwraps: the card model then lives on the unwrapped inner details
 * (`result.details`) and the device name (`props.name`). Historical top-level
 * `resolve` transcripts instead carried `action`/`reason` on `args`, so read
 * details first and fall back to args. When neither is present yet (a running
 * card), the device name supplies the default action.
 */
import type { ReactNode } from "react";
import type { Tone } from "../parts";
import { Badge, Badges, Kv, KvGrid, Note, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, str, truncate } from "../util";

type ResolveKind = "apply" | "discard" | "propose";

/** Short badge word (summary) and full transition badge (body) per card kind. */
const KIND_WORD: Record<ResolveKind, string> = { apply: "apply", discard: "discard", propose: "propose" };
const KIND_TRANSITION: Record<ResolveKind, string> = {
	apply: "proposed → resolved",
	discard: "proposed → rejected",
	propose: "plan proposed",
};
const KIND_TONE: Record<ResolveKind, Tone> = { apply: "ok", discard: "warn", propose: "accent" };

interface ResolveCard {
	kind: ResolveKind;
	tone: Tone;
	/** Apply/discard reason. */
	reason: string | null;
	/** Source tool that staged the preview (apply/discard). */
	sourceToolName: string | null;
	/** Preview label (apply/discard). */
	label: string | null;
	/** Plan title (propose). */
	title: string | null;
	/** Plan artifact path (propose). */
	planFilePath: string | null;
	/** Free-form extra metadata rows. */
	extra: Record<string, unknown> | null;
}

/** Derive the card model from unwrapped inner details, args fallback, and device name. */
function cardModel({ name, args, result }: ToolRenderProps): ResolveCard {
	const details = detailsRecord(result);
	const explicit = str(details?.action) ?? str(args.action);
	const kind: ResolveKind =
		explicit === "apply" || explicit === "discard"
			? explicit
			: name === "propose"
				? "propose"
				: name === "reject"
					? "discard"
					: "apply";
	const extra = isRecord(args.extra) ? args.extra : details && isRecord(details.extra) ? details.extra : null;
	return {
		kind,
		tone: result?.isError ? "err" : KIND_TONE[kind],
		reason: str(details?.reason) ?? str(args.reason),
		sourceToolName: str(details?.sourceToolName) ?? str(args.sourceToolName),
		label: str(details?.label) ?? str(args.label),
		title: str(details?.title) ?? str(args.title),
		planFilePath: str(details?.planFilePath) ?? str(args.planFilePath),
		extra,
	};
}

function Summary(props: ToolRenderProps): ReactNode {
	const card = cardModel(props);
	const trailing = card.kind === "propose" ? card.title : card.reason;
	return (
		<>
			<Badge tone={card.tone}>{KIND_WORD[card.kind]}</Badge>{" "}
			{trailing && <span>{truncate(normalizeWs(trailing), 100)}</span>}
		</>
	);
}

function Body(props: ToolRenderProps): ReactNode {
	const { result } = props;
	const card = cardModel(props);
	const extraRows: ReactNode[] = [];
	if (card.extra) {
		for (const k in card.extra) {
			const v = card.extra[k];
			let text: string;
			if (typeof v === "string") text = v;
			else {
				try {
					text = JSON.stringify(v) ?? String(v);
				} catch {
					text = String(v);
				}
			}
			extraRows.push(
				<Kv key={k} k={k}>
					{truncate(normalizeWs(text), 200)}
				</Kv>,
			);
		}
	}
	return (
		<>
			<Badges
				items={[
					<Badge key="action" tone={card.tone}>
						{KIND_TRANSITION[card.kind]}
					</Badge>,
					card.sourceToolName && <Badge key="source">{card.sourceToolName}</Badge>,
					card.label && <span key="label">{truncate(normalizeWs(card.label), 120)}</span>,
					card.kind === "propose" && card.title && (
						<span key="title">{truncate(normalizeWs(card.title), 120)}</span>
					),
				]}
			/>
			{card.kind !== "propose" && card.reason && <Note>{card.reason}</Note>}
			{card.kind === "propose" && card.planFilePath && (
				<KvGrid>
					<Kv k="plan">{card.planFilePath}</Kv>
				</KvGrid>
			)}
			{extraRows.length > 0 && <KvGrid>{extraRows}</KvGrid>}
			<ResultText result={result} maxLines={6} />
		</>
	);
}

export const resolveRenderer: ToolRenderer = { Summary, Body };
