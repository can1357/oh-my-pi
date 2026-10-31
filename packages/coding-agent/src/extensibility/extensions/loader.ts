/**
 * Extension loader - loads TypeScript extension modules using native Bun import.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type * as fs1 from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { types } from "node:util";
import { type } from "@oh-my-pi/omptype";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	ImageContent,
	Model,
	ServiceTier,
	ServiceTierByFamily,
	ServiceTierFamily,
	TextContent,
	TSchema,
} from "@oh-my-pi/pi-ai";
import { type ComposerStyle, getComposerStyle, isBuiltinComposerStyle, type KeyId } from "@oh-my-pi/pi-tui";
import { hasFsCode, isEacces, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { type ExtensionModule, extensionModuleCapability } from "../../capability/extension-module";
import { type Hook, hookCapability } from "../../capability/hook";
import { isServiceTierFamily, isServiceTierForFamily } from "../../config/service-tier";
import { loadCapability } from "../../discovery";
import { getExtensionNameFromPath } from "../../discovery/helpers";
import type { ExecOptions } from "../../exec/exec";
import { execCommand } from "../../exec/exec";
import { getCodingAgentApi } from "../host-api";
import type { SendUserMessageOptions } from "../../session/agent-session";
import type { CustomMessagePayload } from "../../session/messages";
import type { FileDeleteFallbackHandler, FileWriteFallbackHandler } from "../../tools/file-write-fallback";
import { isFilesystemSourcePath } from "../../tools/path-utils";
import { InternalUrlRouter } from "../../internal-urls/router";
import { EventBus, extensionCallbackScope, OwnedEventBus } from "../../utils/event-bus";
import type { AdmittedWorkKind } from "@oh-my-pi/pi-ai/auth/provider-gate";
import * as TypeBox from "../legacy-typebox";
import { admitToolDefinition } from "./boundary-data";
import {
	createProviderRegistrationQueue,
	forgetQueuedProviderRegistrations,
	type QueuedProviderRegistration,
	rememberQueuedProviderRegistration,
	restoreQueuedProviderRegistrations,
} from "./callback-ownership";
import { resolveExtensionDirectory } from "./directory-resolution";
import { installLegacyPiSpecifierShim, loadLegacyPiModule } from "../plugins/legacy-pi-compat";
import { getAllPluginExtensionPaths } from "../plugins/loader";

import { resolvePath, withHostGuard } from "../utils";
import type { ComposerShapeDefinition } from "@oh-my-pi/pi-tui/overlays/composer-shape-registry";
import type {
	AssistantTextRenderer,
	AssistantThinkingRenderer,
	Extension,
	ExtensionAPI,
	ExtensionCallbackOwner,
	ExtensionContext,
	ExtensionFactory,
	ExtensionRuntime as IExtensionRuntime,
	ExtensionSessionGeneration,
	LoadExtensionsResult,
	MessageRenderer,
	PreparedExtension,
	ProviderConfig,
	RegisteredCommand,
	SourceInfo,
	ToolDefinition,
	ToolInfo,
} from "./types";

installLegacyPiSpecifierShim();

type HandlerFn = (...args: unknown[]) => Promise<unknown>;
type LoadedExtensionModule = ExtensionFactory | { default?: ExtensionFactory };

/** RFC 3986 scheme syntax, lowercased, two characters at least so `c` cannot capture `C:/` paths. */
const LINK_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]+$/;

/** Standard schemes an extension may not claim: web, file and mail links. omp's internal URLs are refused too. */
const STANDARD_LINK_SCHEMES: Readonly<Record<string, true>> = {
	about: true,
	blob: true,
	data: true,
	file: true,
	ftp: true,
	http: true,
	https: true,
	javascript: true,
	mailto: true,
	ssh: true,
	ws: true,
	wss: true,
};

function getExtensionFactory(module: LoadedExtensionModule): ExtensionFactory | null {
	const candidate = typeof module === "function" ? module : module.default;
	return typeof candidate === "function" ? candidate : null;
}

/**
 * Upstream-shaped provenance for an extension-registered tool. Consumers that
 * read `sourceInfo` off `getAllRegisteredTools()` (e.g. pi-fabric) receive an
 * absolute on-disk path: the tool's own `sourcePath` when it is filesystem-
 * absolute, otherwise the extension's resolved entry (`fallbackPath`). A tool
 * with no absolute origin at all falls back to the synthetic `<extension:name>`.
 */
export function extensionToolSourceInfo(
	definition: Pick<ToolDefinition, "name" | "sourcePath">,
	fallbackPath: string,
): SourceInfo {
	const sourcePath = definition.sourcePath;
	const path =
		sourcePath && isFilesystemSourcePath(sourcePath)
			? sourcePath
			: isFilesystemSourcePath(fallbackPath)
				? fallbackPath
				: `<extension:${definition.name}>`;
	return { path, source: "extension", scope: "temporary", origin: "top-level" };
}

