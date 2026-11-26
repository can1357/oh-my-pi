/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The extension control center as a `picker` sheet: provider scopes, the
 * inventory as rows grouped by kind (a kind column once filtered or scoped
 * to a provider), the inspector as the side preview, and Toggle / Expand /
 * Close actions. The terminal draws it as a box (role look
 * `omp.extensions`); the list and the inspector also draw alone.
 */
import * as os from "node:os";
import type { JSXNode, UiNode } from "@oh-my-pi/pi-tui";
import type { TspPickerAction, TspPickerScope, TspSpan, TspText } from "@oh-my-pi/pi-wire";
import {
	sanitizeDisplayField,
	sanitizeDisplayLine,
	sanitizeDisplayLineField,
	sanitizeDisplayText,
} from "../../../extensibility/inventory/display-text";
import type { MCPConnectionHealth, MCPRuntimeCatalogItem } from "../../../extensibility/inventory/mcp-runtime";
import { snapshotMcpRuntime } from "../../../extensibility/inventory/mcp-runtime";
import { type Extension, isShadowedExtension } from "../../../extensibility/inventory/types";
import { shortenPath } from "../../../utils/render-utils";
import "../../styles/panels/extensions";
import { stableKey } from "../pickers/format";
import type { ExtensionInspectorModel } from "./extension-inspector-model";
import type { ExtensionListModel } from "./extension-list-model";
import type { ExtensionDashboardModel, InspectorScrollRequest } from "./extensions-dashboard-model";
import {
	CATALOG_ITEMS,
	catalogWindow,
	commandData,
	contentData,
	DESCRIPTION_LINES,
	enablementLabel,
	hookData,
	INLINE_ARGS,
	isDiscoveredMcpServer,
	LIST_ITEMS,
	liveToolsFor,
	mcpHealthLabel,
	PREVIEW_LINES,
	ruleData,
	skillData,
	snapshotTools,
	type ToolParam,
	toolData,
	toolParams,
} from "./extensions-data";
import { pickerAction } from "../pickers/select-sheet";
import { interruptKbd } from "../../keys/hints";

const MCP_HEALTH_STYLE: Record<MCPConnectionHealth, string> = {
	connected: "success",
	connecting: "muted",
	disconnected: "dim",
	inactive: "warning",
};
const MCP_HEALTH_GLYPH: Record<MCPConnectionHealth, string> = {
	connected: "status.enabled",
	connecting: "status.running",
	disconnected: "status.shadowed",
	inactive: "status.disabled",
};

type Pair = readonly [string, TspText | undefined];

/** A `kv` of label/value pairs with muted labels (empty values skipped); nothing when none is left. */
function Facts(props: { readonly pairs: readonly Pair[]; readonly nodeKey?: string }): JSXNode {
	const items = props.pairs
		.filter((pair): pair is readonly [string, TspText] => pair[1] !== undefined)
		.map(([label, value]) => ({ k: [{ s: "muted", t: label }], v: value }));
	return items.length > 0 ? <kv key={props.nodeKey} items={items} /> : undefined;
}

function hasFacts(pairs: readonly Pair[]): boolean {
	return pairs.some(pair => pair[1] !== undefined);
}

function Section(props: { readonly head: string; readonly children?: JSXNode }): JSXNode {
	return (
		<section key={stableKey(`section:${props.head}`)} head={[{ s: "muted", t: props.head }]}>
			{props.children}
		</section>
	);
}

