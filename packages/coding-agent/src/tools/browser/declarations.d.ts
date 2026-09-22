/** Navigation lifecycle accepted by browser open and goto operations. */
type BrowserWaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";

/** Browser application or attachment selection. */
interface BrowserAppOptions {
	/** Absolute or cwd-relative browser/Electron executable to spawn. Chromium-family browsers launch on an omp-owned profile unless `args` sets `--user-data-dir`. */
	path?: string;
	/** HTTP Chrome DevTools Protocol discovery endpoint to attach to. */
	cdp_url?: string;
	/** Drive the user's existing Chrome tabs through the omp Browser Relay. */
	relay?: boolean;
	/** Extra command-line arguments for a spawned executable. */
	args?: string[];
	/** URL/title substring used to select an attached tab. */
	target?: string;
}

/** Requested browser page viewport. */
interface BrowserViewportOptions {
	/** Viewport width in CSS pixels. */
	width: number;
	/** Viewport height in CSS pixels. */
	height: number;
	/** Device scale factor. */
	scale?: number;
}

/** Runtime geolocation coordinates. */
interface BrowserGeolocationOptions {
	/** Latitude in decimal degrees. */
	latitude: number;
	/** Longitude in decimal degrees. */
	longitude: number;
	/** Position accuracy in meters. */
	accuracy?: number;
}

/** Runtime HTTP basic-auth credentials. */
interface BrowserCredentialsOptions {
	/** Basic-auth username. */
	username: string;
	/** Basic-auth password. */
	password: string;
}

/** Custom runtime network conditions. */
interface BrowserNetworkConditions {
	/** Download throughput in bytes per second. */
	download: number;
	/** Upload throughput in bytes per second. */
	upload: number;
	/** Request latency in milliseconds. */
	latency: number;
}

/** Independently mergeable device, network, and media overrides. */
interface BrowserEmulateOptions {
	/** Override viewport dimensions. */
	viewport?: BrowserViewportOptions;
	/** Emulate a Puppeteer `KnownDevices` profile. */
	device?: string;
	/** Override coordinates, or clear the override with `null`. */
	geolocation?: BrowserGeolocationOptions | null;
	/** Toggle offline mode. */
	offline?: boolean;
	/** Override the preferred color scheme. */
	colorScheme?: "dark" | "light" | "no-preference";
	/** Toggle reduced-motion preference. */
	reducedMotion?: boolean;
	/** Set extra HTTP headers, or clear them with `null`. */
	headers?: Record<string, string> | null;
	/** Set HTTP basic-auth credentials, or clear them with `null`. */
	credentials?: BrowserCredentialsOptions | null;
	/** Set a user agent, or clear it with `null` while retaining an active device UA. */
	userAgent?: string | null;
	/** Set an ICU timezone, or clear it with `null`. */
	timezone?: string | null;
	/** Set a locale, or clear it with `null`. */
	locale?: string | null;
	/** Set a CPU slowdown factor, or clear it with `null`. */
	cpuThrottling?: number | null;
	/** Set a network preset/custom profile, or clear it with `null`. */
	network?: "slow3g" | "fast3g" | BrowserNetworkConditions | null;
}

/** Source used to complete a clipboard action. */
interface BrowserClipboardActionResult {
	/** Chromium page clipboard or in-worker round-trip shim. */
	source: "page" | "shim";
}

/** Clipboard text and its source. */
interface BrowserClipboardReadResult extends BrowserClipboardActionResult {
	/** Clipboard plain text. */
	text: string;
}

/** One registered document-start script. */
interface BrowserInitScript {
	/** Identifier accepted by `removeInitScript`. */
	id: string;
	/** JavaScript source registered for future documents. */
	source: string;
}

/** One completed tab download. */
interface BrowserDownload {
	/** Absolute path to the downloaded file. */
	path: string;
	/** Filename suggested by the response. */
	suggestedFilename: string;
	/** Source URL of the download. */
	url: string;
	/** Number of received file bytes. */
	bytes: number;
}

/** Options for opening or reusing a named browser tab. */
interface BrowserOpenOptions {
	/** Tab name; defaults to `"main"`. */
	name?: string;
	/** URL to navigate to after opening or reusing the tab. */
	url?: string;
	/** Browser process, CDP endpoint, or relay selection. */
	app?: BrowserAppOptions;
	/** Requested page viewport. */
	viewport?: BrowserViewportOptions;
	/** Navigation lifecycle to await. */
	wait_until?: BrowserWaitUntil;
	/** Automatic policy; when omitted, alerts and beforeunload dialogs are accepted while confirms and prompts remain pending. */
	dialogs?: "accept" | "dismiss";
	/** Hostname patterns allowed for every navigation, subresource, fetch, and WebSocket request. */
	allowed_domains?: string[];
	/** Document-start JavaScript sources or cwd-relative source-file paths. */
	init_scripts?: string[];
	/** Absolute or cwd-relative directory for downloads. */
	downloads?: string;
	/** Override the tab user agent before initial navigation. */
	user_agent?: string;
	/** Ignore invalid HTTPS certificates for this page. */
	ignore_https_errors?: boolean;
	/** Permit local file pages to read other local files in an owned browser process. */
	allow_file_access?: boolean;
	/** Override the configured display mode for this open. */
	headed?: boolean;
	/** Keep the tab live across turn settle and idle close (default false). */
	persist?: boolean;
	/** Open timeout in seconds, excluding first-use browser installation. */
	timeout?: number;
}

/** Options for releasing managed browser tabs. */
interface BrowserCloseOptions {
	/** Tab name; defaults to `"main"`. */
	name?: string;
	/** Release every managed tab instead of one named tab. */
	all?: boolean;
	/** Terminate an owned spawned application after its last tab is released. */
	kill?: boolean;
	/** Whole-operation timeout in seconds. */
	timeout?: number;
}

/** Options for closing the current tab handle. */
interface BrowserTabCloseOptions {
	/** Terminate an owned spawned application after its last tab is released. */
	kill?: boolean;
	/** Whole-operation timeout in seconds. */
	timeout?: number;
}

/** Arguments and budget for code executed by `BrowserTab.run`. */
interface BrowserRunOptions<TArgs extends unknown[] = unknown[]> {
	/** Positional arguments passed after the run-scope object. */
	args?: TArgs;
	/** Execution timeout in seconds. */
	timeout?: number;
}

/** Options for a direct tab navigation. */
interface BrowserGotoOptions {
	/** Navigation lifecycle to await. */
	waitUntil?: BrowserWaitUntil;
}

/** Options for a structured accessibility observation. */
interface BrowserObserveOptions {
	/** Include non-interactive accessibility nodes. */
	includeAll?: boolean;
	/** Limit results to nodes inside the current viewport. */
	viewportOnly?: boolean;
	/** Limit the accessibility tree to one matching element. */
	selector?: string;
	/** Remove unnamed empty structural entries. */
	compact?: boolean;
}

/** Options for a Playwright-format ARIA snapshot. */
interface BrowserAriaSnapshotOptions {
	/** Maximum tree depth to render. */
	depth?: number;
	/** Append element bounding boxes. */
	boxes?: boolean;
	/** Keep interactive nodes and their ancestor paths. */
	interactive?: boolean;
	/** Remove unnamed empty structural nodes. */
	compact?: boolean;
	/** Append resolved href values to links. */
	urls?: boolean;
	/** Return a revisioned full, unchanged, or delta result. */
	diff?: boolean;
}