export class ExtensionRuntimeNotInitializedError extends Error {
	constructor() {
		super("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	}
}

/** Takes ownership of a callback a session accepts from an extension. Only a value that IS a
 *  function is taken.
 *
 *  Ownership CANNOT be complete by registration, and it does not need to be: a facility that
 *  invokes a callback can always own that invocation, and a facility that never invokes one has
 *  nothing to own. `ManagedTimers`, `EventBus`, the tool UI controller, `ExtensionRunner.runScoped`,
 *  `ModelRegistry` (`oauth.login`/`refreshToken`/`getApiKey`/`modifyModels`,
 *  `usage.fetchUsage`/`parseRateLimitHeaders`) and `session-maintenance` (`ctx.compact`'s
 *  `onError`/`onComplete`) each own their own calls, and the enumeration lives at those call sites.
 *
 *  Retirement therefore covers WRAPPED callbacks — the ones an owner was given a chance to wrap —
 *  not every callback an extension ever handed over. A callback reached only through an
 *  uninstrumented invoker is still live after disposal; that is a missing invoker, not a missing
 *  mechanism, and it is the thing to look for when a post-disposal call is observed.
 *
 *  Do not try to own every argument crossing the `pi` surface instead. It was built and reverted:
 *  it broke a re-registered built-in tool, an extension `web_search` and the TTSR `willContinue`
 *  gate, in every variant (copy, in-place, direct-functions-only). The cause was not isolated at
 *  the time; review later showed that wrapping a CALLABLE carrying properties — an ArkType schema
 *  with `toJsonSchema` — drops them, which fits. Either way the surface is the wrong place: it
 *  cannot see who will call. */
export function ownAcceptedCallbacks(value: unknown, owner: ExtensionCallbackOwner): unknown {
	if (typeof value === "function") return owner.ownCallback(value as (...args: unknown[]) => unknown);
	return value;
}

type Then = (onFulfilled: (value: unknown) => void, onRejected: (reason: unknown) => void) => unknown;

/** The intrinsic `then`, kept so that observing a genuine promise never asks it for `then` again. */
const promiseThen = Promise.prototype.then;

/** The `then` that makes `value` a thenable, or `undefined` when it is none — asked the way `await`
 *  asks, and asked ONCE. `await` READS the property and sees whether it is callable; `"then" in
 *  value` is a different question, and a Proxy whose `has` says no while its `get` returns a real
 *  `then` answers it differently. And a read is an operation, not an observation: a getter may
 *  answer differently the next time, so the callable this read returned is the one adopted — see
 *  {@link adopt}. Objects and functions alike: a thenable may be either. A getter that throws
 *  propagates, as it does out of `await`. */
function thenOf(value: unknown): Then | undefined {
	if (!isObjectLike(value)) return undefined;
	const then: unknown = Reflect.get(value, "then");
	return typeof then === "function" ? (then as Then) : undefined;
}

function isObjectLike(value: unknown): value is object {
	return value !== null && (typeof value === "object" || typeof value === "function");
}

/** The operation `value` reports through `then`, as a promise, adopted as assimilation adopts it:
 *  `then` is called once, on `value`, in a later job, and a `then` that throws rejects. `then` is
 *  the callable {@link thenOf} already read, so the property is not asked again:
 *  `Promise.resolve(value)` would read it a second time and adopt whatever that read returned.
 *
 *  A genuine promise whose `then` read as the intrinsic one IS its operation, and comes back as it
 *  is — as `Promise.resolve` and `await` take it, with no extra turn. Whatever observes the result
 *  goes through {@link promiseThen}, so that promise is not asked for its `then` again either. */
function adopt(value: unknown, then: Then): Promise<unknown> {
	if (then === promiseThen && types.isPromise(value)) return value;
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	// A reaction job runs in the async context it was queued in: the admission's.
	void Promise.resolve().then(() => {
		try {
			Reflect.apply(then, value, [resolve, reject]);
		} catch (error) {
			reject(error);
		}
	});
	return promise;
}

/** The terminal a producer admitted as a stream reports through `result()`, adopted.
 *
 *  `result` is read once and called on the producer; the completion it returns is a thenable or
 *  nothing, asked once ({@link thenOf}). Throws when there is none: a call site declared this a
 *  stream, so a value that cannot say when it is finished is one this session cannot own, and the
 *  refusal belongs at the boundary rather than as a silent "already complete". */
function streamCompletion(produced: unknown): Promise<unknown> {
	const result: unknown = isObjectLike(produced) ? Reflect.get(produced, "result") : undefined;
	if (typeof result === "function") {
		const completion: unknown = Reflect.apply(result, produced, []);
		const then = thenOf(completion);
		if (then) return adopt(completion, then);
	}
	throw new Error("Extension stream reported no completion; this session cannot own it");
}

/** One session's hold on an extension surface, counted so that concurrent sessions sharing a
 *  runtime release it together. Retirement belongs here rather than on the runtime because a
 *  runtime outlives the session that used it: the next session gets a new lease, and the
 *  callbacks an extension registered once are live again for it.
 *
 *  A lease exists before its session starts: it is the session the runtime will serve next, live
 *  until that session's last holder releases it. So whatever is pinned to it before the session
 *  begins ends with that session, and no lease is ever live again once it has retired.
 *
 *  What the session registered is withdrawn when it retires ({@link whenRetired}): a tool, a
 *  command, a handler that belongs to a session that has gone is not left listed and inert. */
class ExtensionCallbackLease implements ExtensionSessionGeneration {
	#holders = 0;
	#started = false;
	/** What to withdraw when this session retires, in registration order; run newest first, so a
	 *  registration that replaced an earlier one of the same session restores it before that one
	 *  is withdrawn in turn. */
	#withdrawals: Array<() => void> = [];
	/** This session's extension work under way: what its disposal waits for, and nothing another
	 *  session started — sessions sharing the runtime at once share the lease, and so this. */
	readonly pending = new Set<Promise<unknown>>();

	join(): void {
		this.#holders++;
		this.#started = true;
	}

	release(): void {
		if (this.#holders > 0) this.#holders--;
		if (!this.isRetired) return;
		const withdrawals = this.#withdrawals.splice(0).reverse();
		for (const withdraw of withdrawals) {
			try {
				withdraw();
			} catch (error) {
				logger.warn("Withdrawing a retired extension session's registration failed", { error: String(error) });
			}
		}
	}

	/** Registers what to withdraw when this session retires. A session that has already retired
	 *  registers nothing: its registration is refused before it is made (`ConcreteExtensionAPI`). */
	whenRetired(withdraw: () => void): void {
		if (this.isRetired) {
			withdraw();
			return;
		}
		this.#withdrawals.push(withdraw);
	}

	/** Whether a session has claimed it: before then, it is only the session to come. */
	get started(): boolean {
		return this.#started;
	}

	get isRetired(): boolean {
		return this.#started && this.#holders === 0;
	}
}

/** Resolves once every piece of `lease`'s work under way has settled, work it started meanwhile
 *  included. */
async function waitForWork(lease: ExtensionCallbackLease): Promise<void> {
	while (lease.pending.size > 0) {
		await Promise.all(lease.pending);
	}
}

/** The admitted call on this stack: which runtime admitted it, as which session's work. Set by
 *  every entry into extension code ({@link ExtensionRuntime}'s owned callbacks and `runOwned`), so
 *  what extension code accepts or does — a callback it hands back, a timer, a subscription, a
 *  facade call — is attributed to the session the code is running for, even when it runs on after
 *  the runtime has gone on to serve another (a continuation, a timer it set). `lease` is absent
 *  while an extension factory runs (`ExtensionRuntime.runLoading`): what it accepts then, and what
 *  code it set going accepts later, is the runtime's, serving each session in turn. */
const admittedSession = new AsyncLocalStorage<{
	readonly runtime: ExtensionRuntime;
	readonly lease: ExtensionCallbackLease | undefined;
}>();

/**
 * Extension runtime with throwing stubs for action methods.
 * These are replaced with real implementations during initialization.
 */
export class ExtensionRuntime implements IExtensionRuntime {
	flagValues = new Map<string, boolean | string>();
	/** Each record carries the session that queued it, so a drain can pass `owner` straight to
	 *  `ModelRegistry.registerProvider`. One that passes only the other three fields gets it from
	 *  the drain — the records it took out of this queue, or the one its `for…of` is on: see
	 *  `QueuedProviderRegistration`. */
	pendingProviderRegistrations: QueuedProviderRegistration<ProviderConfig>[] =
		createProviderRegistrationQueue<ProviderConfig>();

	/**
	 * Extension-authored callbacks, owned from the moment this session ACCEPTS them.
	 *
	 * Ownership keyed on the facility that invokes a callback cannot be completed by enumeration.
	 * Three rounds of review each closed the measured routes — the runner, timers, the event bus,
	 * a tool's `onSession` — and found more: a provider config's `login` and `fetchDynamicModels`
	 * reaching `ModelRegistry`, a `ctx.compact({ onError })` continuation, a deferred factory the
	 * host started. Any facility handed a callback through `pi` can invoke it, and reaching this
	 * object from the runner does not make the runner see what it never started.
	 *
	 * So ownership is taken where the set IS closed: every extension callback is a value the
	 * extension passes into `pi` or a `ctx` method, and {@link ownCallback} wraps it there. The
	 * wrapper owns its own execution, so no invoking facility has to opt in and a new one cannot
	 * reopen the hole — and it REFUSES to run once the last session hold has been released,
	 * because a callback that should not have been entered cannot be fixed by reporting that it
	 * was.
	 *
	 * What a callback is doing while it runs is counted as the work of the session it runs for
	 * (`ExtensionCallbackLease.pending`), so a session's disposal waits for its own work and never
	 * for what a session before it left running.
	 */
	#callbacksChanged: PromiseWithResolvers<void> | undefined;
	/**
	 * The session this runtime's callbacks belong to: the one holding them, or the one it will
	 * serve next while none has claimed them yet.
	 *
	 * Retirement is per SESSION, not per runtime: a host may build one runner and runtime and use
	 * it for several `AgentSession`s in turn — `agent-session-concurrent.test.ts` does — so
	 * retiring the runtime itself would leave the second session's handlers refused forever. The
	 * lease is the per-session object the wrapper consults, and {@link beginSession} installs a
	 * fresh one once the last holder has gone. Sessions sharing a runtime at the same time share
	 * one lease, so one sibling's disposal cannot retire callbacks another is still invoking.
	 */
	#lease = new ExtensionCallbackLease();

	/** Claims this runtime's callbacks for a session that is starting, and returns the only way to
	 *  give that claim back. A lease retired by an earlier session is replaced; a live one gains a
	 *  holder.
	 *
	 *  The release is a handle rather than a second method for two reasons the review found by
	 *  building them: a handle cannot be called without a matching claim, so no caller can steal a
	 *  live sibling's hold, and it is idempotent, so a session disposed twice — or reentrantly —
	 *  releases once. It releases the lease it claimed, so a handle outliving its generation
	 *  cannot retire the session that came after.
	 *
	 *  Once the last holder releases, every callback accepted through `pi`/`ctx` becomes inert, so
	 *  a facility still holding one (a bus subscription, a provider config, a timer) can no longer
	 *  enter a session whose resources are being released. Work already running is unaffected and
	 *  still has to be waited for. */
	beginSession(): () => void {
		let lease = this.#lease;
		if (lease.isRetired) {
			lease = new ExtensionCallbackLease();
			this.#lease = lease;
		}
		lease.join();
		const claimed = lease;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			claimed.release();
		};
	}

	/** The session the admitted call on this stack runs for, when it is this runtime's and not its
	 *  loading. */
	#sessionHere(): ExtensionCallbackLease | undefined {
		const here = admittedSession.getStore();
		return here?.runtime === this ? here.lease : undefined;
	}

	/** Whether the code on this stack is this runtime's loading ({@link runLoading}). */
	#loadingHere(): boolean {
		const here = admittedSession.getStore();
		return here?.runtime === this && here.lease === undefined;
	}

