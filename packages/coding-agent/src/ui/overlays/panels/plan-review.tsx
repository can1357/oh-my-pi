/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The plan review: the plan as an editable, commentable document beside its
 * Contents (while it has no comments), the decision dock (an Approve split
 * button that turns into Refine once the plan has feedback, its menu holding
 * every approval choice; the model chip; Save; Cancel), then the key hints,
 * the note editor or the note chooser. Once a choice is committed the dock
 * gives way to a "submitting" spinner while the owner works.
 *
 * The terminal draws it as one fullscreen box (role look `omp.planReview`)
 * and drives it with keys: see {@link PlanReviewModel}.
 */
import { computed, type JSXNode, type KeyEvent, type UiNode, untrack } from "@oh-my-pi/pi-tui";
import type { TspMenuItem } from "@oh-my-pi/pi-wire";
import { sanitizeStatusText } from "../../../modes/view-model/chrome/shared";
import { findNode } from "../../styles/panels/common";
import "../../styles/panels/plan-review";
import { feedField, type KeycapHint, KeycapHints } from "./common";
import { annotationWhere } from "./plan-review-frame";
import type { PlanReviewModel } from "./plan-review-model";
import type { SheetAttributes } from "../sheet";

const UP_DOWN = [["up"], ["down"]];

const keysOf = (id: string): string[] => id.split("+");

/** Tern's sheet: a large centered one titled by the plan's own title heading (the body never repeats it). */
export function planReviewSheet(model: PlanReviewModel): SheetAttributes {
	return {
		role: "omp.overlay.planReview",
		size: "lg",
		anchor: "center",
		head: () => {
			model.rev();
			const heading = model.sections[model.titleIndex]?.title;
			return heading ? sanitizeStatusText(heading) : "Plan review";
		},
	};
}