/** Options for running an axe-core accessibility audit. */
interface BrowserA11yOptions {
	/** Restrict the audit to rules carrying at least one of these axe tags. */
	tags?: string[];
	/** Restrict the audit to these axe rule ids. */
	rules?: string[];
	/** Audit only the subtree matching this CSS selector. */
	selector?: string;
	/** Include results that require manual review in the returned report. */
	includeIncomplete?: boolean;
}

/** Accessibility engine metadata. */
interface BrowserA11yEngine {
	/** Engine name. */
	name: "axe-core";
	/** Engine version. */
	version: string;
}

/** Rule-level result counts from an accessibility audit. */
interface BrowserA11yCounts {
	/** Number of rules with confirmed violations. */
	violations: number;
	/** Number of rules requiring manual review. */
	incomplete: number;
	/** Number of passing rules. */
	passes: number;
}

/** One failing DOM node reported by axe-core. */
interface BrowserA11yNode {
	/** Selector path; nested arrays preserve shadow-root boundaries. */
	target: string[] | string[][];
	/** Truncated outer HTML for the failing node. */
	html: string;
	/** Axe's explanation of why the node failed. */
	failureSummary: string;
}

/** One rule result from an axe-core accessibility audit. */
interface BrowserA11yViolation {
	/** Axe rule id. */
	id: string;
	/** Axe impact level, or null when the rule has none. */
	impact: string | null;
	/** Human-readable remediation summary. */
	help: string;
	/** Axe rule documentation URL. */
	helpUrl: string;
	/** Standards and rule-family tags. */
	tags: string[];
	/** Total number of failing nodes before the displayed-node limit. */
	nodeCount: number;
	/** At most ten representative failing nodes. */
	nodes: BrowserA11yNode[];
}

/** Structured result returned by an axe-core accessibility audit. */
interface BrowserA11yResult {
	/** Audited page URL. */
	url: string;
	/** Accessibility engine identity. */
	engine: BrowserA11yEngine;
	/** Rule-level result counts. */
	counts: BrowserA11yCounts;
	/** Rules with confirmed accessibility violations. */
	violations: BrowserA11yViolation[];
	/** Rules needing manual review when requested. */
	incomplete: BrowserA11yViolation[];
}

/** A complete revision returned for a new or reset ARIA snapshot baseline. */
interface BrowserAriaSnapshotFullResult {
	/** Result kind. */
	status: "full";
	/** Current revision number. */
	revision: number;
	/** Complete rendered snapshot. */
	snapshot: string;
}

/** A revision marker returned when an ARIA snapshot did not change. */
interface BrowserAriaSnapshotUnchangedResult {
	/** Result kind. */
	status: "unchanged";
	/** Unchanged revision number. */
	revision: number;
}

/** A compact line delta returned for a changed ARIA snapshot. */
interface BrowserAriaSnapshotDeltaResult {
	/** Result kind. */
	status: "delta";
	/** Current revision number. */
	revision: number;
	/** Revision to which the delta applies. */
	baseRevision: number;
	/** Unified-style line delta. */
	delta: string;
}

/** Revisioned result returned by ARIA snapshot diff mode. */
type BrowserAriaSnapshotDiffResult =
	| BrowserAriaSnapshotFullResult
	| BrowserAriaSnapshotUnchangedResult
	| BrowserAriaSnapshotDeltaResult;

/** Options for readable page extraction. */
interface BrowserExtractOptions {
	/** Limit extraction to one matching element. */
	selector?: string;
	/** Return only a Markdown-style heading outline. */
	outline?: boolean;
	/** Keep sections whose heading contains this case-insensitive substring. */
	filter?: string;
}

/** Options for capturing a browser screenshot. */
interface BrowserScreenshotOptions {
	/** Capture one matching element instead of the page. */
	selector?: string;
	/** Capture the complete scrollable page. */
	fullPage?: boolean;
	/** Save without emitting an Eval image. */
	silent?: boolean;
	/** Overlay numbered labels for interactive elements and refresh `tab.id()` mappings. */
	annotate?: boolean;
	/** Output image encoding. */
	format?: "png" | "jpeg";
	/** JPEG quality from 0 to 100; valid only with `format: "jpeg"`. */
	quality?: number;
	/** Emit and save only when pixels changed since this scope's previous capture. */
	ifChanged?: boolean;
	/** Minimum changed-pixel ratio from 0 to 1; implies `ifChanged`. */
	threshold?: number;
}

/** Options for recording a browser tab to video. */
interface BrowserRecordingOptions {
	/** Constant output frames per second, from 1 through 60. */
	fps?: number;
	/** Draw mouse movement and click ripples into captured frames. */
	cursor?: boolean;
	/** Write and display a changed-frame PNG contact sheet after encoding. */
	contactSheet?: boolean;
	/** Minimum changed-pixel ratio from 0 through 1 for contact-sheet keyframes. */
	contactSheetThreshold?: number;
	/** Capture and encoding quality from 0 through 100. */
	quality?: number;
}

/** Result returned after browser recording begins. */
interface BrowserRecordingStartResult {
	/** Absolute video output path. */
	path: string;
	/** Constant output frames per second. */
	fps: number;
}

/** Result returned after browser recording is finalized. */
interface BrowserRecordingStopResult {
	/** Absolute video output path. */
	path: string;
	/** Elapsed recording time in milliseconds. */
	durationMs: number;
	/** Number of captured screencast frames before constant-rate duplication. */
	frames: number;
	/** Encoded video size in bytes. */
	bytes: number;
	/** Absolute changed-frame contact-sheet PNG path when requested. */
	contactSheet?: string;
}

/** Current persistent browser recording state. */
interface BrowserRecordingStatus {
	/** Whether the tab is recording. */
	active: boolean;
	/** Absolute destination path while active. */
	path?: string;
	/** Requested constant frame rate while active. */
	fps?: number;
	/** Elapsed milliseconds while active. */
	durationMs?: number;
	/** Number of screencast frames accepted so far. */
	frames?: number;
}

/** Change-detection result returned by a tracked screenshot. */
interface BrowserScreenshotChangeResult {
	/** Saved image path, omitted when the capture was unchanged. */
	path?: string;
	/** Whether the changed-pixel ratio exceeded the threshold. */
	changed: boolean;
	/** Monotonic revision for this page, full-page, or selector scope. */
	revision: number;
	/** Fraction of pixels that differ from the previous scope-local capture. */
	pixelChangeRatio: number;
}

/** Options for comparing the current viewport against a PNG baseline. */
interface BrowserDiffScreenshotOptions {
	/** Minimum changed-pixel ratio from 0 to 1. */
	threshold?: number;
	/** Absolute or cwd-relative path for the highlighted PNG diff. */
	output?: string;
}

/** Result of comparing the current viewport against a PNG baseline. */
interface BrowserDiffScreenshotResult {
	/** Fraction of pixels that differ from the baseline. */
	pixelChangeRatio: number;
	/** Whether the changed-pixel ratio exceeded the threshold. */
	changed: boolean;
	/** Absolute path to the highlighted PNG diff. */
	diffPath: string;
}

/** Page margins for PDF output. */
interface BrowserPdfMargin {
	/** Top margin with an optional CSS unit. */
	top?: string | number;
	/** Bottom margin with an optional CSS unit. */
	bottom?: string | number;
	/** Left margin with an optional CSS unit. */
	left?: string | number;
	/** Right margin with an optional CSS unit. */
	right?: string | number;
}

