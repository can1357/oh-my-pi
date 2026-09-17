import { type SgrMouseEvent } from "../../mouse";
import { type SelectItem, SelectList } from "../../components/select-list";
import { Spacer } from "../../components/spacer";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import { Container } from "../../tui";
import { truncateToWidth } from "../../utils";
import { SEARCH_PROVIDER_OPTIONS, type SearchProviderId } from "../../tools/web-search";
import { getSelectListTheme, theme } from "../../theme/theme";
import type { SetupSceneHost, SetupTab } from "./types";

const MAX_VISIBLE = 8;

/** Reuse the shared provider options as the single source of truth for labels/descriptions. */
const WEB_SEARCH_ITEMS: readonly SelectItem[] = SEARCH_PROVIDER_OPTIONS.map(option => ({
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
	#step: WizardStep | undefined;

	readonly #host: SetupSceneHost;

	constructor(host: SetupSceneHost) {
		this.#host = host;
		this.#list = new SelectList(WEB_SEARCH_ITEMS, MAX_VISIBLE, getSelectListTheme());
		const order = host.ctx.webSearchOrder;
		const current = Array.isArray(order) && typeof order[0] === "string" ? order[0] : "auto";
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
		this.#host.requestRender();
	}

	handleInput(data: string): void {
		if (this.#step) this.#step.handleInput(data);
		else this.#list.handleInput(data);
	}

	/** Wheel moves the highlight; hover lights the row under the pointer; click confirms it. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.#step?.routeMouse(event, line, col);
	}

	invalidate(): void {
		if (this.#step) this.#step.invalidate();
		else this.#list.invalidate();
	}

	dispose(): void {
		this.#disposed = true;
	}

	render(width: number, maxLines?: number): readonly string[] {
		const intro = new Text(theme.fg("muted", "Choose the provider the web_search tool should prefer."), 0, 0);
		const status = new Container();
		const selected = this.#list.getSelectedItem();
		if (selected) {
			for (const line of this.#readinessLines(selected.value)) {
				status.addChild(new Text(truncateToWidth(line, width), 0, 0));
			}
		}
		if (selected && this.#status.length > 0) status.addChild(new Spacer(1));
		for (const line of this.#status) {
			status.addChild(new Text(truncateToWidth(line, width), 0, 0));
		}
		if (!this.#step) {
			this.#step = new WizardStep({
				kind: "choice",
				intro,
				content: this.#list,
				status,
				minContentLines: 1,
				fitContent: budget => {
					// Above: hint + blank. Below: the list's own search-status row plus
					// blank + readiness line. Shrinking keeps the selection centered.
					const visible = budget === undefined ? MAX_VISIBLE : budget - 1;
					this.#list.setMaxVisible(Math.max(1, Math.min(MAX_VISIBLE, visible)));
				},
			});
		} else {
			this.#step.setIntro(intro);
			this.#step.setStatus(status);
		}
		this.#step.setMaxHeight(maxLines);
		return this.#step.render(width);
	}

	#onHighlight(value: string): void {
		this.#status = [];
		if (value !== "auto") this.#checkAvailability(value as SearchProviderId);
		this.#host.requestRender();
	}

	#checkAvailability(id: SearchProviderId): void {
		if (this.#availability.has(id)) return;
		this.#availability.set(id, "checking");
		void (async () => {
			let ready = false;
			try {
				ready = await this.#host.ctx.isSearchProviderAvailable(id);
			} catch {
				ready = false;
			}
			if (this.#disposed) return;
			this.#availability.set(id, ready);
			this.#host.requestRender();
		})();
	}

	#apply(value: string): void {
		const option = SEARCH_PROVIDER_OPTIONS.find(option => option.value === value);
		if (!option) return;
		// The wizard picks one favorite; persist it as the head of the priority
		// list with the remaining providers in their built-in order (auto = reset).
		this.#host.ctx.saveSearchProvider(option.value);
		const label = WEB_SEARCH_ITEMS.find(item => item.value === value)?.label ?? value;
		this.#status = [theme.fg("success", `${theme.status.success} Web search set to ${label}`)];
		if (value !== "auto" && this.#availability.get(value as SearchProviderId) === false) {
			this.#status.push(theme.fg("dim", "Not configured yet — add its API key or sign in to enable it."));
		}
		this.#host.requestRender();
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
