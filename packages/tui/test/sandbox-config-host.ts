/**
 * Shared fixture for the `/sandbox` overlay tests: a base model and a host
 * that records every callback and applies it to its model the way `/sandbox`
 * does (write, then push the refreshed model back).
 */
import {
	type SandboxConfigCallbacks,
	type SandboxConfigModel,
	SandboxConfigOverlayComponent,
	type SandboxListId,
	type SandboxSettingChange,
	type SandboxSettingId,
} from "@oh-my-pi/pi-tui/overlays/sandbox-config";

export const BASE_MODEL: SandboxConfigModel = {
	status: { state: "active", backend: "seatbelt", network: "allowlist", warnings: [] },
	enabled: false,
	mode: "workspace-write",
	scope: ["bash", "eval", "exec"],
	fallback: "warn",
	readScope: "all",
	networkMode: "allowlist",
	allowWrite: [],
	allowRead: [],
	denyRead: [],
	allowedHosts: [],
	ignored: [],
	locked: {},
	listNotes: {},
	effective: { readwritePaths: [], readonlyPaths: [], deniedPaths: [] },
	blockedHosts: [],
	sessionPaths: { write: [], read: [] },
};

export type HostCall =
	| ["set", SandboxSettingChange]
	| ["reset", SandboxSettingId]
	| ["add" | "remove", SandboxListId, string]
	| ["replace", SandboxListId, string, string]
	| ["allow", string]
	| ["revoke", "write" | "read", string]
	| ["close"];

export interface SandboxHost {
	readonly overlay: SandboxConfigOverlayComponent;
	readonly calls: HostCall[];
	/** The host's current model. */
	model(): SandboxConfigModel;
	/** Replace the model as a runtime change would. */
	push(next: Partial<SandboxConfigModel>): void;
}

/** The overlay over a recording host; `requestRender` forwards to `render` when given. */
export function sandboxHost(initial: Partial<SandboxConfigModel> = {}, render?: () => void): SandboxHost {
	const calls: HostCall[] = [];
	let model: SandboxConfigModel = { ...BASE_MODEL, ...initial };
	const push = (next: Partial<SandboxConfigModel>): void => {
		model = { ...model, ...next };
		overlay.setModel(model);
	};
	const callbacks: SandboxConfigCallbacks = {
		set: change => {
			calls.push(["set", change]);
			push({ [change.id]: change.value });
		},
		reset: id => void calls.push(["reset", id]),
		addEntry: (list, entry) => {
			calls.push(["add", list, entry]);
			push({ [list]: [...model[list], entry] });
		},
		removeEntry: (list, entry) => {
			calls.push(["remove", list, entry]);
			push({ [list]: model[list].filter(existing => existing !== entry) });
		},
		replaceEntry: (list, previous, next) => {
			calls.push(["replace", list, previous, next]);
			push({ [list]: model[list].map(existing => (existing === previous ? next : existing)) });
		},
		allowHost: host => void calls.push(["allow", host]),
		revokePath: (kind, path) => {
			calls.push(["revoke", kind, path]);
			push({ sessionPaths: { ...model.sessionPaths, [kind]: model.sessionPaths[kind].filter(p => p !== path) } });
		},
		close: () => void calls.push(["close"]),
		requestRender: () => render?.(),
	};
	const overlay = new SandboxConfigOverlayComponent(model, callbacks);
	return { overlay, calls, model: () => model, push };
}