/** Options for printing the page to PDF. */
interface BrowserPdfOptions {
	/** Absolute or cwd-relative destination path; defaults under the system temporary directory. */
	path?: string;
	/** Paper format. */
	format?: "letter" | "legal" | "tabloid" | "ledger" | "a0" | "a1" | "a2" | "a3" | "a4" | "a5" | "a6";
	/** Print in landscape orientation. */
	landscape?: boolean;
	/** Page scale from 0.1 to 2. */
	scale?: number;
	/** Include CSS background graphics. */
	printBackground?: boolean;
	/** Page margins. */
	margin?: BrowserPdfMargin;
	/** Page ranges such as `"1-3, 5"`. */
	pageRanges?: string;
}

/** Options for explicitly settling a pending JavaScript dialog. */
interface BrowserHandleDialogOptions {
	/** Accept the dialog when true; dismiss it when false. */
	accept: boolean;
	/** Text supplied when accepting a prompt. */
	text?: string;
}

/** Runtime state of the page's pending JavaScript dialog. */
interface BrowserDialogState {
	/** Whether a confirm or prompt is waiting for a decision. */
	open: boolean;
	/** Browser dialog kind. */
	type?: string;
	/** Page-provided dialog message. */
	message?: string;
	/** Page-provided prompt default. */
	defaultValue?: string;
}

/** Metadata for one document frame. */
interface BrowserFrameInfo {
	/** DevTools frame identifier. */
	id: string;
	/** Frame name or element id. */
	name: string;
	/** Current frame URL. */
	url: string;
	/** Parent frame identifier, or null for the main frame. */
	parentId: string | null;
	/** Best-effort selector for the owning frame element. */
	selector?: string;
}

/** Metadata for one managed browser tab. */
interface BrowserManagedTab {
	/** Managed tab name. */
	name: string;
	/** Last reported page URL. */
	url: string;
	/** Last reported page title. */
	title: string;
	/** Browser target or cmux surface identifier. */
	targetId: string;
	/** Browser backend kind. */
	kind: "headless" | "spawned" | "connected" | "relay" | "cmux";
	/** Whether settle and idle-close management are disabled. */
	persist: boolean;
}

/** Options for keyboard input through a direct tab helper. */
interface BrowserPressOptions {
	/** Send the key to one matching element. */
	selector?: string;
}

/** Mouse button accepted by pointer helpers. */
type BrowserMouseButton = "left" | "right" | "middle" | "back" | "forward";

/** Options for pointer movement. */
interface BrowserMouseMoveOptions {
	/** Number of intermediate movement events. */
	steps?: number;
}

/** Options for mouse button transitions. */
interface BrowserMouseButtonOptions {
	/** Mouse button to press or release. */
	button?: BrowserMouseButton;
}

/** Options for coordinate-based mouse clicks. */
interface BrowserClickAtOptions extends BrowserMouseButtonOptions {
	/** Number of clicks to dispatch. */
	clickCount?: number;
}

/** Options for page or element scrolling. */
interface BrowserScrollOptions {
	/** Scroll one matching element instead of the page. */
	selector?: string;
}

/** Options for temporary element highlighting. */
interface BrowserHighlightOptions {
	/** Time to keep the highlight visible in milliseconds. */
	duration?: number;
}

/** Options for bounded direct wait helpers. */
interface BrowserWaitOptions {
	/** Wait timeout in milliseconds. */
	timeout?: number;
}

/** Options for polling a predicate inside `tab.run`. */
interface BrowserPollOptions extends BrowserWaitOptions {
	/** Delay between predicate calls in milliseconds. */
	interval?: number;
}

/** Options for waiting on a selector. */
interface BrowserWaitForSelectorOptions extends BrowserWaitOptions {
	/** Require the matching element to be visible. */
	visible?: boolean;
	/** Require the matching element to be hidden. */
	hidden?: boolean;
}

/** Options for waiting until text appears. */
interface BrowserWaitForTextOptions extends BrowserWaitOptions {
	/** Limit the text search to one matching element. */
	selector?: string;
	/** Require the scoped text to equal rather than contain the requested text. */
	exact?: boolean;
}

/** Options for waiting on browser navigation inside `tab.run`. */
interface BrowserWaitForNavigationOptions extends BrowserWaitOptions {
	/** Navigation lifecycle to await. */
	waitUntil?: BrowserWaitUntil;
}

/** A point in page coordinates used by drag operations. */
interface BrowserPoint {
	/** Horizontal page coordinate. */
	readonly x: number;
	/** Vertical page coordinate. */
	readonly y: number;
}

/** Selector or page point accepted by drag operations. */
type BrowserDragTarget = string | BrowserPoint;

/** Element bounds in page coordinates. */
interface BrowserBoundingBox {
	/** Left edge. */
	x: number;
	/** Top edge. */
	y: number;
	/** Width. */
	width: number;
	/** Height. */
	height: number;
}

/** One element in a structured browser observation. */
interface BrowserObservationEntry {
	/** Numeric id accepted by `tab.id`. */
	id: number;
	/** Accessibility role. */
	role: string;
	/** Accessible name. */
	name?: string;
	/** Current accessible value. */
	value?: string | number;
	/** Accessible description. */
	description?: string;
	/** Declared keyboard shortcut. */
	keyshortcuts?: string;
	/** Serialized accessibility states. */
	states: string[];
}

/** Structured result returned by `tab.observe`. */
interface BrowserObservation {
	/** Current page URL. */
	url: string;
	/** Current page title. */
	title?: string;
	/** Current viewport. */
	viewport: {
		/** Viewport width. */
		width: number;
		/** Viewport height. */
		height: number;
		/** Device scale factor. */
		deviceScaleFactor?: number;
	};
	/** Current document scroll metrics. */
	scroll: {
		/** Horizontal scroll offset. */
		x: number;
		/** Vertical scroll offset. */
		y: number;
		/** Visible width. */
		width: number;
		/** Visible height. */
		height: number;
		/** Full scrollable width. */
		scrollWidth: number;
		/** Full scrollable height. */
		scrollHeight: number;
	};
	/** Observed accessibility elements. */
	elements: BrowserObservationEntry[];
}

/** Console levels accepted by captured-console filtering. */
type BrowserConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

/** Options for reading captured page console messages. */
interface BrowserConsoleOptions {
	/** Return only messages at this console level. */
	level?: BrowserConsoleLevel;
	/** Return entries whose sequence is greater than this cursor. */
	since?: number;
	/** Clear the shared capture buffer after reading. */
	clear?: boolean;
	/** Maximum number of entries to return. */
	limit?: number;
}

/** Options for reading captured page errors and failed requests. */
interface BrowserErrorOptions {
	/** Return entries whose sequence is greater than this cursor. */
	since?: number;
	/** Clear the shared capture buffer after reading. */
	clear?: boolean;
	/** Maximum number of entries to return. */
	limit?: number;
}

/** One captured page console message. */
interface BrowserConsoleEntry {
	/** Monotonically increasing capture sequence. */
	seq: number;
	/** Capture time as Unix milliseconds. */
	ts: number;
	/** Captured entry kind. */
	type: "console";
	/** Console message level. */
	level: BrowserConsoleLevel;
	/** Browser-rendered console text. */
	text: string;
	/** Source URL, line, and column when Chromium reports them. */
	location?: string;
	/** Best-effort JSON-safe console arguments. */
	args: unknown[];
}

