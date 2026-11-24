/**
 * Input routing for `InputController` tests without a started shell: records
 * the handlers the controller installs through `interceptInput` and
 * `addGlobalKeyHandler`, and dispatches events the way the shell does —
 * interceptors (newest first), then the focused node (the composer field runs
 * its `addKeyHandler` hooks, then its own bindings; any other focused node its
 * `onKey`/`onPaste`), then the global key handlers (newest first).
 *
 * ```ts
 * const input = createInputHarness();
 * const ctx = { ...stub, composer, ...input.context } as unknown as InteractiveModeContext;
 * new InputController(ctx).setupKeyHandlers();
 * input.press(ctx, "ctrl+c");
 * ```
 */
import type { KeyEvent, UiNode } from "@oh-my-pi/pi-tui";
import type { InputEvent } from "@oh-my-pi/pi-tui/driver/index";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Composer } from "../../src/ui/composer/composer";

type Interceptor = (event: InputEvent) => boolean;
type GlobalKeyHandler = (key: KeyEvent) => boolean;

/** What dispatch reads from a context: the composer and, when present, the shell's focus. */
export interface DispatchContext {
	readonly composer: Composer;
	readonly shell?: { focused(): UiNode | null };
}

/** The stage that took a dispatched event. */
export type DispatchStage = "intercepted" | "composer" | "focused" | "global" | "unhandled";

export interface InputHarness {
	readonly interceptors: Interceptor[];
	readonly globalKeys: GlobalKeyHandler[];
	/** Context members to spread into a stub context. */
	readonly context: {
		interceptInput(handler: Interceptor): () => void;
		addGlobalKeyHandler(handler: GlobalKeyHandler): () => void;
	};
	/** Dispatch one input event; returns which stage took it. */
	dispatch(ctx: DispatchContext, event: InputEvent): DispatchStage;
	/** Press `id` (a canonical pi-tui key id such as `ctrl+c`, `escape`, `a`). */
	press(ctx: DispatchContext, id: string, init?: Partial<KeyEvent>): DispatchStage;
	/** Deliver a bracketed paste. */
	paste(ctx: DispatchContext, text: string): DispatchStage;
}

/** A key event for `id`; single printable characters carry their text. */
export function keyEvent(id: string, init?: Partial<KeyEvent>): KeyEvent {
	const text = id.length === 1 ? id : id === "space" ? " " : undefined;
	return { id, kind: "press", raw: text ?? "", ...(text === undefined ? {} : { text }), ...init };
}

function register<T>(list: T[], item: T): () => void {
	list.push(item);
	return () => {
		const at = list.indexOf(item);
		if (at !== -1) list.splice(at, 1);
	};
}

export function createInputHarness(): InputHarness {
	const interceptors: Interceptor[] = [];
	const globalKeys: GlobalKeyHandler[] = [];
	// Without a shell the composer counts as focused.
	const focusedNode = (ctx: DispatchContext): UiNode | null => (ctx.shell ? ctx.shell.focused() : ctx.composer.field);
	const harness: InputHarness = {
		interceptors,
		globalKeys,
		context: {
			interceptInput: handler => register(interceptors, handler),
			addGlobalKeyHandler: handler => register(globalKeys, handler),
		},
		dispatch(ctx, event) {
			if (interceptors.toReversed().some(handler => handler(event))) return "intercepted";
			const focused = focusedNode(ctx);
			const stage = focused === ctx.composer.field ? "composer" : "focused";
			if (event.type === "paste") {
				if (focused?.handlers.onPaste?.(event.paste)) return stage;
				// The composer field's editing widget inserts what its handlers left.
				if (focused === ctx.composer.field) {
					ctx.composer.insertText(event.paste.text);
					return stage;
				}
				return "unhandled";
			}
			if (event.type !== "key") return "unhandled";
			if (focused?.handlers.onKey?.(event.key)) return stage;
			if (globalKeys.toReversed().some(handler => handler(event.key))) return "global";
			return "unhandled";
		},
		press: (ctx, id, init) => harness.dispatch(ctx, { type: "key", key: keyEvent(id, init) }),
		paste: (ctx, text) => harness.dispatch(ctx, { type: "paste", paste: { text } }),
	};
	return harness;
}

/** A composer whose draft already carries `images` (and their chip links, `undefined` each when omitted). */
export function draftComposer(
	images: readonly ImageContent[] = [],
	links?: readonly (string | undefined)[],
	text = "",
): Composer {
	const composer = new Composer({ text });
	composer.pendingImages.push(...images);
	composer.pendingImageLinks.push(...(links ?? images.map(() => undefined)));
	return composer;
}
