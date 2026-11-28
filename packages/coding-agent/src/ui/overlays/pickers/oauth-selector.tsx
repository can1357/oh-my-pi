/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The provider picker for `/login` and `/logout` (and the setup wizard's
 * "Connect a provider" sheet).
 *
 * Login lists every OAuth provider not disabled; logout lists those with
 * stored credentials. Each row tells whether the provider is signed in and
 * where its credential comes from; the host may validate stored credentials
 * and report each provider's state (`checking`, `valid`, `invalid`).
 * Activating an unavailable provider explains why instead of picking it.
 * With more providers than visible rows the list filters as you type.
 */
import type { CredentialsApi, KeysApi } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth/types";
import {
	type Accessor,
	batch,
	computed,
	type JSXNode,
	type KeyEvent,
	read,
	type Reactive,
	signal,
} from "@oh-my-pi/pi-tui";
import type { TspPickerAction, TspPickerItem, TspText, TspTone } from "@oh-my-pi/pi-wire";
import { connectedProviderName } from "../../../modes/view-model/chrome/format";
import { providerMark } from "../../../modes/view-model/overlays/model-browser";
import { fuzzyFilter } from "../../../utils/fuzzy";
import "../../styles/pickers/oauth";
import type { OAuthLookTerm, OAuthRowStatus } from "../../styles/pickers/oauth";
import { editLine, type LineState } from "../settings/line-edit";
import { closeAction, PICKER_KEY, pickerAction } from "./select-sheet";
import { cancelKbd } from "../../keys/hints";

/** Credential presence and provenance the picker shows. */
export interface OAuthSelectorAuthSource {
	readonly credentials: Pick<CredentialsApi, "has">;
	readonly keys: Pick<KeysApi, "source">;
}

/** A provider's credential check, as the host reports it. */
export type OAuthAuthState = "checking" | "valid" | "invalid";

/**
 * How a host other than `/login` presents the sheet (the setup wizard): its
 * heading, `role` and size, a status line docked above the action bar, and
 * the action Esc runs in place of Close (it cancels like Close).
 */
export interface OAuthSelectorSheet {
	readonly title: string;
	readonly subtitle: TspText;
	readonly role: string;
	readonly size: "md" | "lg";
	readonly status?: TspText;
	readonly leave: { readonly id: string; readonly label: string };
}

export interface OAuthSelectorProps {
	readonly mode: "login" | "logout";
	readonly auth: OAuthSelectorAuthSource;
	/** The catalogue (default: every registered OAuth provider). */
	readonly providers?: readonly OAuthProviderInfo[];
	/** Login entries to hide (by id or by the provider they store credentials under). */
	readonly disabledProviders?: readonly string[];
	/** Credential checks by provider id. */
	readonly authState?: Accessor<ReadonlyMap<string, OAuthAuthState>>;
	/** Bumped after a sign-in stored a credential: re-read credential state. */
	readonly authRevision?: Accessor<number>;
	readonly sheet?: Reactive<OAuthSelectorSheet | undefined>;
	/** Rows the picker may use on a short screen (the list window shrinks to fit). */
	readonly maxHeight?: Accessor<number | undefined>;
	onSelect(providerId: string): void;
	onCancel(): void;
}

type LoginGroup = {
	readonly id: string;
	readonly title: string;
	readonly label: string;
	readonly members: OAuthProviderInfo[];
};

type Entry = OAuthProviderInfo | LoginGroup;

function isGroup(entry: Entry): entry is LoginGroup {
	return "members" in entry;
}

const MAX_VISIBLE = 10;
const UNAVAILABLE = "Provider unavailable in this environment.";

/** Compact tag of each credential origin. */
const ORIGIN_LABELS: Readonly<Record<string, string>> = {
	runtime: "--api-key",
	config: "config",
	oauth: "login",
	api_key: "api key",
	env: "env",
};

/** Visible list rows for a screen of `lines` rows: keep the chrome, never below three rows unless forced. */
function visibleRows(lines: number | undefined): number {
	if (lines === undefined) return MAX_VISIBLE;
	const strict = lines - 3;
	const relaxed = lines - 2;
	return Math.min(MAX_VISIBLE, Math.max(1, strict, Math.min(relaxed, 3)));
}