/** One captured uncaught exception or failed request. */
interface BrowserErrorEntry {
	/** Monotonically increasing capture sequence. */
	seq: number;
	/** Capture time as Unix milliseconds. */
	ts: number;
	/** Captured error kind. */
	type: "pageerror" | "requestfailed";
	/** Error severity. */
	level: "error";
	/** Exception or failed-request description. */
	text: string;
	/** Source location or failed-request URL when available. */
	location?: string;
	/** Exception stack when available. */
	stack?: string;
}

/** Result from a bounded console/error capture query. */
interface BrowserCaptureResult<TEntry> {
	/** Matching captured entries in sequence order. */
	entries: TEntry[];
	/** Sequence cursor for a subsequent `since` query. */
	nextSeq: number;
	/** Entries evicted by bounded-buffer overflow since the last clear. */
	dropped: number;
}

/** Options for starting a Chromium performance trace. */
interface BrowserTraceStartOptions {
	/** Include screenshots in the trace. */
	screenshots?: boolean;
	/** Override the Chromium trace category list. */
	categories?: string[];
}

/** Options for saving a completed Chromium trace. */
interface BrowserTraceStopOptions {
	/** Absolute or cwd-relative destination path. */
	path?: string;
}

/** Options for saving a completed Chromium CPU profile. */
interface BrowserProfileStopOptions {
	/** Absolute or cwd-relative destination path. */
	path?: string;
}

/** Puppeteer page metrics with navigation-relative lifecycle durations. */
interface BrowserMetrics {
	/** Named Chromium or lifecycle metric. */
	[name: string]: number;
	/** Milliseconds from navigation start through DOMContentLoaded. */
	domContentLoaded: number;
	/** Milliseconds from navigation start through load. */
	load: number;
}

/** JSON value bounded for safe React introspection output. */
type BrowserBoundedJson =
	| null
	| string
	| number
	| boolean
	| BrowserBoundedJson[]
	| { [key: string]: BrowserBoundedJson };

/** Options controlling Web Vitals collection. */
interface BrowserVitalsOptions {
	/** Reload before collection; defaults true only when observers missed document start. */
	reload?: boolean;
}

/** Best-effort framework hydration timing. */
interface BrowserHydrationTiming {
	/** Detected client framework. */
	framework: string;
	/** Milliseconds from navigation start to the first observed hydration commit. */
	hydratedAt?: number;
}

/** Web Vitals and navigation timing for the current document. */
interface BrowserVitalsResult {
	/** Current document URL. */
	url: string;
	/** Largest Contentful Paint in milliseconds. */
	lcp: number;
	/** Cumulative Layout Shift score. */
	cls: number;
	/** First Contentful Paint in milliseconds. */
	fcp: number;
	/** Time to First Byte in milliseconds. */
	ttfb: number;
	/** Approximate Interaction to Next Paint in milliseconds. */
	inp: number;
	/** DOMContentLoaded time from navigation start in milliseconds. */
	domContentLoaded: number;
	/** Load time from navigation start in milliseconds. */
	load: number;
	/** Best-effort framework hydration timing. */
	hydration?: BrowserHydrationTiming;
	/** Total observed long-task duration in milliseconds. */
	longTasks: number;
}

/** Result returned after installing the minimal React DevTools hook. */
interface BrowserReactEnableResult {
	/** Whether the hook is installed. */
	installed: boolean;
	/** Version reported by the attached React renderer. */
	reactVersion?: string;
}

/** Options controlling React component tree traversal. */
interface BrowserReactTreeOptions {
	/** Maximum component depth to return. */
	maxDepth?: number;
	/** Include host DOM fibers in the returned tree. */
	includeHost?: boolean;
}

/** One bounded node in the React component tree. */
interface BrowserReactTreeNode {
	/** Stable fiber id accepted by `tab.reactInspect`. */
	id: number;
	/** Component display name. */
	name: string;
	/** Fiber category such as function, class, memo, suspense, or host. */
	type: string;
	/** Explicit React key when present. */
	key?: string;
	/** Bounded prop keys and primitive summaries. */
	props: Record<string, BrowserBoundedJson>;
	/** Nested rendered component children. */
	children: BrowserReactTreeNode[];
}

/** One hook state entry from a function component fiber. */
interface BrowserReactHookState {
	/** Zero-based hook index. */
	index: number;
	/** Hook category such as State, Reducer, Ref, Memo, or Effect. */
	kind: string;
	/** Bounded hook value. */
	value: BrowserBoundedJson;
}

/** Development source metadata available on a React fiber. */
interface BrowserReactSourceInfo {
	/** Source file path. */
	fileName?: string;
	/** One-based source line. */
	lineNumber?: number;
	/** One-based source column. */
	columnNumber?: number;
	/** Display name of the owning component. */
	owner?: string;
}

/** Bounded details for one React fiber. */
interface BrowserReactInspectResult {
	/** Component display name. */
	name: string;
	/** Bounded component props. */
	props: BrowserBoundedJson;
	/** Function hooks or bounded class state. */
	state?: BrowserReactHookState[] | BrowserBoundedJson;
	/** Development source metadata when available. */
	source?: BrowserReactSourceInfo;
	/** CSS selector for the first rendered host element. */
	domSelector?: string;
}

/** Render-recording lifecycle action. */
type BrowserReactRendersAction = "start" | "stop" | "status";

/** Options controlling React render recording. */
interface BrowserReactRendersOptions {
	/** Start, stop, or inspect the current recording. */
	action: BrowserReactRendersAction;
}

/** Aggregate render cost for one component display name. */
interface BrowserReactRenderComponent {
	/** Component display name. */
	name: string;
	/** Number of recorded renders. */
	renders: number;
	/** Sum of React actual-duration values in milliseconds. */
	totalMs: number;
}

/** Recorded React commits and component renders. */
interface BrowserReactRendersResult {
	/** Whether recording remains active, returned by status. */
	active?: boolean;
	/** Number of recorded root commits. */
	commits: number;
	/** Per-component render aggregates sorted by cost. */
	components: BrowserReactRenderComponent[];
}

/** Options controlling Suspense boundary filtering. */
interface BrowserReactSuspenseOptions {
	/** Return only boundaries that have suspended since hook installation. */
	onlyDynamic?: boolean;
}

/** Current and historical state for one Suspense boundary. */
interface BrowserReactSuspenseBoundary {
	/** Stable Suspense fiber id. */
	id: number;
	/** Owning component display name when available. */
	name?: string;
	/** Current pending or resolved state. */
	state: "pending" | "resolved";
	/** Bounded fallback element summary. */
	fallback?: BrowserBoundedJson;
	/** Static or previously suspended classification. */
	classification: "static" | "dynamic";
}

/** Polling/sleep helper available to a browser run function. */
interface BrowserWait {
	/** Sleep for a number of milliseconds. */
	(milliseconds: number): Promise<void>;
	/** Poll until the predicate returns a truthy value. */
	<R>(predicate: () => R | Promise<R>, options?: BrowserPollOptions): Promise<R>;
}

/** Assertion helper available to a browser run function. */
interface BrowserAssert {
	/** Throw with `message` when `condition` is falsy. */
	(condition: unknown, message?: string): asserts condition;
}

/** Behavior for a persistent tab-level network route. */
interface BrowserRouteOptions {
	/** Abort matching requests. */
	abort?: boolean;
	/** Limit the route to one or more resource types. */
	resourceType?: string | string[];
	/** HTTP status used to fulfill matching requests. */
	status?: number;
	/** Response headers used to fulfill matching requests. */
	headers?: Record<string, string>;
	/** Response Content-Type used to fulfill matching requests. */
	contentType?: string;
	/** Response body; objects are serialized as JSON. */
	body?: string | object;
	/** Delay route resolution by this many milliseconds. */
	delay?: number;
}

