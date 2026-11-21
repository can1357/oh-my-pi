/**
 * The composer's model switcher and thinking menu.
 *
 * The switcher is omp's session model picker (alt+p) in a popover: the session orders and ranks its rows
 * (`get_model_picker`), so browsing shows the Recent block (role-held and recently used models) ahead of everything
 * else, a query ranks matches the way the TUI does (`provider/` limits them to a provider), and `@` lists the ctrl+p
 * quick roles. Rows chip the roles a model holds. A thinking slider under the rows follows the highlighted model; picking
 * a model after moving it runs the model at that level, ←/→ step it.
 */
import { Brain } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useState } from "react";
import type {
	ConfiguredThinkingLevel,
	ModelPickerResult,
	ModelPickerRow,
} from "../../../coding-agent/src/modes/rpc/wire/rpc-wire.generated";
import type { PanelModel, PanelSession } from "./session";
import { Menu, type MenuEntry } from "./ui";

/** A session's model catalog as a view sees it. */
export type ModelList =
	| { status: "loading" }
	| { status: "ready"; models: readonly PanelModel[] }
	| { status: "failed"; error: string };

const LOADING: ModelList = { status: "loading" };

/**
 * `session`'s model catalog, fetched the first time `wanted` holds; after a failure, turning `wanted` on again retries.
 * Used by the shortcut editor.
 */
export function useModelList(session: PanelSession | null, wanted: boolean): ModelList {
	const [loaded, setLoaded] = useState<{ session: PanelSession; list: ModelList } | null>(null);
	useEffect(() => {
		if (!wanted || session?.listModels === undefined) return;
		let alive = true;
		setLoaded(current => (current?.session === session && current.list.status === "failed" ? null : current));
		void session.listModels().then(
			models => {
				if (alive) setLoaded({ session, list: { status: "ready", models } });
			},
			(error: unknown) => {
				if (alive)
					setLoaded({
						session,
						list: { status: "failed", error: error instanceof Error ? error.message : String(error) },
					});
			},
		);
		return () => {
			alive = false;
		};
	}, [session, wanted]);
	return loaded?.session === session ? loaded.list : LOADING;
}

/** Labels of thinking selectors, as omp's picker slider and thinking selector name them. */
const LEVEL_LABELS: Readonly<Record<string, string>> = {
	auto: "Auto",
	off: "Off",
	minimal: "Min",
	low: "Low",
	medium: "Med",
	high: "High",
	xhigh: "XHigh",
	max: "Max",
};
/** What each selector does, for the thinking menu. */
const LEVEL_DESCRIPTIONS: Readonly<Record<string, string>> = {
	auto: "omp picks the effort each turn",
	off: "No reasoning",
	minimal: "Very brief reasoning",
	low: "Light reasoning",
	medium: "Moderate reasoning",
	high: "Deep reasoning",
	xhigh: "Extended reasoning",
	max: "Maximum reasoning the model supports",
};
/** Efforts low to high, for showing a pending level on a model whose ladder lacks it. */
const EFFORTS: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** A selector's short label. */
export function levelLabel(level: string): string {
	return LEVEL_LABELS[level] ?? level;
}

/**
 * `level` as one of `steps`: kept when the model offers it, an effort lowered to the nearest one it has (else its
 * lowest), anything else as off. The session clamps again on the switch; this keeps the slider honest meanwhile.
 */
function onLadder(level: ConfiguredThinkingLevel, steps: readonly ConfiguredThinkingLevel[]): ConfiguredThinkingLevel {
	if (steps.includes(level)) return level;
	const wanted = EFFORTS.indexOf(level);
	const efforts = steps.filter(step => EFFORTS.includes(step));
	if (wanted === -1 || efforts.length === 0) return "off";
	return efforts.findLast(step => EFFORTS.indexOf(step) <= wanted) ?? efforts[0]!;
}

function rowId(row: ModelPickerRow): string {
	return row.role === undefined ? `${row.provider}/${row.id}` : `@${row.role}`;
}

type PickerState =
	| { status: "loading" }
	| { status: "ready"; query: string; result: ModelPickerResult }
	| { status: "failed"; error: string };

