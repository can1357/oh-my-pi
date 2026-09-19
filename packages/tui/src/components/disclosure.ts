import type { Component } from "../tui";

/** A component slot; factory slots are constructed only when their branch is first rendered. */
export type DisclosureSlot = Component | (() => Component);

/** Options for a controlled, compositional disclosure. */
export interface DisclosureOptions {
	/** Content rendered in both collapsed and expanded states. */
	summary?: DisclosureSlot;
	/** Optional collapsed-only preview. */
	collapsedBody?: DisclosureSlot;
	/** Expanded-only content. A factory keeps expensive children lazy. */
	body: () => Component;
	/** Initial controlled state. Subsequent changes go through {@link Disclosure.setExpanded}. */
	expanded?: boolean;
	/** Horizontal padding applied outside every rendered slot. */
	paddingX?: number;
	/** Maximum physical rows retained from the collapsed-only preview, including its hint row. */
	maxCollapsedRows?: number;
	/** Build the final row when {@link DisclosureOptions.maxCollapsedRows} hides preview rows. */
	collapsedHint?: (hiddenRows: number, width: number) => string;
}

interface RenderCache {
	width: number;
	expanded: boolean;
	summaryRows: readonly string[];
	summarySnapshot: readonly string[];
	contentRows: readonly string[];
	contentSnapshot: readonly string[];
	lines: string[];
}

/**
 * Controlled summary/detail composition for transcript and overlay surfaces.
 *
 * The expanded body is constructed on its first expanded render, not when the
 * disclosure is created or toggled. Materialized children are retained across
 * collapse/re-expand cycles, invalidated and disposed with the disclosure, and
 * their immutable render arrays are copied rather than mutated.
 */
export class Disclosure implements Component {
	readonly #options: DisclosureOptions;
	#expanded: boolean;
	#summary: Component | undefined;
	#collapsedBody: Component | undefined;
	#body: Component | undefined;
	#ignoreTight: boolean | undefined;
	#disposed = false;
	#cache: RenderCache | undefined;
	#boundedCache:
		| {
				source: readonly string[];
				sourceSnapshot: readonly string[];
				width: number;
				rows: readonly string[];
		  }
		| undefined;

	constructor(options: DisclosureOptions) {
		this.#options = options;
		this.#expanded = options.expanded ?? false;
		if (typeof options.summary !== "function") this.#summary = options.summary;
		if (typeof options.collapsedBody !== "function") this.#collapsedBody = options.collapsedBody;
	}

	/** Current controlled expansion state. */
	get expanded(): boolean {
		return this.#expanded;
	}