/** JSON-safe persistent route description. */
interface BrowserRouteDescription {
	/** Glob string or serialized regular expression. */
	pattern: string | { source: string; flags: string };
	/** Route behavior. */
	options: BrowserRouteOptions;
}

/** Request and response byte counts. */
interface BrowserRequestSizes {
	/** Encoded request body bytes. */
	requestBody: number;
	/** Encoded response body bytes when known. */
	responseBody?: number;
}

/** One bounded tab request-log record. */
interface BrowserRequestRecord {
	/** Stable id accepted by `tab.request`. */
	id: string;
	/** Monotonic per-tab sequence. */
	seq: number;
	/** Request start time as Unix milliseconds. */
	ts: number;
	/** Uppercase HTTP method. */
	method: string;
	/** Requested URL. */
	url: string;
	/** Browser resource type. */
	resourceType: string;
	/** HTTP status when a response arrived. */
	status?: number;
	/** Whether the response status was successful. */
	ok?: boolean;
	/** Network failure or allowlist-block reason. */
	failureText?: string;
	/** Elapsed request time in milliseconds. */
	durationMs?: number;
	/** Request headers. */
	requestHeaders: Record<string, string>;
	/** Response headers when available. */
	responseHeaders?: Record<string, string>;
	/** Request and response byte counts. */
	sizes: BrowserRequestSizes;
}

/** Full request detail with a lazily loaded response body. */
interface BrowserRequestDetail extends BrowserRequestRecord {
	/** Text response body or base64-encoded binary bytes. */
	body?: string | { base64: string };
	/** Response MIME type. */
	contentType?: string;
	/** Whether the body was truncated to the 1 MiB cap. */
	bodyTruncated?: boolean;
}

/** Filters for the bounded request log. */
interface BrowserRequestsOptions {
	/** URL substring or regular expression. */
	filter?: string | RegExp;
	/** Resource type or types to include. */
	type?: string | string[];
	/** HTTP method or methods to include. */
	method?: string | string[];
	/** Exact status, class such as `2xx`, or range such as `400-499`. */
	status?: number | string;
	/** Include requests started at or after this Unix-millisecond timestamp. */
	since?: number;
	/** Clear the log after returning selected records. */
	clear?: boolean;
	/** Maximum number of newest matching records. */
	limit?: number;
}

/** Options for starting a HAR recording. */
interface BrowserHarStartOptions {
	/** Response body capture policy. */
	content?: "text" | "all" | "none";
}

/** Options for stopping a HAR recording. */
interface BrowserHarStopOptions {
	/** Absolute or cwd-relative HAR output path. */
	path?: string;
}

/** Filters for experimental WebMCP page-tool discovery. */
interface BrowserWebMcpListOptions {
	/** Return full schemas and annotations only for tools with this exact name. */
	name?: string;
	/** Restrict discovery to one frame id returned by WebMCP. */
	frame?: string;
}

/** Options for invoking an experimental WebMCP page tool. */
interface BrowserWebMcpInvokeOptions {
	/** Restrict invocation to one frame id returned by WebMCP. */
	frame?: string;
	/** Invocation timeout in milliseconds. */
	timeout?: number;
}

/** Options for polling WebMCP catalog transitions. */
interface BrowserWebMcpEventsOptions {
	/** Return events newer than this sequence cursor. */
	since?: number;
	/** Clear retained events after reading them. */
	clear?: boolean;
}

/** One untrusted page-provided WebMCP tool description. */
interface BrowserWebMcpTool {
	/** Page-defined tool name. */
	name: string;
	/** Page-defined tool description. */
	description: string;
	/** CDP identifier of the frame that owns the tool. */
	frameId: string;
	/** Origin of the owning frame. */
	origin: string;
	/** Page-defined JSON Schema, included only for exact-name discovery. */
	inputSchema?: unknown;
	/** Page-defined tool annotations, included only for exact-name discovery. */
	annotations?: unknown;
	/** Marks page-provided metadata as untrusted content. */
	untrusted: true;
}

/** Result of experimental WebMCP page-tool discovery. */
interface BrowserWebMcpListResult {
	/** Whether native CDP or the page-side registration mirror is available. */
	status: "ready" | "unavailable";
	/** Matching page-provided tools. */
	tools: BrowserWebMcpTool[];
	/** Whether the bounded summary omitted or shortened metadata. */
	truncated: boolean;
	/** Explanation when no native or mirrored catalog is available. */
	reason?: string;
	/** Marks page-provided metadata as untrusted content. */
	untrusted: true;
}

/** Successful WebMCP page-tool invocation. */
interface BrowserWebMcpInvokeSuccess {
	/** Indicates successful page-tool execution. */
	ok: true;
	/** JSON-cloneable page-provided result. */
	result: unknown;
	/** Whether an oversized result was represented by a preview. */
	truncated?: boolean;
	/** Original encoded result size when truncated. */
	originalBytes?: number;
	/** Marks the page-provided result as untrusted content. */
	untrusted: true;
}

/** Failed WebMCP page-tool invocation. */
interface BrowserWebMcpInvokeFailure {
	/** Indicates failed page-tool execution. */
	ok: false;
	/** Delimited page-provided or invocation error text. */
	error: string;
	/** Marks the error text as untrusted content. */
	untrusted: true;
}

/** Result of invoking an experimental WebMCP page tool. */
type BrowserWebMcpInvokeResult = BrowserWebMcpInvokeSuccess | BrowserWebMcpInvokeFailure;

/** One WebMCP catalog transition. */
interface BrowserWebMcpCatalogEvent {
	/** Monotonic per-tab event sequence. */
	sequence: number;
	/** Catalog transition kind. */
	type: "registered" | "updated" | "unregistered";
	/** Page-defined tool name. */
	name: string;
	/** CDP identifier of the owning frame. */
	frameId: string;
	/** Origin of the owning frame. */
	origin: string;
	/** Host timestamp when polling observed the transition. */
	timestamp: number;
	/** Marks page-provided event fields as untrusted content. */
	untrusted: true;
}

/** Result of polling WebMCP catalog transitions. */
interface BrowserWebMcpEventsResult {
	/** Matching catalog transitions. */
	events: BrowserWebMcpCatalogEvent[];
	/** Latest per-tab event sequence. */
	cursor: number;
	/** Whether older retained events were omitted. */
	truncated: boolean;
	/** Marks page-provided event fields as untrusted content. */
	untrusted: true;
}

/** Web Storage area accepted by browser storage helpers. */
type BrowserStorageKind = "local" | "session";

/** Cookie fields returned by `tab.cookies`. */
interface BrowserCookie {
	/** Cookie name. */
	name: string;
	/** Cookie value. */
	value: string;
	/** Cookie domain. */
	domain: string;
	/** Cookie path. */
	path: string;
	/** Expiration time in Unix seconds, or -1 for a session cookie. */
	expires: number;
	/** Whether JavaScript is denied access to the cookie. */
	httpOnly: boolean;
	/** Whether the cookie is limited to secure transports. */
	secure: boolean;
	/** Effective SameSite policy. */
	sameSite: "Strict" | "Lax" | "None";
}

