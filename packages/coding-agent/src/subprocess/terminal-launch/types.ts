import type { TerminalMultiplexer } from "@oh-my-pi/pi-tui/terminal-multiplexer";

export interface PlacementCapabilities {
	execution?: readonly string[];
	target?: "pane" | "session" | "tab" | "workspace" | "surface" | "window" | false;
	direction?: readonly string[];
	floating?: true;
	floatingDirectionExclusive?: true;
	focus?: true;
	name?: true;
	label?: true;
	shellGrammar?: "posix";
	cwdShellInput?: true;
}

type MultiplexerCapabilities =
	| { supported: false; reason: string }
	| ({ supported: true } & (
			| { pane: PlacementCapabilities; window?: PlacementCapabilities }
			| { pane?: PlacementCapabilities; window: PlacementCapabilities }
	  ));

/**
 * Canonical multiplexer launch capabilities. Keep unsupported taxonomy entries
 * explicit so adding a provider requires an intentional launcher decision.
 */
export const terminalLaunchCapabilities = {
	herdr: {
		supported: true,
		pane: {
			execution: ["shell-input"],
			target: "pane",
			direction: ["right", "down"],
			focus: true,
			shellGrammar: "posix",
		},
		window: {
			execution: ["shell-input"],
			target: "workspace",
			focus: true,
			label: true,
			shellGrammar: "posix",
		},
	},
	tmux: {
		supported: true,
		pane: {
			execution: ["direct", "shell"],
			target: "pane",
			direction: ["right", "down"],
			focus: true,
		},
		window: {
			execution: ["direct", "shell"],
			target: "session",
			focus: true,
		},
	},
	screen: {
		supported: false,
		reason: "screen has no supported native launch command.",
	},
	zellij: {
		supported: true,
		pane: {
			execution: ["direct"],
			target: "tab",
			direction: ["right", "down"],
			floating: true,
			floatingDirectionExclusive: true,
			focus: true,
			name: true,
		},
		window: {
			execution: ["direct"],
			target: false,
			focus: true,
			name: true,
		},
	},
	cmux: {
		supported: true,
		pane: {
			execution: ["shell-input"],
			target: "surface",
			direction: ["right", "left", "up", "down"],
			focus: true,
			shellGrammar: "posix",
			cwdShellInput: true,
		},
		window: {
			execution: ["shell-input"],
			target: "window",
			focus: true,
			name: true,
			shellGrammar: "posix",
		},
	},
	wmux: {
		supported: false,
		reason: "wmux launch is not implemented by this API.",
	},
} as const satisfies Record<TerminalMultiplexer, MultiplexerCapabilities>;

export type TerminalLaunchMultiplexer = {
	[M in TerminalMultiplexer]: (typeof terminalLaunchCapabilities)[M] extends { supported: true } ? M : never;
}[TerminalMultiplexer];

export type TerminalLaunchPlacement = "pane" | "window";

type CapabilityValues<C, K extends PropertyKey> = K extends keyof C
	? C[K] extends readonly (infer Value)[]
		? Value
		: never
	: never;

type TargetOption<C> = C extends { target: false }
	? { target?: never }
	: C extends { target: string }
		? { target?: string }
		: { target?: never };

type ExecutionOption<C> = C extends { execution: readonly string[] }
	? { execution?: CapabilityValues<C, "execution"> }
	: { execution?: never };

type DirectionAndFloatingOptions<C> = C extends { floatingDirectionExclusive: true }
	? { floating: true; direction?: never } | { floating?: false; direction?: CapabilityValues<C, "direction"> }
	: {
			direction?: CapabilityValues<C, "direction">;
			floating?: C extends { floating: true } ? boolean : never;
		};

type OptionalStringOption<C, K extends "name" | "label"> =
	C extends Record<K, true> ? { [P in K]?: string } : { [P in K]?: never };

type FocusOption<C> = C extends { focus: true } ? { focus?: boolean } : { focus?: never };

type ShellGrammarOption<C> = C extends { shellGrammar: "posix" } ? { shellGrammar: "posix" } : { shellGrammar?: never };

type RequestOptions<C> = TargetOption<C> &
	ExecutionOption<C> &
	DirectionAndFloatingOptions<C> &
	OptionalStringOption<C, "name"> &
	OptionalStringOption<C, "label"> &
	FocusOption<C> &
	ShellGrammarOption<C>;

type RequestForPlacement<
	Multiplexer extends TerminalLaunchMultiplexer,
	Placement extends TerminalLaunchPlacement,
	C,
> = {
	multiplexer: Multiplexer;
	placement: Placement;
	command: readonly string[];
	cwd: string;
} & RequestOptions<C>;

type RequestsForEntry<Multiplexer extends TerminalLaunchMultiplexer, Entry> = {
	[Placement in Extract<keyof Entry, TerminalLaunchPlacement>]: RequestForPlacement<
		Multiplexer,
		Placement,
		Entry[Placement]
	>;
}[Extract<keyof Entry, TerminalLaunchPlacement>];

type RequestsFor<Multiplexer extends TerminalLaunchMultiplexer> =
	(typeof terminalLaunchCapabilities)[Multiplexer] extends infer Entry
		? Entry extends { supported: true }
			? RequestsForEntry<Multiplexer, Entry>
			: never
		: never;

/** Requests are derived from the canonical capability map, excluding unsupported providers and impossible options. */
export type TerminalLaunchRequest = { [M in TerminalLaunchMultiplexer]: RequestsFor<M> }[TerminalLaunchMultiplexer];

export interface TerminalLaunchResult {
	multiplexer: TerminalLaunchMultiplexer;
	placement: TerminalLaunchPlacement;
	/** Provider-native pane, tab, workspace, window, or session ID when the CLI reports one. */
	id?: string;
}

export interface TerminalLaunchCliResult {
	stdout: string;
	exitCode: number | null;
}

/** Receives the exact argv dispatched to a backend CLI and its process cwd. */
export type TerminalLaunchCliRunner = (argv: readonly string[], cwd: string) => Promise<TerminalLaunchCliResult>;

/** Shared runtime inputs supplied to every provider backend. */
export interface TerminalLaunchBackendContext {
	environment: NodeJS.ProcessEnv;
	runCli: TerminalLaunchCliRunner;
}

/** Typed contract implemented by each provider-specific backend module. */
export type TerminalLaunchBackend<Multiplexer extends TerminalLaunchMultiplexer> = (
	request: Extract<TerminalLaunchRequest, { multiplexer: Multiplexer }>,
	context: TerminalLaunchBackendContext,
) => Promise<TerminalLaunchResult>;

/** Sanitized launch failure. Messages deliberately omit command argv, stdout, and stderr. */
export class TerminalLaunchError extends Error {
	constructor(
		message: string,
		public readonly multiplexer: TerminalMultiplexer,
		public readonly placement: TerminalLaunchPlacement,
		public readonly operation: string,
		public readonly exitCode?: number | null,
	) {
		super(message);
		this.name = "TerminalLaunchError";
	}
}

/** @internal Dependency seam for deterministic CLI behavior tests. */
export interface TerminalLaunchDependencies {
	environment?: () => NodeJS.ProcessEnv;
	runCli?: TerminalLaunchCliRunner;
}