	/** Show or hide the lazily constructed detail body. */
	setExpanded(expanded: boolean): void {
		if (this.#disposed || this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#cache = undefined;
		this.#boundedCache = undefined;
	}

	setIgnoreTight(ignore: boolean): this {
		if (this.#disposed || this.#ignoreTight === ignore) return this;
		this.#ignoreTight = ignore;
		this.#summary?.setIgnoreTight?.(ignore);
		this.#collapsedBody?.setIgnoreTight?.(ignore);
		this.#body?.setIgnoreTight?.(ignore);
		this.invalidate();
		return this;
	}

	invalidate(): void {
		if (this.#disposed) return;
		this.#cache = undefined;
		this.#boundedCache = undefined;
		this.#summary?.invalidate?.();
		this.#collapsedBody?.invalidate?.();
		this.#body?.invalidate?.();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#cache = undefined;
		this.#boundedCache = undefined;
		const disposed = new Set<Component>();
		for (const component of [this.#summary, this.#collapsedBody, this.#body]) {
			if (component === undefined || disposed.has(component)) continue;
			disposed.add(component);
			component.dispose?.();
		}
	}

	debugState(): Record<string, unknown> {
		return {
			expanded: this.#expanded,
			disposed: this.#disposed,
			bodyMaterialized: this.#body !== undefined,
			collapsedBodyMaterialized: this.#collapsedBody !== undefined,
			maxCollapsedRows: this.#options.maxCollapsedRows,
		};
	}

	get debugChildren(): readonly Component[] {
		if (this.#disposed) return EMPTY_COMPONENTS;
		const children: Component[] = [];
		if (this.#summary) children.push(this.#summary);
		if (this.#expanded) {
			if (this.#body) children.push(this.#body);
		} else if (this.#collapsedBody) {
			children.push(this.#collapsedBody);
		}
		return children;
	}

	render(width: number): readonly string[] {
		if (this.#disposed) return EMPTY_ROWS;
		width = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
		const configuredPadding = this.#options.paddingX ?? 0;
		const paddingX = Math.min(
			Math.max(0, Math.floor(Number.isFinite(configuredPadding) ? configuredPadding : 0)),
			Math.floor((width - 1) / 2),
		);
		const innerWidth = width - paddingX * 2;
		const summaryRows = this.#getSummary()?.render(innerWidth) ?? EMPTY_ROWS;
		let contentRows = this.#expanded
			? this.#getBody().render(innerWidth)
			: (this.#getCollapsedBody()?.render(innerWidth) ?? EMPTY_ROWS);

		if (!this.#expanded) contentRows = this.#boundCollapsedRows(contentRows, innerWidth);

		const cached = this.#cache;
		if (
			cached !== undefined &&
			cached.width === width &&
			cached.expanded === this.#expanded &&
			cached.summaryRows === summaryRows &&
			rowsMatchSnapshot(summaryRows, cached.summarySnapshot) &&
			cached.contentRows === contentRows &&
			rowsMatchSnapshot(contentRows, cached.contentSnapshot)
		) {
			return cached.lines;
		}

		const pad = paddingX > 0 ? " ".repeat(paddingX) : "";
		const lines: string[] = [];
		for (const rows of [summaryRows, contentRows]) {
			for (const row of rows) lines.push(paddingX > 0 ? `${pad}${row}${pad}` : row);
		}
		this.#cache = {
			width,
			expanded: this.#expanded,
			summaryRows,
			summarySnapshot: [...summaryRows],
			contentRows,
			contentSnapshot: [...contentRows],
			lines,
		};
		return lines;
	}

	#getSummary(): Component | undefined {
		if (this.#summary === undefined && typeof this.#options.summary === "function") {
			this.#summary = this.#options.summary();
			if (this.#ignoreTight !== undefined) this.#summary.setIgnoreTight?.(this.#ignoreTight);
		}
		return this.#summary;
	}

	#getCollapsedBody(): Component | undefined {
		if (this.#collapsedBody === undefined && typeof this.#options.collapsedBody === "function") {
			this.#collapsedBody = this.#options.collapsedBody();
			if (this.#ignoreTight !== undefined) this.#collapsedBody.setIgnoreTight?.(this.#ignoreTight);
		}
		return this.#collapsedBody;
	}

	#getBody(): Component {
		if (this.#body === undefined) {
			this.#body = this.#options.body();
			if (this.#ignoreTight !== undefined) this.#body.setIgnoreTight?.(this.#ignoreTight);
		}
		return this.#body;
	}

	#boundCollapsedRows(rows: readonly string[], width: number): readonly string[] {
		const configuredMaxRows = this.#options.maxCollapsedRows;
		if (configuredMaxRows === undefined || !Number.isFinite(configuredMaxRows)) return rows;
		const maxRows = Math.max(0, Math.floor(configuredMaxRows));
		if (rows.length <= maxRows) return rows;
		if (maxRows === 0) return EMPTY_ROWS;

		const cached = this.#boundedCache;
		if (cached?.source === rows && cached.width === width && rowsMatchSnapshot(rows, cached.sourceSnapshot)) {
			return cached.rows;
		}

		const hint = this.#options.collapsedHint;
		const bounded =
			hint === undefined
				? rows.slice(0, maxRows)
				: [...rows.slice(0, Math.max(0, maxRows - 1)), hint(rows.length - Math.max(0, maxRows - 1), width)];
		this.#boundedCache = { source: rows, sourceSnapshot: [...rows], width, rows: bounded };
		return bounded;
	}
}

function rowsMatchSnapshot(rows: readonly string[], snapshot: readonly string[]): boolean {
	if (rows.length !== snapshot.length) return false;
	for (let index = 0; index < rows.length; index++) {
		if (rows[index] !== snapshot[index]) return false;
	}
	return true;
}

const EMPTY_ROWS: readonly string[] = [];
const EMPTY_COMPONENTS: readonly Component[] = [];
