/**
 * Mounting the component an extension's renderer returned, in the scope that owns it.
 *
 * A host's own renderers — a built-in or MCP tool's, the host's message renderers — are host code,
 * and so are the components they return: a host calls them directly. An extension's are its
 * author's. They may run only inside the session that registered them, and never once that
 * session has gone. `@oh-my-pi/pi-coding-agent` (which this package cannot import) runs the
 * renderers themselves inside that admission, on copies of what the host hands them, and hands
 * each one with a {@link ToolRendererScope} (`rendererScope`): a tool's renderers through
 * `RegisteredToolAdapter`, message, thinking and text renderers through `ExtensionRunner`. Every
 * host that mounts a component one returned mounts it through {@link SafeToolRendererComponent}
 * with that scope — the chat card (`ToolExecutionComponent`), the `write xd://` device card
 * (`tools/xdev.ts`), the custom message frame (`FramedMessageComponent`) and the assistant
 * message's thinking extensions (`AssistantMessageComponent`) — and treats a renderer whose scope
 * has gone as no renderer: it draws its own default rendering.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { isFramedBlockComponent, markFramedBlockComponent } from "../render/output-block";
import type { AutocompleteItem, AutocompleteProvider } from "../autocomplete";
import type { Component } from "../tui";

/** Where an extension's renderers run, and the components they return. */
export interface ToolRendererScope {
	/** Whether the owner still holds the renderers. Once false, a host calls nothing they returned
	 *  and draws its own default rendering in their place. */
	readonly live: boolean;
	/** Runs `call` as the owner's work and returns its answer. Throws once the owner has gone. */
	run<T>(call: () => T): T;
	/**
	 * The scope of the session the owner is serving now, which never becomes live again once that
	 * session has gone. An owner may outlive its session — an extension runtime reused for the next
	 * one — and answer `live` for whichever session holds it; what one session leaves behind (a
	 * component bound to its input, an overlay it showed) belongs to that session, not to the next.
	 * Absent for a scope that is already one session's, or one that never ends.
	 */
	pin?(): ToolRendererScope;
}

/** The scope `scope` stands for in the session it serves now ({@link ToolRendererScope.pin}). */
export function pinInputScope(scope: ToolRendererScope): ToolRendererScope {
	return scope.pin?.() ?? scope;
}

/** The scope `holder` — a tool, or a renderer function — names for its renderers
 *  (`rendererScope`): an extension's, or `undefined` for the host's own, whose renderers and
 *  components are called directly. */
export function toolRendererScope(holder: object | undefined): ToolRendererScope | undefined {
	if (holder === undefined || !("rendererScope" in holder)) return undefined;
	const scope = holder.rendererScope;
	if (typeof scope !== "object" || scope === null || !("live" in scope) || !("run" in scope)) return undefined;
	// Shaped as coding-agent shapes it; the host reads `live` and calls `run`, nothing else.
	const named: ToolRendererScope = scope as ToolRendererScope;
	return named;
}

/** Whether `holder`'s renderers may be called: the host's own always, an extension's while its
 *  owner holds them. A renderer whose scope has gone is no renderer. */
export function toolRenderersLive(holder: object | undefined): boolean {
	return toolRendererScope(holder)?.live !== false;
}

/** Which renderer produced a component: a tool's call or result renderer, a message renderer, a
 *  thinking renderer, or a `ctx.ui` component factory (widget, footer, header). */
export type ToolRendererStage = "call" | "result" | "message" | "thinking" | "widget";

/** The lines a scoped component rendered, copied while its scope is on the stack: the array and
 *  each line read once, each line a string. The host reads only the copy afterwards. */
function copyRenderedLines(lines: unknown): string[] {
	if (!Array.isArray(lines)) throw new TypeError("render() returned no array of lines");
	const length = lines.length;
	// oxlint-disable-next-line unicorn/no-new-array -- render-frame length preallocation
	const copy = new Array<string>(length);
	for (let index = 0; index < length; index++) {
		const line: unknown = lines[index];
		if (typeof line !== "string") throw new TypeError(`render() line ${index} is not a string`);
		copy[index] = line;
	}
	return copy;
}

/** Answers what the component's `handleInput` answers, so the scope it runs in owns an asynchronous
 *  handler until it ends. */
function handleInputOf(component: Component, data: string): unknown {
	const handleInput = component.handleInput;
	return handleInput === undefined ? undefined : handleInput.call(component, data);
}

