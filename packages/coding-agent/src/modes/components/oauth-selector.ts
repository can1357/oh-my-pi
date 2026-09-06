import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth/types";
import {
	Container,
	extractPrintableText,
	fuzzyFilter,
	matchesKey,
	ScrollView,
	type SgrMouseEvent,
	Spacer,
	TruncatedText,
} from "@oh-my-pi/pi-tui";
import { settings } from "../../config/settings";
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import type { AuthStorage, CredentialOriginKind } from "../../session/auth-storage";
import { OverlayPanel } from "./overlay-box";

const OAUTH_SELECTOR_MAX_VISIBLE = 10;

/**
 * Provider ids the user has disabled via settings. `/login` (login mode) hides
 * these so a disabled provider's models stay out of reach end-to-end, mirroring
 * the model picker's `disabledProviders` filtering. Reads the settings singleton
 * defensively: it throws before `Settings.init()`, in which case nothing is disabled.
 */
function getDisabledProviderIds(): ReadonlySet<string> {
	try {
		return new Set(settings.get("disabledProviders"));
	} catch {
		return new Set();
	}
}

/**
 * Rendered lines before the provider rows: top border
 * (must mirror the constructor's addChild order).
 */
const LIST_ROW_OFFSET = 1;

/** Compact, human-readable tag for each credential-origin leg. */
const ORIGIN_LABELS: Record<CredentialOriginKind, string> = {
	runtime: "--api-key",
	config: "config",
	oauth: "login",
	api_key: "api key",
	env: "env",
	fallback: "custom provider",
};
/**
 * Component that renders an OAuth provider selector.
 */
export class OAuthSelectorComponent extends OverlayPanel {
	#listContainer: Container;
	#allProviders: OAuthProviderInfo[] = [];
	#filteredProviders: OAuthProviderInfo[] = [];
	#searchQuery = "";
	#selectedIndex: number = 0;
	#hoveredIndex: number | null = null;
	/** First provider index of the visible ScrollView window (last #updateList). */
	#scrollStart = 0;
	#visibleCount = 0;
	/** Visible list window, shrunk by {@link setMaxHeight} on short screens. */
	#maxVisible = OAUTH_SELECTOR_MAX_VISIBLE;
	#mode: "login" | "logout";
	#authStorage: AuthStorage;
	#onSelectCallback: (providerId: string) => void;
	#onCancelCallback: () => void;
	#statusMessage: string | undefined;
	#validateAuthCallback?: (providerId: string) => Promise<boolean>;
	#requestRenderCallback?: () => void;
	#authState: Map<string, "checking" | "valid" | "invalid"> = new Map();
	#spinnerFrame: number = 0;
	#spinnerInterval?: NodeJS.Timeout;
	#validationGeneration: number = 0;
	constructor(
		mode: "login" | "logout",
		authStorage: AuthStorage,
		onSelect: (providerId: string) => void,
		onCancel: () => void,
		options?: {
			validateAuth?: (providerId: string) => Promise<boolean>;
			requestRender?: () => void;
		},
	) {
		super(mode === "login" ? "Select provider to login" : "Select provider to logout");
		this.#mode = mode;
		this.#authStorage = authStorage;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#validateAuthCallback = options?.validateAuth;
		this.#requestRenderCallback = options?.requestRender;
		// Load all OAuth providers
		this.#loadProviders();
		// Create list container
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		// Initial render
		this.#updateList();
		this.#startValidation();
	}

	stopValidation(): void {
		this.#validationGeneration += 1;
		this.#stopSpinner();
	}