/** Popover above the model chip; picking a row hands its model (and the slider's level) to `onPick` and closes. */
export function ModelPicker(props: {
	session: PanelSession;
	onPick(model: PanelModel, options: { thinkingLevel?: ConfiguredThinkingLevel; role?: string }): void;
	onClose(): void;
}): ReactNode {
	const { session } = props;
	const [query, setQuery] = useState("");
	const [state, setState] = useState<PickerState>({ status: "loading" });
	const [activeId, setActiveId] = useState<string | null>(null);
	/** The slider's level once moved; untouched, each model shows the level the session would run it at. */
	const [pending, setPending] = useState<ConfiguredThinkingLevel | null>(null);

	useEffect(() => {
		if (session.pickModels === undefined) return;
		let alive = true;
		session.pickModels(query).then(
			result => {
				if (alive) setState({ status: "ready", query, result });
			},
			(error: unknown) => {
				if (alive) setState({ status: "failed", error: error instanceof Error ? error.message : String(error) });
			},
		);
		return () => {
			alive = false;
		};
	}, [session, query]);

	const result = state.status === "ready" ? state.result : null;
	const rows = result?.rows ?? [];
	const roleMode = query.startsWith("@");
	const entries: MenuEntry[] = [];
	rows.forEach((row, index) => {
		if (result !== null && result.recent > 0 && (index === 0 || index === result.recent))
			entries.push({
				kind: "caption",
				id: index === 0 ? "recent" : "rest",
				label: index === 0 ? "Recent" : query.trim() ? "Matches" : "All",
			});
		const id = rowId(row);
		entries.push({
			kind: "item",
			id,
			label: row.role === undefined ? row.name || row.id : `@${row.role}`,
			description: `${row.provider}/${row.id}${row.overContext ? " · context too large, compacts" : ""}`,
			meta:
				row.role === undefined
					? row.roles?.map(role => role.label).join(" · ")
					: row.thinkingLevel === undefined
						? undefined
						: levelLabel(row.thinkingLevel),
			checked: row.current === true,
			onSelect: () => {
				const model = { provider: row.provider, id: row.id, name: row.name };
				if (row.role !== undefined) {
					props.onPick(model, {
						role: row.role,
						...(row.thinkingLevel === undefined ? {} : { thinkingLevel: row.thinkingLevel }),
					});
					return;
				}
				const level = pending !== null && row.thinking !== undefined ? onLadder(pending, row.thinking) : undefined;
				props.onPick(model, level === undefined ? {} : { thinkingLevel: level });
			},
		});
	});
	const hidden = (result?.total ?? 0) - rows.length;
	if (hidden > 0)
		entries.push({
			kind: "caption",
			id: "more",
			label: query.trim() ? `${hidden.toLocaleString()} more matches, keep typing` : `Type to search ${hidden.toLocaleString()} more`,
		});

	const highlighted = roleMode ? undefined : (rows.find(row => rowId(row) === activeId) ?? rows[0]);
	const steps = highlighted?.thinking;
	const shown =
		highlighted === undefined || steps === undefined
			? undefined
			: pending !== null
				? onLadder(pending, steps)
				: (highlighted.thinkingLevel ?? "off");
	const step = (delta: -1 | 1): boolean => {
		if (steps === undefined || shown === undefined) return false;
		const next = steps[Math.max(0, Math.min(steps.length - 1, steps.indexOf(shown) + delta))];
		if (next !== undefined) setPending(next);
		return true;
	};
	const onKey = (event: ReactKeyboardEvent): boolean => {
		if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
		if (event.key === "ArrowLeft") return step(-1);
		if (event.key === "ArrowRight") return step(1);
		return false;
	};
	const footer =
		highlighted === undefined ? null : (
			<div className="pn-thinking-slider" role="radiogroup" aria-label="Thinking level">
				<Brain size={13} />
				{steps === undefined || shown === undefined ? (
					<span className="pn-thinking-none">no thinking</span>
				) : (
					steps.map(level => (
						<button
							key={level}
							type="button"
							role="radio"
							aria-checked={level === shown}
							className="pn-thinking-step"
							onClick={() => setPending(level)}
						>
							{levelLabel(level)}
						</button>
					))
				)}
			</div>
		);

	const empty =
		state.status === "loading"
			? "Loading models…"
			: state.status === "failed"
				? `Couldn’t load models: ${state.error}`
				: roleMode
					? "No quick roles in the ctrl+p cycle"
					: query.trim()
						? `No models match “${query.trim()}”`
						: "No models available";
	return (
		<Menu
			entries={entries}
			className="pn-pop pn-pop--above-right pn-model-menu"
			width={320}
			dense
			autoFocus
			empty={empty}
			search={{ value: query, placeholder: "Search, @ for roles…", onChange: setQuery }}
			footer={footer}
			onActiveChange={setActiveId}
			onKey={onKey}
			onClose={props.onClose}
		/>
	);
}

/** Popover above the thinking chip: the selectors the session's model accepts. */
export function ThinkingMenu(props: {
	level: ConfiguredThinkingLevel;
	levels: readonly ConfiguredThinkingLevel[];
	onPick(level: ConfiguredThinkingLevel): void;
	onClose(): void;
}): ReactNode {
	const entries: MenuEntry[] = props.levels.map(level => ({
		kind: "item",
		id: level,
		label: levelLabel(level),
		description: LEVEL_DESCRIPTIONS[level],
		checked: level === props.level,
		onSelect: () => props.onPick(level),
	}));
	return (
		<Menu
			entries={entries}
			className="pn-pop pn-pop--above-right"
			width={240}
			dense
			autoFocus
			onClose={props.onClose}
		/>
	);
}