function invalidateOf(component: Component): void {
	const invalidate = component.invalidate;
	if (invalidate !== undefined) invalidate.call(component);
}

function setIgnoreTightOf(component: Component, ignore: boolean): void {
	const setIgnoreTight = component.setIgnoreTight;
	if (setIgnoreTight !== undefined) setIgnoreTight.call(component, ignore);
}

function disposeOf(component: Component): void {
	const dispose = component.dispose;
	if (dispose !== undefined) dispose.call(component);
}

function releaseRenderCachesOf(component: Component): void {
	const release = component.releaseRenderCaches;
	if (release !== undefined) release.call(component);
}

/**
 * The component a renderer returned, as a host mounts it.
 *
 * A component that throws while rendering is contained: the host's `fallback` is drawn instead,
 * and the failure logged once. With a `scope` — a renderer that is not the host's own — every read
 * of the component and every call into it runs inside that scope, the lines it renders are copied
 * there, and once the scope has gone the component is never called again: `render` draws the
 * fallback and the other methods do nothing. The component belongs to the session the scope
 * serves when it is mounted ({@link pinInputScope}): a scope whose owner goes on to serve the next
 * session does not bring it back. Without one, the component is called directly.
 *
 * The component is held, not wrapped: its methods are called on it as their receiver, so a
 * component keeping its state in `#private` fields works as it does unmounted. Its `describe` is
 * not forwarded: a native terminal draws it through `render`, inside the scope, because a node it
 * described could hold more of its components for the host to call later.
 */
export class SafeToolRendererComponent implements Component {
	/** Whose renderer it is: the tool's name, the message's custom type. */
	readonly #source: string;
	readonly #stage: ToolRendererStage;
	readonly #component: Component;
	readonly #fallback: () => Component | undefined;
	readonly #scope: ToolRendererScope | undefined;
	#warned = false;
	readonly wantsKeyRelease: boolean | undefined;

	constructor(
		source: string,
		stage: ToolRendererStage,
		component: Component,
		fallback: () => Component | undefined,
		rendererScope?: ToolRendererScope,
	) {
		this.#source = source;
		this.#stage = stage;
		this.#component = component;
		this.#fallback = fallback;
		const scope = rendererScope === undefined ? undefined : pinInputScope(rendererScope);
		this.#scope = scope;
		if (scope === undefined) {
			this.wantsKeyRelease = component.wantsKeyRelease;
			if (isFramedBlockComponent(component)) markFramedBlockComponent(this);
			return;
		}
		// What the host reads off a scoped component it reads once, inside the scope, as host values.
		const marks = scope.live
			? scope.run(() => {
					const wants: unknown = component.wantsKeyRelease;
					return {
						wantsKeyRelease: wants === undefined ? undefined : wants === true,
						framed: isFramedBlockComponent(component),
					};
				})
			: undefined;
		this.wantsKeyRelease = marks?.wantsKeyRelease;
		if (marks?.framed) markFramedBlockComponent(this);
	}

