/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The fullscreen /models hub as a `lg` picker sheet: the sidebar is the
 * picker's scopes (Roles, All models, providers), the model list or the
 * Roles view its rows, the open chip strip or name field its `strip`, the
 * selection's facts its side preview. State and behaviour live in
 * {@link ModelHubState}; the terminal look is `omp.model-hub`.
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { computed, effect, type JSXNode, onCleanup } from "@oh-my-pi/pi-tui";
import type {
	TspPickerAction,
	TspPickerColumn,
	TspPickerGroup,
	TspPickerItem,
	TspPickerProps,
	TspPickerScope,
	TspSpan,
} from "@oh-my-pi/pi-wire";
import {
	MODEL_PICKER_COLUMNS,
	type ModelBrowserItem,
	providerMark,
	thinkingDotToken,
} from "../../../modes/view-model/overlays/model-browser";
import type {
	ModelHubCallbacks,
	ModelHubOptions,
	ModelHubRegistry,
	ModelHubSource,
	ScopedModelItem,
} from "../../../modes/view-model/overlays/model-hub";
import { getConfiguredThinkingLevelMetadata } from "../../../thinking/levels";
import "../../styles/pickers/model-hub";
import { compactionNotice, type ModelHubTerm } from "../../styles/pickers/model-hub";
import { modelPreview } from "./model-browser";
import {
	compactionConfirmPending,
	MODEL_KIND_LABELS,
	MODEL_KIND_TABS,
	ModelHubState,
	nativeJudgeRouteError,
	type NativeRouteForm,
	nativeRouteFieldView,
	ROLE_TABS,
	type RolesAction,
	type RolesRow,
	rolesRowKey,
	type StripState,
} from "./model-hub-state";
import { closeAction, pickerAction } from "./select-sheet";
import { confirmKbd } from "../../keys/hints";

/** Fact columns of the Roles view. */
const ROLE_PICKER_COLUMNS: readonly TspPickerColumn[] = [
	{ id: "model", head: "Model", format: "text", priority: 2 },
	{ id: "thinking", head: "Thinking", format: "dim", priority: 1 },
];

export interface ModelHubProps {
	readonly source: ModelHubSource;
	readonly registry: ModelHubRegistry;
	readonly scopedModels: ReadonlyArray<ScopedModelItem>;
	readonly callbacks: ModelHubCallbacks;
	readonly options?: ModelHubOptions;
	/** Terminal height (the hub fills it; default 40 rows). */
	readonly terminalRows?: () => number;
	/** Receives the hub's state (hosts call `refreshAfterExternalMutation` after async writes). */
	readonly onState?: (hub: ModelHubState) => void;
}

/** The sidebar as picker scopes: Roles, All models, then signed-in and signed-out providers. */
function pickerScopes(hub: ModelHubState): TspPickerScope[] {
	const counts = hub.searchCounts;
	const oauth = new Set(getOAuthProviders().map(provider => provider.id));
	const scopes: TspPickerScope[] = [];
	for (const entry of hub.entries) {
		switch (entry.kind) {
			case "separator":
				break;
			case "roles":
				scopes.push({ id: entry.id, label: "Roles", icon: "sparkles", count: hub.visibleRoleIds().length });
				break;
			case "all":
				scopes.push({
					id: entry.id,
					label: "All models",
					icon: "list",
					count: counts ? hub.searchTotal : hub.availableItems.length,
				});
				break;
			case "recent":
				scopes.push({
					id: entry.id,
					label: "Recent",
					icon: "clock",
					count: counts ? hub.recentSearchCount : hub.recentItems.length,
				});
				break;
			case "provider": {
				const providerId = entry.providerId ?? entry.label;
				const mark = providerMark(providerId);
				if (entry.locked) {
					const envVars = hub.envVarsOf(providerId);
					scopes.push({
						id: entry.id,
						label: entry.label,
						mark,
						group: "Not signed in",
						disabled: oauth.has(providerId)
							? "Sign in with /login"
							: envVars.length > 0
								? `Set ${envVars.join(" or ")} to sign in`
								: "Add an API key in config to sign in",
						dot: "muted",
					});
					break;
				}
				const dot = providerDot(hub, providerId);
				scopes.push({
					id: entry.id,
					label: entry.label,
					mark,
					group: "Providers",
					count: counts ? (counts.get(providerId) ?? 0) : Number(entry.annotation ?? 0),
					...(dot ? { dot } : {}),
				});
				break;
			}
		}
	}
	return scopes;
}

