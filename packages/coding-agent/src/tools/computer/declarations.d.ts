/** Options shared by every native input helper. */
interface ComputerInputOptions {
	/** Omit for background input, or foreground takeover while control is acquired. Explicit false always stays background. */
	takeover?: boolean;
}

/** Options for pointer clicks. */
interface ComputerClickOptions extends ComputerInputOptions {
	button?: "left" | "right" | "middle";
	count?: number;
	modifiers?: string[];
}

/** Options for pointer drags. */
interface ComputerDragOptions extends ComputerInputOptions {
	modifiers?: string[];
	keys?: string[];
}

/** Bounded key/button ownership, always released before the helper returns. */
interface ComputerHoldOptions extends ComputerInputOptions {
	/** Seconds, from 0 through 100. Held input is released even on cancellation. */
	duration: number;
}

/** Mouse hold with optional accompanying keys; no pressed state escapes the call. */
interface ComputerHoldMouseOptions extends ComputerHoldOptions {
	button?: "left" | "right" | "middle";
	keys?: string[];
}

/** Native installed application identity and observable running-process information. */
interface ComputerApplication {
	id: string;
	name: string;
	path: string;
	running: boolean;
	pid?: number;
}

/** Filters installed applications by identity/name/path or running state. */
interface ComputerApplicationQuery {
	query?: string;
	runningOnly?: boolean;
}

/** A native menu item snapshot; selection revalidates the command before dispatch. */
interface ComputerMenuItem {
	title: string;
	path: string[];
	enabled: boolean;
	checked: boolean;
	hasSubmenu: boolean;
	shortcut?: string;
}

/** A full screenshot paired with its window's accessibility snapshot. */
interface ComputerObservationResult extends ComputerScreenshotResult {
	ax: string;
	nodeCount: number;
	truncated: boolean;
}

/** Options for wheel scrolling; `dx`/`dy` are scroll units at the pointer position. */
interface ComputerScrollOptions extends ComputerInputOptions {
	dx?: number;
	dy?: number;
}

/** Options for capturing a screenshot; `silent` skips the auto-displayed image. */
interface ComputerScreenshotOptions {
	silent?: boolean;
}

/** Options for an accessibility-tree snapshot. */
interface ComputerAxOptions {
	/** Include nodes that are normally pruned as non-interactive. */
	all?: boolean;
	maxDepth?: number;
}

/** Accessibility query matched against role, title, and value. */
interface ComputerAxQuery {
	role?: string;
	title?: string;
	value?: string;
	limit?: number;
}

/** Window filter: exact `id` (a number means the same id as its string), or case-insensitive substrings of the owning app name and title. */
interface ComputerWindowFilter {
	id?: string | number;
	app?: string;
	title?: string;
}

/** Rectangle in platform-native global coordinates: physical desktop pixels on Windows, logical points on macOS. */
interface ComputerBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** One capturable top-level window in global desktop coordinates. */
interface ComputerWindowInfo extends ComputerBounds {
	/** Opaque backend-defined id; never parse it. */
	id: string;
	app: string;
	title: string;
	pid?: number;
	focused: boolean;
}

/** Monitor geometry in both desktop coordinates and composite screenshot pixels. */
interface ComputerDisplay extends ComputerBounds {
	id: string;
	name: string;
	/** OS DPI scale; screenshot mapping uses the explicit desktop and pixel rectangles. */
	scale: number;
	pixelX: number;
	pixelY: number;
	pixelWidth: number;
	pixelHeight: number;
	isPrimary: boolean;
}

/** Target-local region in pixels of the most recent full screenshot of the same target. */
interface CaptureRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Saved screenshot frame; `width`/`height` are the emitted image size. */
interface ComputerScreenshotResult {
	path: string;
	width: number;
	height: number;
	/** Full screenshot dimensions used by subsequent input, unchanged by zoom. */
	coordinateWidth: number;
	coordinateHeight: number;
	/** Captured rectangle in the full screenshot coordinate frame; absent for full screenshots. */
	region?: CaptureRegion;
}