/** Cookie object accepted by `tab.setCookies`. */
interface BrowserCookieInput {
	/** Cookie name. */
	name: string;
	/** Cookie value. */
	value: string;
	/** Cookie domain override. */
	domain?: string;
	/** Cookie path override. */
	path?: string;
	/** URL used to infer domain, path, and scheme. */
	url?: string;
	/** Expiration time in Unix seconds. */
	expires?: number;
	/** Deny JavaScript access to the cookie. */
	httpOnly?: boolean;
	/** Limit the cookie to secure transports. */
	secure?: boolean;
	/** Cookie SameSite policy. */
	sameSite?: "Strict" | "Lax" | "None";
}

/** Optional trailing scope for imported raw cookie pairs. */
interface BrowserCookieScope {
	/** Default domain for imported cookie pairs. */
	domain?: string;
	/** Default URL for imported cookie pairs. */
	url?: string;
}

/** Cookie lookup options. */
interface BrowserCookieQueryOptions {
	/** URLs whose matching cookies should be returned. */
	urls?: string[];
}

/** Cookie deletion options. */
interface BrowserClearCookiesOptions {
	/** Cookie names to delete; omission deletes every current-page cookie. */
	names?: string[];
}

/** Web Storage key lookup options. */
interface BrowserStorageKeyOptions {
	/** Return only this key's value. */
	key?: string;
}

/** Result of restoring per-origin browser state. */
interface BrowserLoadStateResult {
	/** Origins whose Web Storage was restored. */
	loadedOrigins: string[];
	/** Origins skipped because safe hidden navigation was unavailable or failed. */
	skippedOrigins: string[];
}