/** Discovery state as a scope dot: refreshing, ok, cached/empty, unavailable, signed out. */
function providerDot(hub: ModelHubState, providerId: string): TspPickerScope["dot"] {
	if (hub.isRefreshing(providerId)) return "pending";
	switch (hub.registry.getProviderDiscoveryState(providerId)?.status) {
		case "ok":
			return "success";
		case "cached":
		case "empty":
			return "warning";
		case "unavailable":
			return "error";
		case "unauthenticated":
			return "muted";
		default:
			return undefined;
	}
}

/** The action bar for the current view; each button runs the path of the key it shows. */
function pickerActions(hub: ModelHubState): TspPickerAction[] {
	const strip = hub.strip;
	const cancel = (label: string): TspPickerAction => closeAction(label);
	if (hub.assignmentPending) return [closeAction()];
	if (hub.nativeRouteForm) {
		return [
			pickerAction("nativeRouteSubmit", hub.nativeSubmitLabel(), "enter", { primary: true }),
			hub.canTestNativeRoute() ? pickerAction("nativeRouteTest", "Test route", "ctrl+t") : undefined,
			closeAction("Cancel"),
		].filter((action): action is TspPickerAction => action !== undefined);
	}
	const route = hub.canEditNativeRoute() ? pickerAction("nativeRoute", "Native route", "ctrl+r") : undefined;
	const create = hub.canCreateNativeJudge()
		? pickerAction("nativeJudgeCreate", "Add native judge", "ctrl+n")
		: undefined;
	if (strip) {
		const apply =
			strip.kind === "name"
				? strip.purpose === "compaction"
					? pickerAction(
							"compactionPoint",
							compactionConfirmPending(strip) ? "Accept compaction point" : "Set compaction point",
							"enter",
							{ primary: true },
						)
					: pickerAction(
							strip.purpose === "preset" ? "presetName" : "roleName",
							strip.purpose === "preset" ? "Save preset" : "Create role",
							"enter",
							{ primary: true },
						)
				: pickerAction(
						"stripApply",
						strip.kind === "thinking" ? "Apply" : strip.kind === "scope" ? "Save to scope" : "Assign / clear",
						"enter",
						{ primary: true },
					);
		return [apply, route, create, cancel(strip.kind === "thinking" ? "Keep" : "Cancel")].filter(
			(action): action is TspPickerAction => action !== undefined,
		);
	}
	const entry = hub.activeEntry();
	const refresh =
		entry.kind === "provider" && !entry.locked ? pickerAction("refresh", "Refresh provider", "f5") : undefined;
	const manage = hub.manageUrl() ? pickerAction("manage", "Manage access", "f6") : undefined;
	const assigning = hub.assigning;
	if (assigning !== null) {
		const label =
			assigning.kind === "fallback"
				? "Pick fallback"
				: assigning.kind === "fallbackKey"
					? "Pick protected model"
					: "Assign";
		const selected = hub.browser.selected()?.model;
		const invalid =
			assigning.kind !== "fallbackKey" && assigning.role === "judge" && selected
				? nativeJudgeRouteError(selected)
				: undefined;
		return [
			pickerAction("assign", label, confirmKbd(), { primary: true, ...(invalid ? { disabled: invalid } : {}) }),
			route,
			create,
			refresh,
			cancel("Cancel"),
		].filter((action): action is TspPickerAction => action !== undefined);
	}
	if (hub.rolesView()) {
		const row = hub.rolesRows[hub.roleIndex];
		// A live query takes the letter keys: those buttons keep working without keycaps.
		const searching = hub.browser.query.length > 0;
		const action = (id: RolesAction, label: string, key: string, primary = false): TspPickerAction =>
			pickerAction(
				`roles:${id}`,
				label,
				searching && key !== "enter" ? undefined : key,
				primary ? { primary: true } : undefined,
			);
		const compaction =
			hub.callbacks.onCompactionPointChange && hub.roleRowModel()
				? action("compaction", "Compaction limit", "k")
				: undefined;
		const actions: (TspPickerAction | undefined)[] = [];
		switch (row?.kind) {
			case "role": {
				const assigned = hub.roles[row.role];
				actions.push(
					action("pick", "Pick model", "enter", true),
					action("fallback", "Add fallback", "f"),
					assigned && !assigned.autoSelected ? action("clear", "Clear", "x") : undefined,
					hub.roleThinkingTarget(row.role) ? action("thinking", "Thinking", "t") : undefined,
					compaction,
					action("cycle", hub.cycleOrder().includes(row.role) ? "Leave cycle" : "Add to cycle", "c"),
					action("new", "New role", "n"),
					hub.callbacks.onSavePreset ? action("save", "Save preset", "s") : undefined,
					hub.presets().names.length > 0 ? action("nextPreset", "Next preset", "p") : undefined,
				);
				break;
			}
			case "fallback":
				actions.push(
					action("pick", "Replace", "enter", true),
					action("fallback", "Add another", "f"),
					action("clear", "Remove", "x"),
					hub.resolveFallbackEntry(row.role, row.chainIndex) ? action("thinking", "Thinking", "t") : undefined,
					compaction,
					action("earlier", "Earlier", "["),
					action("later", "Later", "]"),
				);
				break;
			case "chainKey":
				actions.push(action("pick", "Add fallback", "enter", true), action("clear", "Clear chain", "x"));
				break;
			case "newFallback":
				actions.push(action("pick", "New fallback chain", "enter", true));
				break;
			case "newRole":
				actions.push(action("pick", "New role", "enter", true));
				break;
		}
		return [...actions, route, create, closeAction()].filter(
			(value): value is TspPickerAction => value !== undefined,
		);
	}
	if (hub.lockedView())
		return entry.oauth
			? [pickerAction("login", "Log in", confirmKbd(), { primary: true }), closeAction()]
			: [closeAction()];
	return [
		pickerAction(
			"assign",
			"Assign role",
			"enter",
			hub.browser.pickerSelected ? { primary: true } : { primary: true, disabled: "No model selected" },
		),
		refresh,
		manage,
		hub.browser.query.length > 0 ? cancel("Clear search") : closeAction(),
	].filter((value): value is TspPickerAction => value !== undefined);
}