	/**
	 * Fit the selector into `lines` rendered rows by shrinking the visible list
	 * window (the window is centered on the selection, so the selected row is
	 * always visible at any height). Prefers keeping the full chrome — borders,
	 * spacers, title, search status — but sacrifices the trailing spacer/border
	 * (clipped by the host) before dropping below three visible rows.
	 */
	setMaxHeight(lines: number): void {
		// Above the rows: LIST_ROW_OFFSET; below: search status + border.
		const strict = lines - LIST_ROW_OFFSET - 2;
		// Keeps only the rows + search status inside `lines`.
		const relaxed = lines - LIST_ROW_OFFSET - 1;
		const rows = Math.min(OAUTH_SELECTOR_MAX_VISIBLE, Math.max(1, strict, Math.min(relaxed, 3)));
		if (rows === this.#maxVisible) return;
		this.#maxVisible = rows;
		this.#updateList();
	}
	#hasSelectableAuth(providerId: string): boolean {
		return this.#mode === "logout" ? this.#authStorage.has(providerId) : this.#authStorage.hasAuth(providerId);
	}

	#loadProviders(): void {
		const providers = getOAuthProviders();
		if (this.#mode === "logout") {
			// Logout stays unfiltered by `disabledProviders`: a now-disabled
			// provider may still hold stored credentials worth removing.
			this.#allProviders = providers.filter(provider => this.#hasSelectableAuth(provider.id));
		} else {
			const disabled = getDisabledProviderIds();
			// Hide a login entry when either its own id or the provider id it
			// stores credentials under is disabled, so alias logins (e.g.
			// `openai-codex-device` ⇒ `openai-codex`) disappear alongside the
			// model provider they authenticate.
			this.#allProviders = providers.filter(
				provider =>
					!disabled.has(provider.id) &&
					!(provider.storeCredentialsAs && disabled.has(provider.storeCredentialsAs)),
			);
		}
		this.#filteredProviders = this.#allProviders;
	}

	#startValidation(): void {
		if (!this.#validateAuthCallback) return;
		const generation = this.#validationGeneration + 1;
		this.#validationGeneration = generation;

		let pending = 0;
		for (const provider of this.#allProviders) {
			if (!this.#hasSelectableAuth(provider.id)) {
				this.#authState.delete(provider.id);
				continue;
			}
			this.#authState.set(provider.id, "checking");
			pending += 1;
			void this.#validateProvider(provider.id, generation);
		}

		if (pending > 0) {
			this.#startSpinner();
			this.#updateList();
			this.#requestRenderCallback?.();
		}
	}

	async #validateProvider(providerId: string, generation: number): Promise<void> {
		if (!this.#validateAuthCallback) return;
		let isValid = false;
		try {
			isValid = await this.#validateAuthCallback(providerId);
		} catch {
			isValid = false;
		}

		if (generation !== this.#validationGeneration) return;
		this.#authState.set(providerId, isValid ? "valid" : "invalid");
		if (![...this.#authState.values()].includes("checking")) {
			this.#stopSpinner();
		}
		this.#updateList();
		this.#requestRenderCallback?.();
	}

	#startSpinner(): void {
		if (this.#spinnerInterval) return;
		this.#spinnerInterval = setInterval(() => {
			const frameCount = theme.spinnerFrames.length;
			if (frameCount > 0) {
				this.#spinnerFrame = (this.#spinnerFrame + 1) % frameCount;
			}
			this.#updateList();
			this.#requestRenderCallback?.();
		}, 80);
	}

	#stopSpinner(): void {
		if (this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
		}
	}

	/**
	 * Muted provenance suffix (" (env: COPILOT_GITHUB_TOKEN)", " (login)", …) so
	 * the list distinguishes a real login from an env var aliasing the provider.
	 */
	#getSourceLabel(providerId: string): string {
		const origin = this.#authStorage.getCredentialOrigin(providerId);
		if (!origin) return "";
		const detail = origin.kind === "env" && origin.envVar ? `env: ${origin.envVar}` : ORIGIN_LABELS[origin.kind];
		return theme.fg("muted", ` (${detail})`);
	}

	#getStatusIndicator(providerId: string): string {
		const state = this.#authState.get(providerId);
		const source = this.#getSourceLabel(providerId);
		if (state === "checking") {
			const frameCount = theme.spinnerFrames.length;
			const spinner = frameCount > 0 ? theme.spinnerFrames[this.#spinnerFrame % frameCount] : theme.status.pending;
			return theme.fg("warning", ` ${spinner} checking`) + source;
		}
		if (state === "invalid") {
			return theme.fg("error", ` ${theme.status.error} invalid`) + source;
		}
		if (state === "valid") {
			return theme.fg("success", ` ${theme.status.enabled} logged in`) + source;
		}
		return this.#hasSelectableAuth(providerId)
			? theme.fg("success", ` ${theme.status.enabled} logged in`) + source
			: "";
	}

	#isSearchEnabled(): boolean {
		return this.#allProviders.length > this.#maxVisible;
	}

	#shouldRenderSearchStatus(): boolean {
		return this.#isSearchEnabled() || this.#searchQuery.length > 0;
	}

	#renderStatusLine(_total: number): string {
		const query = this.#searchQuery.trim();
		const suffix = query ? `Search: ${this.#searchQuery}` : "Type to search";
		return theme.fg("muted", suffix);
	}

	#getProviderSearchText(provider: OAuthProviderInfo): string {
		let text = `${provider.name} ${provider.id}`;
		const origin = this.#authStorage.getCredentialOrigin(provider.id);
		if (origin) {
			text += ` logged in authenticated ${ORIGIN_LABELS[origin.kind]}`;
			if (origin.envVar) text += ` ${origin.envVar}`;
		}
		if (!provider.available) {
			text += " unavailable";
		}
		return text;
	}

	#setSearchQuery(query: string): void {
		this.#searchQuery = query;
		this.#filteredProviders = query.trim()
			? fuzzyFilter(this.#allProviders, query, provider => this.#getProviderSearchText(provider))
			: this.#allProviders;
		this.#selectedIndex = 0;
		this.#statusMessage = undefined;
		this.#updateList();
	}

	#handleSearchInput(keyData: string): boolean {
		if (!this.#isSearchEnabled()) return false;

		if (matchesKey(keyData, "backspace")) {
			if (this.#searchQuery.length === 0) return false;
			const chars = [...this.#searchQuery];
			chars.pop();
			this.#setSearchQuery(chars.join(""));
			return true;
		}

		const printableText = extractPrintableText(keyData);
		if (printableText === undefined) return false;
		if (this.#searchQuery.length === 0 && printableText.trim().length === 0) return false;

		this.#setSearchQuery(this.#searchQuery + printableText);
		return true;
	}

	#updateList(): void {
		this.#listContainer.clear();

		const total = this.#filteredProviders.length;
		const maxVisible = this.#maxVisible;
		const startIndex =
			total <= maxVisible
				? 0
				: Math.max(0, Math.min(this.#selectedIndex - Math.floor(maxVisible / 2), total - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, total);
		this.#scrollStart = startIndex;
		this.#visibleCount = endIndex - startIndex;

		const rows: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const provider = this.#filteredProviders[i];
			if (!provider) continue;
			const isSelected = i === this.#selectedIndex;
			const isAvailable = provider.available;
			const statusIndicator = this.#getStatusIndicator(provider.id);

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", `${theme.nav.cursor} `);
				const text = isAvailable ? theme.fg("accent", provider.name) : theme.fg("dim", provider.name);
				line = prefix + text + statusIndicator;
			} else {
				const text = isAvailable ? `  ${provider.name}` : theme.fg("dim", `  ${provider.name}`);
				line = text + statusIndicator;
			}
			if (!isSelected && i === this.#hoveredIndex) {
				line = theme.bg("selectedBg", line);
			}
			rows.push(line);
		}

		if (rows.length > 0) {
			const sv = new ScrollView(rows, {
				height: rows.length,
				scrollbar: "auto",
				totalRows: total,
				theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
			});
			sv.setScrollOffset(startIndex);
			this.#listContainer.addChild(sv);
		}

		// Search status line (scrollbar covers overflow indication)
		if (this.#shouldRenderSearchStatus()) {
			this.#listContainer.addChild(new TruncatedText(this.#renderStatusLine(total), 0, 0));
		}

		if (total === 0) {
			const message =
				this.#allProviders.length === 0
					? this.#mode === "login"
						? "No OAuth providers available"
						: "No stored provider credentials to log out"
					: "No matching providers";
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", message), 0, 0));
		}
		if (this.#statusMessage) {
			this.#listContainer.addChild(new Spacer(1));
			this.#listContainer.addChild(new TruncatedText(theme.fg("warning", this.#statusMessage), 0, 0));
		}
	}
	handleInput(keyData: string): void {
		// Escape or Ctrl+C
		if (matchesSelectCancel(keyData)) {
			this.stopValidation();
			this.#onCancelCallback();
			return;
		}

		if (this.#handleSearchInput(keyData)) {
			return;
		}

		// Up arrow
		if (matchesSelectUp(keyData)) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === 0 ? this.#filteredProviders.length - 1 : this.#selectedIndex - 1;
			}
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// Down arrow
		else if (matchesSelectDown(keyData)) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === this.#filteredProviders.length - 1 ? 0 : this.#selectedIndex + 1;
			}
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// Page up - jump up by one visible page
		else if (matchesKey(keyData, "pageUp")) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex = Math.max(0, this.#selectedIndex - this.#maxVisible);
			}
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// Page down - jump down by one visible page
		else if (matchesKey(keyData, "pageDown")) {
			if (this.#filteredProviders.length > 0) {
				this.#selectedIndex = Math.min(this.#filteredProviders.length - 1, this.#selectedIndex + this.#maxVisible);
			}
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// Enter
		else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#confirmSelection();
		}
	}

	/** Confirm the selected provider (Enter or mouse click). */
	#confirmSelection(): void {
		const selectedProvider = this.#filteredProviders[this.#selectedIndex];
		if (selectedProvider?.available) {
			this.#statusMessage = undefined;
			this.stopValidation();
			this.#onSelectCallback(selectedProvider.id);
		} else if (selectedProvider) {
			this.#statusMessage = "Provider unavailable in this environment.";
			this.#updateList();
		}
	}

	/** Move the selection one step for a wheel notch (clamped, no wrap). */
	handleWheel(delta: -1 | 1): void {
		if (this.#filteredProviders.length === 0) return;
		const next = Math.max(0, Math.min(this.#selectedIndex + delta, this.#filteredProviders.length - 1));
		if (next === this.#selectedIndex) return;
		this.#selectedIndex = next;
		this.#statusMessage = undefined;
		this.#updateList();
	}

	/**
	 * Route an SGR mouse report at component-local coordinates. Provider rows
	 * start LIST_ROW_OFFSET lines into the render; the ScrollView window shows
	 * #visibleCount rows from #scrollStart. Wheel moves the selection, motion
	 * drives the hover band, and a left click selects and confirms like Enter.
	 */
	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		if (event.wheel !== null) {
			this.handleWheel(event.wheel);
			return;
		}
		const localRow = line - LIST_ROW_OFFSET;
		const index = localRow >= 0 && localRow < this.#visibleCount ? this.#scrollStart + localRow : undefined;
		const target = index !== undefined && index < this.#filteredProviders.length ? index : null;
		if (event.motion) {
			if (target !== this.#hoveredIndex) {
				this.#hoveredIndex = target;
				this.#updateList();
			}
			return;
		}
		if (!event.leftClick || target === null) return;
		if (target !== this.#selectedIndex) {
			this.#selectedIndex = target;
			this.#statusMessage = undefined;
		}
		this.#confirmSelection();
	}
}
