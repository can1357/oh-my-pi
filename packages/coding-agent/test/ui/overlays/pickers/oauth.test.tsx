/** @jsxImportSource @oh-my-pi/pi-tui */
import { afterAll } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { type Signal, signal, type UiEvent } from "@oh-my-pi/pi-tui";
import {
	type OAuthAuthState,
	OAuthSelector,
	type OAuthSelectorAuthSource,
	type OAuthSelectorSheet,
} from "../../../../src/ui/overlays/pickers/oauth-selector";
import { type Driver, pickerSuite } from "./harness";

const noop = (): void => {};

// The cases exercise "unavailable in this environment": the registry objects are shared, so restore them after.
const touched = getOAuthProviders().filter(provider => provider.id === "anthropic" || provider.id === "kimi-code");
for (const provider of touched) provider.available = false;
afterAll(() => {
	for (const provider of touched) provider.available = true;
});

const auth = (signedIn: string[], env: Record<string, string> = {}): OAuthSelectorAuthSource => ({
	credentials: { has: (id: string) => signedIn.includes(id) },
	keys: {
		source: (id: string) =>
			(signedIn.includes(id)
				? { kind: id === "zai" ? "api_key" : "oauth" }
				: env[id]
					? { kind: "env", envVar: env[id] }
					: undefined) as ReturnType<OAuthSelectorAuthSource["keys"]["source"]>,
	},
});
const sheet = (status?: string): OAuthSelectorSheet => ({
	title: "Connect a provider",
	subtitle: "Step 2 of 4",
	role: "omp.setup.sheet",
	size: "lg",
	status,
	leave: { id: "skip", label: "Skip" },
});

function ev(
	event: { type: "select" | "activate"; key: string; item: string } | { type: "action"; key: string; act: string },
) {
	return (d: Driver): void => {
		if (event.key === "list" && event.type !== "action") {
			// The old screen's pre-picker `list` keypath: a click there picked at once.
			d.emit({ type: "activate", key: "picker", item: event.item });
			return;
		}
		d.emit((event.type === "action" ? { ...event, mods: [] } : event) as UiEvent);
	};
}
const move = (row: number) => (d: Driver) => d.mouse(row, 4, { button: "none", action: "move" });
const wheel = (row: number) => (d: Driver) => d.mouse(row, 4, { button: "wheel-down", action: "press" });
const click = (row: number) => (d: Driver) => d.mouse(row, 4, { button: "left", action: "press" });

/** Credential checks the host settled before the first paint. */
function checks(ids: string[], verdict: (id: string) => OAuthAuthState): Map<string, OAuthAuthState> {
	return new Map(ids.map(id => [id, verdict(id)]));
}

pickerSuite({
	dir: "overlays/oauth-selector",
	mount(caseName) {
		const maxHeight: Signal<number | undefined> = signal<number | undefined>(undefined);
		const currentSheet: Signal<OAuthSelectorSheet | undefined> = signal<OAuthSelectorSheet | undefined>(undefined);
		const revision = signal(0);
		let mode: "login" | "logout" = "login";
		let source = auth([]);
		let disabled: string[] | undefined;
		let states: Map<string, OAuthAuthState> | undefined;
		const wheelStep = (d: Driver): void => {
			const picker = d.find("picker")!;
			d.emit({ type: "select", key: "picker", item: (picker.props() as { selected?: string }).selected ?? "" });
		};
		let steps: Record<string, (d: Driver) => void> = {};
		switch (caseName) {
			case "login-keys":
				source = auth(["openai-codex", "zai"], { openrouter: "OPENROUTER_API_KEY" });
				steps = {
					"max height 6": () => maxHeight.set(6),
					"max height 3": () => maxHeight.set(3),
					"max height 40": () => maxHeight.set(40),
					"wheel down": wheel(1),
					"wheel up": d => d.mouse(1, 4, { button: "wheel-up", action: "press" }),
					"wheel up clamp": d => d.mouse(1, 4, { button: "wheel-up", action: "press" }),
					"hover row 3": move(3),
					"hover outside": move(0),
					"mouse wheel": wheel(2),
					"click unavailable": click(2),
					"native select": ev({ type: "select", key: "list", item: "zai" }),
					"picker select": ev({ type: "select", key: "picker", item: "kimi-code" }),
					"picker confirm unavailable": ev({ type: "action", key: "picker", act: "confirm" }),
					refresh: () => revision.set(revision() + 1),
					"set sheet": () => currentSheet.set(sheet("Signed in to OpenAI ✓")),
					"picker clear": ev({ type: "action", key: "picker", act: "clear" }),
					"list activate": ev({ type: "activate", key: "list", item: "anthropic" }),
					"picker activate": ev({ type: "activate", key: "picker", item: "openrouter" }),
				};
				break;
			case "logout":
				mode = "logout";
				source = auth(["openai-codex", "zai", "anthropic"]);
				steps = {
					hover: move(1),
					click: click(1),
					"picker close": ev({ type: "action", key: "picker", act: "close" }),
				};
				break;
			case "logout-empty":
				mode = "logout";
				steps = { wheel: wheelStep };
				break;
			case "disabled-sheet":
				source = auth(["zai"]);
				disabled = getOAuthProviders()
					.slice(4)
					.map(p => p.id);
				currentSheet.set(sheet());
				steps = {
					leave: ev({ type: "action", key: "picker", act: "skip" }),
					"max height 2": () => maxHeight.set(2),
				};
				break;
			case "validation-pending":
				source = auth(["openai-codex", "zai"]);
				states = checks(["openai-codex", "zai"], () => "checking");
				steps = { down: d => d.press("\x1b[B"), stop: noop };
				break;
			case "validation-settled":
				source = auth(["openai-codex", "zai", "openrouter"]);
				states = checks(["openai-codex", "zai", "openrouter"], id => (id === "zai" ? "valid" : "invalid"));
				steps = { settle: noop, refresh: () => revision.set(revision() + 1), confirm: d => d.press("\r") };
				break;
			case "validation-throws":
				mode = "logout";
				source = auth(["openai-codex", "zai"]);
				states = checks(["openai-codex", "zai"], id => (id === "zai" ? "invalid" : "valid"));
				steps = { settle: noop };
				break;
		}
		return {
			view: () => (
				<OAuthSelector
					mode={mode}
					auth={source}
					disabledProviders={disabled}
					authState={states ? () => states : undefined}
					authRevision={revision}
					sheet={currentSheet}
					maxHeight={maxHeight}
					onSelect={noop}
					onCancel={noop}
				/>
			),
			steps,
		};
	},
});