/** The open Ctrl+R / Ctrl+N step as the picker's strip: its choices as chips, or its field. */
function nativeRouteStrip(hub: ModelHubState, form: NativeRouteForm): NonNullable<TspPickerProps["strip"]> {
	const step = form.step;
	if (step.choices) {
		return {
			label: [{ s: "muted", t: `${step.label} ` }],
			items: step.choices.map((choice, index) => ({ id: String(index), label: choice.label })),
			selected: String(step.index),
		};
	}
	const preview = hub.nativeRoutePreview();
	const note = step.error
		? { s: "error", t: `  ${step.error}` }
		: preview
			? { s: "dim", t: `  ${preview}` }
			: undefined;
	return {
		label: [
			{ s: "muted", t: `${step.label} ` },
			{ s: "mono", t: nativeRouteFieldView(step).text },
			{ s: "accent", t: "▏" },
			...(note ? [note] : []),
		],
		items: [],
	};
}

/** The open strip as the picker's chip strip (or its name field). */
function pickerStrip(hub: ModelHubState, strip: StripState): NonNullable<TspPickerProps["strip"]> {
	if (strip.kind === "name") {
		if (strip.purpose === "compaction") {
			const notice = compactionNotice(hub, strip);
			return {
				label: [
					{ s: "mono", t: strip.model.id },
					{ s: "muted", t: " limit " },
					{ s: "mono", t: strip.field.text },
					{ s: "accent", t: "▏" },
					{ s: notice.style, t: `  ${notice.text}` },
				],
				items: [],
			};
		}
		return {
			label: [
				{ s: "muted", t: strip.purpose === "preset" ? "Preset name " : "New role name " },
				{ s: "mono", t: strip.field.text },
				{ s: "accent", t: "▏" },
			],
			items: [],
		};
	}
	let label: TspSpan[];
	if (strip.kind === "role") {
		// The second step of "New fallback chain…" reuses the role strip with key chips only.
		label = strip.chips.every(chip => chip.label.startsWith("for "))
			? [{ s: "muted", t: "New fallback chain" }]
			: [
					{ s: "muted", t: "Assign " },
					{ s: "mono", t: strip.item.id },
					{ s: "muted", t: " to" },
				];
	} else {
		const info = hub.source.getRoleInfo(strip.role ?? "");
		label = [
			{ s: "muted", t: strip.kind === "thinking" ? "Thinking for " : "Save " },
			{ s: "strong", t: (info.tag ?? strip.role ?? "").toLowerCase() },
			{ s: "muted", t: " · " },
			{ s: "mono", t: strip.item.id },
			...(strip.kind === "scope" ? [{ s: "muted", t: " to" }] : []),
		];
	}
	return {
		label,
		items: strip.chips.map((chip, index) => {
			const assigned = chip.role ? hub.roles[chip.role] : undefined;
			const level =
				chip.action === "thinking"
					? chip.thinkingLevel
					: chip.action === "unassign" && assigned && !assigned.autoSelected
						? assigned.thinkingLevel
						: undefined;
			const dot = level !== undefined ? thinkingDotToken(level) : undefined;
			const on =
				chip.action === "unassign" ||
				(strip.kind === "thinking" &&
					chip.thinkingLevel !== undefined &&
					chip.thinkingLevel === strip.initialThinkingLevel);
			return { id: String(index), label: chip.label, ...(on ? { on: true } : {}), ...(dot ? { dot } : {}) };
		}),
		selected: String(strip.index),
	};
}