/** The inspector's preview nodes: identity, facts, prose, kind sections, contents, config. */
export function inspectorPreview(
	inspector: ExtensionInspectorModel,
	expandGlyph: string,
	glyph: (key: string) => string,
	scroll?: InspectorScrollRequest,
): JSXNode[] {
	const ext = inspector.extension;
	if (!ext)
		return [<text wrap="word" scroll={scroll} spans={[{ s: "muted", t: "Select an extension to view details" }]} />];
	const expanded = inspector.expanded;
	const more = (hidden: number, noun: string) => (
		<text spans={[{ s: "dim", t: `… ${hidden} more ${noun} (${expandGlyph} to expand)` }]} />
	);
	const shortText = (value: string | undefined, key: string) => {
		const cleaned = sanitizeDisplayField(value);
		return cleaned ? (
			<text
				key={key}
				text={sanitizeDisplayText(cleaned)}
				wrap="word"
				lines={expanded ? undefined : DESCRIPTION_LINES}
			/>
		) : undefined;
	};
	const paramsNode = (list: ToolParam[]) =>
		list.length === 0 ? (
			<text spans={[{ s: "dim", t: "(no arguments)" }]} />
		) : (
			<kv
				items={list.map(param => ({
					k: [{ s: "accent mono", t: param.name }],
					v: [
						{ s: "muted", t: param.type },
						{ s: param.required ? "warning" : "dim", t: `  ${param.flag}` },
						...(param.description ? [{ t: `  ${sanitizeDisplayLine(param.description)}` }] : []),
					],
				}))}
			/>
		);
	const catalogEntry = (
		name: string,
		title: string | undefined,
		description: string | undefined,
		parameters: unknown,
	) => {
		const list = toolParams(parameters);
		const spans: TspSpan[] = [{ s: "accent mono", t: sanitizeDisplayLine(name) }];
		if (title && title !== name) spans.push({ s: "muted", t: `  ${sanitizeDisplayLine(title)}` });
		return (
			<col gap="xs">
				<text spans={spans} />
				{description && <text text={sanitizeDisplayText(description)} wrap="word" />}
				{expanded || list.length <= INLINE_ARGS ? (
					paramsNode(list)
				) : (
					<text spans={[{ s: "dim", t: `${list.length} args (${expandGlyph} to expand)` }]} />
				)}
			</col>
		);
	};
	const nameList = (head: string, entries: MCPRuntimeCatalogItem[]) => {
		const { shown, hidden } = catalogWindow(entries, expanded ? entries.length : CATALOG_ITEMS);
		return (
			<Section head={head}>
				{shown.map(entry => (
					<text spans={[{ s: "accent mono", t: entry.name }]} />
				))}
				{hidden > 0 && more(hidden, "")}
			</Section>
		);
	};
	const list = (items: string[] | undefined): TspSpan[] | undefined => {
		if (!items?.length) return undefined;
		const shown = items.slice(0, expanded ? items.length : LIST_ITEMS).map(item => sanitizeDisplayText(item));
		const spans: TspSpan[] = [{ s: "accent", t: shown.join("\n") }];
		if (items.length > shown.length)
			spans.push({ s: "dim", t: `\n… ${items.length - shown.length} more (${expandGlyph} to expand)` });
		return spans;
	};

	// The kind's view: runtime facts, description, guidance, sections, contents, config.
	let title: string | undefined;
	let description: string | undefined = ext.description;
	let guidance: string | undefined;
	let runtime: Pair[] = [];
	let health = false;
	let sections: JSXNode[] = [];
	let preview: { heading: string; text: string } | undefined;
	let config: Pair[] = [];
	switch (ext.kind) {
		case "mcp": {
			description = undefined;
			if (isShadowedExtension(ext)) {
				const command =
					isDiscoveredMcpServer(ext.raw) && ext.raw.command
						? shortenPath(sanitizeDisplayText(ext.raw.command), os.homedir())
						: undefined;
				config = [["Command", command ? [{ s: "mono", t: command }] : undefined]];
				break;
			}
			const snap = isDiscoveredMcpServer(ext.raw)
				? snapshotMcpRuntime(ext.raw, inspector.mcpSource, { enabled: ext.state !== "disabled" })
				: undefined;
			const state: MCPConnectionHealth = snap?.health ?? "disconnected";
			runtime = [
				[
					"Health",
					[
						{ s: MCP_HEALTH_STYLE[state], t: `${glyph(MCP_HEALTH_GLYPH[state])} ${mcpHealthLabel(state)}` },
						{ s: "muted", t: `  ${snap?.transport ?? "stdio"}` },
					],
				],
			];
			if (snap?.implementationName) {
				runtime.push([
					"Server",
					[
						{
							s: "dim",
							t: `${snap.implementationName}${snap.implementationVersion ? ` ${snap.implementationVersion}` : ""}`,
						},
					],
				]);
				if (snap.websiteUrl) runtime.push(["Website", [{ s: "dim", t: snap.websiteUrl, href: snap.websiteUrl }]]);
			}
			health = true;
			title = snap?.title;
			description = snap?.description;
			guidance = snap?.instructions;
			if (snap && snap.tools.length > 0) {
				const { shown, hidden } = catalogWindow(snap.tools, expanded ? snap.tools.length : CATALOG_ITEMS);
				sections.push(
					<Section head="Tools">
						{shown.map(tool => catalogEntry(tool.name, tool.title, tool.description, tool.parameters))}
						{hidden > 0 && more(hidden, "tools")}
					</Section>,
				);
			}
			if (snap && snap.resources.length > 0) sections.push(nameList("Resources", snap.resources));
			if (snap && snap.prompts.length > 0) sections.push(nameList("Prompts", snap.prompts));
			config = [
				["Command", snap?.command ? [{ s: "mono", t: shortenPath(snap.command, os.homedir()) }] : undefined],
				["URL", snap?.url ? [{ s: "mono", t: snap.url, href: snap.url }] : undefined],
				["Args", snap?.args?.length ? [{ s: "mono dim", t: snap.args.join(" ") }] : undefined],
				["Env vars", snap && snap.envCount > 0 ? [{ s: "dim", t: `${snap.envCount} defined` }] : undefined],
			];
			break;
		}
		case "tool": {
			const lives = liveToolsFor(ext, snapshotTools(inspector.toolSource));
			const data = toolData(ext, lives, inspector.source);
			description = data.description;
			if (data.factory.length > 1) {
				sections = [
					<Section head="Tools">
						{data.factory.map(tool => catalogEntry(tool.name, tool.label, tool.description, tool.parameters))}
					</Section>,
				];
			} else if (lives.length > 0 || data.params.length > 0) {
				title = data.label;
				sections = [<Section head="Arguments">{paramsNode(data.params)}</Section>];
			}
			break;
		}
		case "rule": {
			const data = ruleData(ext, inspector.source);
			description = data.description;
			const applies: Pair[] = [
				["always", data.alwaysApply ? [{ s: "accent", t: "always" }] : undefined],
				["globs", data.globs?.join(", ")],
				["condition", list(data.condition)],
				["ast", list(data.astCondition)],
				["scope", list(data.scope)],
				["agents", list(data.agents)],
				["interrupt", data.interruptMode ? [{ s: "dim", t: data.interruptMode }] : undefined],
			];
			sections = [
				<Section head="Applies">
					{hasFacts(applies) ? (
						<Facts pairs={applies} />
					) : (
						<text spans={[{ s: "dim", t: "(no apply conditions)" }]} />
					)}
				</Section>,
			];
			preview = { heading: "Rule", text: data.content };
			break;
		}
		case "skill": {
			const data = skillData(ext);
			description = data.description;
			if (data.hidden)
				runtime = [
					["Visibility", [{ s: "warning", t: "hidden" }, { t: "  omitted from the system-prompt skill list" }]],
				];
			const surface: Pair[] = [
				["apply", data.alwaysApply ? [{ s: "accent", t: "always apply" }] : undefined],
				["globs", data.globs?.join(", ")],
			];
			if (hasFacts(surface)) sections = [<Facts nodeKey="surface" pairs={surface} />];
			preview = { heading: "Instruction", text: data.content };
			break;
		}
		case "slash-command": {
			const data = commandData(ext);
			description = data.description;
			const hint: Pair[] = [
				["hint", data.argumentHint ? [{ s: "dim", t: sanitizeDisplayText(data.argumentHint) }] : undefined],
			];
			sections = [
				<Section head="Invocation">
					<text spans={[{ s: "accent mono", t: `/${sanitizeDisplayText(ext.name)}` }]} />
					{hasFacts(hint) && <Facts pairs={hint} />}
					{data.usesArguments && <text spans={[{ s: "dim", t: "accepts $ARGUMENTS" }]} />}
				</Section>,
			];
			preview = { heading: "Template", text: data.body };
			break;
		}
		case "hook": {
			const data = hookData(ext);
			const facts: Pair[] = [
				["when", data.hookType],
				["tool", data.tool],
			];
			sections = [<Section head="Hook">{hasFacts(facts) && <Facts pairs={facts} />}</Section>];
			break;
		}
		case "prompt":
		case "context-file":
			preview = { heading: ext.kind === "prompt" ? "Prompt" : "Preview", text: contentData(ext).content };
			break;
		case "instruction": {
			const data = contentData(ext);
			if (data.applyTo)
				sections = [
					<Section head="Applies">
						<Facts pairs={[["files", data.applyTo]]} />
					</Section>,
				];
			preview = { heading: "Instruction", text: data.content };
			break;
		}
		default:
			if (ext.trigger)
				sections = [
					<Section head="Trigger">
						<text spans={[{ s: "accent mono", t: sanitizeDisplayText(ext.trigger) }]} />
					</Section>,
				];
	}

	const name = sanitizeDisplayLine(ext.displayName);
	const subtitle = sanitizeDisplayLineField(title);
	const level = ext.source.level === "user" ? "User" : ext.source.level === "project" ? "Project" : "Native";
	const filePath = sanitizeDisplayText(ext.path);
	const facts: Pair[] = [
		...runtime,
		["Status", health && ext.state === "active" ? undefined : status(ext, glyph)],
		["Origin", `via ${sanitizeDisplayLine(ext.source.providerName)} (${level})`],
		[
			"Path",
			[
				{
					s: "path dim",
					t: sanitizeDisplayText(shortenPath(ext.path, os.homedir())),
					...(filePath.startsWith("/") ? { href: `file://${filePath}` } : {}),
				},
			],
		],
	];
	const out: JSXNode[] = [
		<text key="title" text={name} role="omp.picker.title" scroll={scroll} />,
		subtitle && subtitle !== name && <text key="subtitle" spans={[{ s: "muted", t: subtitle }]} />,
		<Facts nodeKey="facts" pairs={facts} />,
		shortText(description, "description"),
		shortText(guidance, "guidance"),
		...sections,
	];
	if (preview) {
		if (!preview.text)
			out.push(<Section head={preview.heading}>{<text spans={[{ s: "dim", t: "(empty)" }]} />}</Section>);
		else {
			const lines = sanitizeDisplayText(preview.text).split("\n");
			const cut = !expanded && lines.length > PREVIEW_LINES;
			const shown = cut ? lines.slice(0, PREVIEW_LINES - 1) : lines;
			out.push(
				<Section head={preview.heading}>
					<code text={shown.join("\n")} lang="md" wrap />
					{cut && more(lines.length - shown.length, "lines")}
				</Section>,
			);
		}
	}
	out.push(<Facts nodeKey="config" pairs={config} />);
	return out.filter(Boolean);
}