export function OAuthSelector(props: OAuthSelectorProps): JSXNode {
	const login = props.mode === "login";
	const auth = props.auth;
	const revision = (): number => props.authRevision?.() ?? 0;
	const hasAuth = (id: string): boolean => (login ? auth.keys.source(id) !== undefined : auth.credentials.has(id));
	const sourceLabel = (id: string): string | undefined => {
		const origin = auth.keys.source(id);
		if (!origin) return undefined;
		return origin.kind === "env" && origin.envVar ? `env: ${origin.envVar}` : ORIGIN_LABELS[origin.kind];
	};
	const catalogue = props.providers ?? getOAuthProviders();
	const providers = computed(() => {
		revision();
		if (!login) return catalogue.filter(provider => hasAuth(provider.id));
		const disabled = new Set(props.disabledProviders ?? []);
		// An alias login (`openai-codex-device` ⇒ `openai-codex`) hides with the provider it authenticates.
		return catalogue.filter(
			provider =>
				!disabled.has(provider.id) && !(provider.storeCredentialsAs && disabled.has(provider.storeCredentialsAs)),
		);
	});
	const rootEntries = computed((): readonly Entry[] => {
		if (!login) return providers();
		const groups = new Map<string, LoginGroup>();
		const entries: Entry[] = [];
		for (const provider of providers()) {
			const group = provider.loginGroup;
			if (!group) {
				entries.push(provider);
				continue;
			}
			let entry = groups.get(group.title);
			if (!entry) {
				entry = { id: `group:${group.title}`, title: group.title, label: group.label, members: [] };
				groups.set(group.title, entry);
				entries.push(entry);
			}
			entry.members.push(provider);
		}
		for (const group of groups.values()) {
			group.members.sort((a, b) => a.loginGroup!.order - b.loginGroup!.order);
		}
		return entries;
	});
	const openGroup = signal<string | null>(null);
	const group = computed(() => {
		const id = openGroup();
		if (id === null) return undefined;
		return rootEntries().find((entry): entry is LoginGroup => entry.id === id && isGroup(entry));
	});
	const entries = computed(() => group()?.members ?? rootEntries());

	const nameOf = (provider: OAuthProviderInfo): string =>
		!login || (provider.loginGroup && auth.credentials.has(provider.storeCredentialsAs ?? provider.id))
			? connectedProviderName(provider.id, provider.name)
			: provider.name;
	const providerSearchText = (provider: OAuthProviderInfo): string => {
		let text = `${nameOf(provider)} ${provider.name} ${provider.id}`;
		const origin = auth.keys.source(provider.id);
		if (origin) {
			text += ` logged in authenticated ${ORIGIN_LABELS[origin.kind]}`;
			if (origin.envVar) text += ` ${origin.envVar}`;
		}
		if (!provider.available) text += " unavailable";
		return text;
	};
	const searchText = (entry: Entry): string =>
		isGroup(entry) ? `${entry.label} ${entry.members.map(providerSearchText).join(" ")}` : providerSearchText(entry);

	const search = signal<LineState>({ text: "", cursor: 0 });
	let parentSearch: LineState | undefined;
	const status = signal<string | null>(null);
	const rows = computed(() => visibleRows(props.maxHeight?.()));
	const searchable = (): boolean => entries().length > rows();
	const showSearch = (): boolean => searchable() || search().text.length > 0;
	const visible = computed(() => {
		const query = search().text.trim();
		const all = entries();
		return query ? fuzzyFilter([...all], query, searchText) : all;
	});
	const selected = signal<string | null>(entries()[0]?.id ?? null);
	const state = (id: string): OAuthAuthState | undefined => props.authState?.().get(id);

	const setQuery = (next: LineState): void =>
		batch(() => {
			const changed = next.text !== search().text;
			search.set(next);
			if (!changed) return;
			status.set(null);
			// A new query starts at its best match.
			selected.set(visible()[0]?.id ?? null);
		});
	const confirm = (): void => {
		const entry = visible().find(p => p.id === selected());
		if (!entry) return;
		if (isGroup(entry)) {
			parentSearch = search();
			batch(() => {
				openGroup.set(entry.id);
				setQuery({ text: "", cursor: 0 });
				selected.set(visible()[0]?.id ?? null);
				status.set(null);
			});
		} else if (entry.available) {
			status.set(null);
			props.onSelect(entry.id);
		} else status.set(UNAVAILABLE);
	};
	const leave = (): void => {
		const id = openGroup();
		if (id === null) {
			props.onCancel();
			return;
		}
		batch(() => {
			openGroup.set(null);
			setQuery(parentSearch ?? { text: "", cursor: 0 });
			selected.set(id);
			status.set(null);
		});
		parentSearch = undefined;
	};
	const pick = (id: string, activate: boolean): void => {
		if (!visible().some(provider => provider.id === id)) return;
		if (id !== selected())
			batch(() => {
				selected.set(id);
				status.set(null);
			});
		if (activate) confirm();
	};
	const onKey = (key: KeyEvent): boolean => {
		if (!searchable()) return false;
		const line = search();
		if (line.text.length === 0) {
			// An empty search lets Backspace and a leading space through.
			if (key.id === "backspace") return false;
			if (key.text !== undefined && key.text.trim().length === 0) return false;
		}
		const next = editLine(line, key);
		if (!next) return false;
		setQuery(next);
		return true;
	};

	const item = (provider: OAuthProviderInfo): TspPickerItem => {
		const origin = auth.keys.source(provider.id);
		const check = state(provider.id);
		const dot: TspTone =
			check === "checking"
				? "pending"
				: check === "invalid"
					? "error"
					: check === "valid" || hasAuth(provider.id)
						? "success"
						: "muted";
		const source = sourceLabel(provider.id);
		const detail = !source
			? "Not configured"
			: origin?.kind === "oauth"
				? `Signed in · ${source}`
				: `API key · ${source}`;
		return {
			id: provider.id,
			label: nameOf(provider),
			detail,
			mark: providerMark(provider.storeCredentialsAs ?? provider.id),
			dot,
			...(provider.available ? {} : { disabled: "Provider unavailable in this environment" }),
		};
	};
	const items = computed(() => {
		revision();
		return entries().map(entry =>
			isGroup(entry)
				? { id: entry.id, label: entry.label, mark: providerMark(entry.members[0]!.id) }
				: item(entry),
		);
	});
	const actions = (): TspPickerAction[] => {
		const sheet = read(props.sheet);
		const onGroup = login && visible().some(entry => entry.id === selected() && isGroup(entry));
		return [
			pickerAction(
				"confirm",
				login ? (onGroup ? "Continue" : "Sign in") : "Sign out",
				"enter",
				login ? { primary: true } : { primary: true, danger: true },
			),
			group()
				? pickerAction("back", "Back", cancelKbd(), { end: true })
				: sheet
					? pickerAction(sheet.leave.id, sheet.leave.label, cancelKbd(), { end: true })
					: closeAction(),
		];
	};
	const term = (): OAuthLookTerm => {
		const statuses: Record<string, OAuthRowStatus> = {};
		const sources: Record<string, string> = {};
		const unavailable: string[] = [];
		for (const provider of visible()) {
			if (isGroup(provider)) continue;
			const check = state(provider.id);
			const status: OAuthRowStatus =
				check === "checking"
					? "checking"
					: check === "invalid"
						? "invalid"
						: check === "valid" || hasAuth(provider.id)
							? "valid"
							: "none";
			statuses[provider.id] = status;
			const source = sourceLabel(provider.id);
			if (source) sources[provider.id] = source;
			if (!provider.available) unavailable.push(provider.id);
		}
		const query = search();
		const empty =
			providers().length === 0
				? login
					? "No sign-in methods available"
					: "No stored provider credentials to log out"
				: "No matching providers";
		return {
			look: "omp.oauth",
			title: group()?.title ?? (login ? "Select provider to login" : "Select provider to logout"),
			maxRows: rows(),
			statuses,
			sources,
			unavailable,
			searchLine: showSearch() ? (query.text.trim() ? query : null) : undefined,
			empty: visible().length === 0 ? empty : undefined,
			status: status() ?? undefined,
		};
	};
	const sheetProp = <K extends keyof OAuthSelectorSheet>(key: K): OAuthSelectorSheet[K] | undefined =>
		read(props.sheet)?.[key];

	return (
		<col>
			<picker
				key={PICKER_KEY}
				role={() => sheetProp("role")}
				title={() => group()?.title ?? sheetProp("title") ?? (login ? "Sign in" : "Sign out")}
				subtitle={() =>
					group()
						? "Choose how to connect"
						: (sheetProp("subtitle") ?? (login ? "Pick a provider" : "Remove stored credentials"))
				}
				icon="key-round"
				noun="providers"
				size={() => sheetProp("size") ?? "md"}
				layout="cards"
				preview="none"
				query={() => (showSearch() ? search().text : null)}
				cursor={() => (showSearch() ? search().cursor : undefined)}
				placeholder="Search providers…"
				items={items}
				order={() => (search().text.length > 0 ? visible().map(provider => provider.id) : undefined)}
				selected={selected}
				total={() => entries().length}
				empty={login ? "No sign-in methods available" : "No stored provider credentials to log out"}
				message={() => status() ?? undefined}
				strip={() => {
					const label = sheetProp("status");
					return label ? { label, items: [] } : undefined;
				}}
				actions={actions}
				term={term}
				onKey={onKey}
				onSelect={id => pick(id, false)}
				onActivate={id => pick(id, true)}
				onAction={act => {
					if (act === "confirm") confirm();
					else if (act === "clear") {
						batch(() => {
							setQuery({ text: "", cursor: 0 });
							status.set(null);
						});
					} else if (act === "back" || act === "close" || act === "cancel" || act === sheetProp("leave")?.id) leave();
				}}
			/>
		</col>
	);
}