/** The badge of a Judge row whose native route its protocol cannot post to. */
const INVALID_ROUTE_BADGE = { text: "invalid native route", tone: "error" as const };

/** Roles-view rows as picker items. */
function rolePickerItems(hub: ModelHubState): TspPickerItem[] {
	const cycle = hub.cycleOrder();
	const items: TspPickerItem[] = [];
	hub.rolesRows.forEach((row, index) => {
		const id = rolesRowKey(row, index);
		switch (row.kind) {
			case "separator":
				return;
			case "newRole":
				items.push({ id, label: "New role…", icon: "plus", tone: "muted" });
				return;
			case "newFallback":
				items.push({ id, label: "New fallback chain…", icon: "plus", tone: "muted" });
				return;
			case "chainKey":
				items.push({ id, label: row.role, mono: true, icon: "git-branch", detail: "fallback chain" });
				return;
			case "fallback":
				items.push({
					id,
					label: row.selector,
					mono: true,
					depth: 1,
					detail: `fallback ${row.chainIndex + 1}`,
					...(hub.judgeRowError(row) ? { badges: [INVALID_ROUTE_BADGE] } : {}),
				});
				return;
			case "role":
				break;
		}
		const info = hub.source.getRoleInfo(row.role);
		const tag = info.tag ?? info.name ?? row.role;
		const assignment = hub.roles[row.role];
		const facts: Record<string, string> = {};
		if (assignment) {
			const selector = `${assignment.model.provider}/${assignment.model.id}`;
			facts.model = assignment.autoSelected ? `auto → ${selector}` : selector;
			if (assignment.thinkingLevel !== ThinkingLevel.Inherit)
				facts.thinking = getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label;
		} else facts.model = "—";
		const stop = cycle.indexOf(row.role);
		const badges = [
			...(hub.judgeRowError(row) ? [INVALID_ROUTE_BADGE] : []),
			...(stop >= 0
				? [
						{
							text: `cycle ${stop + 1}`,
							tone: "accent" as const,
							title: `Stop ${stop + 1} of the quick-switch cycle`,
						},
					]
				: []),
		];
		items.push({
			id,
			label: tag,
			...(info.name && info.name !== tag ? { detail: info.name } : {}),
			facts,
			...(assignment && !assignment.autoSelected ? {} : { tone: "muted" as const }),
			...(badges.length > 0 ? { badges } : {}),
		});
	});
	return items;
}

/** Roles-view order: separators become group heads (chat roles, kind roles, model fallback chains). */
function rolePickerOrder(hub: ModelHubState): (string | TspPickerGroup)[] {
	const order: (string | TspPickerGroup)[] = [];
	let head: { group: string; label: string; count: number } | undefined;
	const open = (group: string, label: string): void => {
		head = { group, label, count: 0 };
		order.push(head);
	};
	open(hub.roleTab === "kind" ? "kind" : "chat", hub.roleTab === "kind" ? "Kind roles" : "Chat roles");
	hub.rolesRows.forEach((row, index) => {
		if (row.kind === "separator") {
			if (hub.rolesRows[index - 1]?.kind === "newRole") open("chains", "Model fallback chains");
			else open("kind", "Kind roles");
			return;
		}
		order.push(rolesRowKey(row, index));
		// Heads count roles and chains, not their entries or the "new" rows.
		if (head && (row.kind === "role" || row.kind === "chainKey")) head.count++;
	});
	return order;
}

