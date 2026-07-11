import {
	routeSelectListMouse,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
	truncateToWidth,
} from "@pk-nerdsaver-ai/pi-tui";
import { SETTINGS_SCHEMA } from "../../../config/settings-schema";
import { getSearchProvider, setPreferredSearchProvider } from "../../../web/search/provider";
import { isSearchProviderPreference, type SearchProviderId } from "../../../web/search/types";
import { getSelectListTheme, theme } from "../../theme/theme";
import type { SetupSceneHost, SetupTab } from "./types";

const MAX_VISIBLE = 8;

/** Reuse the settings schema as the single source of truth for labels/descriptions. */
const WEB_SEARCH_ITEMS: readonly SelectItem[] = SETTINGS_SCHEMA["providers.webSearch"].ui.options.map(option => ({
	value: option.value,
	label: option.label,
	description: option.description,
}));

type Availability = "checking" | boolean;

/**
 * "Web search" panel: picks the provider the web_search tool should prefer and
 * reports whether the highlighted provider is ready to use given current
 * credentials (env keys or OAuth sign-ins from the Sign in tab) or an
 * unauthenticated fallback.
 */
export class WebSearchTab implements SetupTab {
	readonly id = "web-search";
	readonly label = "Web search";
	readonly modal = false;

	#list: SelectList;
	#availability = new Map<SearchProviderId, Availability>();
	#status: string[] = [];
	#disposed = false;
	/** Render line where the select list begins. */
	#listRowStart = 0;

	constructor(private readonly host: SetupSceneHost) {
		this.#list = new SelectList(WEB_SEARCH_ITEMS, MAX_VISIBLE, getSelectListTheme());
		const current = host.ctx.settings.get("providers.webSearch");
		const index = WEB_SEARCH_ITEMS.findIndex(item => item.value === current);
		if (index >= 0) this.#list.setSelectedIndex(index);
		this.#list.onSelectionChange = item => this.#onHighlight(item.value);
		this.#list.onSelect = item => this.#apply(item.value);
		this.#list.onCancel = () => host.finish("skipped");
	}

	onActivate(): void {
		// Auth may have changed in the Sign in tab; re-check from scratch.
		this.#availability.clear();
		this.#status = [];
		const selected = this.#list.getSelectedItem();
		if (selected) this.#onHighlight(selected.value);
		this.host.requestRender();
	}

	handleInput(data: string): void {
		this.#list.handleInput(data);
	}

	/** Wheel moves the highlight; hover lights the row under the pointer; click confirms it. */
	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		routeSelectListMouse(this.#list, event, line - this.#listRowStart);
	}

	invalidate(): void {
		this.#list.invalidate();
	}

	dispose(): void {
		this.#disposed = true;
	}

	render(width: number): readonly string[] {
		const lines = [theme.fg("muted", "Choose the provider the web_search tool should prefer."), ""];
		this.#listRowStart = lines.length;
		lines.push(...this.#list.render(width));
		const selected = this.#list.getSelectedItem();
		if (selected) {
			lines.push("", ...this.#readinessLines(selected.value).map(line => truncateToWidth(line, width)));
		}
		if (this.#status.length > 0) {
			lines.push("", ...this.#status.map(line => truncateToWidth(line, width)));
		}
		return lines;
	}

	#onHighlight(value: string): void {
		this.#status = [];
		if (value !== "auto") this.#checkAvailability(value as SearchProviderId);
		this.host.requestRender();
	}

	#checkAvailability(id: SearchProviderId): void {
		if (this.#availability.has(id)) return;
		this.#availability.set(id, "checking");
		void (async () => {
			let ready = false;
			try {
				const provider = await getSearchProvider(id);
				ready = await provider.isExplicitlyAvailable(this.host.ctx.session.modelRegistry.authStorage);
			} catch {
				ready = false;
			}
			if (this.#disposed) return;
			this.#availability.set(id, ready);
			this.host.requestRender();
		})();
	}

	#apply(value: string): void {
		if (!isSearchProviderPreference(value)) return;
		this.host.ctx.settings.set("providers.webSearch", value);
		setPreferredSearchProvider(value);
		const label = WEB_SEARCH_ITEMS.find(item => item.value === value)?.label ?? value;
		this.#status = [theme.fg("success", `${theme.status.success} Web search set to ${label}`)];
		if (value !== "auto" && this.#availability.get(value as SearchProviderId) === false) {
			this.#status.push(theme.fg("dim", "Not configured yet — add its API key or sign in to enable it."));
		}
		this.host.requestRender();
	}

	#readinessLines(value: string): string[] {
		if (value === "auto") {
			return [theme.fg("dim", "Automatically uses the first configured provider.")];
		}
		const state = this.#availability.get(value as SearchProviderId);
		if (state === undefined || state === "checking") {
			return [theme.fg("dim", "Checking availability…")];
		}
		return state
			? [theme.fg("success", `${theme.status.success} Ready to use`)]
			: [theme.fg("warning", `${theme.status.pending} Needs credentials`)];
	}
}