	render(width: number): readonly string[] {
		const scope = this.#scope;
		if (scope !== undefined && !scope.live) return this.#fallback()?.render(width) ?? [];
		try {
			if (scope === undefined) return this.#component.render(width);
			return scope.run(() => copyRenderedLines(this.#component.render(width)));
		} catch (err) {
			this.#warn("render", err);
			return this.#fallback()?.render(width) ?? [];
		}
	}

	handleInput(data: string): void {
		this.#use(handleInputOf, data);
	}

	invalidate(): void {
		this.#use(invalidateOf, undefined);
	}

	releaseRenderCaches(): void {
		try {
			this.#use(releaseRenderCachesOf, undefined);
		} catch (err) {
			this.#warn("releaseRenderCaches", err);
		}
	}

	setIgnoreTight(ignore: boolean): void {
		this.#use(setIgnoreTightOf, ignore);
	}

	dispose(): void {
		this.#use(disposeOf, undefined);
	}

	/** Calls into the component: directly without a scope, inside it with one, and not at all once
	 *  that scope has gone. */
	#use<A>(call: (component: Component, arg: A) => void, arg: A): void {
		const scope = this.#scope;
		if (scope === undefined) call(this.#component, arg);
		else if (scope.live) scope.run(() => call(this.#component, arg));
	}

	#warn(phase: "render" | "releaseRenderCaches", err: unknown): void {
		if (this.#warned) return;
		this.#warned = true;
		const stage = this.#stage;
		const tool = stage === "call" || stage === "result";
		logger.warn(tool ? "Tool renderer failed" : "Extension renderer failed", {
			[tool ? "tool" : "renderer"]: this.#source,
			stage,
			...(phase === "render" ? {} : { phase }),
			error: String(err),
		});
	}
}

/** A component an extension supplied that the host gives keyboard focus, and what the host does
 *  with it once its scope has gone. */
interface InputScope {
	readonly scope: ToolRendererScope;
	readonly retire: () => Component | undefined;
	retired: boolean;
	/** What `retire` put in the component's place: the host's own editor; none for a closed dialog. */
	successor: Component | undefined;
	/** Focus targets inside this one that took its scope ({@link adoptInputScope}). */
	adopted: Set<Component> | undefined;
}

/**
 * The components an extension supplied that take keyboard input — a replaced editor
 * (`setEditorComponent`), a `custom` dialog — each with the scope it runs in. Host-owned: the
 * extension never holds this map, so it cannot remove its own entry. The TUI consults it wherever
 * it hands a component input or focus (`TUI`'s input target and focus flags).
 */
const inputScopes = new WeakMap<Component, InputScope>();
/** Bound components not yet retired, for {@link retireGoneInputScopes}: removed when retired or
 *  unbound, so a component the host has let go of is not kept. */
const awaitingRetirement = new Set<Component>();
/** What a host owes once a scope has gone, whatever components it touched ({@link whenInputScopeGone}). */
const scopeObligations = new Set<{ readonly scope: ToolRendererScope; readonly settle: () => void }>();

/**
 * Registers `component` — one an extension supplied that the host focuses — as running in
 * `scope`. While the scope is live, the TUI calls into it for input and focus inside the scope.
 * Once it has gone, `retire` — the host's — takes it out of input before anything of it runs
 * again, and answers what took its place: the host's own editor, with the same text, for a
 * replaced editor; nothing for a dialog it closed. `retire` is called once.
 *
 * What this boundary does NOT cover, while the session is live: the host's own direct calls into
 * the component run outside the admission. For a replaced editor (`setEditorComponent`) that is
 * the host input listeners' `editor.getText()` (`input-controller.ts:380`, `:391`, `:400`),
 * `InteractiveMode#installEditor`'s configuration calls on it (`setUseTerminalCursor` through
 * `setText`, `composer.setEditor`), drawing it as a child of `editorContainer`, and
 * `InteractiveMode#applyAutocompleteProvider`'s `editor.setAutocompleteProvider`. For a `custom`
 * dialog it is the overlay compositor drawing it and `showHookCustom`'s `getText`/`setText` on the
 * current editor. Its `ownsOverlayFocusTarget` hook is asked inside its scope (`tui.ts`
 * `isOverlayFocusTarget`), and a focus target it owns takes input in its scope
 * ({@link adoptInputScope}). Once the session has gone none of these reach it: the sweep below runs
 * before input is dispatched and before a frame is drawn, and takes it out first. The binding is
 * the session's that is being served when it is made ({@link pinInputScope}): an owner reused for
 * the next session does not bring it back.
 */
export function bindInputScope(
	component: Component,
	scope: ToolRendererScope,
	retire: () => Component | undefined,
): void {
	inputScopes.set(component, {
		scope: pinInputScope(scope),
		retire,
		retired: false,
		successor: undefined,
		adopted: undefined,
	});
	awaitingRetirement.add(component);
}

/**
 * Gives `target` — a component `owner` delegates keyboard focus to (`ownsOverlayFocusTarget`) —
 * the scope `owner` takes input in, when `owner` is an extension's and `target` has none of its
 * own: a child of an extension's dialog is the extension's code too, and is called for input and
 * focus only inside that scope, and not at all once it has gone. Its owner's retirement is what
 * takes it out of input, and what takes the owner's place takes the child's too.
 */
export function adoptInputScope(target: Component, owner: Component): void {
	const bound = inputScopes.get(owner);
	if (bound === undefined || bound.retired || !bound.scope.live || hasInputScope(target)) return;
	inputScopes.set(target, {
		scope: bound.scope,
		retire: () => owner,
		retired: false,
		successor: undefined,
		adopted: undefined,
	});
	awaitingRetirement.add(target);
	(bound.adopted ??= new Set()).add(target);
}

/**
 * Registers what a host owes once `scope` has gone — the overlays an extension's code showed
 * through it, whichever components they hold and whoever bound those — run by the sweep that
 * retires the scope's components, before them, and once. A component is safe once its session has
 * gone only if nothing the host does can show, draw or focus it again, and a component's own
 * binding cannot promise that: the same component may be bound by one call and shown by another.
 * Answers what withdraws the obligation, for a host that settles it while the scope is live. It is
 * owed to the session being served when it is registered ({@link pinInputScope}), and settled once
 * that session has gone even if its owner already serves the next.
 */
export function whenInputScopeGone(scope: ToolRendererScope, settle: () => void): () => void {
	const obligation = { scope: pinInputScope(scope), settle };
	scopeObligations.add(obligation);
	return () => scopeObligations.delete(obligation);
}

/** Whether `component` takes input in a scope that is still live ({@link bindInputScope},
 *  {@link adoptInputScope}): a host binding a component an extension hands it keeps that one. A
 *  binding whose scope has gone is no binding — a session that hands the TUI a component an earlier
 *  session left behind binds it to its own scope — and a component is only ever retired once. */
export function hasInputScope(component: Component): boolean {
	return inputScopes.has(component) && !isRetiredInputScope(component);
}

/** Whether `component` is an extension's that has been, or is about to be, taken out of input:
 *  its scope has gone. A pure question — it retires nothing. */
export function isRetiredInputScope(component: Component): boolean {
	const bound = inputScopes.get(component);
	return bound !== undefined && (bound.retired || !bound.scope.live);
}

/** Lets go of a component the host has stopped using while its scope was live (a dialog closed,
 *  an editor replaced). The TUI still never calls into it once its scope has gone. */
export function unbindInputScope(component: Component): void {
	awaitingRetirement.delete(component);
	const adopted = inputScopes.get(component)?.adopted;
	if (adopted) for (const target of adopted) awaitingRetirement.delete(target);
}

/**
 * How the TUI may call into `component`: `call` itself for a component of the host's own; inside
 * its scope for an extension's while that is live; and not at all once it has gone, answering
 * `undefined` — the component then takes no input and its focus flag is left alone.
 */
export function withInputScope<T>(component: Component | null | undefined, call: () => T): T | undefined {
	const bound = component ? inputScopes.get(component) : undefined;
	if (bound === undefined) return call();
	// A retired binding stays retired: a scope that comes back to life is a new session's.
	if (bound.retired || !bound.scope.live) return undefined;
	return bound.scope.run(call);
}

/** Takes every bound component whose scope has gone out of input, through its host's `retire`,
 *  after settling what its host owes the scope ({@link whenInputScopeGone}). The TUI runs this
 *  before it resolves an input target and before it draws a frame. */
export function retireGoneInputScopes(): void {
	if (awaitingRetirement.size === 0 && scopeObligations.size === 0) return;
	for (const obligation of scopeObligations) {
		if (obligation.scope.live) continue;
		scopeObligations.delete(obligation);
		obligation.settle();
	}
	// A retirement may bind or unbind others; a Set visits what is added and skips what is removed.
	for (const component of awaitingRetirement) {
		const bound = inputScopes.get(component);
		if (bound === undefined || bound.retired || bound.scope.live) continue;
		bound.retired = true;
		awaitingRetirement.delete(component);
		bound.successor = bound.retire();
	}
}

/**
 * Who takes input addressed to `component`: itself while it is in input — the host's own
 * component, or an extension's whose scope is live — and once an extension's scope has gone, what
 * its host put in its place. An edit the user typed into a replaced editor in the moment its
 * session went reaches the host's editor, which holds the same text; a closed dialog has no
 * successor, and input addressed to it goes nowhere (`undefined`).
 */
export function inputRecipient(component: Component): Component | undefined {
	retireGoneInputScopes();
	let recipient: Component | undefined = component;
	for (let hop = 0; recipient !== undefined && hop < 8; hop++) {
		const bound = inputScopes.get(recipient);
		if (bound === undefined || (!bound.retired && bound.scope.live)) return recipient;
		recipient = bound.successor;
	}
	return undefined;
}

type Suggestions = { items: AutocompleteItem[]; prefix: string };

function textField(value: unknown, at: string): string {
	if (typeof value !== "string") throw new TypeError(`autocomplete ${at} is not a string`);
	return value;
}

function numberField(value: unknown, at: string): number {
	if (typeof value !== "number") throw new TypeError(`autocomplete ${at} is not a number`);
	return value;
}

function optionalText(value: unknown, at: string): string | undefined {
	return value === undefined ? undefined : textField(value, at);
}

function copyLines(lines: unknown, at: string): string[] {
	if (!Array.isArray(lines)) throw new TypeError(`autocomplete ${at} is not an array of lines`);
	const length = lines.length;
	// oxlint-disable-next-line unicorn/no-new-array -- per-keystroke length preallocation
	const copy = new Array<string>(length);
	for (let index = 0; index < length; index++) copy[index] = textField(lines[index], `${at}[${index}]`);
	return copy;
}

/** An item an extension's provider answered, read field by field, each once. */
function copyItem(item: AutocompleteItem, at: string): AutocompleteItem {
	const description = optionalText(item.description, `${at}.description`);
	const icon = optionalText(item.icon, `${at}.icon`);
	const iconName = optionalText(item.iconName, `${at}.iconName`);
	const nativeDetail = optionalText(item.nativeDetail, `${at}.nativeDetail`);
	const state = optionalText(item.state, `${at}.state`);
	const hint = optionalText(item.hint, `${at}.hint`);
	const descriptionMatch: unknown = item.descriptionMatch;
	return {
		value: textField(item.value, `${at}.value`),
		label: textField(item.label, `${at}.label`),
		...(description !== undefined && { description }),
		...(icon !== undefined && { icon }),
		...(iconName !== undefined && { iconName }),
		...(nativeDetail !== undefined && { nativeDetail }),
		...(state !== undefined && { state }),
		...(hint !== undefined && { hint }),
		...(descriptionMatch !== undefined && { descriptionMatch: descriptionMatch === true }),
	};
}

function copySuggestions(value: Suggestions | null, at: string): Suggestions | null {
	if (value === null || value === undefined) return null;
	const items: unknown = value.items;
	if (!Array.isArray(items)) throw new TypeError(`autocomplete ${at}.items is not an array`);
	const length = items.length;
	// oxlint-disable-next-line unicorn/no-new-array -- per-keystroke length preallocation
	const copy = new Array<AutocompleteItem>(length);
	for (let index = 0; index < length; index++) copy[index] = copyItem(items[index], `${at}.items[${index}]`);
	return { items: copy, prefix: textField(value.prefix, `${at}.prefix`) };
}

/**
 * `signal`, as an extension's provider is handed it: a signal of its own that aborts with the
 * caller's, inside `scope` — so a listener the provider adds runs as its session's work, and not
 * at all once that session has gone — and with a copy of the caller's reason, which is the
 * editor's own object. `release` stops following the caller.
 */
function scopedSignal(
	signal: AbortSignal | undefined,
	scope: ToolRendererScope,
): { signal: AbortSignal | undefined; release(): void } {
	if (signal === undefined) return { signal: undefined, release() {} };
	const controller = new AbortController();
	const abort = (): void => {
		if (scope.live) scope.run(() => controller.abort(copiedReason(signal.reason)));
	};
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	return { signal: controller.signal, release: () => signal.removeEventListener("abort", abort) };
}

/** An abort reason as an extension is handed it: a structured copy, or, for one that cannot be
 *  copied (it holds a function), an `AbortError` of its own carrying the reason's message. */
function copiedReason(reason: unknown): unknown {
	try {
		return structuredClone(reason);
	} catch {
		const message = reason instanceof Error ? reason.message : "The operation was aborted";
		return new DOMException(message, "AbortError");
	}
}

/**
 * An extension's autocomplete provider as the editor calls it, on every keystroke.
 *
 * Each method runs inside `scope` on copies of the editor's arguments, and what it answers is
 * copied there: items field by field, lines as strings, an `onApplied` callback run through the
 * scope when the editor calls it. Which optional methods the provider has is read once, inside the
 * scope. Once the scope has gone the provider is never called again: every call goes to `fallback`
 * — the provider the extension wrapped — and `onRetired` lets the host drop it from its chain, so
 * the editor completes as it would without the extension. The provider belongs to the session the
 * scope serves when it is wrapped ({@link pinInputScope}), not to whichever the scope's owner
 * serves later.
 */
export function scopedAutocompleteProvider(
	provider: AutocompleteProvider,
	fallback: AutocompleteProvider,
	rendererScope: ToolRendererScope,
	onRetired: () => void,
): AutocompleteProvider {
	const scope = pinInputScope(rendererScope);
	const has = scope.run(() => ({
		getInlineHint: typeof provider.getInlineHint === "function",
		trySyncSlashCompletion: typeof provider.trySyncSlashCompletion === "function",
		trySyncInlineReplace: typeof provider.trySyncInlineReplace === "function",
		getForceFileSuggestions: typeof provider.getForceFileSuggestions === "function",
		shouldTriggerFileCompletion: typeof provider.shouldTriggerFileCompletion === "function",
	}));
	let retired = false;
	/** Whether the provider may still be called; reports retirement to the host once. */
	const live = (): boolean => {
		if (scope.live) return true;
		if (!retired) {
			retired = true;
			onRetired();
		}
		return false;
	};
	const scoped: AutocompleteProvider = {
		getSuggestions(lines, cursorLine, cursorCol, signal, onPartial) {
			if (!live()) return fallback.getSuggestions(lines, cursorLine, cursorCol, signal, onPartial);
			const handed = scopedSignal(signal, scope);
			const partial =
				onPartial &&
				((value: Suggestions) => {
					const copy = copySuggestions(value, "onPartial()");
					if (copy) onPartial(copy);
				});
			return scope.run(async () => {
				try {
					const answer = await provider.getSuggestions(
						lines.slice(),
						cursorLine,
						cursorCol,
						handed.signal,
						partial,
					);
					return copySuggestions(answer, "getSuggestions()");
				} finally {
					handed.release();
				}
			});
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!live()) return fallback.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			return scope.run(() => {
				const applied = provider.applyCompletion(lines.slice(), cursorLine, cursorCol, { ...item }, prefix);
				const onApplied: unknown = applied.onApplied;
				return {
					lines: copyLines(applied.lines, "applyCompletion().lines"),
					cursorLine: numberField(applied.cursorLine, "applyCompletion().cursorLine"),
					cursorCol: numberField(applied.cursorCol, "applyCompletion().cursorCol"),
					...(typeof onApplied === "function" && {
						onApplied: () => {
							if (scope.live) scope.run(() => Reflect.apply(onApplied, applied, []));
						},
					}),
				};
			});
		},
	};
	if (has.getInlineHint) {
		scoped.getInlineHint = (lines, cursorLine, cursorCol) => {
			if (!live()) return fallback.getInlineHint?.(lines, cursorLine, cursorCol) ?? null;
			return scope.run(() => {
				const hint: unknown = provider.getInlineHint?.(lines.slice(), cursorLine, cursorCol);
				return hint === null || hint === undefined ? null : textField(hint, "getInlineHint()");
			});
		};
	}
	if (has.trySyncSlashCompletion) {
		scoped.trySyncSlashCompletion = textBeforeCursor => {
			if (!live()) return fallback.trySyncSlashCompletion?.(textBeforeCursor) ?? null;
			return scope.run(() =>
				copySuggestions(provider.trySyncSlashCompletion?.(textBeforeCursor) ?? null, "trySyncSlashCompletion()"),
			);
		};
	}
	if (has.trySyncInlineReplace) {
		scoped.trySyncInlineReplace = textBeforeCursor => {
			if (!live()) return fallback.trySyncInlineReplace?.(textBeforeCursor) ?? null;
			return scope.run(() => {
				const replace = provider.trySyncInlineReplace?.(textBeforeCursor);
				if (replace === null || replace === undefined) return null;
				return {
					replaceLen: numberField(replace.replaceLen, "trySyncInlineReplace().replaceLen"),
					insert: textField(replace.insert, "trySyncInlineReplace().insert"),
				};
			});
		};
	}
	if (has.getForceFileSuggestions) {
		scoped.getForceFileSuggestions = (lines, cursorLine, cursorCol, signal) => {
			if (!live())
				return fallback.getForceFileSuggestions?.(lines, cursorLine, cursorCol, signal) ?? Promise.resolve(null);
			const handed = scopedSignal(signal, scope);
			return scope.run(async () => {
				try {
					const answer = await provider.getForceFileSuggestions?.(
						lines.slice(),
						cursorLine,
						cursorCol,
						handed.signal,
					);
					return copySuggestions(answer ?? null, "getForceFileSuggestions()");
				} finally {
					handed.release();
				}
			});
		};
	}
	if (has.shouldTriggerFileCompletion) {
		scoped.shouldTriggerFileCompletion = (lines, cursorLine, cursorCol) => {
			if (!live()) return fallback.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
			return scope.run(() => provider.shouldTriggerFileCompletion?.(lines.slice(), cursorLine, cursorCol) === true);
		};
	}
	return scoped;
}