function itemOf(model: ModelBrowserItem["model"]): ModelBrowserItem {
	return { provider: model.provider, id: model.id, model, selector: `${model.provider}/${model.id}` };
}

/** The selected Roles row's preview: its model's facts and its fallback chain. */
function rolePreview(hub: ModelHubState, row: RolesRow | undefined): JSXNode[] {
	const children: JSXNode[] = [];
	const chain = (key: string): void => {
		const entries = hub.fallbackChains()[key] ?? [];
		if (entries.length === 0) return;
		children.push(
			<section head="Fallback chain">
				<md text={entries.map((selector, index) => `${index + 1}. \`${selector}\``).join("\n")} />
			</section>,
		);
	};
	switch (row?.kind) {
		case "role": {
			const info = hub.source.getRoleInfo(row.role);
			const assignment = hub.roles[row.role];
			if (assignment) {
				children.push(...modelPreview(hub.browser, itemOf(assignment.model), "full", hub.currentSelector));
				children.push(
					<kv
						items={[
							{ k: [{ s: "muted", t: "Role" }], v: info.name },
							{
								k: [{ s: "muted", t: "Thinking" }],
								v: getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label,
							},
							{ k: [{ s: "muted", t: "Source" }], v: assignment.autoSelected ? "auto-selected" : "configured" },
						]}
					/>,
				);
			} else {
				children.push(
					<text role="omp.picker.title" text={info.name} />,
					<text spans={[{ s: "muted", t: "Not assigned; no available model fits this role." }]} wrap="word" />,
				);
			}
			chain(row.role);
			break;
		}
		case "fallback": {
			const resolved = hub.resolveFallbackEntry(row.role, row.chainIndex);
			if (resolved) children.push(...modelPreview(hub.browser, resolved.item, "full", hub.currentSelector));
			else children.push(<text spans={[{ s: "mono", t: row.selector }]} role="omp.picker.title" />);
			chain(row.role);
			break;
		}
		case "chainKey":
			children.push(<text spans={[{ s: "mono", t: row.role }]} role="omp.picker.title" />);
			chain(row.role);
			break;
		case "newRole":
			children.push(
				<text role="omp.picker.title" text="New role" />,
				<text spans={[{ s: "muted", t: "Name a custom role, then pick the model it runs on." }]} wrap="word" />,
			);
			break;
		case "newFallback":
			children.push(
				<text role="omp.picker.title" text="New fallback chain" />,
				<text
					spans={[{ s: "muted", t: "Pick the model (or provider) a new retry fallback chain protects." }]}
					wrap="word"
				/>,
			);
			break;
	}
	return children;
}

/** A signed-out provider's preview: how to sign in and its catalog. */
function lockedPreview(hub: ModelHubState): JSXNode[] {
	const entry = hub.activeEntry();
	const children: JSXNode[] = [
		<text role="omp.picker.title" text={entry.label} />,
		<text spans={[{ s: "muted", t: hub.lockedMessage(entry) }]} wrap="word" />,
	];
	const count = entry.catalogCount ?? 0;
	const models = hub.lockedCatalog(entry);
	if (count > 0 && !hub.scoped)
		children.push(
			<section head={`${count} models in catalog`}>
				<md text={models.map(model => `- \`${model.id}\``).join("\n")} />
			</section>,
		);
	return children;
}

