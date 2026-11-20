/**
 * The composer's model switcher: a searchable popover over the session's model catalog, which can run to thousands of
 * models across dozens of providers. Without a query it lists the current model, the rest of its provider, then every
 * other provider in turn; a query ranks every model by fuzzy match, the current provider winning ties. Either view
 * shows at most {@link MAX_ROWS} rows.
 */
import { FuzzyCorpus } from "@oh-my-pi/pi-tui/fuzzy";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { PanelModel, PanelSession } from "./session";
import { Menu, type MenuEntry } from "./ui";

/** Rows rendered at once; typing reaches the rest. */
const MAX_ROWS = 100;

/** A session's model catalog as a view sees it. */
export type ModelList =
	| { status: "loading" }
	| { status: "ready"; models: readonly PanelModel[] }
	| { status: "failed"; error: string };

const LOADING: ModelList = { status: "loading" };
const NO_MODELS: readonly PanelModel[] = [];

/**
 * `session`'s model catalog, fetched the first time `wanted` holds; after a failure, turning `wanted` on again retries.
 * Used by the composer's picker and the shortcut editor.
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

function same(a: PanelModel, b: PanelModel | null): boolean {
	return b !== null && a.provider === b.provider && a.id === b.id;
}

/** The current model, the rest of its provider, then the other providers alphabetically; catalog order within each. */
function browseOrder(models: readonly PanelModel[], current: PanelModel | null): PanelModel[] {
	const home = current?.provider;
	return models.toSorted(
		(a, b) =>
			Number(same(b, current)) - Number(same(a, current)) ||
			Number(b.provider === home) - Number(a.provider === home) ||
			a.provider.localeCompare(b.provider),
	);
}

/** Fuzzy matches best first; near-equal scores prefer the current provider. */
function searchOrder(corpus: FuzzyCorpus<PanelModel>, query: string, current: PanelModel | null): PanelModel[] {
	const home = current?.provider;
	return corpus
		.rank(query)
		.sort(
			(a, b) =>
				Math.round(a.score / 10) - Math.round(b.score / 10) ||
				Number(b.item.provider === home) - Number(a.item.provider === home) ||
				a.score - b.score,
		)
		.map(result => result.item);
}

/** Popover above the model chip; picking a row hands its model to `onPick` and closes. */
export function ModelPicker(props: {
	list: ModelList;
	current: PanelModel | null;
	onPick(model: PanelModel): void;
	onClose(): void;
}): ReactNode {
	const { list, current } = props;
	const [query, setQuery] = useState("");
	const models = list.status === "ready" ? list.models : NO_MODELS;
	const corpus = useMemo(() => new FuzzyCorpus(models, model => `${model.name} ${model.provider}/${model.id}`), [models]);
	const trimmed = query.trim();
	const browsing = trimmed === "";
	const ordered = useMemo(
		() => (browsing ? browseOrder(models, current) : searchOrder(corpus, trimmed, current)),
		[browsing, models, corpus, trimmed, current],
	);

	const entries: MenuEntry[] = [];
	let group: string | null = null;
	for (const model of ordered.slice(0, MAX_ROWS)) {
		// Browsing groups rows under provider captions; search results carry their provider on the row.
		if (browsing && model.provider !== group) {
			group = model.provider;
			entries.push({ kind: "caption", id: `provider-${group}`, label: group });
		}
		entries.push({
			kind: "item",
			id: `${model.provider}/${model.id}`,
			label: model.name || model.id,
			// Names repeat within a provider (dated snapshots, aliases); the id tells the rows apart.
			description: browsing ? model.id : `${model.provider}/${model.id}`,
			checked: same(model, current),
			onSelect: () => props.onPick(model),
		});
	}
	const hidden = ordered.length - MAX_ROWS;
	if (hidden > 0)
		entries.push({
			kind: "caption",
			id: "more",
			label: browsing
				? `Type to search ${hidden.toLocaleString()} more`
				: `${hidden.toLocaleString()} more matches, keep typing`,
		});

	const empty =
		list.status === "loading"
			? "Loading models…"
			: list.status === "failed"
				? `Couldn’t load models: ${list.error}`
				: browsing
					? "No models available"
					: `No models match “${trimmed}”`;
	return (
		<Menu
			entries={entries}
			className="pn-pop pn-pop--above-right pn-model-menu"
			width={300}
			dense
			autoFocus
			empty={empty}
			search={{ value: query, placeholder: "Search models", onChange: setQuery }}
			onClose={props.onClose}
		/>
	);
}