/** Native desktop backend and permission state. */
interface ComputerCapabilities {
	/** Active native backend identifier. */
	backend: string;
	/** Linux display-server kind when applicable. */
	displayServer?: string;
	capture: boolean;
	input: boolean;
	/** Whether OS accessibility automation is available. */
	ax: boolean;
	/** Whether input can target a background window. */
	backgroundWindowInput: boolean;
	/** Whether window input accepts `takeover: true`. */
	takeover: boolean;
	/** Whether pressing Escape anywhere stops takeover input (`takeover: true` or held control). Background input ignores the user's Escape; stop it with the host interrupt. */
	globalEscape: boolean;
	capturePermission: string;
	inputPermission: string;
	axPermission: string;
	displayCount: number;
	applications: boolean;
	menus: boolean;
	heldInput: boolean;
	spaces: boolean;
}

/** Live accessibility element resolved from a snapshot ref; expired refs throw `StaleRef`. */
interface ComputerElement {
	/** Snapshot ref tag, e.g. `e5`. */
	readonly ref: string;
	readonly role: string;
	readonly nativeRole: string;
	readonly title?: string;
	readonly description?: string;
	readonly enabled: boolean;
	readonly focused: boolean;
	readonly childCount: number;
	value(): Promise<string | undefined>;
	setValue(value: string): Promise<void>;
	/** Bounds in global desktop coordinates, or null when the element has none. */
	bounds(): Promise<ComputerBounds | null>;
	attributes(): Promise<Record<string, string>>;
	actions(): Promise<string[]>;
	perform(action: string): Promise<void>;
	/** Perform the element's native press action; needs no screenshot. */
	press(): Promise<void>;
	/** Click the element's center with native input. */
	click(options?: ComputerInputOptions): Promise<void>;
	focus(): Promise<void>;
	parent(): Promise<ComputerElement | null>;
	children(): Promise<ComputerElement[]>;
}

/** Native input helpers shared by the desktop root and window handles; `x`/`y` are pixels in the most recent full screenshot of the same target, never zoom pixels. */
interface ComputerInputTarget {
	screenshot(options?: ComputerScreenshotOptions): Promise<ComputerScreenshotResult>;
	/** Display a detailed region without replacing the input frame. Use base full screenshot coordinates for subsequent input, not zoom pixels. */
	zoom(region: CaptureRegion, options?: ComputerScreenshotOptions): Promise<ComputerScreenshotResult>;
	click(x: number, y: number, options?: ComputerClickOptions): Promise<void>;
	doubleClick(x: number, y: number, options?: Omit<ComputerClickOptions, "count">): Promise<void>;
	move(x: number, y: number): Promise<void>;
	drag(points: Array<[number, number]>, options?: ComputerDragOptions): Promise<void>;
	scroll(x: number, y: number, options?: ComputerScrollOptions): Promise<void>;
	type(text: string, options?: ComputerInputOptions): Promise<void>;
	/** Key chord such as `"cmd+shift+p"` or `["cmd", "shift", "p"]`. */
	press(chord: string | string[], options?: ComputerInputOptions): Promise<void>;
	/** Hold keys for a bounded duration; release on completion, error, or cancellation. */
	holdKeys(keys: string[], options: ComputerHoldOptions): Promise<void>;
	/** Hold a mouse button at full-screenshot coordinates, then release it and any keys. */
	holdMouse(x: number, y: number, options: ComputerHoldMouseOptions): Promise<void>;
}

/** Live display selector with an independent full-screenshot coordinate frame. */
interface ComputerDisplayTarget extends ComputerInputTarget {
	readonly id: string;
}

/** Window handle resolved by `window`/`focusedWindow`; identity fields are a snapshot taken at resolution. */
interface ComputerWindow extends ComputerInputTarget {
	readonly id: string;
	readonly app: string;
	readonly title: string;
	readonly pid?: number;
	readonly bounds: ComputerBounds;
	readonly focused: boolean;
	raise(): Promise<void>;
	/** Move this macOS window to the current Space without switching Spaces; recapture afterward. */
	bringToCurrentSpace(): Promise<void>;
	/** Emit one full screenshot and AX snapshot without exposing a partial failed observation. */
	observe(options?: ComputerScreenshotOptions & ComputerAxOptions): Promise<ComputerObservationResult>;
	readonly menu: {
		/** Inspect a menu path without activating the application. */
		items(path?: string | string[]): Promise<ComputerMenuItem[]>;
		/** Select one unambiguous enabled command using the window's native menu context. */
		select(path: string[]): Promise<void>;
	};
	/** Formatted accessibility tree as one string, one node per line with `[ref=eN]` tags. */
	ax(options?: ComputerAxOptions): Promise<string>;
	find(query: ComputerAxQuery): Promise<ComputerElement[]>;
	ref(ref: string): Promise<ComputerElement>;
}