/** The hub's native props for the current view. */
function hubProps(hub: ModelHubState): TspPickerProps {
	hub.version();
	const entry = hub.activeEntry();
	const rolesView = hub.rolesView();
	const strip = hub.strip;
	const subtitle = (): TspPickerProps["subtitle"] => {
		if (hub.assignmentPending) return hub.nativeRouteForm ? "Saving native route…" : "Applying model…";
		if (hub.nativeRouteForm) {
			const test = hub.nativeTestStatus();
			return test ? [{ s: test.style, t: test.text }] : [{ s: "accent", t: hub.nativeRouteTitle() }];
		}
		const judge = hub.judgeStatus();
		if (judge?.error) return [{ s: "error", t: judge.text }];
		const assigning = hub.assigning;
		if (assigning !== null) {
			if (assigning.kind === "fallbackKey") return "New fallback chain — pick the model it protects";
			const info = hub.source.getRoleInfo(assigning.role);
			const verb =
				assigning.kind === "role"
					? "Assigning"
					: assigning.index === null
						? "Adding fallback for"
						: "Replacing fallback of";
			return [
				{ t: `${verb} ` },
				{ s: "strong", t: info.tag ?? info.name ?? assigning.role },
				...(judge ? [{ s: "muted", t: ` · ${judge.text}` }] : []),
			];
		}
		if (judge) return [{ s: "muted", t: judge.text }];
		if (hub.configError && entry.kind !== "provider") return [{ s: "error", t: hub.configError }];
		if (entry.kind === "provider" && hub.isRefreshing(entry.providerId))
			return `${entry.label} · refreshing model list…`;
		const manageUrl = hub.manageUrl(entry);
		if (manageUrl && entry.providerId) {
			const off = hub.accessOff(entry.providerId);
			return [
				{ s: off ? "warning" : "muted", t: off ? "Off for this account · " : "On · " },
				{ s: "muted", t: `F6 manages access at ${manageUrl}` },
			];
		}
		const presets = rolesView ? hub.presets() : undefined;
		if (presets && presets.names.length > 0)
			return [
				{ s: "muted", t: "Preset " },
				presets.active ? { s: "strong", t: presets.active } : { s: "muted", t: "custom" },
				{ s: "muted", t: hub.scoped ? " · --models scope" : " · Cleared roles fall back to auto-selection" },
			];
		if (hub.scoped) return "--models scope";
		if (rolesView) return "Cleared roles fall back to auto-selection";
		return undefined;
	};
	const base: TspPickerProps = {
		title: "Models",
		subtitle: subtitle(),
		icon: "cpu",
		noun: rolesView ? "roles" : "models",
		size: "lg",
		layout: "rows",
		preview: "side",
		// The Roles rows' letter commands own printable keys until a query is live.
		query: rolesView && hub.browser.query.length === 0 ? null : hub.browser.query,
		cursor: hub.browser.cursor,
		placeholder: "Search models…",
		scopes: pickerScopes(hub),
		scope: entry.id,
		actions: pickerActions(hub),
		strip: hub.nativeRouteForm ? nativeRouteStrip(hub, hub.nativeRouteForm) : strip ? pickerStrip(hub, strip) : null,
		focus: strip || hub.nativeRouteForm ? "strip" : hub.focus === "scope" ? "scopes" : "list",
	};
	if (rolesView) {
		const row = hub.rolesRows[hub.roleIndex];
		return {
			...base,
			tabs: ROLE_TABS.map(tab => ({
				id: tab,
				label: tab === "all" ? "All" : tab === "chat" ? "Chat" : "Kinds",
				count: hub.visibleRoleIds().filter(role => tab === "all" || hub.source.getRoleInfo(role).section === tab)
					.length,
			})),
			tab: hub.roleTab,
			columns: ROLE_PICKER_COLUMNS,
			items: rolePickerItems(hub),
			order: rolePickerOrder(hub),
			selected: row && row.kind !== "separator" ? rolesRowKey(row, hub.roleIndex) : null,
			total: hub.allRolesRowCount(),
		};
	}
	const catalogue = hub.browser.pickerItems(hub.availableItems);
	const current = hub.currentSelector;
	if (hub.lockedView())
		return {
			...base,
			columns: MODEL_PICKER_COLUMNS,
			...catalogue,
			order: [],
			selected: null,
			total: entry.catalogCount ?? 0,
			empty: hub.lockedMessage(entry),
			...(current ? { current: [current] } : {}),
		};
	const query = hub.browser.query.trim();
	const grouping = {
		providers: entry.kind === "all" && query.length === 0,
		rest: entry.kind === "provider" ? entry.label : query ? "Matches" : "All models",
	};
	const view = hub.browser.pickerOrder(grouping);
	const refreshing = hub.catalogRefreshing || (entry.kind === "provider" && hub.isRefreshing(entry.providerId));
	const state =
		view.count > 0 || query
			? "ready"
			: refreshing
				? "loading"
				: hub.configError && !hub.assigning
					? "error"
					: "ready";
	const kindCounts = new Map<string, number>();
	for (const item of hub.candidateItems) {
		const kind = modelKind(item.model);
		kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
	}
	return {
		...base,
		tabs: MODEL_KIND_TABS.map(kind => ({
			id: kind,
			label: MODEL_KIND_LABELS[kind],
			count: kind === "all" ? hub.candidateItems.length : (kindCounts.get(kind) ?? 0),
		})),
		tab: hub.modelKindTab,
		...hub.browser.pickerRows(catalogue, grouping, current),
		state,
		...(state === "error" && hub.configError ? { message: hub.configError } : {}),
		empty:
			hub.emptyStateMessage()?.trim() ??
			(entry.kind === "provider" ? `No models from ${entry.label} yet` : "No models available in this scope"),
	};
}

