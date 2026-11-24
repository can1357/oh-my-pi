/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Plugin settings: the installed plugins (npm and marketplace) and, for one
 * plugin, its on/off switch, feature toggles and manifest settings.
 *
 * {@link createPluginSettings} owns the navigation (list → detail → back),
 * the async loads, every value write and the keys. Each view is a panel card
 * (`omp.overlay.plugin-settings`): its native children describe it to a Tern
 * terminal; `term.blocks` carry its terminal look. The settings window shows
 * the same views as its Plugins page (`prefs` rows natively).
 */
import {
	type Accessor,
	batch,
	computed,
	type JSXNode,
	type KeyEvent,
	signal,
	type UiEvent,
	type UiNode,
} from "@oh-my-pi/pi-tui";
import type { TspPrefsControl, TspPrefsSection, TspSpan } from "@oh-my-pi/pi-wire";
import type {
	InstalledPlugin,
	InstalledPluginSummary,
	PluginListEntry,
	PluginSettingSchema,
	PluginSettingsHost,
} from "../../../modes/view-model/overlays/plugin-settings";
import { fuzzyFilter } from "../../../utils/fuzzy";
import type { PanelBlock, PanelSetting } from "../../styles/settings/plugins";
import { editLine, type LineState } from "../settings/line-edit";
import type { SettingsPluginsPage, SettingsPluginsPrefs } from "../settings/settings";
import "../../styles/settings/plugins";
import { listKeyId } from "../../../config/keybindings/matchers";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import { bindingGlyph } from "../../styles/panels/common";

const ROLE = "omp.overlay.plugin-settings";
const FIELD_ROLE = `${ROLE}.field`;
const CONFIGURE: TspPrefsControl = { k: "action", label: "Configure", act: "open" };
/** The confirm and cancel keys as hints show them (`⏎`, `⎋`). */
const confirmGlyph = (): string => bindingGlyph("tui.select.confirm", "enter");
const cancelGlyph = (): string => bindingGlyph("tui.select.cancel", "escape");
const detailHint = (): string => `${confirmGlyph()} to edit · ${cancelGlyph()} to go back`;
const settingsHint = (): string => `${confirmGlyph()}/␣ to change · Type to search · ${cancelGlyph()} to cancel`;
const ENABLED = "●";
const DISABLED = "⦸";
const SHADOWED = "○";

/** What the plugin settings report to their host. */
export interface PluginSettingsCallbacks {
	onClose(): void;
	onPluginChanged(): void | Promise<void>;
	/** A view started on its own (see {@link PluginStart}): a plugin picked from the list. */
	onOpen?(entry: PluginListEntry): void;
	/** A view started on its own: ⎋ on a plugin's settings. */
	onBack?(): void;
}

/**
 * Start on one view instead of loading the list from the host: the given
 * list, or one plugin's settings. Such a view does not navigate; picks and
 * backs go to `onOpen`/`onBack`.
 */
export type PluginStart =
	| { readonly kind: "list"; readonly entries: readonly PluginListEntry[] }
	| { readonly kind: "npm"; readonly plugin: InstalledPlugin }
	| { readonly kind: "mkt"; readonly plugin: InstalledPluginSummary };

/** One row of a plugin's detail list. */
interface DetailItem {
	readonly id: string;
	/** As drawn (feature and config rows indented two cells). */
	readonly label: string;
	readonly description: string;
	readonly value: string;
	/** A true/false row. */
	readonly toggle: boolean;
	/** The manifest setting behind a config row. */
	readonly schema?: PluginSettingSchema;
	readonly key?: string;
}

/** An open config editor over a detail list. */
type ConfigEditor =
	| { readonly kind: "enum"; readonly item: DetailItem; readonly values: readonly string[]; readonly selected: number }
	| { readonly kind: "input"; readonly item: DetailItem; readonly line: LineState; readonly error?: string };

interface Detail {
	readonly kind: "npm" | "mkt";
	readonly title: string;
	readonly description?: string;
	/** Dim facts under the list (marketplace installs). */
	readonly summary?: readonly string[];
	readonly lead: string;
	readonly items: readonly DetailItem[];
	readonly selected: string;
	readonly query: string;
	readonly editor: ConfigEditor | null;
	/** Rows the list shows before it scrolls. */
	readonly maxVisible: number;
	/** The rows are still loading (the panel shows only its frame). */
	readonly loading?: boolean;
}

