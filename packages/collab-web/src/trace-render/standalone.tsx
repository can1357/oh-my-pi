/** Self-contained, shadow-scoped trace viewer registered by the export bundle. */
import statsStyles from "@oh-my-pi/omp-stats/client/styles.css" with { type: "text" };
import {
	type SessionTrace,
	SessionTraceView,
	type TraceEntryLoader,
	TraceThemeRoot,
} from "@oh-my-pi/omp-stats/client/traces";
import traceStyles from "@oh-my-pi/omp-stats/client/traces/traces.css" with { type: "text" };
import { createRoot, type Root } from "react-dom/client";

/** Embedded transcripts and trace consumed by the standalone export element. */
export interface ExportTraceSessionData {
	trace?: SessionTrace;
	entries: Array<{ id: string }>;
	subSessions?: Record<string, { entries: Array<{ id: string }> }>;
}

// Keep the dashboard's styles inside the shadow tree. Theme values supplied by
// the host win over these defaults, including custom TUI export palettes.
const scopedStyles = statsStyles
	.replaceAll(":root", ":host")
	.replaceAll('[data-theme="dark"]', ':host([data-theme="dark"])')
	.replaceAll('[data-theme="light"]', ':host([data-theme="light"])');
const themeTokens = [
	...new Set<string>(
		[...statsStyles.slice(0, statsStyles.indexOf("Reset & base")).matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]),
	),
];
const styles = `${scopedStyles}\n${traceStyles}\n
:host {
	display: block;
	min-width: 0;
	font-family: var(--font-sans);
	font-size: 13.5px;
	line-height: 1.5;
	color: var(--ink-1);
	color-scheme: dark;
}
:host([data-theme="light"]) { color-scheme: light; }
:host([hidden]) { display: none; }
.traces-inline-detail { border: 1px solid var(--line-2); border-radius: var(--r-card); background: var(--card); overflow: hidden; }
.traces-inline-detail .drawer-header { position: static; }
.traces-inline-detail .drawer-body { overflow: visible; }
.traces-view[data-view="timeline"] .traces-timeline { max-height: 280px; }
.traces-view .card { animation: none; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;

/** Hosts the shared trace viewer with offline entry lookup and scoped theme styles. */
export class OmpSessionTraceElement extends HTMLElement {
	static observedAttributes = ["view"];
	#root: Root | null = null;
	#mount: HTMLDivElement;
	#data: ExportTraceSessionData | null = null;
	#entries = new Map<string, Map<string, { id: string }>>();
	#themeObserver: MutationObserver | null = null;
	#scheme = matchMedia("(prefers-color-scheme: light)");

	constructor() {
		super();
		const shadow = this.attachShadow({ mode: "open" });
		const style = document.createElement("style");
		style.textContent = styles;
		this.#mount = document.createElement("div");
		shadow.append(style, this.#mount);
		// Keep embedded controls from triggering the outer transcript shortcuts.
		shadow.addEventListener("keydown", event => event.stopPropagation());
	}

	get sessionData(): ExportTraceSessionData | null {
		return this.#data;
	}

	set sessionData(value: ExportTraceSessionData | null) {
		this.#data = value;
		this.#entries.clear();
		this.#render();
	}

	connectedCallback(): void {
		// Honor a property set before the browser upgraded the custom element.
		if (Object.hasOwn(this, "sessionData")) {
			const value = this.sessionData;
			Reflect.deleteProperty(this, "sessionData");
			this.sessionData = value;
		}
		this.#syncTheme();
		this.#themeObserver = new MutationObserver(this.#syncTheme);
		this.#themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme", "style", "class"],
		});
		this.#scheme.addEventListener("change", this.#syncTheme);
		this.#render();
	}

	disconnectedCallback(): void {
		this.#themeObserver?.disconnect();
		this.#themeObserver = null;
		this.#scheme.removeEventListener("change", this.#syncTheme);
		queueMicrotask(() => {
			if (this.isConnected) return;
			this.#root?.unmount();
			this.#root = null;
		});
	}

	attributeChangedCallback(): void {
		this.#render();
	}

	#syncTheme = (): void => {
		const theme = document.documentElement.dataset.theme;
		this.dataset.theme = theme === "light" || theme === "dark" ? theme : this.#scheme.matches ? "light" : "dark";
		const inherited = getComputedStyle(this.parentElement ?? document.documentElement);
		for (const token of themeTokens) {
			const value = inherited.getPropertyValue(token).trim();
			if (value) this.style.setProperty(token, value);
			else this.style.removeProperty(token);
		}
	};

	#loadEntry: TraceEntryLoader = async (file, entryId, signal) => {
		if (signal.aborted) throw new DOMException("Entry load aborted", "AbortError");
		let entries = this.#entries.get(file);
		if (!entries) {
			const source = file === "main" ? this.#data?.entries : this.#data?.subSessions?.[file]?.entries;
			entries = new Map((source ?? []).map(entry => [entry.id, entry]));
			this.#entries.set(file, entries);
		}
		const entry = entries.get(entryId);
		if (!entry) throw new Error("This entry is not present in the exported snapshot.");
		return { entry };
	};

	#navigate = (trackId: string, entryId: string): void => {
		this.dispatchEvent(
			new CustomEvent("trace-navigate", {
				detail: { trackId, entryId },
				bubbles: true,
				composed: true,
			}),
		);
	};

	#render(): void {
		if (!this.isConnected) return;
		this.#root ??= createRoot(this.#mount);
		this.#root.render(
			<TraceThemeRoot.Provider value={this}>
				{this.#data?.trace ? (
					<SessionTraceView
						trace={this.#data.trace}
						view={this.getAttribute("view") === "full" ? "full" : "timeline"}
						loadEntry={this.#loadEntry}
						onNavigate={this.#navigate}
						embedded
					/>
				) : (
					<p role="status">No trace data in this export.</p>
				)}
			</TraceThemeRoot.Provider>,
		);
	}
}

if (!customElements.get("omp-session-trace")) {
	customElements.define("omp-session-trace", OmpSessionTraceElement);
}
