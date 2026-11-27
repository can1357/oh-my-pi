/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The standalone model browser: a search field, the model list (keyed
 * `list`, one `item` per model, a `rule` after the Recent block) and the
 * selection's detail (`detail`: name and badges, facts, blurb, then the
 * over-context warning or the current mark and held roles).
 *
 * The host owns the scope ({@link ModelBrowserState.setItems}, roles, MRU,
 * perf) and the callbacks; keys reach the state through the column's
 * `onKey`, native list picks through `select`/`activate` (both pick: a
 * native list highlights on the way), query edits through the field's
 * `edit` events. The terminal look is `omp.model-browser`
 * (`styles/pickers/model-browser`).
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { For, type JSXNode } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspSpan, TspText } from "@oh-my-pi/pi-wire";
import {
	formatCostDetail,
	heldRoles,
	isFreeModel,
	type ModelBrowserItem,
	nextCreditRateNote,
	previewPrice,
	type RoleAssignment,
	roleChipLabel,
} from "../../../modes/view-model/overlays/model-browser";
import { getConfiguredThinkingLevelMetadata } from "../../../thinking/levels";
import { thinkingLevelGlyph } from "../../../utils/render-utils";
import "../../styles/pickers/model-browser";
import type { ModelBrowserTerm } from "../../styles/pickers/model-browser";
import { applyEdit } from "../panels/common";
import {
	flatDescription,
	formatTps,
	formatTtft,
	glyph,
	intelligenceOf,
	isSeparator,
	type ModelBrowserState,
	type RoleChip,
	tokenCount,
} from "./model-browser-state";

/** Detail chips as spans: the current mark, then each held role (auto-selected ones hollow and dim). */
export function roleChipSpans(current: boolean, roles: readonly RoleChip[]): TspSpan[] {
	const spans: TspSpan[] = [];
	if (current) spans.push({ s: "success", t: `${glyph("status.enabled")} current` });
	for (const role of roles) {
		if (spans.length > 0) spans.push({ s: "dim", t: " · " });
		spans.push(
			role.auto
				? { s: "dim", t: `${glyph("status.shadowed")} ${role.label}` }
				: { s: role.color ?? "muted", t: `${glyph("status.enabled")} ${role.label}` },
		);
		const level = thinkingLevelGlyph(glyph, role.level);
		if (level) spans.push({ s: "dim", t: ` ${level}` });
	}
	return spans;
}

function itemLabel(browser: ModelBrowserState, item: ModelBrowserItem, showProvider: boolean): TspSpan[] {
	const label: TspSpan[] = [];
	if (showProvider) label.push({ s: "dim", t: `${item.provider}/` });
	label.push(item.labelColor ? { s: item.labelColor, t: item.id } : { t: item.id });
	if (item.selector === browser.currentSelector) label.push({ s: "success", t: ` ${glyph("status.enabled")}` });
	return label;
}

/** One model row of the native list. */
function ModelItem(props: { browser: ModelBrowserState; item: ModelBrowserItem }): JSXNode {
	const { browser, item } = props;
	const row = () => browser.rowView(item);
	const metrics = (): string => {
		const view = row();
		return [
			view.intelligence === undefined ? "" : `${glyph("icon.intelligence")} ${view.intelligence}`,
			view.perf.full,
			view.ctx === undefined ? "" : `${view.ctx} ${glyph("icon.context")}`,
			view.cost,
		]
			.filter(Boolean)
			.join("  ");
	};
	return (
		<item
			key={item.selector}
			label={() => itemLabel(browser, item, browser.showProvider)}
			value={() => [{ s: "dim", t: metrics() }]}
			detail={() => {
				const over = row().overContext;
				return over ? [{ s: "warning", t: `${glyph("status.disabled")} context>${over}` }] : undefined;
			}}
			tone={() => (row().overContext ? "muted" : undefined)}
		/>
	);
}