	/** Runs an extension factory as this runtime's loading: what it registers — and what code it
	 *  set going registers later — belongs to the runtime and serves each session in turn, even
	 *  when the extension is loaded while a session is running. */
	runLoading<T>(call: () => T): T {
		return admittedSession.run({ runtime: this, lease: undefined }, call);
	}

	/** The session a gate checks: the admitted call's on this stack, else the one served now. */
	#leaseNow(): ExtensionCallbackLease {
		return this.#sessionHere() ?? this.#lease;
	}

	/** The session a callback accepted now belongs to: the admitted call's on this stack, else the
	 *  one a session holds now. While an extension factory runs ({@link runLoading}), and before
	 *  any session has claimed the runtime, there is none: what is accepted then is the runtime's,
	 *  live for each session it serves in turn. */
	#acceptingLease(): ExtensionCallbackLease | undefined {
		if (this.#loadingHere()) return undefined;
		const lease = this.#sessionHere() ?? this.#lease;
		return lease.started ? lease : undefined;
	}

	/** Whether the session a gate checks here has gone: the admitted call's on this stack, so code
	 *  of a session that has gone is refused even after the runtime serves another, else the
	 *  session served now. */
	get isRetired(): boolean {
		return this.#leaseNow().isRetired;
	}

	/**
	 * The session this runtime serves now — or, before any has claimed it, the one it will serve
	 * first — as an object of its own: retired once that session's last holder has released it,
	 * and never live again; the next session gets another. What one session leaves behind is
	 * pinned to it (`ExtensionRunner.rendererScope`'s `pin`), so reusing the runtime cannot revive
	 * it, and something pinned before the first session began ends with that session. Inside an
	 * admitted call it is that call's session.
	 */
	get sessionGeneration(): ExtensionSessionGeneration {
		return this.#leaseNow();
	}

	readonly #sessionOwners = new WeakMap<ExtensionCallbackLease, ExtensionCallbackOwner>();

	/**
	 * This runtime as one session's owner: every gate it has — `isRetired`, `ownCallback`,
	 * `runOwned` — reads that session alone, so a facade or a provider gate made for it stays
	 * that session's when the runtime goes on to serve the next. The session is the admitted
	 * call's on this stack, else the one served now (before any, the one to come). One object
	 * per session.
	 */
	forSession(): ExtensionCallbackOwner {
		return this.#ownerFor(this.#leaseNow());
	}

	/** This runtime as the owner of what is accepted now ({@link #acceptingLease}): one session's
	 *  ({@link forSession}), or the runtime itself for what an extension factory accepts at load. */
	forAcceptance(): ExtensionCallbackOwner {
		const lease = this.#acceptingLease();
		return lease ? this.#ownerFor(lease) : this;
	}

	#ownerFor(lease: ExtensionCallbackLease): ExtensionCallbackOwner {
		let owner = this.#sessionOwners.get(lease);
		if (!owner) {
			const runtime = this;
			const view: ExtensionCallbackOwner = {
				beginSession: () => runtime.beginSession(),
				get isRetired() {
					return lease.isRetired;
				},
				get sessionGeneration() {
					return lease;
				},
				ownCallback: fn => runtime.#own(fn, lease),
				runOwned: (call, kind) => runtime.#runOwned(call, kind, lease),
				finishOwned: call => runtime.#runOwned(call, "value", lease, true),
				trackCallback: result => runtime.#track(result, lease),
				hasPendingCallbacks: () => lease.pending.size > 0,
				waitForPendingCallbacks: () => waitForWork(lease),
				whenCallbacksChange: () => runtime.whenCallbacksChange(),
				forSession: () => view,
				forAcceptance: () => view,
				registrant: runtime,
				whenSessionEnds: withdraw => lease.whenRetired(withdraw),
			};
			owner = view;
			this.#sessionOwners.set(lease, owner);
		}
		return owner;
	}

	/** Wraps a callback this session accepts. It belongs to the session it is accepted for
	 *  ({@link #acceptingLease}), refuses once that session's last hold has been released — even if
	 *  the runtime serves another session by then — and owns the lifetime of what it returns. A
	 *  callback an extension factory accepted at load is the runtime's, live for each session. */
	ownCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R | undefined {
		return this.#own(fn, this.#acceptingLease());
	}

	#own<A extends unknown[], R>(
		fn: (...args: A) => R,
		pinned: ExtensionCallbackLease | undefined,
	): (...args: A) => R | undefined {
		const owner = this;
		// A regular function, not an arrow: a facility may invoke a callback with a receiver
		// (`definition.execute.call(tool, …)`), and dropping `this` silently breaks it.
		return function (this: unknown, ...args: A): R | undefined {
			const lease = pinned ?? owner.#lease;
			if (lease.isRetired) return undefined;
			// Re-entered so a subscription this callback makes (`pi.events.on` from inside a
			// handler) is attributed to this session, not to whoever is on the stack.
			return owner.#enter(lease, () => owner.#track(fn.apply(this, args), lease));
		};
	}

	/** Runs `call` as `lease`'s admitted work on this stack. */
	#enter<T>(lease: ExtensionCallbackLease, call: () => T): T {
		return admittedSession.run({ runtime: this, lease }, () => extensionCallbackScope.run(this, call));
	}

	/**
	 * Counts what an admitted call produced as this session's live work, until that work is
	 * finished. This is the `value` kind — see {@link runOwned} for the kind a call site
	 * declares.
	 *
	 * A thenable says when it is done by settling, and a cold one runs its body on each `then`,
	 * so observing it by calling `then` and handing the original back would run it twice; the
	 * adopted promise is returned in its place. Its `then` is read once and the callable that
	 * read returned is the one adopted ({@link thenOf}, {@link adopt}), so what this session
	 * watches is exactly what the caller receives. Thenable duck-typing, not `instanceof`: a
	 * callback compiled in another realm (`node:vm`, an `--import` loader) returns a Promise
	 * that fails the brand check while being every bit as live, and a thenable may be a
	 * function as readily as an object.
	 *
	 * Anything else is already complete when it is returned: a value carries no outstanding
	 * work. Nothing here inspects a value for a completion method. That was tried twice and is
	 * wrong in both directions — see {@link AdmittedWorkKind}.
	 */
	trackCallback<T>(result: T): T {
		return this.#track(result, this.#leaseNow());
	}

	/** {@link trackCallback}, as `lease`'s work. */
	#track<T>(result: T, lease: ExtensionCallbackLease): T {
		const then = thenOf(result);
		if (!then) return result;
		const adopted = adopt(result, then);
		this.#watch(adopted, lease);
		return adopted as T;
	}

	/** Holds `lease`'s session open until `work` — a promise {@link adopt} returned — settles,
	 *  however it settles. */
	#watch(work: Promise<unknown>, lease: ExtensionCallbackLease): void {
		const settled: Promise<undefined> = Reflect.apply(promiseThen, work, [() => undefined, () => undefined]);
		lease.pending.add(settled);
		this.#notifyCallbacksChanged();
		void settled.finally(() => {
			lease.pending.delete(settled);
			this.#notifyCallbacksChanged();
		});
	}

	/**
	 * Runs one call into extension code this session accepted, and holds the session open until
	 * the work of the declared kind is finished.
	 *
	 * `stream` is the kind a producer has when it is handed back at once and keeps working — an
	 * `AssistantMessageEventStream` and anything else that reports its terminal through
	 * `result()`. The call site says so; nothing here inspects the value to find out. A stream
	 * that reports no completion is REFUSED rather than assumed finished: a producer this
	 * session cannot be held open for is one it cannot own, and silently treating it as done is
	 * how a child's stream outlived its credential restriction. A call that returns a PROMISE of
	 * a producer is held open until the producer it resolves has finished, not merely until the
	 * promise settles — and if that producer reports no completion, the refusal reaches the
	 * caller through the promise it is awaiting rather than settling quietly on a promise only
	 * this object watches. The call runs as the admitted call's session on this stack, else the
	 * session served now, and is refused once that session has gone.
	 */
	runOwned<R>(call: () => R, kind: AdmittedWorkKind = "value"): R {
		return this.#runOwned(call, kind, this.#leaseNow());
	}

	/** Runs `call` as `runOwned` does, but as the finish of work that session already began: a
	 *  dispatch under way when its session ended runs to its end as that session's work, rather
	 *  than skipping what is left of it. Never starts anything for a session that has gone. */
	finishOwned<R>(call: () => R): R {
		return this.#runOwned(call, "value", this.#leaseNow(), true);
	}

	#runOwned<R>(call: () => R, kind: AdmittedWorkKind = "value", lease: ExtensionCallbackLease, finishing = false): R {
		if (lease.isRetired && !finishing) {
			throw new Error("Extension session retired; its callbacks are no longer callable");
		}
		return this.#enter(lease, () => {
			const produced = call();
			if (kind !== "stream") return this.#track(produced, lease);
			const then = thenOf(produced);
			if (then) {
				const resolved: Promise<unknown> = Reflect.apply(promiseThen, adopt(produced, then), [
					(value: unknown) => {
						// Throws here on a malformed producer, so the caller's await rejects.
						this.#watch(streamCompletion(value), lease);
						return value;
					},
				]);
				this.#watch(resolved, lease);
				return resolved as R;
			}
			this.#watch(streamCompletion(produced), lease);
			// The producer itself is handed back untouched: the caller consumes the stream.
			return produced;
		});
	}

	/** Whether extension work of `session` — by default the admitted call's on this stack, else the
	 *  one served now — is under way. Work another session left running is not this one's. */
	hasPendingCallbacks(session?: ExtensionSessionGeneration): boolean {
		return this.#leaseOf(session).pending.size > 0;
	}

	/** Resolves once every extension callback `session` (as {@link hasPendingCallbacks} names it)
	 *  has under way now has returned. */
	waitForPendingCallbacks(session?: ExtensionSessionGeneration): Promise<void> {
		return waitForWork(this.#leaseOf(session));
	}

	/** The lease `session` names, when it is one of this runtime's, else the session a gate checks. */
	#leaseOf(session: ExtensionSessionGeneration | undefined): ExtensionCallbackLease {
		return session instanceof ExtensionCallbackLease ? session : this.#leaseNow();
	}

	/** Settles on the next add or remove, so a caller can wait for a change instead of sampling. */
	whenCallbacksChange(): Promise<void> {
		this.#callbacksChanged ??= Promise.withResolvers<void>();
		return this.#callbacksChanged.promise;
	}

	#notifyCallbacksChanged(): void {
		const changed = this.#callbacksChanged;
		this.#callbacksChanged = undefined;
		changed?.resolve();
	}

	registerProvider(name: string, config: ProviderConfig, sourceId: string): void {
		// The configuration is queued exactly as the extension wrote it, and the owner travels
		// with THIS registration rather than with the object: an author may hand one object to
		// every session that loads the extension, and each session's registration of it is its
		// own. main.ts, sdk.ts and models-cli.ts drain this queue into ModelRegistry with the
		// owner; a host that drains it itself and passes only name, config and source still has
		// its owner found, from the record indexed here and the queue it waits in.
		const registration: QueuedProviderRegistration<ProviderConfig> = { name, config, sourceId, owner: this };
		rememberQueuedProviderRegistration(registration, () => this.pendingProviderRegistrations);
		this.pendingProviderRegistrations.push(registration);
	}

	unregisterProvider(name: string): void {
		const removed = this.pendingProviderRegistrations.filter(registration => registration.name === name);
		const remaining = this.pendingProviderRegistrations.filter(registration => registration.name !== name);
		this.pendingProviderRegistrations.splice(0, this.pendingProviderRegistrations.length, ...remaining);
		// Withdrawn before any drain: such a record must not lend its owner to a later
		// registration of the same object by another session.
		forgetQueuedProviderRegistrations(removed);
	}

	sendMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	sendUserMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	appendEntry(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setLabel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getActiveTools(): string[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getAllTools(): ToolInfo[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setActiveTools(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getCommands(): never {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setModel(): Promise<boolean> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getThinkingLevel(): ThinkingLevel {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setThinkingLevel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getServiceTiers(): ServiceTierByFamily {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setServiceTier(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getSessionName(): string | undefined {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setSessionName(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}
}

/**
 * ExtensionAPI implementation for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
class ConcreteExtensionAPI implements ExtensionAPI, IExtensionRuntime {
	readonly logger = logger;
	readonly typebox = TypeBox;
	readonly arktype = type;
	readonly zod = zod;
	readonly flagValues = new Map<string, boolean | string>();
	readonly pendingProviderRegistrations: QueuedProviderRegistration<ProviderConfig>[] = [];

	get pi() {
		return getCodingAgentApi();
	}

	readonly events: EventBus;

	constructor(
		private readonly extension: Extension,
		private readonly runtime: IExtensionRuntime,
		private readonly cwd: string,
		events: EventBus,
	) {
		// A view of the host's bus bound to THIS session's owner, not the bus itself. The scope
		// alone attributes a subscription to whoever is accepting on the stack, which is silent
		// for a `pi` reference captured and used later and wrong for one used while another
		// session is on the stack; the reference knows which session gave it out. The transport
		// is shared, so emits and handlers still cross sessions exactly as before — see
		// `OwnedEventBus`. Stable identity: one view per binding, so `pi.events === pi.events`,
		// and two bindings of one extension still see two different objects for two sessions.
		this.events = new OwnedEventBus(events, runtime);
		// Extensions destructure `pi.on` or forward API methods as callbacks, so every
		// prototype method must keep its receiver when detached. Walk the prototype
		// rather than listing methods: a new method is bound without touching this.
		//
		// Taking ownership of every ARGUMENT here was tried and reverted: a callback reached only
		// through a registration's configuration object cannot be owned without rewriting that
		// object, and consumers key on what they were handed. See `ownAcceptedCallbacks`.
		const prototype = ConcreteExtensionAPI.prototype;
		for (const name of Object.getOwnPropertyNames(prototype)) {
			if (name === "constructor") continue;
			const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
			if (typeof descriptor?.value !== "function") continue;
			Object.defineProperty(this, name, { value: descriptor.value.bind(this), writable: true, configurable: true });
		}
	}

	beginSession(): () => void {
		return this.runtime.beginSession();
	}

	get isRetired(): boolean {
		return this.runtime.isRetired;
	}

	ownCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R | undefined {
		return this.runtime.ownCallback(fn);
	}

	runOwned<R>(call: () => R, kind?: AdmittedWorkKind): R {
		return this.runtime.runOwned(call, kind);
	}

	/** Callback ownership belongs to the one runtime behind every facade for this session; this
	 *  object is an API surface, not a second owner. */
	trackCallback<T>(result: T): T {
		return this.runtime.trackCallback(result);
	}

	hasPendingCallbacks(session?: ExtensionSessionGeneration): boolean {
		return this.runtime.hasPendingCallbacks(session);
	}

	waitForPendingCallbacks(session?: ExtensionSessionGeneration): Promise<void> {
		return this.runtime.waitForPendingCallbacks(session);
	}

	whenCallbacksChange(): Promise<void> {
		return this.runtime.whenCallbacksChange();
	}

	get sessionGeneration(): ExtensionSessionGeneration | undefined {
		return this.runtime.sessionGeneration;
	}

	forSession(): ExtensionCallbackOwner {
		return this.runtime.forSession?.() ?? this;
	}

	forAcceptance(): ExtensionCallbackOwner {
		return this.runtime.forAcceptance?.() ?? this;
	}

	/**
	 * The session a registration made now belongs to. One an extension factory makes at load, before
	 * any session has claimed the runtime, belongs to the runtime and serves each session in turn:
	 * `undefined`. One made while a session is running — from a handler, a command, a timer — is
	 * that session's (`forAcceptance`): its callbacks run as that session's work, and the
	 * registration is withdrawn when that session ends ({@link #listFor}, {@link #setFor}), so the
	 * next session sees a true picture rather than a tool that answers nothing. A session that has
	 * already ended registers nothing.
	 */
	#registeringSession(): ExtensionCallbackOwner | undefined {
		const owner = this.runtime.forAcceptance?.();
		if (owner === undefined || owner === this.runtime) return undefined;
		if (owner.isRetired) {
			throw new Error(
				`Extension ${this.extension.path}: its session has ended, so it can no longer register anything`,
			);
		}
		return owner;
	}

	/** A callback this API registers, as the host keeps it: owned by the session it belongs to, so
	 *  it runs as that session's work. A callback registered at load is kept as it is. */
	#registered<F>(session: ExtensionCallbackOwner | undefined, callback: F): F {
		if (session === undefined || typeof callback !== "function") return callback;
		return session.ownCallback(callback as (...args: unknown[]) => unknown) as F;
	}

	/** Adds `value` to `list`, and takes it out again when `session` ends. */
	#listFor<T>(session: ExtensionCallbackOwner | undefined, list: T[], value: T): void {
		list.push(value);
		session?.whenSessionEnds?.(() => {
			const index = list.lastIndexOf(value);
			if (index !== -1) list.splice(index, 1);
		});
	}

	/** Sets `key` to `value` in `map`, and, when `session` ends, puts back what it replaced — unless
	 *  a later registration has replaced it in turn — then calls `withdrawn`. */
	#setFor<K, V>(
		session: ExtensionCallbackOwner | undefined,
		map: Map<K, V>,
		key: K,
		value: V,
		withdrawn?: () => void,
	): void {
		const replaced = map.has(key);
		const previous = map.get(key);
		map.set(key, value);
		session?.whenSessionEnds?.(() => {
			if (map.get(key) !== value) return;
			if (replaced) map.set(key, previous as V);
			else map.delete(key);
			withdrawn?.();
		});
	}

	on<F extends HandlerFn>(event: string, handler: F): void {
		const session = this.#registeringSession();
		let list = this.extension.handlers.get(event);
		if (!list) {
			list = [];
			this.extension.handlers.set(event, list);
		}
		this.#listFor(session, list, this.#registered(session, handler));
	}

	/** Keeps the host's copy of the definition (`admitToolDefinition`), taken here, inside the
	 *  registering call: everything the host later reads off a registered tool — its description
	 *  for a request, its approval answers, the environment its `shellEnv` gives a shell — is read
	 *  from that copy, never from the extension's object. A tool registered while a session runs is
	 *  that session's: its callbacks run as that session's work, and it is withdrawn when the
	 *  session ends. */
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void {
		const session = this.#registeringSession();
		const definition = admitToolDefinition(tool, session ?? this.runtime, this.extension.path);
		const registered = {
			definition,
			extensionPath: this.extension.path,
			sourceInfo: extensionToolSourceInfo(definition, this.extension.resolvedPath),
		};
		this.#setFor(session, this.extension.tools, definition.name, registered);
		for (const listener of this.extension.toolRegistrationListeners ?? []) listener(definition.name);
	}

	registerFileWriteFallback(handler: FileWriteFallbackHandler): void {
		const session = this.#registeringSession();
		this.#listFor(session, this.extension.fileWriteFallbackHandlers, this.#registered(session, handler));
	}

	registerFileDeleteFallback(handler: FileDeleteFallbackHandler): void {
		const session = this.#registeringSession();
		this.#listFor(session, this.extension.fileDeleteFallbackHandlers, this.#registered(session, handler));
	}

	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void {
		const session = this.#registeringSession();
		this.#setFor(session, this.extension.commands, name, {
			name,
			...options,
			getArgumentCompletions: this.#registered(session, options.getArgumentCompletions),
			handler: this.#registered(session, options.handler),
		});
	}

	setLabel(label: string): void {
		this.extension.label = label;
	}

	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void {
		const session = this.#registeringSession();
		this.#setFor(session, this.extension.shortcuts, shortcut, {
			shortcut,
			extensionPath: this.extension.path,
			...options,
			handler: this.#registered(session, options.handler),
		});
	}

	registerFlag(
		name: string,
		options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
	): void {
		const session = this.#registeringSession();
		const values = this.runtime.flagValues;
		const hadValue = values.has(name);
		const previousValue = values.get(name);
		// The flag's value goes with its declaration, whatever it has been set to since: a value
		// the user chose for a session's flag is that session's. What it replaced comes back.
		this.#setFor(
			session,
			this.extension.flags,
			name,
			{ name, extensionPath: this.extension.path, ...options },
			() => {
				if (hadValue) values.set(name, previousValue as boolean | string);
				else values.delete(name);
			},
		);
		if (options.default !== undefined) values.set(name, options.default);
	}

	registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
		const session = this.#registeringSession();
		this.#setFor(
			session,
			this.extension.messageRenderers,
			customType,
			this.#registered(session, renderer as MessageRenderer),
		);
	}

	registerAssistantThinkingRenderer(renderer: AssistantThinkingRenderer): void {
		const session = this.#registeringSession();
		this.#listFor(session, this.extension.assistantThinkingRenderers, this.#registered(session, renderer));
	}

	registerAssistantTextRenderer(renderer: AssistantTextRenderer): void {
		if (typeof renderer !== "function") {
			throw new TypeError(
				`registerAssistantTextRenderer expects a function, got ${typeof renderer} (extension ${this.extension.path})`,
			);
		}
		const session = this.#registeringSession();
		this.#listFor(session, this.extension.assistantTextRenderers, this.#registered(session, renderer));
	}

	registerLinkScheme(scheme: string): void {
		const normalized = scheme.toLowerCase();
		if (!LINK_SCHEME_PATTERN.test(normalized)) {
			throw new Error(
				`registerLinkScheme: "${scheme}" is not a URL scheme of two or more characters (letters, digits, "+", "-", ".")`,
			);
		}
		// `=== true`: inherited keys such as `constructor` are not reserved.
		if (STANDARD_LINK_SCHEMES[normalized] === true || InternalUrlRouter.instance().isBuiltin(normalized)) {
			throw new Error(`registerLinkScheme: "${scheme}" is reserved for standard or omp-internal links`);
		}
		const session = this.#registeringSession();
		if (!this.extension.linkSchemes.includes(normalized))
			this.#listFor(session, this.extension.linkSchemes, normalized);
	}

	registerComposerShape(definition: ComposerShapeDefinition): void {
		const id = definition.style.id;
		if (id.length === 0 || id !== id.trim()) {
			throw new TypeError("Composer shape id must be a non-empty trimmed string");
		}
		if (definition.label.trim().length === 0) {
			throw new TypeError(`Composer shape "${id}" must have a label`);
		}
		if (isBuiltinComposerStyle(id)) {
			throw new Error(`Cannot replace built-in composer shape "${id}"`);
		}
		const session = this.#registeringSession();
		// A host that installed this extension's shapes reinstalls them: a shape a session adds is
		// drawable, and one its end withdraws leaves the host's registries.
		const changed = (): void => {
			// A fixed snapshot: a listener that subscribes again while it runs is told of the next
			// change, not of this one a second time.
			for (const listener of Array.from(this.extension.composerShapeListeners ?? [])) listener();
		};
		this.#setFor(
			session,
			this.extension.composerShapes,
			id,
			session === undefined ? definition : sessionComposerShape(definition, session),
			changed,
		);
		changed();
	}

	getFlag(name: string): boolean | string | undefined {
		if (!this.extension.flags.has(name)) return undefined;
		return this.runtime.flagValues.get(name);
	}

	sendMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" },
	): void {
		this.runtime.sendMessage(message, options);
	}

	sendUserMessage(content: string | (TextContent | ImageContent)[], options?: SendUserMessageOptions): void {
		this.runtime.sendUserMessage(content, options);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.runtime.appendEntry(customType, data);
	}

	exec(command: string, args: string[], options?: ExecOptions) {
		return execCommand(command, args, options?.cwd ?? this.cwd, options);
	}

	getActiveTools(): string[] {
		return this.runtime.getActiveTools();
	}

	getAllTools(): ToolInfo[] {
		return this.runtime.getAllTools();
	}

	setActiveTools(toolNames: string[]): Promise<void> {
		return this.runtime.setActiveTools(toolNames);
	}

	getCommands() {
		return this.runtime.getCommands();
	}

	setModel(model: Model): Promise<boolean> {
		return this.runtime.setModel(model);
	}

	getThinkingLevel(): ThinkingLevel | undefined {
		return this.runtime.getThinkingLevel();
	}

	setThinkingLevel(level: ThinkingLevel, persist?: boolean): void {
		this.runtime.setThinkingLevel(level, persist);
	}

	getServiceTiers(): Readonly<ServiceTierByFamily> {
		return { ...this.runtime.getServiceTiers() };
	}

	setServiceTier(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		if (!isServiceTierFamily(family) || (tier !== undefined && !isServiceTierForFamily(family, tier))) {
			throw new TypeError(`Invalid service tier "${String(tier)}" for family "${String(family)}"`);
		}
		this.runtime.setServiceTier(family, tier);
	}

	getSessionName(): string | undefined {
		return this.runtime.getSessionName();
	}

	setSessionName(name: string): Promise<void> {
		return this.runtime.setSessionName(name);
	}

	registerProvider(name: string, config: ProviderConfig): void {
		// Refused, by throwing, from a session that has ended — the same check every other
		// registration makes — before anything reaches the registry.
		this.#registeringSession();
		this.extension.registersProviders = true;
		this.runtime.registerProvider(name, config, this.extension.path);
	}

	/** Withdraws every registration of `name` this extension made, at load and in any session — but
	 *  not from a session that has ended: its continuation must not reach a later session's
	 *  registration. The session-end withdrawal is the host's (`whenSessionEnds`), not this call. */
	unregisterProvider(name: string): void {
		this.#registeringSession();
		this.runtime.unregisterProvider(name, this.extension.path);
	}
}