/** Browser-tab helpers whose behavior is shared by direct and run-realm handles. */
interface BrowserTabHelpers {
	/** Return the current page title. */
	title(): Promise<string>;
	/** Navigate the page. */
	goto(url: string, options?: BrowserGotoOptions): Promise<void>;
	/** Navigate to the previous session-history entry. */
	back(options?: BrowserGotoOptions): Promise<string>;
	/** Navigate to the next session-history entry. */
	forward(options?: BrowserGotoOptions): Promise<string>;
	/** Reload the current document. */
	reload(options?: BrowserGotoOptions): Promise<string>;
	/** Perform client-side navigation without loading a new document. */
	pushState(url: string): Promise<string>;
	/** List the current main and child frames. */
	frames(): Promise<BrowserFrameInfo[]>;
	/** Return the current pending JavaScript-dialog state. */
	dialog(): Promise<BrowserDialogState>;
	/** Explicitly settle the pending confirm or prompt. */
	handleDialog(options: BrowserHandleDialogOptions): Promise<void>;
	/** Change the automatic JavaScript-dialog policy at runtime. */
	setDialogs(policy: "accept" | "dismiss" | null): Promise<void>;
	/** Capture a structured accessibility observation. */
	observe(options?: BrowserObserveOptions): Promise<BrowserObservation>;
	/** Capture a Playwright-format ARIA snapshot. */
	ariaSnapshot(
		selector?: string,
		options?: BrowserAriaSnapshotOptions,
	): Promise<string | BrowserAriaSnapshotDiffResult>;
	/** Run an axe-core accessibility audit across the page frame tree. */
	a11y(options?: BrowserA11yOptions): Promise<BrowserA11yResult>;
	/** Discover experimental page-provided WebMCP tools. */
	webmcpList(options?: BrowserWebMcpListOptions): Promise<BrowserWebMcpListResult>;
	/** Invoke one experimental page-provided WebMCP tool. */
	webmcpInvoke(
		name: string,
		params: Record<string, unknown>,
		options?: BrowserWebMcpInvokeOptions,
	): Promise<BrowserWebMcpInvokeResult>;
	/** Poll the experimental WebMCP catalog change log. */
	webmcpEvents(options?: BrowserWebMcpEventsOptions): Promise<BrowserWebMcpEventsResult>;
	/** Capture the page or one matching element; tracked captures return change metadata. */
	screenshot(options?: BrowserScreenshotOptions): Promise<string | BrowserScreenshotChangeResult>;
	/** Compare the current viewport against a saved PNG and display a highlighted diff. */
	diffScreenshot(baselinePath: string, options?: BrowserDiffScreenshotOptions): Promise<BrowserDiffScreenshotResult>;
	/** Print the page to PDF and return its absolute path. */
	pdf(options?: BrowserPdfOptions): Promise<string>;
	/** Extract readable page content. */
	extract(format?: "text" | "markdown", options?: BrowserExtractOptions): Promise<string>;
	/** Click the element matching `selector`. */
	click(selector: string): Promise<void>;
	/** Double-click the element matching `selector`. */
	dblclick(selector: string): Promise<void>;
	/** Hover the element matching `selector`. */
	hover(selector: string): Promise<void>;
	/** Focus the element matching `selector`. */
	focus(selector: string): Promise<void>;
	/** Set a checkbox, radio, or ARIA switch. */
	check(selector: string): Promise<void>;
	/** Clear a checkbox, radio, or ARIA switch. */
	uncheck(selector: string): Promise<void>;
	/** Press a keyboard key without releasing it. */
	keyDown(key: string): Promise<void>;
	/** Release a keyboard key. */
	keyUp(key: string): Promise<void>;
	/** Move the pointer to viewport coordinates. */
	mouseMove(x: number, y: number, options?: BrowserMouseMoveOptions): Promise<void>;
	/** Press a mouse button at the current pointer position. */
	mouseDown(options?: BrowserMouseButtonOptions): Promise<void>;
	/** Release a mouse button at the current pointer position. */
	mouseUp(options?: BrowserMouseButtonOptions): Promise<void>;
	/** Click the element under viewport coordinates. */
	clickAt(x: number, y: number, options?: BrowserClickAtOptions): Promise<void>;
	/** Dispatch a raw wheel event. */
	wheel(deltaX: number, deltaY: number): Promise<void>;
	/** Draw a temporary inert outline around a matching element. */
	highlight(selector: string, options?: BrowserHighlightOptions): Promise<void>;
	/** Type text into the element matching `selector`. */
	type(selector: string, text: string): Promise<void>;
	/** Replace the value of the element matching `selector`. */
	fill(selector: string, value: string): Promise<void>;
	/** Press a keyboard key, optionally on a matching element. */
	press(key: string, options?: BrowserPressOptions): Promise<void>;
	/** Scroll by page-relative or matching-element deltas. */
	scroll(deltaX: number, deltaY: number, options?: BrowserScrollOptions): Promise<void>;
	/** Drag from one selector or point to another. */
	drag(from: BrowserDragTarget, to: BrowserDragTarget): Promise<void>;
	/** Evaluate a function or source string in the page. */
	evaluate<R, TArgs extends unknown[]>(fn: string | ((...args: TArgs) => R | Promise<R>), ...args: TArgs): Promise<R>;
	/** Scroll the matching element into view. */
	scrollIntoView(selector: string): Promise<void>;
	/** Select values in the matching `<select>` element. */
	select(selector: string, ...values: string[]): Promise<string[]>;
	/** Upload files through a matching file input, chooser trigger, or drop zone. */
	uploadFile(selector: string, ...filePaths: string[]): Promise<void>;
	/** Wait for the current URL to match a string or regular expression. */
	waitForUrl(pattern: string | RegExp, options?: BrowserWaitOptions): Promise<string>;
	/** Start persistent CDP screencast recording to an MP4 or WebM path. */
	recordStart(path: string, options?: BrowserRecordingOptions): Promise<BrowserRecordingStartResult>;
	/** Stop and finalize the active recording. */
	recordStop(): Promise<BrowserRecordingStopResult>;
	/** Finalize an active recording, then immediately start another. */
	recordRestart(path: string, options?: BrowserRecordingOptions): Promise<BrowserRecordingStartResult>;
	/** Return the current persistent recording state. */
	recording(): Promise<BrowserRecordingStatus>;
	/** Return cookies visible to the current page or supplied URLs. */
	cookies(options?: BrowserCookieQueryOptions): Promise<BrowserCookie[]>;
	/** Install cookie objects, a raw Cookie header, a cURL dump, or a JSON cookie array; an optional scope object may be last. */
	setCookies(...cookies: Array<BrowserCookieInput | string | BrowserCookieScope>): Promise<void>;
	/** Delete all current-page cookies or selected cookie names. */
	clearCookies(options?: BrowserClearCookiesOptions): Promise<void>;
	/** Return all pairs from a Web Storage area, or one selected value. */
	storage(
		kind: BrowserStorageKind,
		options?: BrowserStorageKeyOptions,
	): Promise<Record<string, string> | string | null>;
	/** Set one Web Storage value; non-string values are JSON-stringified. */
	setStorage(kind: BrowserStorageKind, key: string, value: unknown): Promise<void>;
	/** Set several Web Storage values; non-string values are JSON-stringified. */
	setStorage(kind: BrowserStorageKind, entries: Record<string, unknown>): Promise<void>;
	/** Clear one Web Storage area. */
	clearStorage(kind: BrowserStorageKind): Promise<void>;
	/** Save Playwright-compatible cookies and current-origin storage, returning the absolute file path. */
	saveState(path?: string): Promise<string>;
	/** Restore cookies and per-origin storage from a saved state file. */
	loadState(path: string): Promise<BrowserLoadStateResult>;
	/** Return the first matching element's rendered text, or `null`. */
	text(selector: string): Promise<string | null>;
	/** Return the first matching element's inner HTML, or `null`. */
	html(selector: string): Promise<string | null>;
	/** Return the first matching form element's current value, or `null`. */
	value(selector: string): Promise<string | null>;
	/** Return one attribute from the first matching element, or `null`. */
	attr(selector: string, name: string): Promise<string | null>;
	/** Count elements matching a selector. */
	count(selector: string): Promise<number>;
	/** Return the first matching element's page-coordinate bounds, or `null`. */
	box(selector: string): Promise<BrowserBoundingBox | null>;
	/** Return selected computed styles for the first matching element, or `null`. */
	styles(selector: string, props?: string[]): Promise<Record<string, string> | null>;
	/** Report whether the first matching element is visible. */
	isVisible(selector: string): Promise<boolean>;
	/** Report whether the first matching element is enabled. */
	isEnabled(selector: string): Promise<boolean>;
	/** Report whether the first matching element is checked. */
	isChecked(selector: string): Promise<boolean>;
	/** Wait until text appears in the document body or one matching element. */
	waitForText(text: string, options?: BrowserWaitForTextOptions): Promise<void>;
	/** Register JavaScript for every future document and return its identifier. */
	addInitScript(source: string): Promise<{ id: string }>;
	/** Remove a previously registered document-start script. */
	removeInitScript(id: string): Promise<void>;
	/** List document-start scripts registered through this tab helper. */
	initScripts(): Promise<BrowserInitScript[]>;
	/** Wait for the next completed download. */
	waitForDownload(options?: BrowserWaitOptions): Promise<BrowserDownload>;
	/** List completed downloads for this tab. */
	downloads(): Promise<BrowserDownload[]>;
	/** Merge runtime emulation overrides, or return the current state when omitted. */
	emulate(options?: BrowserEmulateOptions): Promise<BrowserEmulateOptions>;
	/** List Puppeteer known-device names. */
	devices(): Promise<string[]>;
	/** Read plain text from the page clipboard. */
	clipboardRead(): Promise<BrowserClipboardReadResult>;
	/** Write plain text to the page clipboard. */
	clipboardWrite(text: string): Promise<BrowserClipboardActionResult>;
	/** Copy the page's current selection. */
	clipboardCopy(): Promise<BrowserClipboardActionResult>;
	/** Paste the page clipboard into the focused control. */
	clipboardPaste(): Promise<BrowserClipboardActionResult>;
	/** Read captured page console messages. */
	console(options?: BrowserConsoleOptions): Promise<BrowserCaptureResult<BrowserConsoleEntry>>;
	/** Read captured uncaught exceptions and failed requests. */
	errors(options?: BrowserErrorOptions): Promise<BrowserCaptureResult<BrowserErrorEntry>>;
	/** Clear captured page console messages, errors, and overflow state. */
	clearConsole(): Promise<void>;
	/** Start a Chromium performance trace. */
	traceStart(options?: BrowserTraceStartOptions): Promise<void>;
	/** Stop the active trace, save it, and return its absolute path. */
	traceStop(options?: BrowserTraceStopOptions): Promise<string>;
	/** Start Chromium CPU profiling. */
	profileStart(): Promise<void>;
	/** Stop CPU profiling, save it, and return its absolute path. */
	profileStop(options?: BrowserProfileStopOptions): Promise<string>;
	/** Return Chromium page metrics and navigation lifecycle durations. */
	metrics(): Promise<BrowserMetrics>;
	/** Register a persistent URL-glob or regular-expression route. */
	route(pattern: string | RegExp, options?: BrowserRouteOptions): Promise<void>;
	/** Remove matching routes, or every route when omitted. */
	unroute(pattern?: string | RegExp): Promise<void>;
	/** List persistent tab routes. */
	routes(): Promise<BrowserRouteDescription[]>;
	/** Query the bounded request log. */
	requests(options?: BrowserRequestsOptions): Promise<BrowserRequestRecord[]>;
	/** Load one request and its capped response body. */
	request(id: string | number): Promise<BrowserRequestDetail>;
	/** Clear the bounded request log. */
	clearRequests(): Promise<void>;
	/** Start a HAR 1.2 recording. */
	harStart(options?: BrowserHarStartOptions): Promise<void>;
	/** Stop the active HAR recording and return its absolute path. */
	harStop(options?: BrowserHarStopOptions): Promise<string>;
	/** Return the tab's normalized hostname allowlist. */
	allowedDomains(): Promise<string[]>;
	/** Collect Web Vitals and navigation timing for the current document. */
	vitals(options?: BrowserVitalsOptions): Promise<BrowserVitalsResult>;
	/** Install the minimal React DevTools hook and reload the page. */
	reactEnable(): Promise<BrowserReactEnableResult>;
	/** Return the mounted React component tree. */
	reactTree(options?: BrowserReactTreeOptions): Promise<BrowserReactTreeNode[]>;
	/** Inspect one React fiber by its tree id. */
	reactInspect(id: number): Promise<BrowserReactInspectResult>;
	/** Start, stop, or inspect React render recording. */
	reactRenders(options: BrowserReactRendersOptions): Promise<BrowserReactRendersResult>;
	/** List mounted React Suspense boundaries. */
	reactSuspense(options?: BrowserReactSuspenseOptions): Promise<BrowserReactSuspenseBoundary[]>;
}