/** The selection's detail children. */
function detailChildren(browser: ModelBrowserState): JSXNode[] {
	const selected = browser.selected();
	if (!selected) return [];
	const model = selected.model;
	const children: JSXNode[] = [
		<row gap="sm" align="center" wrap>
			<text spans={[{ s: "strong", t: model.name }]} />
			{model.isNew ? <badge text="new" tone="accent" /> : null}
			{model.isBeta ? <badge text="beta" tone="warning" /> : null}
			{model.isRecommended ? <badge text="recommended" tone="success" /> : null}
		</row>,
		<text
			spans={[{ s: "muted", t: browser.detailFacts(selected, { badges: false, description: false }).join(" · ") }]}
			wrap="word"
		/>,
	];
	const description = flatDescription(model.description);
	if (description) children.push(<text spans={[{ s: "dim", t: description }]} wrap="word" lines={2} />);
	if (browser.isOverContext(selected)) {
		const warning = `${glyph("status.disabled")} context ${tokenCount(browser.contextTokens)} exceeds ${tokenCount(model.contextWindow ?? 0)} limit · compacts with current model, then switches`;
		children.push(<text spans={[{ s: "warning", t: warning }]} wrap="word" />);
	} else {
		const chips = roleChipSpans(selected.selector === browser.currentSelector, browser.roleChips(model));
		if (chips.length > 0) children.push(<text spans={chips} wrap="word" />);
	}
	return children;
}

/** The browser's native tree, drawn in the terminal by the `omp.model-browser` look. */
export function ModelBrowser(props: { browser: ModelBrowserState }): JSXNode {
	const browser = props.browser;
	const term: ModelBrowserTerm = { role: "omp.model-browser", browser };
	return (
		<col gap="sm" term={term} onKey={key => browser.handleKey(key)}>
			<row align="center" gap="sm">
				<text spans={[{ s: "accent", t: glyph("icon.search") }]} />
				<input
					cursor={() => browser.cursor}
					prompt="> "
					sendable={false}
					text={() => browser.query}
					onEdit={edit => {
						const next = applyEdit({ text: browser.query, cursor: browser.cursor }, edit);
						if (next) browser.editQuery(next);
					}}
				/>
			</row>
			<list
				key="list"
				role="omp.model-browser.list"
				selected={() => browser.pickerSelected}
				filter={() => browser.query.trim() || undefined}
				empty={() => {
					if (browser.visible.length > 0) return undefined;
					const text =
						browser.emptyNote?.trim() ||
						(browser.query.trim() ? "No matching models" : "No models available in this scope");
					return [{ s: "muted", t: text }];
				}}
				virtual
				grow={1}
				onSelect={id => browser.routePickerItem(id, true)}
				onActivate={id => browser.routePickerItem(id, true)}
			>
				<For each={() => browser.visible}>
					{row => (isSeparator(row) ? <rule key="separator" /> : <ModelItem browser={browser} item={row} />)}
				</For>
			</list>
			<col key="detail" role="omp.model-browser.detail" gap="none">
				{() => detailChildren(browser)}
			</col>
		</col>
	);
}

/** A role badge of the preview: on (accent) when the model holds it, muted when auto-selected, its state as tooltip. */
function roleBadge(browser: ModelBrowserState, role: string, assignment: RoleAssignment | undefined): JSXNode {
	const info = browser.source.getRoleInfo(role);
	const level =
		assignment && assignment.thinkingLevel !== ThinkingLevel.Inherit
			? getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label
			: undefined;
	return (
		<badge
			text={roleChipLabel(role, browser.source)}
			tone={assignment ? (assignment.autoSelected ? "muted" : "accent") : undefined}
			title={
				assignment
					? `${info.name}${assignment.autoSelected ? " (auto-selected)" : ""}${level ? ` · thinking ${level}` : ""}`
					: `${info.name}: not assigned`
			}
		/>
	);
}

/**
 * A model's preview (picker sheets' side pane): `full` is the title, the
 * copyable id, badges, a fact grid, every role the model can fill (held
 * ones on) and its description; `compact` one inline fact line and the held
 * roles. `current` marks the session's model.
 */