type View =
	/** Loading the list; `stale` is the view it replaces, still the native page until the list arrives. */
	| { readonly kind: "loading"; readonly stale?: Detail }
	| { readonly kind: "list"; readonly entries: readonly PluginListEntry[]; readonly selected: number }
	| ({ readonly view: "detail" } & Detail & { readonly kind: "npm" | "mkt" });

/** The plugin settings: their current view node, keys and native page. */
export type PluginSettings = SettingsPluginsPage;

function entryValue(entry: PluginListEntry): string {
	return entry.kind === "npm" ? `npm:${entry.plugin.name}` : `mkt:${entry.plugin.scope}:${entry.plugin.id}`;
}

function marketplaceEnabled(summary: InstalledPluginSummary): boolean {
	return summary.entries[0]?.enabled !== false;
}

function shortenPath(path: string): string {
	const home = process.env.HOME;
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function filterText(item: DetailItem): string {
	let text = `${item.label} ${item.id} ${item.value}`;
	if (item.description) text += ` ${item.description}`;
	if (item.toggle) text += " true false";
	return text
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** A list entry's status, name and details: styled for the terminal, plain for the native item. */
function entryLook(entry: PluginListEntry): {
	label: TspSpan[];
	detail: TspSpan[];
	plainLabel: string;
	plainDetail: string;
} {
	if (entry.kind === "npm") {
		const p = entry.plugin;
		const features = p.manifest.features ? Object.keys(p.manifest.features).length : 0;
		const status: TspSpan = p.enabled ? { s: "success", t: ENABLED } : { s: "muted", t: DISABLED };
		let details = ` · v${p.version}`;
		if (features > 0) details += ` · ${p.enabledFeatures?.length ?? features}/${features} features`;
		return {
			label: [status, { t: ` ${p.name}` }],
			detail: [{ s: "dim", t: "[npm]" }, { t: details }],
			plainLabel: `${status.t} ${p.name}`,
			plainDetail: `[npm]${details}`,
		};
	}
	const s = entry.plugin;
	const status: TspSpan = marketplaceEnabled(s) ? { s: "success", t: ENABLED } : { s: "muted", t: DISABLED };
	let details = ` · v${s.entries[0]?.version ?? "?"}`;
	if (s.shadowedBy) details += ` · shadowed by ${s.shadowedBy}`;
	const label: TspSpan[] = [status, { t: ` ${s.id}` }];
	if (s.shadowedBy) label.push({ t: " " }, { s: "warning", t: SHADOWED });
	return {
		label,
		detail: [{ s: "dim", t: "[marketplace]" }, { t: " " }, { s: "dim", t: `[${s.scope}]` }, { t: details }],
		plainLabel: `${status.t} ${s.id}${s.shadowedBy ? ` ${SHADOWED}` : ""}`,
		plainDetail: `[marketplace] [${s.scope}]${details}`,
	};
}

async function configItems(plugin: InstalledPlugin, host: PluginSettingsHost): Promise<DetailItem[]> {
	const schemas = plugin.manifest.settings;
	if (!schemas) return [];
	const values = await host.manager.getPluginSettings(plugin.name);
	const items: DetailItem[] = [];
	for (const key in schemas) {
		const schema = schemas[key]!;
		const current = values[key] ?? schema.default;
		const base = {
			id: `config:${key}`,
			label: `  ${key}`,
			description: schema.description || `Configure ${key}`,
			schema,
			key,
		};
		if (schema.type === "boolean") items.push({ ...base, value: current ? "true" : "false", toggle: true });
		else if (schema.type === "enum")
			items.push({ ...base, value: String(current ?? schema.default ?? ""), toggle: false });
		else
			items.push({
				...base,
				value: schema.secret && current ? "••••••••" : String(current ?? "(not set)"),
				toggle: false,
			});
	}
	return items;
}

/** The settings list of a detail view as a native `omp.settings` column, or its open editor. */
function DetailList(props: { detail: Detail; visible: readonly DetailItem[] }): JSXNode {
	const { detail, visible } = props;
	const editor = detail.editor;
	if (editor)
		return (
			<col role="omp.settings" gap="sm">
				{<EditorPanel editor={editor} />}
			</col>
		);
	return (
		<col role="omp.settings" gap="sm">
			<list
				key="list"
				empty={detail.items.length === 0 ? "No settings available" : "No matching settings"}
				max={{ lines: detail.maxVisible }}
				selected={visible.some(item => item.id === detail.selected) ? detail.selected : (visible[0]?.id ?? null)}
				filter={detail.query.trim() || undefined}
			>
				{visible.map(item => (
					<item
						key={item.id}
						label={[{ t: item.label.trim() }]}
						value={[{ s: "muted", t: item.value }]}
						detail={item.description ? [{ s: "muted", t: item.description }] : undefined}
					/>
				))}
			</list>
			<text key="hint" spans={[{ s: "muted", t: settingsHint() }]} />
		</col>
	);
}

/** An open config editor: a titled field panel (enum choices or a text field). */
function EditorPanel(props: { editor: ConfigEditor }): JSXNode {
	const { editor } = props;
	const schema = editor.item.schema!;
	const key = editor.item.key!;
	if (editor.kind === "enum") {
		const description = schema.description || `Select value for ${key}`;
		const blocks: PanelBlock[] = [
			{ k: "gap" },
			{ k: "text", spans: [{ s: "muted", t: description }] },
			{ k: "gap" },
			{
				k: "select",
				options: editor.values.map(value => ({ label: [{ t: value }] })),
				selected: editor.selected,
				max: Math.min(editor.values.length || 1, 8),
			},
			{ k: "gap" },
			{ k: "text", spans: [{ s: "dim", t: `${confirmGlyph()} to select · ${cancelGlyph()} to cancel` }] },
		];
		return (
			<card head={key} role={FIELD_ROLE} term={{ blocks }}>
				<col role="omp.form.field" gap="sm">
					<text spans={[{ s: "muted", t: description }]} />
					<col role="omp.select">
						<list
							key="list"
							empty="No items"
							max={{ lines: Math.min(editor.values.length || 1, 8) }}
							selected={editor.values[editor.selected] ?? null}
						>
							{editor.values.map(value => (
								<item key={value} label={[{ t: value }]} />
							))}
						</list>
					</col>
					<text text="" hidden />
					<text spans={[{ s: "muted", t: `${confirmGlyph()} to select · ${cancelGlyph()} to cancel` }]} />
				</col>
			</card>
		);
	}
	let typeHint = `Type: ${schema.type}`;
	if (schema.type === "number" && (schema.min !== undefined || schema.max !== undefined))
		typeHint += ` (${schema.min ?? ""}..${schema.max ?? ""})`;
	const blocks: PanelBlock[] = [{ k: "gap" }];
	if (schema.description) blocks.push({ k: "text", spans: [{ s: "muted", t: schema.description }] }, { k: "gap" });
	blocks.push(
		{ k: "text", spans: [{ s: "dim", t: typeHint }] },
		{ k: "gap" },
		{ k: "input", text: editor.line.text, cursor: editor.line.cursor, mask: schema.secret },
		{ k: "gap" },
	);
	if (editor.error) blocks.push({ k: "text", spans: [{ s: "error", t: editor.error }] });
	blocks.push({
		k: "text",
		spans: [{ s: "dim", t: `${bindingGlyph("tui.input.submit", "enter")} to save · ${cancelGlyph()} to cancel` }],
	});
	return (
		<card head={key} role={FIELD_ROLE} term={{ blocks }}>
			<col role="omp.form.field" gap="sm">
				{schema.description ? <text spans={[{ s: "muted", t: schema.description }]} /> : null}
				{schema.description ? <spacer size="sm" /> : null}
				<text spans={[{ s: "dim", t: typeHint }]} wrap="word" />
				<input
					text={schema.secret ? "•".repeat([...editor.line.text].length) : editor.line.text}
					cursor={editor.line.cursor}
					prompt="> "
					sendable={false}
				/>
				{editor.error ? <text spans={[{ s: "error", t: editor.error }]} /> : <text text="" hidden />}
				<text
					spans={[
						{
							s: "muted",
							t: `${bindingGlyph("tui.input.submit", "enter")} to save · ${cancelGlyph()} to cancel`,
						},
					]}
				/>
			</col>
		</card>
	);
}

function ListPanel(props: { entries: readonly PluginListEntry[]; selected: number }): JSXNode {
	const { entries, selected } = props;
	if (entries.length === 0) {
		const blocks: PanelBlock[] = [
			{ k: "gap" },
			{ k: "text", spans: [{ s: "muted", t: "No plugins installed" }] },
			{ k: "gap" },
			{ k: "text", spans: [{ s: "dim", t: "Install npm plugins:        omp plugin install <package>" }] },
			{
				k: "text",
				spans: [{ s: "dim", t: "Install marketplace plugins: omp plugin install <name>@<marketplace>" }],
			},
			{ k: "gap" },
		];
		return (
			<card head="Plugins" role={ROLE} term={{ blocks }}>
				<text spans={[{ s: "muted", t: "No plugins installed" }]} />
				<kv
					items={[
						{ k: "Install npm plugins", v: [{ s: "code", t: "omp plugin install <package>" }] },
						{
							k: "Install marketplace plugins",
							v: [{ s: "code", t: "omp plugin install <name>@<marketplace>" }],
						},
					]}
				/>
				<Hints hints={[["escape", "go back"]]} />
			</card>
		);
	}
	const looks = entries.map(entryLook);
	const max = Math.min(entries.length, 8);
	const blocks: PanelBlock[] = [
		{ k: "gap" },
		{
			k: "select",
			options: looks.map(look => ({ label: look.label, detail: look.detail })),
			selected,
			max,
			column: { min: 24, max: 64 },
		},
		{ k: "gap" },
		{ k: "text", spans: [{ s: "dim", t: `${confirmGlyph()} to configure · ${cancelGlyph()} to go back` }] },
	];
	return (
		<card head="Plugins" role={ROLE} term={{ blocks }}>
			<col role="omp.select">
				<list key="list" empty="No items" max={{ lines: max }} selected={entryValue(entries[selected]!)}>
					{entries.map((entry, index) => (
						<item
							key={entryValue(entry)}
							label={[{ t: looks[index]!.plainLabel }]}
							detail={[{ s: "muted", t: looks[index]!.plainDetail }]}
						/>
					))}
				</list>
			</col>
			<Hints
				hints={[
					["enter", "configure"],
					["escape", "go back"],
				]}
			/>
		</card>
	);
}

function Hints(props: { hints: readonly (readonly [string, string])[] }): JSXNode {
	return (
		<row key="hints" role="omp.overlay.hints" gap="md" wrap>
			{props.hints.map(([key, label]) => (
				<row gap="xs" align="center">
					<kbd keys={[key]} />
					<text spans={[{ s: "muted", t: label }]} />
				</row>
			))}
		</row>
	);
}

function DetailPanel(props: { detail: Detail; visible: readonly DetailItem[] }): JSXNode {
	const { detail, visible } = props;
	if (detail.loading) return <card head={detail.title} role={ROLE} term={{ blocks: [] }} />;
	const stable = detail.maxVisible + 4 + 1 + 2;
	const blocks: PanelBlock[] = [];
	if (detail.description) blocks.push({ k: "text", spans: [{ s: "muted", t: detail.description }] });
	blocks.push({ k: "gap" });
	if (detail.editor) blocks.push({ k: "node", node: editorNode(detail.editor), height: stable });
	else
		blocks.push({
			k: "settings",
			rows: visible.map((item): PanelSetting => ({
				id: item.id,
				label: item.label,
				value: item.value,
				description: item.description,
			})),
			total: detail.items.length,
			selected: Math.max(
				0,
				visible.findIndex(item => item.id === detail.selected),
			),
			maxVisible: detail.maxVisible,
			query: detail.query,
		});
	blocks.push({ k: "gap" });
	for (const fact of detail.summary ?? []) blocks.push({ k: "text", spans: [{ s: "dim", t: fact }] });
	if (detail.summary) blocks.push({ k: "gap" });
	blocks.push({ k: "text", spans: [{ s: "dim", t: detailHint() }] });
	return (
		<card head={detail.title} role={ROLE} term={{ blocks }}>
			<col role="omp.form.field" gap="sm">
				{detail.description ? <text spans={[{ s: "muted", t: detail.description }]} /> : null}
				<DetailList detail={detail} visible={visible} />
				<text text="" hidden />
				{(detail.summary ?? []).map(fact => (
					<text spans={[{ s: "dim", t: fact }]} wrap="word" />
				))}
				{detail.summary ? <spacer size="sm" /> : null}
				<text spans={[{ s: "muted", t: detailHint() }]} />
			</col>
		</card>
	);
}

/** The editor panel as a standalone node (painted inside the detail panel's frame). */
function editorNode(editor: ConfigEditor): UiNode {
	return (<EditorPanel editor={editor} />) as UiNode;
}

/** Build the plugin settings over `host`. */
export function createPluginSettings(
	host: PluginSettingsHost,
	callbacks: PluginSettingsCallbacks,
	start?: PluginStart,
): PluginSettings {
	const view = signal<View>({ kind: "loading" });
	let generation = 0;

	const changed = (): void => void callbacks.onPluginChanged();

	const showList = async (): Promise<void> => {
		const run = ++generation;
		const previous = view();
		view.set({ kind: "loading", stale: previous.kind === "npm" || previous.kind === "mkt" ? previous : undefined });
		const [npm, marketplace] = await Promise.all([
			host.manager.list().catch((): InstalledPlugin[] => []),
			host
				.createMarketplaceManager()
				.then(manager => manager.listInstalledPlugins())
				.catch((): InstalledPluginSummary[] => []),
		]);
		if (run !== generation) return;
		const entries: PluginListEntry[] = [
			...npm.map((plugin): PluginListEntry => ({ kind: "npm", plugin })),
			...marketplace.map((plugin): PluginListEntry => ({ kind: "marketplace", plugin })),
		];
		view.set({ kind: "list", entries, selected: 0 });
	};

	const detailOf = (): (Detail & { view: "detail" }) | undefined => {
		const current = view();
		return current.kind === "npm" || current.kind === "mkt" ? current : undefined;
	};

	const setDetail = (next: Partial<Detail>): void => {
		const current = detailOf();
		if (current) view.set({ ...current, ...next });
	};

	/** The rows a detail list shows (its type-to-search filter applied). */
	const visibleOf = (detail: Detail): readonly DetailItem[] =>
		detail.query.trim() ? fuzzyFilter([...detail.items], detail.query, filterText) : detail.items;

	const showNpm = async (plugin: InstalledPlugin): Promise<void> => {
		const run = ++generation;
		const manifest = plugin.manifest;
		const items: DetailItem[] = [
			{
				id: "__enabled__",
				label: "Enabled",
				description: "Enable or disable this plugin",
				value: plugin.enabled ? "true" : "false",
				toggle: true,
			},
		];
		const features = manifest.features ?? {};
		const names = Object.keys(features);
		if (names.length > 0) {
			const enabled = new Set(plugin.enabledFeatures ?? names.filter(name => features[name]?.default));
			for (const name of names)
				items.push({
					id: `feature:${name}`,
					label: `  ${name}`,
					description: features[name]?.description || `Enable ${name} feature`,
					value: enabled.has(name) ? "true" : "false",
					toggle: true,
				});
		}
		view.set({
			view: "detail",
			kind: "npm",
			title: plugin.name,
			description: manifest.description || undefined,
			lead: manifest.description || "Turn the plugin and its features on and off, and change its settings.",
			items: [],
			selected: "__enabled__",
			query: "",
			editor: null,
			maxVisible: 0,
			loading: true,
		});
		npmPlugin = plugin;
		const config = await configItems(plugin, host);
		if (run !== generation) return;
		const all = [...items, ...config];
		view.set({
			view: "detail",
			kind: "npm",
			title: plugin.name,
			description: manifest.description || undefined,
			lead: manifest.description || "Turn the plugin and its features on and off, and change its settings.",
			items: all,
			selected: "__enabled__",
			query: "",
			editor: null,
			maxVisible: Math.min(all.length, 10),
		});
	};

	let npmPlugin: InstalledPlugin | undefined;
	let marketplacePlugin: InstalledPluginSummary | undefined;
	let runtimePlugin: InstalledPlugin | undefined;

	const marketplaceDetail = (
		summary: InstalledPluginSummary,
		config: readonly DetailItem[],
	): Detail & { view: "detail" } => {
		const entry = summary.entries[0];
		const subtitle = [`[${summary.scope}]`];
		if (summary.shadowedBy) subtitle.push(`${SHADOWED} shadowed by ${summary.shadowedBy}`);
		const facts = [
			`version       ${entry?.version ?? "(unknown)"}`,
			`scope         ${summary.scope}`,
			`install path  ${entry?.installPath ? shortenPath(entry.installPath) : "(unknown)"}`,
			`installed at  ${entry?.installedAt ?? "(unknown)"}`,
			`last updated  ${entry?.lastUpdated ?? "(unknown)"}`,
		];
		if (entry?.gitCommitSha) facts.push(`git sha       ${entry.gitCommitSha}`);
		const lead = [`${summary.scope} install`, `v${entry?.version ?? "?"}`];
		if (entry?.installPath) lead.push(shortenPath(entry.installPath));
		if (summary.shadowedBy) lead.push(`shadowed by the ${summary.shadowedBy} install`);
		const items: DetailItem[] = [
			{
				id: "__enabled__",
				label: "Enabled",
				description: "Enable or disable this marketplace plugin",
				value: marketplaceEnabled(summary) ? "true" : "false",
				toggle: true,
			},
			...config,
		];
		return {
			view: "detail",
			kind: "mkt",
			title: summary.id,
			description: subtitle.join(" "),
			summary: facts,
			lead: lead.join(" · "),
			items,
			selected: "__enabled__",
			query: "",
			editor: null,
			maxVisible: Math.min(items.length, 10),
		};
	};

	const showMarketplace = async (summary: InstalledPluginSummary): Promise<void> => {
		const run = ++generation;
		marketplacePlugin = summary;
		runtimePlugin = undefined;
		view.set(marketplaceDetail(summary, []));
		const entry = summary.entries[0];
		if (!entry) return;
		const name = host.parsePluginId(summary.id)?.name ?? summary.id;
		try {
			const runtime = await host.manager.getPlugin(name, { path: entry.installPath });
			if (!runtime) return;
			const config = await configItems(runtime, host);
			if (run !== generation) return;
			runtimePlugin = runtime;
			const current = detailOf();
			view.set({ ...marketplaceDetail(marketplacePlugin, config), selected: current?.selected ?? "__enabled__" });
		} catch {
			// The panel stays usable without the runtime settings.
		}
	};

	/** A toggle row set to `on`: the plugin, a feature or a boolean setting. */
	const applyToggle = (detail: Detail, item: DetailItem, on: boolean): void => {
		const items = detail.items.map(candidate =>
			candidate.id === item.id ? { ...candidate, value: on ? "true" : "false" } : candidate,
		);
		setDetail({ items, selected: item.id });
		if (detail.kind === "npm" && npmPlugin) {
			const plugin = npmPlugin;
			if (item.id === "__enabled__") {
				npmPlugin = { ...plugin, enabled: on };
				void host.manager.setEnabled(plugin.name, on).then(changed);
			} else if (item.id.startsWith("feature:")) {
				const feature = item.id.slice(8);
				const next = new Set(plugin.enabledFeatures ?? []);
				if (on) next.add(feature);
				else next.delete(feature);
				npmPlugin = { ...plugin, enabledFeatures: [...next] };
				void (async () => {
					const current = new Set((await host.manager.getEnabledFeatures(plugin.name)) ?? []);
					if (on) current.add(feature);
					else current.delete(feature);
					await host.manager.setEnabledFeatures(plugin.name, [...current]);
					await callbacks.onPluginChanged();
				})();
			} else if (item.key) void host.manager.setPluginSetting(plugin.name, item.key, on).then(changed);
			return;
		}
		if (detail.kind === "mkt" && marketplacePlugin) {
			const summary = marketplacePlugin;
			if (item.id === "__enabled__") {
				marketplacePlugin = { ...summary, entries: summary.entries.map(entry => ({ ...entry, enabled: on })) };
				void host
					.createMarketplaceManager()
					.then(manager => manager.setPluginEnabled(summary.id, on, summary.scope))
					.then(changed)
					.catch(() => {});
			} else if (item.key && runtimePlugin)
				void host.manager.setPluginSetting(runtimePlugin.name, item.key, on).then(changed);
		}
	};

	/** A config value picked or typed: stored, shown, the editor closed. */
	const applyConfig = (detail: Detail, item: DetailItem, value: string): void => {
		const schema = item.schema!;
		const items = detail.items.map(candidate => (candidate.id === item.id ? { ...candidate, value } : candidate));
		setDetail({ items, editor: null, selected: item.id });
		const parsed = schema.type === "number" ? Number(value) : value;
		const name = detail.kind === "npm" ? npmPlugin?.name : runtimePlugin?.name;
		if (name) void host.manager.setPluginSetting(name, item.key!, parsed).then(changed);
	};

	/** ⏎/␣ (or a native activate) on a detail row: toggles flip, other rows open their editor. */
	const activate = (detail: Detail, item: DetailItem): void => {
		if (item.toggle) {
			applyToggle(detail, item, item.value !== "true");
			return;
		}
		const schema = item.schema;
		if (!schema) return;
		if (schema.type === "enum") {
			setDetail({
				selected: item.id,
				editor: {
					kind: "enum",
					item,
					values: schema.values,
					selected: Math.max(0, schema.values.indexOf(item.value)),
				},
			});
			return;
		}
		const text = schema.secret ? "" : item.value === "(not set)" ? "" : item.value;
		setDetail({ selected: item.id, editor: { kind: "input", item, line: { text, cursor: text.length } } });
	};

	const editorKey = (detail: Detail, editor: ConfigEditor, key: KeyEvent): void => {
		const id = listKeyId(key);
		if (id === "escape") {
			setDetail({ editor: null });
			return;
		}
		if (editor.kind === "enum") {
			const count = editor.values.length;
			if (id === "up") setDetail({ editor: { ...editor, selected: (editor.selected - 1 + count) % count } });
			else if (id === "down") setDetail({ editor: { ...editor, selected: (editor.selected + 1) % count } });
			else if (id === "enter" || id === "ctrl+j") {
				const value = editor.values[editor.selected];
				if (value !== undefined) applyConfig(detail, editor.item, value);
			}
			return;
		}
		if (getKeybindings().matches(key, "tui.input.submit")) {
			const value = editor.line.text;
			if (value.trim() === "") setDetail({ editor: null });
			else applyConfig(detail, editor.item, editor.item.schema?.secret ? value : value);
			return;
		}
		const line = editLine(editor.line, key);
		if (line) setDetail({ editor: { ...editor, line, error: undefined } });
	};

	/** A new type-to-search query: the selection survives while its row still matches, else the first match takes it. */
	const setQuery = (detail: Detail, query: string): void => {
		const visible = visibleOf({ ...detail, query });
		const selected = visible.some(item => item.id === detail.selected) ? detail.selected : (visible[0]?.id ?? "");
		setDetail({ query, selected });
	};

	const detailKey = (detail: Detail, key: KeyEvent): void => {
		if (detail.editor) {
			editorKey(detail, detail.editor, key);
			return;
		}
		const id = listKeyId(key);
		if (id === "escape") {
			if (detail.query) setQuery(detail, "");
			else if (start) callbacks.onBack?.();
			else void showList();
			return;
		}
		if (detail.items.length === 0) return;
		const visible = visibleOf(detail);
		if (id === "backspace") {
			if (detail.query) setQuery(detail, [...detail.query].slice(0, -1).join(""));
			return;
		}
		const typed = key.text;
		if (typed !== undefined && id !== "space" && /^[^\x00-\x1f\x7f]+$/.test(typed)) {
			if (detail.query === "" && typed.trim() === "") return;
			setQuery(detail, detail.query + typed);
			return;
		}
		if (visible.length === 0) return;
		const at = Math.max(
			0,
			visible.findIndex(item => item.id === detail.selected),
		);
		const move = (index: number): void => setDetail({ selected: visible[index]!.id });
		switch (id) {
			case "up":
				move((at - 1 + visible.length) % visible.length);
				return;
			case "down":
				move((at + 1) % visible.length);
				return;
			case "pageUp":
				move(Math.max(0, at - detail.maxVisible));
				return;
			case "pageDown":
				move(Math.min(visible.length - 1, at + detail.maxVisible));
				return;
			case "enter":
			case "space":
			case "ctrl+j":
				activate(detail, visible[at]!);
				return;
		}
	};

	const open = (entry: PluginListEntry): void => {
		if (start) callbacks.onOpen?.(entry);
		else if (entry.kind === "npm") void showNpm(entry.plugin);
		else void showMarketplace(entry.plugin);
	};

	const key = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		const current = view();
		const id = listKeyId(key);
		if (current.kind === "loading") {
			if (id === "escape") callbacks.onClose();
			return true;
		}
		if (current.kind === "list") {
			const count = current.entries.length;
			if (id === "escape") callbacks.onClose();
			else if (count === 0) return true;
			else if (id === "up") view.set({ ...current, selected: (current.selected - 1 + count) % count });
			else if (id === "down") view.set({ ...current, selected: (current.selected + 1) % count });
			else if (id === "pageUp")
				view.set({ ...current, selected: Math.max(0, current.selected - Math.min(count, 8)) });
			else if (id === "pageDown")
				view.set({ ...current, selected: Math.min(count - 1, current.selected + Math.min(count, 8)) });
			else if (id === "home") view.set({ ...current, selected: 0 });
			else if (id === "end") view.set({ ...current, selected: count - 1 });
			else if (id === "enter" || id === "ctrl+j") open(current.entries[current.selected]!);
			return true;
		}
		detailKey(current, key);
		return true;
	};

	const event = (event: UiEvent): void => {
		const current = view();
		if (current.kind === "list") {
			const index = (id: string): number => current.entries.findIndex(entry => entryValue(entry) === id);
			if (event.type === "select" && index(event.item) >= 0) view.set({ ...current, selected: index(event.item) });
			else if (event.type === "activate" && index(event.item) >= 0) open(current.entries[index(event.item)]!);
			else if (event.type === "action" && event.act === "open" && event.value && index(event.value) >= 0) {
				view.set({ ...current, selected: index(event.value) });
				open(current.entries[index(event.value)]!);
			}
			return;
		}
		if (current.kind === "loading") return;
		const find = (id: string): DetailItem | undefined => current.items.find(item => item.id === id);
		switch (event.type) {
			case "change": {
				const item = find(event.item);
				if (item?.toggle && typeof event.value === "boolean") applyToggle(current, item, event.value);
				return;
			}
			case "select":
				if (find(event.item) && visibleOf(current).some(item => item.id === event.item))
					setDetail({ selected: event.item });
				return;
			case "activate": {
				const item = find(event.item);
				if (item && !current.editor) {
					setDetail({ selected: item.id });
					if (!item.toggle) activate(current, item);
				}
				return;
			}
			case "action": {
				if (event.act === "edit" && event.value) {
					const item = find(event.value);
					if (item && !current.editor && !item.toggle) activate(current, item);
				} else if (event.act === "close" && event.value && current.editor?.item.id === event.value)
					setDetail({ editor: null });
				return;
			}
			default:
				return;
		}
	};

	const root = (
		<col>
			{() => {
				const current = view();
				if (current.kind === "loading") return null;
				if (current.kind === "list") return <ListPanel entries={current.entries} selected={current.selected} />;
				return <DetailPanel detail={current} visible={visibleOf(current)} />;
			}}
		</col>
	) as UiNode;

	const prefs: Accessor<SettingsPluginsPrefs> = computed(() => {
		const shown = view();
		const current = shown.kind === "loading" && shown.stale ? shown.stale : shown;
		if (current.kind === "loading")
			return { lead: "Loading installed plugins…", sections: [], focus: null, editing: null };
		if (current.kind === "list") {
			const rows = current.entries.map(entry => {
				const id = entryValue(entry);
				if (entry.kind === "npm") {
					const p = entry.plugin;
					const features = p.manifest.features ? Object.keys(p.manifest.features).length : 0;
					const parts = [p.enabled ? "Enabled" : "Disabled", "npm", `v${p.version}`];
					if (features > 0) parts.push(`${p.enabledFeatures?.length ?? features}/${features} features`);
					return { id, label: p.name, hint: parts.join(" · "), control: CONFIGURE };
				}
				const s = entry.plugin;
				const parts = [
					marketplaceEnabled(s) ? "Enabled" : "Disabled",
					"marketplace",
					s.scope,
					`v${s.entries[0]?.version ?? "?"}`,
				];
				return {
					id,
					label: s.id,
					hint: parts.join(" · "),
					warning: s.shadowedBy ? `Shadowed by the ${s.shadowedBy} install` : undefined,
					control: CONFIGURE,
				};
			});
			return {
				lead:
					rows.length > 0
						? "Plugins installed for you and this project. Configure one to turn it or its features on and off."
						: "No plugins installed. Install one with omp plugin install <package>, or <name>@<marketplace>.",
				sections: rows.length > 0 ? [{ id: "installed", title: "Installed", rows }] : [],
				focus: current.entries[current.selected] ? entryValue(current.entries[current.selected]!) : null,
				editing: null,
			};
		}
		const visible = visibleOf(current);
		const rows = visible.map(item => ({
			id: item.id,
			label: item.label.trim(),
			hint: item.description || undefined,
			control: item.toggle
				? ({ k: "switch", on: item.value === "true" } as const)
				: ({ k: "action", label: item.value.trim() || "Edit…", act: "edit" } as const),
		}));
		const sections: TspPrefsSection[] = rows.length > 0 ? [{ id: "plugin", title: current.title, rows }] : [];
		return {
			lead: current.lead,
			sections,
			focus: visible.some(item => item.id === current.selected) ? current.selected : (visible[0]?.id ?? null),
			editing: null,
		};
	});

	if (!start) void showList();
	else if (start.kind === "list") view.set({ kind: "list", entries: start.entries, selected: 0 });
	else if (start.kind === "npm") void showNpm(start.plugin);
	else void showMarketplace(start.plugin);
	return {
		view: root,
		prefs,
		key,
		event: e => batch(() => event(e)),
		dispose: () => {
			generation++;
		},
	};
}

/** The settings window's Plugins page. */
export function createPluginSettingsPage(
	host: PluginSettingsHost,
	options: { onClose(): void; onChanged(): void },
): SettingsPluginsPage {
	return createPluginSettings(host, { onClose: options.onClose, onPluginChanged: options.onChanged });
}