export function PlanReview(props: { readonly model: PlanReviewModel }): JSXNode {
	const model = props.model;
	const rev = model.rev;
	/** The note editor's field, when open (resolving the tree builds it). */
	const editorNode = (): UiNode | undefined =>
		untrack(() => model.annotating) ? findNode(root, node => node.kind === "editor") : undefined;

	const onKey = (key: KeyEvent): boolean => {
		if (model.key(key.id, key.text, key.raw)) return true;
		const field = editorNode();
		if (field) feedField(field, { key }, edit => model.editDraft(edit));
		return true;
	};

	const sidebar = computed(() => (rev(), model.sidebarShown()));
	const footerMode = computed(() => {
		rev();
		if (model.committed) return "committed";
		if (model.chooser) return "chooser";
		return model.annotating ? "note" : "hints";
	});

	const doc = () => (
		<col key="body" role="omp.plan.body" grow={1}>
			<doc
				key="doc"
				role="omp.plan.doc"
				text={() => (rev(), model.docText())}
				edit
				comment
				comments={() => (rev(), model.docComments())}
				jump={() => {
					rev();
					const jump = model.currentJump();
					if (!jump) return undefined;
					let heading = 0;
					for (let i = 0; i < Math.min(jump.section, model.sections.length); i++) {
						if (model.sections[i]!.level >= 1 && i !== model.titleIndex) heading++;
					}
					return { heading, n: jump.n };
				}}
			/>
		</col>
	);

	const toc = () => (
		<list
			key="toc"
			role="omp.plan.toc"
			actions={{ click: "select", dblclick: "activate" }}
			selected={() => {
				rev();
				const section = model.toc[model.currentTocCursor()];
				return section === undefined ? null : `h${section}`;
			}}
		>
			{() => {
				rev();
				return model.toc.map(index => {
					const section = model.sections[index]!;
					const count = section.annotations.length;
					return (
						<item
							key={`h${index}`}
							label={section.title || "(untitled)"}
							value={count > 0 ? [{ s: "warning", t: `✎${count}` }] : undefined}
							role={`omp.plan.toc.depth${section.level - model.tocBaseLevel}`}
						/>
					);
				});
			}}
		</list>
	);

	const dock = () => (
		<row key="dock" role="omp.plan.dock" gap="sm" align="center">
			<buttons key="approve" role="omp.plan.approve" variant="split">
				<button
					key="main"
					text={() => (rev(), model.hasFeedback && model.refine ? "Refine" : "Approve")}
					variant="primary"
					keys={["enter"]}
					actions={() => (rev(), { click: model.hasFeedback && model.refine ? "refine" : "approve" })}
				/>
				<menu
					key="more"
					trigger="primary"
					icon="chev"
					title="Approve options"
					align="start"
					items={() => {
						rev();
						return model.choices.map((choice): TspMenuItem => {
							const detail = choice.detail ?? choice.meta;
							return {
								id: choice.id,
								label: choice.label,
								...(detail ? { detail } : {}),
								...(choice.disabled !== undefined ? { disabled: choice.disabled || true } : {}),
							};
						});
					}}
				/>
			</buttons>
			{model.slider && model.slider.segments.length >= 2 && (
				<menu
					key="model"
					role="omp.plan.model"
					text={() => {
						rev();
						const active = model.slider!.segments[model.sliderIndex]!;
						return active.detail ?? active.label;
					}}
					caret
					title="Model that executes the plan"
					items={() => {
						rev();
						return model.slider!.segments.map((segment, i): TspMenuItem => ({
							id: `tier:${i}`,
							label: segment.label,
							...(segment.detail ? { detail: segment.detail } : {}),
							radio: "tier",
							checked: i === model.sliderIndex,
						}));
					}}
				/>
			)}
			<spacer grow={1} />
			{model.callbacks.onSave && <button key="save" role="omp.btn" text="Save" actions={{ click: "save" }} />}
			<button
				key="cancel"
				role="omp.btn"
				text="Cancel"
				keys={keysOf(model.cancelKey)}
				actions={{ click: "cancel" }}
			/>
		</row>
	);

	const hints = (): KeycapHint[] => {
		rev();
		const out: KeycapHint[] = [];
		if (model.slider) out.push({ keys: [["left"], ["right"]], label: "model" });
		if (model.sidebarShown()) {
			out.push({ keys: UP_DOWN, label: "section" }, { keys: [["d"]], label: "delete section" });
			if (!model.nativeDoc) out.push({ keys: [["a"]], label: "annotate" }, { keys: [["e"]], label: "edit" });
		}
		out.push({ keys: [["u"]], label: "undo" });
		if (model.nativeDoc)
			out.push({ keys: [], label: "double-click to edit" }, { keys: [], label: "select text to comment" });
		return out;
	};

	const chooser = () => [
		<text key="chooserHead" spans={[{ s: "accent strong", t: "Edit annotation" }]} />,
		<list
			key="chooser"
			actions={{ click: "select", dblclick: "activate" }}
			selected={() => (rev(), `c${model.chooser?.selected ?? 0}`)}
		>
			{() => {
				rev();
				return (model.chooser?.entries ?? []).map((ref, i) => {
					const section = model.sections[ref.sectionIndex];
					const annotation = section?.annotations[ref.annotationIndex];
					return (
						<item
							key={`c${i}`}
							label={sanitizeStatusText(annotation?.note ?? "")}
							detail={`${sanitizeStatusText(section?.title || "Plan preamble")} · ${annotation ? annotationWhere(annotation.target) : "section"}`}
						/>
					);
				});
			}}
		</list>,
		<KeycapHints
			nodeKey="chooserHints"
			hints={() => [
				{ keys: UP_DOWN, label: "choose" },
				{ keys: [["enter"]], label: "edit" },
				{ keys: [keysOf(model.cancelKey)], label: "cancel" },
			]}
		/>,
	];

	const feedback = () => (
		<col key="feedback" role="omp.plan.feedback" gap="xs">
			<text
				key="annotateHead"
				truncate="end"
				spans={() => {
					rev();
					const target = model.target;
					const title = sanitizeStatusText(
						(target && model.sections[target.sectionIndex]?.title) || "Plan preamble",
					);
					const location = !target || target.row === null ? `‹${title}›` : `‹${title}› · ${target.context}`;
					return [
						{ s: "muted", t: "Note on " },
						{ s: "accent", t: location },
					];
				}}
			/>
			<col role="omp.field">
				<editor
					key="input"
					text={() => (rev(), model.draft.text)}
					cursor={() => (rev(), model.draft.cursor)}
					maxLines={() => Math.max(1, Math.min(6, model.terminal.size().rows - 12))}
					sendable={false}
				/>
			</col>
			<KeycapHints
				nodeKey="annotateHints"
				hints={() => {
					rev();
					const out: KeycapHint[] = [
						{ keys: [["enter"]], label: "save" },
						{ keys: [["shift", "enter"]], label: "newline" },
						{ keys: [keysOf(model.cancelKey)], label: "cancel" },
					];
					if (model.editing) out.push({ keys: [], label: "empty deletes" });
					if (model.externalEditorLabel) out.push({ keys: [], label: `${model.externalEditorLabel} editor` });
					return out;
				}}
			/>
		</col>
	);

	const root = (
		<col
			gap="md"
			term={() => ({ role: "omp.planReview", review: model, rev: rev() })}
			onKey={onKey}
			onPaste={paste => {
				const field = editorNode();
				if (field) feedField(field, { paste }, edit => model.editDraft(edit));
				return true;
			}}
			onEvent={event => {
				const leaf = event.key.slice(event.key.lastIndexOf("/") + 1);
				switch (event.type) {
					case "docChange":
						return model.docChange(event.text);
					case "comment":
						return model.comment(event.quote, event.at, event.note);
					case "commentNote":
						return model.setNote(event.comment, event.note);
					case "uncomment":
						return model.setNote(event.comment, "");
					case "action":
						return model.action(leaf, event.act);
					case "select":
					case "activate":
						return model.pick(leaf, event.item, event.type === "activate");
					case "edit":
						return model.editDraft(event);
				}
			}}
		>
			{() =>
				sidebar() ? (
					<row key="split" gap="lg" align="start">
						<col key="sidebar" max={{ w: "32ch" }} shrink={0}>
							{toc()}
						</col>
						{doc()}
					</row>
				) : (
					doc()
				)
			}
			{() => {
				switch (footerMode()) {
					case "committed":
						return [
							<spinner
								key="options"
								label={[
									{
										s: "accent strong",
										t: model.committedLabel ? `${model.committedLabel} — submitting…` : "Submitting…",
									},
								]}
							/>,
							<text
								key="footer"
								wrap="word"
								spans={[
									{
										s: "dim",
										t: "Applying your selection — this can take a moment while context is prepared.",
									},
								]}
							/>,
						];
					case "chooser":
						return [dock(), ...chooser()];
					case "note":
						return [dock(), feedback()];
					default:
						return [dock(), <KeycapHints nodeKey="hints" hints={hints} />];
				}
			}}
		</col>
	) as UiNode;
	return root;
}