function status(ext: Extension, glyph: (key: string) => string): TspSpan[] {
	switch (ext.state) {
		case "active":
			return [{ s: "success", t: `${glyph("status.enabled")} ${enablementLabel(ext.state)}` }];
		case "disabled":
			return [{ s: "dim", t: `${glyph("status.disabled")} ${enablementLabel(ext.state, ext.disabledReason)}` }];
		case "shadowed":
			return [
				{
					s: "warning",
					t: `${glyph("status.shadowed")} ${enablementLabel(ext.state, ext.disabledReason, ext.shadowedBy)}`,
				},
			];
	}
}

/** Up to two initials of a provider label, for its scope mark. */
function initials(label: string): string {
	return label
		.split(/[\s()_-]+/)
		.filter(word => word.length > 0)
		.slice(0, 2)
		.map(word => word[0]?.toUpperCase() ?? "")
		.join("");
}

export function ExtensionDashboard(props: { readonly model: ExtensionDashboardModel }): JSXNode {
	const model = props.model;
	const rev = model.rev;
	const view = () => (rev(), model.list.rev(), model.inspector.rev(), model.list.pickerView());
	const root = (
		<picker
			term={() => ({ role: "omp.extensions", dashboard: model, rev: rev() })}
			title="Extension Control Center"
			icon="extension"
			noun="extensions"
			size="lg"
			layout="rows"
			preview="side"
			query={() => (rev(), model.list.rev(), model.list.search.text)}
			cursor={() => (rev(), model.list.rev(), model.list.search.cursor)}
			placeholder="Search extensions…"
			scopes={() => {
				rev();
				return model.tabs.map((tab): TspPickerScope => {
					if (tab.id === "all") return { id: tab.id, label: "All", icon: "extension", count: tab.count };
					const emptyEnabled = tab.count === 0 && tab.enabled;
					return {
						id: tab.id,
						label: tab.label,
						mark: { text: initials(tab.label), seed: tab.id },
						count: tab.count,
						group: "Providers",
						dot: !tab.enabled ? "muted" : emptyEnabled ? "warning" : "success",
						disabled: emptyEnabled ? "No extensions" : undefined,
					};
				});
			}}
			scope={() => (rev(), model.tabs[model.activeTab]?.id ?? "all")}
			columns={() => (view().grouped ? undefined : [{ id: "kind", format: "dim", priority: 1 }])}
			items={() => view().items}
			order={() => view().order}
			hits={() => view().hits}
			selected={() => view().selected}
			total={() => (rev(), model.tabFiltered.length)}
			empty="No extensions found for this provider."
			actions={() => {
				rev();
				model.list.rev();
				model.inspector.rev();
				const selected = model.list.selectedSwitch();
				const expanded = model.inspector.expanded;
				return [
					{
						id: "toggle",
						label: "Toggle",
						keys: ["space"],
						primary: true,
						on: selected?.on,
						disabled: selected ? selected.blocked : "Select an extension",
					},
					{
						id: "expand",
						label: expanded ? "Collapse" : "Expand",
						keys: model.expandKey.split("+"),
						on: expanded,
					},
					pickerAction("close", "Close", interruptKbd(), { end: true }),
				] satisfies TspPickerAction[];
			}}
			focus="list"
			onKey={key => {
				model.key(key.id, key.text);
				return true;
			}}
			onEvent={event => {
				if (event.type === "select" || event.type === "activate") model.event(event.type, event.item);
				else if (event.type === "action") model.event("action", event.value, event.act);
			}}
		>
			{() => {
				rev();
				model.inspector.rev();
				return inspectorPreview(
					model.inspector,
					model.expandGlyph,
					key => model.terminal.theme().symbols.symbol(key),
					model.nativeScroll,
				);
			}}
		</picker>
	) as UiNode;
	return root;
}

/** The inventory list drawn alone (its terminal face). */
export function ExtensionListView(props: { readonly list: ExtensionListModel }): JSXNode {
	return (
		<col
			term={() => ({ role: "omp.extensions.list", list: props.list, rev: props.list.rev() })}
			onKey={key => {
				props.list.key(key.id, key.text);
				return true;
			}}
		/>
	);
}

/** The inspector drawn alone (its terminal face). */
export function ExtensionInspectorView(props: { readonly inspector: ExtensionInspectorModel }): JSXNode {
	return (
		<col
			term={() => ({ role: "omp.extensions.inspector", inspector: props.inspector, rev: props.inspector.rev() })}
		/>
	);
}