/**
 * A composer shape one session registered, as the host keeps it. Withdrawing it at the session's
 * end unlists it, but a host that installed it still holds its style (`installExtensionComposerShape`)
 * and draws through it: so the style is the session's. Its data is read once, here, inside the
 * registering call; its drawing methods run as that session's work. Once the session has ended
 * the style answers as the host's `box` style — same id, nothing of the extension's runs — so the
 * prompt stays drawable until the host resyncs its shapes.
 */
function sessionComposerShape(
	definition: ComposerShapeDefinition,
	session: ExtensionCallbackOwner,
): ComposerShapeDefinition {
	const style = definition.style;
	const fallback = getComposerStyle("box");
	const ended = (): boolean => session.isRetired;
	const data = {
		filledSurface: style.filledSurface,
		sideBorders: style.sideBorders,
		verticalChrome: style.verticalChrome,
		statusAttachment: style.statusAttachment,
		bottomBar: style.bottomBar,
		bottomBarGap: style.bottomBarGap,
		defaultPromptGutter: style.defaultPromptGutter,
	};
	const method = <K extends "defaultPaddingX" | "sideChromeWidth" | "renderTop" | "renderRow" | "renderBottom">(
		key: K,
	): ComposerStyle[K] => {
		const own = style[key] as (...args: unknown[]) => unknown;
		const box = fallback[key] as (...args: unknown[]) => unknown;
		return ((...args: unknown[]): unknown =>
			ended()
				? Reflect.apply(box, fallback, args)
				: session.runOwned(() => Reflect.apply(own, style, args))) as ComposerStyle[K];
	};
	const gated: ComposerStyle = {
		id: style.id,
		get filledSurface() {
			// `box` paints no surface of its own.
			return ended() ? false : data.filledSurface;
		},
		get sideBorders() {
			return ended() ? fallback.sideBorders : data.sideBorders;
		},
		get verticalChrome() {
			return ended() ? fallback.verticalChrome : data.verticalChrome;
		},
		get statusAttachment() {
			return ended() ? fallback.statusAttachment : data.statusAttachment;
		},
		get bottomBar() {
			return ended() ? fallback.bottomBar : data.bottomBar;
		},
		get bottomBarGap() {
			return ended() ? fallback.bottomBarGap : data.bottomBarGap;
		},
		get defaultPromptGutter() {
			return ended() ? fallback.defaultPromptGutter : data.defaultPromptGutter;
		},
		defaultPaddingX: method("defaultPaddingX"),
		sideChromeWidth: method("sideChromeWidth"),
		renderTop: method("renderTop"),
		renderRow: method("renderRow"),
		renderBottom: method("renderBottom"),
	};
	return { label: definition.label, description: definition.description, style: gated };
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	return {
		path: extensionPath,
		resolvedPath,
		handlers: new Map(),
		tools: new Map(),
		toolRegistrationListeners: new Set(),
		assistantThinkingRenderers: [],
		assistantTextRenderers: [],
		linkSchemes: [],
		fileWriteFallbackHandlers: [],
		fileDeleteFallbackHandlers: [],
		messageRenderers: new Map(),
		composerShapes: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

/**
 * Runs an extension factory with provider registration rollback on failure.
 * Restores the complete registration queue when the factory throws because an
 * extension may unregister entries queued by an earlier extension.
 */
async function runExtensionFactory(
	factory: ExtensionFactory,
	api: ExtensionAPI,
	runtime: IExtensionRuntime,
): Promise<void> {
	const providerRegistrationCheckpoint = [...runtime.pendingProviderRegistrations];

	try {
		// Scoped so a `pi.events.on` during registration is attributed to THIS session, which a
		// bus shared between sessions cannot work out for itself. Run as the runtime's loading, so
		// what the factory registers serves every session even when it is loaded during one.
		const run = () => extensionCallbackScope.run(runtime, () => factory(api));
		await (runtime instanceof ExtensionRuntime ? runtime.runLoading(run) : run());
	} catch (error) {
		const discarded = runtime.pendingProviderRegistrations.filter(
			registration => !providerRegistrationCheckpoint.includes(registration),
		);
		runtime.pendingProviderRegistrations.splice(
			0,
			runtime.pendingProviderRegistrations.length,
			...providerRegistrationCheckpoint,
		);
		// The queue's owner index follows the queue: what the failed extension queued is gone, and
		// what it unregistered is queued again.
		forgetQueuedProviderRegistrations(discarded);
		restoreQueuedProviderRegistrations(providerRegistrationCheckpoint);
		throw error;
	}
}

async function importExtensionModule(extensionPath: string, cwd: string): Promise<PreparedExtension> {
	const resolvedPath = resolvePath(extensionPath, cwd);
	try {
		const module = (await withHostGuard(() => loadLegacyPiModule(resolvedPath))) as LoadedExtensionModule;
		const factory = getExtensionFactory(module);

		if (typeof factory !== "function") {
			return {
				path: extensionPath,
				factory: null,
				resolvedPath,
				error: `Extension does not export a valid factory function: ${extensionPath}`,
			};
		}

		return { path: extensionPath, factory, resolvedPath, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { path: extensionPath, factory: null, resolvedPath, error: `Failed to load extension: ${message}` };
	}
}

async function bindExtension(
	extensionPath: string,
	imported: PreparedExtension,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
): Promise<{ extension: Extension | null; error: string | null }> {
	const factory = imported.factory;
	if (imported.error !== null || factory === null) {
		return { extension: null, error: imported.error };
	}
	try {
		const extension = createExtension(extensionPath, imported.resolvedPath);
		const api = new ConcreteExtensionAPI(extension, runtime, cwd, eventBus);
		await withHostGuard(() => runExtensionFactory(factory, api, runtime));

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
	name = "<inline>",
): Promise<Extension> {
	const extension = createExtension(name, name);
	const api = new ConcreteExtensionAPI(extension, runtime, cwd, eventBus);
	await runExtensionFactory(factory, api, runtime);
	return extension;
}

/**
 * Load extensions from paths.
 *
 * Module import (the dominant cold-start cost — file I/O plus module
 * evaluation) runs concurrently across extensions; factory binding then runs
 * sequentially in the original path order, so registration semantics
 * (last-wins collisions, shared runtime flag defaults) stay deterministic.
 */
export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: IExtensionRuntime,
): Promise<LoadExtensionsResult> {
	const preparedExtensions = await Promise.all(paths.map(extPath => importExtensionModule(extPath, cwd)));
	return bindPreparedExtensions(preparedExtensions, cwd, eventBus, runtime);
}

/**
 * Bind previously imported extension factories. A fresh session runtime is
 * created unless `runtime` is given: deferred startup extensions bind into the
 * live session's runtime so they share its flag values and wired actions.
 */
export async function bindPreparedExtensions(
	preparedExtensions: readonly PreparedExtension[],
	cwd: string,
	eventBus?: EventBus,
	runtime: IExtensionRuntime = new ExtensionRuntime(),
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? new EventBus();

	for (const prepared of preparedExtensions) {
		const { extension, error } = await bindExtension(prepared.path, prepared, cwd, resolvedEventBus, runtime);

		if (error) {
			errors.push({ path: prepared.path, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime,
		preparedExtensions: [...preparedExtensions],
	};
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

const CONFIGURED_EXTENSION_DIRECTORY_OPTIONS = {
	indexNames: ["index.ts", "index.js"],
	isScanFile: isExtensionFile,
	throwUnexpectedStatErrors: true,
	onReadError: (filePath: string, error: unknown) => {
		logger.warn("Failed to resolve extension directory", { path: filePath, error: String(error) });
	},
};

async function discoverHooksInPackageRoot(root: string): Promise<string[]> {
	const hooks: string[] = [];
	for (const hookType of ["pre", "post"]) {
		const hookDir = path.join(root, "hooks", hookType);
		let entries: fs1.Dirent[];
		try {
			entries = await fs.readdir(hookDir, { withFileTypes: true });
		} catch (err) {
			if (isEnoent(err) || isEacces(err) || hasFsCode(err, "ENOTDIR") || hasFsCode(err, "EPERM")) continue;
			throw err;
		}
		for (const entry of entries) {
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				hooks.push(path.join(hookDir, entry.name));
			}
		}
	}
	return hooks;
}

/**
 * Discover absolute paths of extensions to load, without importing or
 * binding factories. Hot path on session startup — the scan walks native
 * `.omp`/`.pi` extension capabilities, JS/TS hook factories, the
 * installed-plugin tree, and any configured paths.
 *
 * The root session imports these paths once and forwards prepared factories to
 * subagents. Each child rebinds fresh Extension instances to its OWN
 * ExtensionAPI (cwd, eventBus, runtime) without re-evaluating the module graph.
 */
export interface DiscoverExtensionPathOptions {
	/** Include ambient native extensions, hooks, and installed plugins. */
	ambient?: boolean;
	/** Include ambient hook factories. Disable for read-only catalog commands. */
	includeAmbientHooks?: boolean;
}

export async function discoverExtensionPaths(
	configuredPaths: string[],
	cwd: string,
	disabledExtensionIds?: string[],
	options: DiscoverExtensionPathOptions = {},
): Promise<string[]> {
	const allPaths: string[] = [];
	const seen = new Set<string>();
	const disabled = new Set(disabledExtensionIds ?? []);
	const loadOptions = disabledExtensionIds ? { cwd, disabledExtensions: disabledExtensionIds } : { cwd };

	const isDisabledName = (name: string): boolean => disabled.has(`extension-module:${name}`);

	// Key on the real file so a symlink and its target load once, e.g. an
	// extensions/ symlink plus the same file passed with --extension. Missing
	// paths keep their lexical key so the loader still reports them.
	const addPath = async (extPath: string): Promise<void> => {
		const resolved = path.resolve(extPath);
		const key = await fs.realpath(resolved).catch(() => resolved);
		if (!seen.has(key)) {
			seen.add(key);
			allPaths.push(extPath);
		}
	};

	const addPaths = async (paths: string[]): Promise<void> => {
		for (const extPath of paths) {
			if (isDisabledName(getExtensionNameFromPath(extPath))) continue;
			await addPath(extPath);
		}
	};

	const ambient = options.ambient !== false;
	if (ambient) {
		// 1. Discover extension modules via capability API (native .omp/.pi only).
		// Scope the load to the native provider — the extension-module capability
		// also has claude/codex/gemini/opencode providers, and their items were
		// discarded here anyway (see #4198). The provider filter skips the walk
		// entirely instead of running four foreign directory scans and dropping
		// the results.
		const discovered = await loadCapability<ExtensionModule>(extensionModuleCapability.id, {
			...loadOptions,
			providers: ["native"],
		});
		for (const ext of discovered.items) {
			await addPath(ext.path);
		}
	}

	// 2. Discover JS/TS hook factories and bind them through the extension
	// runner, which owns the current runtime event bus. Non-ambient discovery
	// scans only this invocation's configured package roots; it must not consult
	// settings, installed packages, or process-global CLI injection state.
	if (ambient) {
		if (options.includeAmbientHooks !== false) {
			const hooks = await loadCapability<Hook>(hookCapability.id, loadOptions);
			for (const hookPath of hooks.items
				.map(hook => hook.path)
				.filter(hookPath => isExtensionFile(path.basename(hookPath)))) {
				await addPath(hookPath);
			}
		}
	} else {
		for (const configuredPath of configuredPaths) {
			await addPaths(await discoverHooksInPackageRoot(resolvePath(configuredPath, cwd)));
		}
	}

	// 3. Discover extension entry points from installed plugins.
	if (ambient) {
		await addPaths(await getAllPluginExtensionPaths(cwd));
	}

	// 4. Explicitly configured paths
	for (const configuredPath of configuredPaths) {
		const resolved = resolvePath(configuredPath, cwd);

		let stat: fs1.Stats | null = null;
		try {
			stat = await fs.stat(resolved);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}

		if (stat?.isDirectory()) {
			await addPaths(resolveExtensionDirectory(resolved, CONFIGURED_EXTENSION_DIRECTORY_OPTIONS).files);
			continue;
		}

		await addPath(resolved);
	}

	return allPaths;
}

/**
 * Discover and load extensions from standard locations. Composed of
 * {@link discoverExtensionPaths} (FS scan) + {@link loadExtensions}
 * (per-session binding).
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	eventBus?: EventBus,
	disabledExtensionIds?: string[],
	options: DiscoverExtensionPathOptions = {},
): Promise<LoadExtensionsResult> {
	const paths = await discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds, options);
	return loadExtensions(paths, cwd, eventBus);
}
