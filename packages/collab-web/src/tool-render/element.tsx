/**
 * `<omp-tool-view>` — web-component wrapper around ToolView for non-React
 * hosts (the exported-session HTML page).
 *
 * Payload sources, in priority order:
 * 1. `el.data = {...}` property assignment.
 * 2. `data-key` attribute → lookup in `globalThis.__OMP_TOOL_VIEW_DATA`
 *    (a Map populated by the host before inserting markup via innerHTML;
 *    survives `cloneNode` since only the key attribute is copied).
 * 3. `payload` attribute → inline JSON.
 *
 * The boolean `open` attribute expands the card by default.
 */
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { ToolView, type ToolViewProps } from "./ToolView";

type PayloadStore = { get(key: string): ToolViewProps | undefined };

export class OmpToolViewElement extends HTMLElement {
	#root: Root | null = null;
	#data: ToolViewProps | null = null;

	set data(value: ToolViewProps) {
		this.#data = value;
		this.#render();
	}

	connectedCallback(): void {
		this.#render();
	}

	disconnectedCallback(): void {
		const root = this.#root;
		this.#root = null;
		// Defer: React forbids synchronous unmount during a concurrent render.
		if (root) queueMicrotask(() => root.unmount());
	}

	#resolveProps(): ToolViewProps | null {
		if (this.#data) return this.#data;
		const key = this.getAttribute("data-key");
		if (key) {
			const store = (globalThis as { __OMP_TOOL_VIEW_DATA?: PayloadStore }).__OMP_TOOL_VIEW_DATA;
			const props = store?.get(key);
			if (props) return props;
		}
		const payload = this.getAttribute("payload");
		if (payload) {
			try {
				const parsed: unknown = JSON.parse(payload);
				if (parsed && typeof parsed === "object") return parsed as ToolViewProps;
			} catch {
				// fall through to null — element renders nothing
			}
		}
		return null;
	}

	#render(): void {
		if (!this.isConnected) return;
		const props = this.#resolveProps();
		if (!props || typeof props.name !== "string") return;
		this.#root ??= createRoot(this);
		this.#root.render(<ToolView {...props} defaultOpen={props.defaultOpen ?? this.hasAttribute("open")} />);
	}
}

export function defineToolViewElement(tag = "omp-tool-view"): void {
	if (!customElements.get(tag)) customElements.define(tag, OmpToolViewElement);
}