export function modelPreview(
	browser: ModelBrowserState,
	item: ModelBrowserItem,
	mode: "full" | "compact",
	current: string | undefined,
): JSXNode[] {
	const model = item.model;
	const ctx = model.contextWindow ?? 0;
	const out = model.maxTokens ?? 0;
	const free = isFreeModel(model);
	const warning = browser.isOverContext(item) ? (
		<text
			spans={[
				{
					s: "warning",
					t: `Context ${tokenCount(browser.contextTokens)} exceeds the ${tokenCount(ctx)} limit · compacts with the current model, then switches`,
				},
			]}
			wrap="word"
		/>
	) : null;
	const held = heldRoles(model, browser.roles, browser.source);
	if (mode === "compact") {
		const facts: { k: TspText; v: TspText }[] = [];
		if (ctx > 0) facts.push({ k: "ctx", v: tokenCount(ctx) });
		if (out > 0) facts.push({ k: "out", v: tokenCount(out) });
		facts.push({ k: "price", v: free ? "free" : formatCostDetail(model) });
		const credits = nextCreditRateNote(model);
		if (credits) facts.push({ k: "then", v: credits });
		facts.push({ k: "reasoning", v: model.reasoning ? "yes" : "no" });
		const chips: JSXNode[] = [];
		if (item.selector === current) chips.push(<badge text="current" tone="success" />);
		for (const { role, assignment } of held) chips.push(roleBadge(browser, role, assignment));
		return [
			<kv items={facts} layout="inline" />,
			chips.length > 0 ? (
				<row gap="xs" wrap>
					{chips}
				</row>
			) : null,
			warning,
		].filter((node): node is JSXNode => node !== null);
	}
	const badges: JSXNode[] = [];
	if (item.selector === current) badges.push(<badge text="current" tone="success" />);
	if (model.isNew) badges.push(<badge text="new" tone="accent" />);
	if (model.isBeta) badges.push(<badge text="beta" tone="warning" />);
	if (model.isRecommended) badges.push(<badge text="recommended" tone="success" />);
	if (model.reasoning) badges.push(<badge text="reasoning" />);
	if (model.input.includes("image")) badges.push(<badge text="vision" />);
	const measured = browser.measured(item);
	const speed: string[] = [];
	if (measured) {
		speed.push(`${formatTps(measured.perf.tps).replace("t/s", " t/s")}${measured.tier ? ` ${measured.tier}` : ""}`);
		if (measured.perf.ttftMs !== null) speed.push(`${formatTtft(measured.perf.ttftMs).replace("s", " s")} TTFT`);
		speed.push(`${measured.perf.samples} ${measured.perf.samples === 1 ? "sample" : "samples"}`);
	} else if (model.tps != null && Number.isFinite(model.tps) && model.tps > 0) {
		speed.push(`~${formatTps(model.tps).replace("t/s", " t/s")} (catalog)`);
	}
	const facts: { k: TspText; v: TspText }[] = [];
	const fact = (k: string, v: string | undefined): void => {
		if (v) facts.push({ k: [{ s: "muted", t: k }], v: [{ s: "mono", t: v }] });
	};
	fact("Context", ctx > 0 ? ctx.toLocaleString("en-US") : undefined);
	const compaction = browser.source.compactionPointFor?.(model);
	if (compaction) {
		const value =
			compaction.tokens === undefined
				? "off"
				: `${compaction.tokens.toLocaleString("en-US")}${compaction.basis !== undefined ? ` · ${compaction.basis}` : ""}`;
		facts.push({
			k: [{ s: "muted", t: "Compacts at" }],
			v: [
				{ s: "mono", t: value },
				{ s: "dim", t: ` · ${compaction.source}` },
			],
		});
	}
	fact("Max output", out > 0 ? out.toLocaleString("en-US") : undefined);
	fact("Price", free ? "free" : `${previewPrice(model)} per M`);
	fact("Speed", speed.length > 0 ? speed.join(" · ") : undefined);
	fact("Intelligence", intelligenceOf(model) === undefined ? undefined : String(intelligenceOf(model)));
	fact("Input", model.input.join(" · "));
	fact("Reasoning", model.reasoning ? "yes" : "no");
	const heldBy = new Map(held.map(entry => [entry.role, entry.assignment]));
	const roles: JSXNode[] = [];
	for (const role of browser.source.knownRoleIds) {
		const info = browser.source.getRoleInfo(role);
		if (info.hidden || !info.accepts(model)) continue;
		roles.push(roleBadge(browser, role, heldBy.get(role)));
	}
	const description = model.description ? sanitizeText(model.description).trim() : "";
	const children: (JSXNode | null)[] = [
		<text role="omp.picker.title" text={model.name} />,
		<text
			spans={[{ s: "mono", t: item.selector }]}
			actions={{ click: "copy" }}
			title="Copy model id"
			truncate="middle"
		/>,
		badges.length > 0 ? (
			<row gap="xs" wrap>
				{badges}
			</row>
		) : null,
		<kv items={facts} />,
		warning,
		roles.length > 0 ? (
			<section head="Roles">
				<row gap="xs" wrap>
					{roles}
				</row>
			</section>
		) : null,
		description ? <md text={description} /> : null,
	];
	return children.filter((node): node is JSXNode => node !== null);
}
