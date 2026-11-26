/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The add-MCP-server sheet: the phase strip, the step's title and lead,
 * its body (the field, a status, the review), its choices, and a footer
 * whose buttons run what Escape (Back), Enter (Continue) and Ctrl+C
 * (Cancel) run. The terminal draws the step in a box (role look
 * `omp.mcpAddWizard`); see {@link MCPAddWizardModel}.
 */
import { computed, type JSXNode, type UiNode, untrack } from "@oh-my-pi/pi-tui";
import type { TspSpan, TspText, TspTone } from "@oh-my-pi/pi-wire";
import { findNode, keyGlyph } from "../../styles/panels/common";
import "../../styles/panels/mcp-add-wizard";
import { ActionButton, feedField } from "./common";
import { type MCPAddWizardModel, PHASE_AUTH, PHASES, type WizardStatus } from "./mcp-add-wizard-model";
import { actionKeyId } from "../../keys/hints";

const STATUS_ICON = {
	ok: ["check", "success"],
	warn: ["warn", "warning"],
	error: ["x-circle", "error"],
} as const;

/** How a key reads in a button's tooltip (`esc`, `⏎`, `⌃C`). */
function tooltipKey(id: string): string {
	return id === "escape" ? "esc" : keyGlyph(id);
}

function Button(props: {
	readonly act: string;
	readonly label: string;
	readonly keys: string;
	readonly tone?: TspTone;
}): JSXNode {
	return (
		<ActionButton
			id={props.act}
			label={props.label}
			title={`${props.label}  ${tooltipKey(props.keys)}`}
			tone={props.tone}
			keys={props.keys.split("+")}
		/>
	);
}

function StatusRow(props: { readonly status: WizardStatus }): JSXNode {
	const { status } = props;
	const label = status.label;
	const text: { text?: string; spans?: TspSpan[] } =
		typeof label === "string"
			? { text: label }
			: { spans: label.map((t, i): TspSpan => (i % 2 === 1 ? { s: "mono", t } : { t })) };
	if (status.state === "busy") {
		return (
			<row key={status.key} role="omp.mcpAdd.status" gap="sm" align="center">
				<spinner style="orbit" tone="accent" />
				<text {...text} wrap="word" />
			</row>
		);
	}
	const [icon, tone] = STATUS_ICON[status.state];
	return (
		<row key={status.key} role="omp.mcpAdd.status" tone={tone} gap="sm" align="center">
			<icon name={icon} tone={tone} />
			<text {...text} wrap="word" />
		</row>
	);
}