/** Desktop helpers shared by the direct `computer` facade and the `desktop` object inside `computer.run`. */
interface ComputerDesktop extends ComputerInputTarget {
	displays(): Promise<ComputerDisplay[]>;
	/** Select a display ID, "active", or "all" without changing configuration or resetting the worker. */
	display(selector: string): Promise<ComputerDisplayTarget>;
	readonly apps: {
		/** Discover native application identities without requiring capture permission. */
		list(options?: ComputerApplicationQuery): Promise<ComputerApplication[]>;
		/** Launch an exact identity/path or unique name; deliberate activation is opt-in. */
		open(idOrNameOrNativeAppPath: string, options?: { activate?: boolean }): Promise<ComputerApplication>;
	};
	readonly control: {
		/** Requires a live human UI confirmation; headless/refused requests never acquire. */
		acquire(options: { reason: string }): Promise<{ active: boolean }>;
		/** Revoke foreground permission and release native task ownership. */
		release(): Promise<void>;
		/** Read the live native ownership state, including revocation by interruption. */
		state(): Promise<{ active: boolean }>;
	};
	windows(filter?: ComputerWindowFilter): Promise<ComputerWindowInfo[]>;
	/** Resolve exactly one window by id (`"74"` or `74`) or filter; ambiguous filters throw listing candidates. */
	window(selector: string | number | ComputerWindowFilter): Promise<ComputerWindow>;
	focusedWindow(): Promise<ComputerWindow | null>;
	/** Element under a global desktop coordinate. */
	elementAt(x: number, y: number): Promise<ComputerElement | null>;
	focusedElement(): Promise<ComputerElement | null>;
	ref(ref: string): Promise<ComputerElement>;
	readonly clipboard: {
		read(): Promise<string>;
		write(text: string): Promise<void>;
	};
}

/** Scope object passed as the first argument to a computer run function. */
interface ComputerRunScope {
	/** Persistent host-desktop facade; `capabilities()` is also available here. */
	readonly desktop: ComputerDesktop & { capabilities(): ComputerCapabilities };
	/** Sleep for milliseconds or poll a predicate until truthy. */
	readonly wait: (
		msOrPredicate: number | (() => unknown),
		options?: {
			/** Maximum polling time in milliseconds. */
			timeout?: number;
			/** Delay between predicate calls in milliseconds. */
			interval?: number;
		},
	) => Promise<unknown>;
	/** Throw with `message` when `condition` is falsy. */
	readonly assert: (condition: unknown, message?: string) => void;
}

/** Arguments and policy for code executed by `computer.run`. */
interface ComputerRunOptions {
	/** Positional arguments passed after the run-scope object. */
	args?: unknown[];
	/** Allow desktop inspection while blocking desktop-facade input and mutation. */
	read_only?: boolean;
	/** Execution timeout in seconds. */
	timeout?: number;
}

/** Session-scoped host-computer facade available in JavaScript Eval. Direct helpers each run one approved call. */
declare const computer: ComputerDesktop & {
	/** Run a serialized function in the persistent computer runtime for multi-step sequences. */
	run<R>(
		fn: (scope: ComputerRunScope, ...args: unknown[]) => R | Promise<R>,
		options?: ComputerRunOptions,
	): Promise<Awaited<R>>;
	/** Run a JavaScript function body in the persistent computer runtime. */
	run<R = unknown>(code: string, options?: ComputerRunOptions): Promise<R>;
	/** Return native backend capabilities and permission state. */
	capabilities(): Promise<ComputerCapabilities | undefined>;
	/** End the persistent desktop session; later calls fail. */
	close(): Promise<void>;
};
