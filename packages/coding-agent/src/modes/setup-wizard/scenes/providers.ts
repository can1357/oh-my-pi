import { type SgrMouseEvent, TabBar } from "@oh-my-pi/pi-tui";
import { getTabBarTheme } from "../../shared";
import { SignInTab } from "./sign-in";
import type { SetupScene, SetupSceneController, SetupSceneHost, SetupTab } from "./types";
import { WebSearchTab } from "./web-search";

/**
 * Tabbed "Set up your providers" scene. Composes independent panels (model
 * sign-in, web search) behind a {@link TabBar}; the active panel owns
 * rendering and input, while modal panels (e.g. an in-flight OAuth login)
 * temporarily suppress tab switching.
 */
class ProvidersSceneController implements SetupSceneController {
	title = "Set up your providers";
	subtitle = "Sign in and pick a web search provider. Press Esc when you're done.";

	#tabs: SetupTab[];
	#tabBar: TabBar;
	/** Lines the tab bar occupied in the last render (body starts one blank line below). */
	#tabRowCount = 1;

	constructor(host: SetupSceneHost) {
		this.#tabs = [new SignInTab(host), new WebSearchTab(host)];
		this.#tabBar = new TabBar(
			"Providers",
			this.#tabs.map(tab => ({ id: tab.id, label: tab.label })),
			getTabBarTheme(),
		);
		this.#tabBar.onTabChange = () => {
			this.#activeTab().onActivate?.();
			host.requestRender();
		};
	}

	#activeTab(): SetupTab {
		return this.#tabs[this.#tabBar.getActiveIndex()] ?? this.#tabs[0];
	}

	onMount(): void {
		this.#activeTab().onActivate?.();
	}

	invalidate(): void {
		for (const tab of this.#tabs) tab.invalidate();
	}

	handleInput(data: string): void {
		const tab = this.#activeTab();
		if (tab.modal) {
			tab.handleInput(data);
			return;
		}
		if (this.#tabBar.handleInput(data)) return;
		tab.handleInput(data);
	}

	/**
	 * Hit-test mouse reports against the last render: rows inside the tab bar
	 * hover/switch tabs (suppressed while the active panel is modal, matching
	 * keyboard tab cycling); everything else forwards to the active panel at
	 * panel-local coordinates. Wheel always goes to the panel so scrolling
	 * works regardless of pointer position.
	 */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		const tab = this.#activeTab();
		if (event.wheel === null && line >= 0 && line < this.#tabRowCount) {
			if (tab.modal) return;
			const hit = this.#tabBar.tabAt(line, col);
			if (event.motion) {
				this.#tabBar.setHoverTab(hit && !hit.muted ? hit.id : null);
			} else if (event.leftClick && hit) {
				this.#tabBar.selectTab(hit.id);
			}
			return;
		}
		if (event.motion) this.#tabBar.setHoverTab(null);
		const spacerRowsAfterTabs = 1;
		const bodyLine = line - this.#tabRowCount - spacerRowsAfterTabs;
		if (tab.routeMouse) {
			tab.routeMouse(event, bodyLine, col);
			return;
		}
		if (event.wheel !== null && !tab.modal) {
			tab.handleInput(event.wheel === -1 ? "\x1b[A" : "\x1b[B");
		}
	}

	render(width: number, maxLines?: number): readonly string[] {
		const tabLines = this.#tabBar.render(width);
		this.#tabRowCount = tabLines.length;
		const tabBudget = maxLines === undefined ? undefined : Math.max(1, maxLines - tabLines.length - 1);
		return [...tabLines, "", ...this.#activeTab().render(width, tabBudget)];
	}

	dispose(): void {
		for (const tab of this.#tabs) tab.dispose();
	}
}

export const providersSetupScene: SetupScene = {
	id: "providers",
	title: "Set up your providers",
	minVersion: 1,
	mount: host => new ProvidersSceneController(host),
};