export function MCPAddWizard(props: { readonly model: MCPAddWizardModel }): JSXNode {
	const model = props.model;
	const rev = model.rev;
	/** The mounted step's identity: the sheet rebuilds when it changes. */
	const shape = computed(() => {
		rev();
		return model.view;
	});

	const progress = () => (
		<row key="progress" role="omp.mcpAdd.progress" gap="xs">
			{PHASES.map((label, index) => (
				<col
					key={label}
					role="omp.mcpAdd.phase"
					tone={() => {
						rev();
						const phase = model.view.phase;
						if (index === phase) return "accent";
						if (index > phase) return "muted";
						return index === PHASE_AUTH && model.authSkipped(phase) ? "neutral" : "success";
					}}
					title={() => (
						rev(),
						index === PHASE_AUTH && model.authSkipped(model.view.phase) ? "Auth · not needed" : undefined
					)}
				>
					<text text={label} />
				</col>
			))}
		</row>
	);

	const body = (): JSXNode[] => {
		const view = model.view;
		switch (view.kind) {
			case "input":
				return [
					<col key="field" role="omp.mcpAdd.field" gap="xs" tone={view.error ? "error" : undefined}>
						<input
							prompt="> "
							text={() => (
								rev(),
								view.secret ? "•".repeat(Array.from(model.field.text).length) : model.field.text
							)}
							cursor={() => (rev(), model.field.cursor)}
							placeholder={view.placeholder}
							sendable={false}
						/>
						{view.error ? (
							<text
								role="omp.mcpAdd.note"
								wrap="word"
								spans={[{ s: "error", t: view.error.replace(/\t/g, "   ") }]}
							/>
						) : (
							view.note && <text role="omp.mcpAdd.note" wrap="word" text={view.note} />
						)}
					</col>,
				];
			case "choice":
				return [
					view.failure && !view.failure.cancelled && (
						<text key="error" role="omp.mcpAdd.error" wrap="word" text={view.failure.message} />
					),
					view.failure?.tip && <text key="tip" role="omp.mcpAdd.note" wrap="word" text={view.failure.tip} />,
				];
			case "async": {
				const statuses = view.statuses.map(status => <StatusRow status={status} />);
				return [
					view.checks ? (
						<col key="checks" role="omp.mcpAdd.checks" gap="sm">
							{statuses}
						</col>
					) : (
						statuses
					),
					view.error !== undefined && <text key="error" role="omp.mcpAdd.error" wrap="word" text={view.error} />,
				];
			}
			case "confirm":
				return [
					<kv
						key="summary"
						role="omp.mcpAdd.summary"
						items={model.summary().map(row => ({ k: row.key, v: row.native satisfies TspText }))}
					/>,
				];
		}
	};

	const choices = () => {
		const view = model.view;
		if (view.kind !== "choice") return undefined;
		return (
			<list key={`choices-${model.step}`} role="omp.mcpAdd.choices" selected={() => (rev(), String(model.selected))}>
				{view.choices.map((choice, index) => (
					<item
						key={String(index)}
						label={choice.label}
						detail={
							choice.description === undefined
								? undefined
								: choice.monoDetail
									? [{ s: "mono", t: choice.description }]
									: choice.description
						}
						icon={choice.icon}
						value={choice.tag ? [{ s: "mono", t: choice.tag }] : undefined}
					/>
				))}
			</list>
		);
	};

	const actions = () => {
		const view = model.view;
		const named = model.step === "name";
		const backKey = view.kind === "input" ? model.cancelKey : actionKeyId("tui.select.cancel", "escape");
		const next =
			view.kind === "input" || view.kind === "choice"
				? "Continue"
				: view.kind === "confirm"
					? "Save server"
					: undefined;
		return (
			<row key="actions" role="omp.actions" gap="sm" align="center">
				<Button act="cancel" label="Cancel" keys={named ? backKey : "ctrl+c"} />
				<spacer grow={1} />
				{!named && <Button act="back" label={view.kind === "async" ? view.back : "Back"} keys={backKey} />}
				{next && (
					<Button
						act="next"
						label={next}
						keys={
							view.kind === "input"
								? actionKeyId("tui.input.submit", "enter")
								: actionKeyId("tui.select.confirm", "enter")
						}
						tone="accent"
					/>
				)}
			</row>
		);
	};

	const head = () => {
		const view = model.view;
		const title = view.kind === "confirm" ? "Review and save" : view.title;
		const lead = view.kind === "confirm" ? "omp connects to the server as soon as it is saved." : view.lead;
		return (
			<col key="head" role="omp.mcpAdd.head" gap="xs">
				<row gap="sm" align="center">
					<text role="omp.mcpAdd.title" wrap="word" text={title} />
					{view.kind === "input" && view.optional && <text role="omp.mcpAdd.tag" text="Optional" />}
				</row>
				{lead && <text role="omp.mcpAdd.lead" wrap="word" text={lead} />}
			</col>
		);
	};

	const fieldNode = (): UiNode | undefined =>
		untrack(() => model.view.kind === "input") ? findNode(root, node => node.kind === "input") : undefined;

	const root = (
		<col
			term={() => ({ role: "omp.mcpAddWizard", wizard: model, rev: rev() })}
			onKey={key => {
				if (model.key(key.id)) return true;
				const field = fieldNode();
				if (field) feedField(field, { key }, edit => model.editField(edit));
				return true;
			}}
			onPaste={paste => {
				model.paste(paste.text);
				return true;
			}}
			onEvent={event => {
				const leaf = event.key.slice(event.key.lastIndexOf("/") + 1);
				if (event.type === "action") model.action(event.act);
				else if (event.type === "select" || event.type === "activate") model.pick(leaf, event.item);
				else if (event.type === "edit") model.editField(event);
			}}
		>
			<overlay key="sheet" role="omp.overlay.mcpAdd" head="Add MCP server" anchor="center" size="md" modal>
				{() => {
					shape();
					return (
						<col gap="lg">
							{progress()}
							{head()}
							{body()}
							{choices()}
							{actions()}
						</col>
					);
				}}
			</overlay>
		</col>
	) as UiNode;
	return root;
}