/** A child-frame handle returned by `BrowserTab.frame`. */
interface BrowserFrame {
	/** Click a matching element inside this frame. */
	click(selector: string): Promise<void>;
	/** Replace a matching form control's value inside this frame. */
	fill(selector: string, value: string): Promise<void>;
	/** Type text into a matching element inside this frame. */
	type(selector: string, text: string): Promise<void>;
	/** Press a key, optionally after focusing a matching element. */
	press(key: string, options?: BrowserPressOptions): Promise<void>;
	/** Return a matching element's text content. */
	text(selector: string): Promise<string>;
	/** Return a matching element's inner HTML. */
	html(selector: string): Promise<string>;
	/** Return a matching form control's value. */
	value(selector: string): Promise<string>;
	/** Return one matching element attribute. */
	attr(selector: string, name: string): Promise<string | null>;
	/** Count matching elements inside this frame. */
	count(selector: string): Promise<number>;
	/** Report whether a matching element is visible. */
	isVisible(selector: string): Promise<boolean>;
	/** Capture a Playwright-format ARIA snapshot inside this frame. */
	ariaSnapshot(selector?: string, options?: BrowserAriaSnapshotOptions): Promise<string>;
	/** Evaluate a function or source string inside this frame. */
	evaluate<R, TArgs extends unknown[]>(fn: string | ((...args: TArgs) => R | Promise<R>), ...args: TArgs): Promise<R>;
	/** Wait for a selector and report whether it appeared. */
	waitFor(selector: string, options?: BrowserWaitForSelectorOptions): Promise<boolean>;
	/** Wait for a selector and report whether it appeared. */
	waitForSelector(selector: string, options?: BrowserWaitForSelectorOptions): Promise<boolean>;
	/** Capture a matching element and return the saved path. */
	screenshot(selector: string): Promise<string>;
}

/** An element handle returned by `BrowserTab.id` or `BrowserTab.ref`. */
interface BrowserElement {
	/** Click this element. */
	click(): Promise<void>;
	/** Double-click this element. */
	dblclick(): Promise<void>;
	/** Set this checkbox, radio, or ARIA switch. */
	check(): Promise<void>;
	/** Clear this checkbox, radio, or ARIA switch. */
	uncheck(): Promise<void>;
	/** Draw a temporary inert outline around this element. */
	highlight(options?: BrowserHighlightOptions): Promise<void>;
	/** Type text into this element. */
	type(text: string): Promise<void>;
	/** Replace this element's value. */
	fill(value: string): Promise<void>;
	/** Press a keyboard key on this element. */
	press(key: string): Promise<void>;
	/** Hover this element. */
	hover(): Promise<void>;
	/** Focus this element. */
	focus(): Promise<void>;
	/** Select values when this element is a `<select>`. */
	select(...values: string[]): Promise<string[]>;
	/** Upload files when this element is a file input. */
	uploadFile(...filePaths: string[]): Promise<void>;
	/** Scroll this element into view. */
	scrollIntoView(): Promise<void>;
	/** Return this element's page-coordinate bounds. */
	boundingBox(): Promise<BrowserBoundingBox | null>;
	/** Report whether this element is visible. */
	isVisible(): Promise<boolean>;
	/** Report whether this element is hidden. */
	isHidden(): Promise<boolean>;
	/** Return this element's rendered text. */
	text(): Promise<string>;
	/** Return this element's inner HTML. */
	html(): Promise<string>;
	/** Return this form element's current value, or `null` when unsupported. */
	value(): Promise<string | null>;
	/** Return one attribute, or `null` when absent. */
	attr(name: string): Promise<string | null>;
	/** Return selected computed styles. */
	styles(props?: string[]): Promise<Record<string, string>>;
	/** Report whether this element is enabled. */
	isEnabled(): Promise<boolean>;
	/** Report whether this element is checked. */
	isChecked(): Promise<boolean>;
	/** Evaluate a function or source string with this element as the first argument. */
	evaluate<R, TArgs extends unknown[]>(
		fn: string | ((element: unknown, ...args: TArgs) => R | Promise<R>),
		...args: TArgs
	): Promise<R>;
}

/** Full tab helper available inside the isolated `tab.run` realm. */
interface BrowserTabRealm extends BrowserTabHelpers {
	/** Managed-tab name. */
	readonly name: string;
	/** Raw Puppeteer page object. */
	readonly page: unknown;
	/** Abort signal for the active run. */
	readonly signal?: AbortSignal;
	/** Return the current page URL synchronously. */
	url(): string;
	/** Wait for and return an actionable element handle. */
	waitFor(selector: string, options?: BrowserWaitOptions): Promise<BrowserElement>;
	/** Wait for and return an element handle, or `null` when it remains absent. */
	waitForSelector(selector: string, options?: BrowserWaitForSelectorOptions): Promise<BrowserElement | null>;
	/** Wait for a matching network response and return the raw response object. */
	waitForResponse(
		pattern: string | RegExp | ((response: unknown) => boolean | Promise<boolean>),
		options?: BrowserWaitOptions,
	): Promise<unknown>;
	/** Wait for the next navigation and return its raw response when available. */
	waitForNavigation(options?: BrowserWaitForNavigationOptions): Promise<unknown | null>;
	/** Resolve a numeric observation id to an element handle. */
	id(id: number): Promise<BrowserElement>;
	/** Resolve an ARIA snapshot reference to an element handle. */
	ref(id: string): Promise<BrowserElement>;
	/** Resolve a child frame by selector, name, or exact URL. */
	frame(selectorOrNameOrUrl: string): Promise<BrowserFrame>;
}

/** Scope object passed as the first argument to a browser run function. */
interface BrowserRunScope {
	/** Full tab helper for the current run realm. */
	readonly tab: BrowserTabRealm;
	/** Raw Puppeteer page object. */
	readonly page: unknown;
	/** Raw Puppeteer browser object. */
	readonly browser: unknown;
	/** Polling and sleep helper. */
	readonly wait: BrowserWait;
	/** Assertion helper. */
	readonly assert: BrowserAssert;
}

/** A named browser tab handle returned by `browser.open` or `browser.tab`. */
interface BrowserTab extends BrowserTabHelpers {
	/** Immutable managed-tab name. */
	readonly name: string;
	/** Return the current page URL. */
	url(): Promise<string>;
	/** Wait for an actionable selector and report whether it appeared. */
	waitFor(selector: string, options?: BrowserWaitOptions): Promise<boolean>;
	/** Wait for a selector and report whether it appeared. */
	waitForSelector(selector: string, options?: BrowserWaitForSelectorOptions): Promise<boolean>;
	/** Return a numeric observation-id element proxy. */
	id(id: number): BrowserElement;
	/** Return an ARIA-reference element proxy. */
	ref(id: string): BrowserElement;
	/** Return a child-frame proxy resolved by selector, name, or exact URL. */
	frame(selectorOrNameOrUrl: string): BrowserFrame;
	/** Run a serialized function in the tab runtime. */
	run<R, TArgs extends unknown[]>(
		fn: (scope: BrowserRunScope, ...args: TArgs) => R | Promise<R>,
		options?: BrowserRunOptions<TArgs>,
	): Promise<R>;
	/** Run a JavaScript function body in the tab runtime. */
	run<R = unknown>(code: string, options?: BrowserRunOptions): Promise<R>;
	/** Release this managed tab. */
	close(options?: BrowserTabCloseOptions): Promise<void>;
}

/** Session-scoped browser facade available in JavaScript Eval. */
declare const browser: {
	/** Open or reuse a tab and return its handle. */
	open(options?: BrowserOpenOptions): Promise<BrowserTab>;
	/** Return a handle for an existing named tab without opening it. */
	tab(name?: string): BrowserTab;
	/** List the session's managed browser tabs. */
	tabs(): Promise<BrowserManagedTab[]>;
	/** Release one or all managed tabs. */
	close(options?: BrowserCloseOptions): Promise<void>;
};