/** The open Ctrl+R / Ctrl+N form's preview: the step's help, its choices, the request preview and outcome. */
function nativeRoutePreview(hub: ModelHubState, form: NativeRouteForm): JSXNode[] {
	const step = form.step;
	const children: JSXNode[] = [
		<text role="omp.picker.title" text={hub.nativeRouteTitle()} />,
		<text spans={[{ s: "strong", t: step.label }]} />,
		<text spans={[{ s: "muted", t: step.description }]} wrap="word" />,
	];
	if (step.choices)
		children.push(
			<kv items={step.choices.map(choice => ({ k: [{ s: "muted", t: choice.label }], v: choice.description }))} />,
		);
	const preview = hub.nativeRoutePreview();
	if (preview) children.push(<text spans={[{ s: "mono", t: preview }]} wrap="word" />);
	if (step.error) children.push(<text spans={[{ s: "error", t: step.error }]} wrap="word" />);
	const test = hub.nativeTestStatus();
	if (test) children.push(<text spans={[{ s: test.style, t: test.text }]} wrap="word" />);
	return children;
}

/** The side preview for the current view. */
function hubPreview(hub: ModelHubState): JSXNode[] {
	hub.version();
	if (hub.nativeRouteForm) return nativeRoutePreview(hub, hub.nativeRouteForm);
	if (hub.rolesView()) return rolePreview(hub, hub.rolesRows[hub.roleIndex]);
	if (hub.lockedView()) return lockedPreview(hub);
	const selected = hub.browser.selected();
	return selected ? modelPreview(hub.browser, selected, "full", hub.currentSelector) : [];
}

export function ModelHub(props: ModelHubProps): JSXNode {
	const hub = new ModelHubState(props.source, props.registry, props.scopedModels, props.callbacks, {
		...props.options,
		terminalRows: props.terminalRows,
	});
	props.onState?.(hub);
	onCleanup(() => hub.dispose());
	effect(() => hub.browser.setMaxVisible(hub.contentRows() - 7));
	const term: ModelHubTerm = { role: "omp.model-hub", hub };
	// One computation per change: `pickerItems` tracks which rows went out whole.
	const shown = computed(() => hubProps(hub));
	const prop =
		<K extends keyof TspPickerProps>(key: K) =>
		(): TspPickerProps[K] =>
			shown()[key];
	return (
		<picker
			title={prop("title")}
			subtitle={prop("subtitle")}
			icon={prop("icon")}
			noun={prop("noun")}
			size={prop("size")}
			layout={prop("layout")}
			preview={prop("preview")}
			query={prop("query")}
			cursor={prop("cursor")}
			placeholder={prop("placeholder")}
			scopes={prop("scopes")}
			scope={prop("scope")}
			actions={prop("actions")}
			strip={prop("strip")}
			focus={prop("focus")}
			tabs={prop("tabs")}
			tab={prop("tab")}
			columns={prop("columns")}
			items={prop("items")}
			itemsAdd={prop("itemsAdd")}
			itemsDel={prop("itemsDel")}
			order={prop("order")}
			hits={prop("hits")}
			selected={prop("selected")}
			current={prop("current")}
			total={prop("total")}
			state={prop("state")}
			message={prop("message")}
			empty={prop("empty")}
			term={term}
			onKey={key => hub.handleKey(key)}
			onSelect={item => hub.handleEvent({ type: "select", item })}
			onActivate={item => hub.handleEvent({ type: "activate", item })}
			onAction={(act, event) => hub.handleEvent({ type: "action", act, value: event.value })}
		>
			{() => hubPreview(hub)}
		</picker>
	);
}
