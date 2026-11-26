/**
 * Fine-grained reactivity for TSX components: signals, lazy computeds,
 * effects, ownership and context.
 *
 * Updates are synchronous and glitch-free. A write marks direct observers
 * dirty and their dependents "check"; queued effects then pull their sources
 * in creation order, so a computed reruns only when a source actually changed
 * and every effect sees a consistent graph. Writes inside {@link batch} (or
 * inside a running effect) flush once, when the outermost batch ends.
 *
 * Ownership. Every computation created while another runs is owned by it and
 * disposed before that owner reruns; {@link createRoot} opens a detached owner
 * that lives until its `dispose` is called. {@link onCleanup} runs when the
 * current owner reruns or is disposed.
 *
 * Invalidation epochs. An owner may carry an epoch signal (a mounted
 * {@link Root} does); value computations ({@link computed}, {@link effect},
 * host prop bindings) created under it read the epoch, so bumping it
 * re-derives every themed value without recreating structure.
 *
 * @example
 * const count = signal(1);
 * const doubled = computed(() => count() * 2);
 * effect(() => log(doubled()));
 * count.set(2); // logs 4
 */

/** A tracked read of a reactive value. */
export type Accessor<T> = () => T;

/** A value, or an accessor that yields it (a reactive binding when passed as a prop or child). */
export type Reactive<T> = T | Accessor<T>;

/** Writable reactive state: call to read (tracked), `set`/`update` to write, `peek` to read untracked. */
export interface Signal<T> extends Accessor<T> {
	set(value: T): void;
	update(fn: (value: T) => T): void;
	peek(): T;
}

/** Equality deciding whether a write (or a recomputed value) notifies observers. */
export type Equals<T> = (previous: T, next: T) => boolean;

/** Options shared by {@link signal} and {@link computed}. */
export interface ReactiveOptions<T> {
	/** `false` notifies on every write; defaults to `Object.is`. */
	equals?: Equals<T> | false;
}

const CLEAN = 0;
const CHECK = 1;
const DIRTY = 2;
type State = typeof CLEAN | typeof CHECK | typeof DIRTY;

/** Upper bound on effect reruns in one flush; exceeding it means an effect writes what it reads. */
const MAX_FLUSH_RUNS = 100_000;

const kAccessor = Symbol("jsx.accessor");

interface Source {
	observers: Computation<unknown>[] | null;
	/** Scratch mark: the run that last tracked it, or the resubscribe pass that last visited it. */
	stamp: number;
	/** Bring the value up to date (computeds); no-op for signals. */
	refresh(): void;
}

/** A scope that owns computations, cleanups and context values. */
export class Owner {
	owner: Owner | null;
	owned: Owner[] | null = null;
	cleanups: (() => void)[] | null = null;
	context: Map<symbol, unknown> | null = null;
	/** Invalidation epoch inherited by value computations created under this owner. */
	epoch: Accessor<number> | null;
	disposed = false;

	constructor(owner: Owner | null) {
		this.owner = owner;
		this.epoch = owner?.epoch ?? null;
	}

	/** Dispose owned scopes and run cleanups (latest first), keeping the owner usable. */
	reset(): void {
		const owned = this.owned;
		if (owned) {
			this.owned = null;
			for (let i = owned.length - 1; i >= 0; i--) owned[i]!.dispose();
		}
		const cleanups = this.cleanups;
		if (cleanups) {
			this.cleanups = null;
			for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]!();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.reset();
	}
}

let currentOwner: Owner | null = null;
let currentObserver: Computation<unknown> | null = null;
/** Sources the running computation read this run, in first-read order. */
let currentSources: Source[] | null = null;
/** Source of every stamp: run ids and resubscribe marks never repeat. */
let stampClock = 0;
/** Id of the running computation's run; a source stamped with it is already in `currentSources`. */
let currentRun = 0;
let batchDepth = 0;
let pendingEffects: Computation<unknown>[] = [];

function track(source: Source): void {
	if (currentSources === null || source.stamp === currentRun) return;
	// A nested run may restamp a source this run already read; the duplicate push is swept in `#resubscribe`.
	source.stamp = currentRun;
	currentSources.push(source);
}

function markStale(node: Computation<unknown>, state: State): void {
	if (node.state >= state) return;
	if (node.state === CLEAN && node.isEffect) pendingEffects.push(node);
	node.state = state;
	const observers = node.observers;
	if (observers) for (const observer of observers) markStale(observer, CHECK);
}

function notify(source: Source): void {
	const observers = source.observers;
	if (!observers) return;
	for (const observer of observers) markStale(observer, DIRTY);
	if (batchDepth === 0) flush();
}

function flush(): void {
	batchDepth++;
	try {
		let runs = 0;
		while (pendingEffects.length > 0) {
			const queue = pendingEffects;
			pendingEffects = [];
			for (const effect of queue) {
				if (++runs > MAX_FLUSH_RUNS) {
					pendingEffects = [];
					throw new Error("reactive flush did not settle: an effect keeps writing a signal it reads");
				}
				if (!effect.disposed) effect.refresh();
			}
		}
	} finally {
		batchDepth--;
	}
}

class SignalNode<T> implements Source {
	observers: Computation<unknown>[] | null = null;
	stamp = 0;
	value: T;
	readonly equals: Equals<T> | false;

	constructor(value: T, equals: Equals<T> | false) {
		this.value = value;
		this.equals = equals;
	}

	refresh(): void {}

	read(): T {
		track(this);
		return this.value;
	}

	write(value: T): void {
		if (this.equals !== false && this.equals(this.value, value)) return;
		this.value = value;
		notify(this);
	}
}

class Computation<T> extends Owner implements Source {
	observers: Computation<unknown>[] | null = null;
	sources: Source[] | null = null;
	stamp = 0;
	state: State = DIRTY;
	value: T | undefined = undefined;
	readonly isEffect: boolean;
	readonly #fn: (previous: T | undefined) => T;
	readonly #equals: Equals<T> | false;
	readonly #tracksEpoch: boolean;
	/** Whether a run completed, so `value` is a real previous value for `equals`. */
	#settled = false;

	constructor(fn: (previous: T | undefined) => T, isEffect: boolean, equals: Equals<T> | false, tracksEpoch: boolean) {
		super(currentOwner);
		this.#fn = fn;
		this.isEffect = isEffect;
		this.#equals = equals;
		this.#tracksEpoch = tracksEpoch;
		if (currentOwner) (currentOwner.owned ??= []).push(this);
	}

	read(): T {
		if (this.disposed) return this.value as T;
		this.refresh();
		track(this);
		return this.value as T;
	}

	refresh(): void {
		if (this.state === CLEAN) return;
		if (this.state === CHECK) {
			for (const source of this.sources ?? []) {
				source.refresh();
				if ((this.state as State) === DIRTY) break;
			}
			if (this.state === CHECK) {
				this.state = CLEAN;
				return;
			}
		}
		// Clean before running: a write to an own source during the run marks it dirty again.
		this.state = CLEAN;
		this.#run();
	}

	#run(): void {
		this.reset();
		const prevOwner = currentOwner;
		const prevObserver = currentObserver;
		const prevSources = currentSources;
		const prevRun = currentRun;
		const sources: Source[] = [];
		currentOwner = this;
		currentObserver = this as Computation<unknown>;
		currentSources = sources;
		currentRun = ++stampClock;
		let next: T;
		try {
			if (this.#tracksEpoch) this.epoch?.();
			next = this.#fn(this.value);
		} finally {
			currentOwner = prevOwner;
			currentObserver = prevObserver;
			currentSources = prevSources;
			currentRun = prevRun;
			this.#resubscribe(sources);
		}
		const changed = !this.#settled || this.#equals === false || !this.#equals(this.value as T, next);
		this.#settled = true;
		this.value = next;
		// Observers mid-check rerun; a clean observer is the one pulling this value right now.
		if (changed && this.observers) {
			for (const observer of this.observers) if (observer.state === CHECK) observer.state = DIRTY;
		}
	}

	/**
	 * Subscribe to the sources of the run that just ended and drop the ones it no longer read, in
	 * one pass over each list: previous sources are marked, then `next` is walked (deduplicated in
	 * place, first read kept, so the CHECK walk keeps read order), then unmarked previous ones leave.
	 */
	#resubscribe(next: Source[]): void {
		const self = this as Computation<unknown>;
		const previous = this.sources;
		const kept = ++stampClock;
		if (previous) for (const source of previous) source.stamp = kept;
		const seen = ++stampClock;
		let length = 0;
		for (const source of next) {
			const stamp = source.stamp;
			if (stamp === seen) continue;
			if (stamp !== kept) (source.observers ??= []).push(self);
			source.stamp = seen;
			next[length++] = source;
		}
		next.length = length;
		if (previous) {
			for (const source of previous) {
				if (source.stamp === seen) continue;
				const list = source.observers;
				if (!list) continue;
				const index = list.indexOf(self);
				if (index !== -1) list.splice(index, 1);
			}
		}
		this.sources = next;
	}

	override dispose(): void {
		if (this.disposed) return;
		super.dispose();
		for (const source of this.sources ?? []) {
			const list = source.observers;
			if (!list) continue;
			const index = list.indexOf(this as Computation<unknown>);
			if (index !== -1) list.splice(index, 1);
		}
		this.sources = null;
	}
}

function brand<T extends (...args: never[]) => unknown>(fn: T): T {
	Object.defineProperty(fn, kAccessor, { value: true });
	return fn;
}

/**
 * Whether `value` is a branded accessor ({@link signal}, {@link computed},
 * {@link derived}). Hosts use this for function-typed props, where an
 * unbranded function is the prop value itself (a styler, a callback).
 */
export function isAccessor(value: unknown): value is Accessor<unknown> {
	return typeof value === "function" && kAccessor in value;
}

/** Mark `fn` as an accessor, so a function-typed prop (a styler) binds to it instead of taking it as the value. */
export function derived<T>(fn: () => T): Accessor<T> {
	return brand(() => fn());
}

/** Reactive state. */
export function signal<T>(value: T, options?: ReactiveOptions<T>): Signal<T> {
	const node = new SignalNode(value, options?.equals ?? Object.is);
	const read = brand(() => node.read()) as Signal<T>;
	read.set = next => node.write(next);
	read.update = fn => node.write(fn(node.value));
	read.peek = () => node.value;
	return read;
}

/**
 * A lazily evaluated, cached derivation: runs on first read, then only after
 * a source changed. Owned by the current owner; reads its epoch.
 */
export function computed<T>(fn: (previous: T | undefined) => T, options?: ReactiveOptions<T>): Accessor<T> {
	const node = new Computation<T>(fn, false, options?.equals ?? Object.is, true);
	return brand(() => node.read());
}

/** A lazily evaluated derivation that ignores invalidation epochs (structure, not values). */
export function structural<T>(fn: (previous: T | undefined) => T, options?: ReactiveOptions<T>): Accessor<T> {
	const node = new Computation<T>(fn, false, options?.equals ?? Object.is, false);
	return brand(() => node.read());
}

/** Run `fn` now and again after any source it read changes. Owned by the current owner; reads its epoch. */
export function effect(fn: () => void): void {
	const node = new Computation<void>(fn, true, false, true);
	node.refresh();
}

/** {@link effect} that ignores invalidation epochs (structural updates such as child lists). */
export function structuralEffect(fn: () => void): void {
	const node = new Computation<void>(fn, true, false, false);
	node.refresh();
}

/**
 * Run `fn` in a detached owner that lives until the `dispose` it receives is
 * called. Context and the invalidation epoch are inherited from the current
 * owner; disposal is not.
 */
export function createRoot<T>(fn: (dispose: () => void) => T, epoch?: Accessor<number>): T {
	const root = new Owner(currentOwner);
	if (epoch) root.epoch = epoch;
	return runIn(root, null, () => fn(() => root.dispose()));
}

/** Register `fn` to run when the current owner reruns or is disposed. */
export function onCleanup(fn: () => void): void {
	if (currentOwner) (currentOwner.cleanups ??= []).push(fn);
}

/** Read inside `fn` without subscribing the running computation. */
export function untrack<T>(fn: () => T): T {
	const prevObserver = currentObserver;
	const prevSources = currentSources;
	currentObserver = null;
	currentSources = null;
	try {
		return fn();
	} finally {
		currentObserver = prevObserver;
		currentSources = prevSources;
	}
}

/** Apply every write in `fn`, then flush effects once. */
export function batch<T>(fn: () => T): T {
	batchDepth++;
	try {
		return fn();
	} finally {
		batchDepth--;
		if (batchDepth === 0) flush();
	}
}

/** The owner scope new computations attach to, or null outside any. */
export function getOwner(): Owner | null {
	return currentOwner;
}

function runIn<T>(owner: Owner | null, observer: Computation<unknown> | null, fn: () => T): T {
	const prevOwner = currentOwner;
	const prevObserver = currentObserver;
	const prevSources = currentSources;
	currentOwner = owner;
	currentObserver = observer;
	currentSources = null;
	try {
		return fn();
	} finally {
		currentOwner = prevOwner;
		currentObserver = prevObserver;
		currentSources = prevSources;
	}
}

/** Run `fn` (untracked) as if created under `owner`: for callbacks that build reactive state later. */
export function runWithOwner<T>(owner: Owner | null, fn: () => T): T {
	return runIn(owner, null, fn);
}

/** A typed context slot resolved through the owner chain. */
export interface Context<T> {
	readonly id: symbol;
	readonly defaultValue: T;
}

/** A context slot; {@link useContext} returns `defaultValue` when no owner provides it. */
export function createContext<T>(defaultValue: T, name = "context"): Context<T> {
	return { id: Symbol(name), defaultValue };
}

/** The nearest provided value of `context`, else its default. */
export function useContext<T>(context: Context<T>): T {
	for (let owner = currentOwner; owner; owner = owner.owner) {
		if (owner.context?.has(context.id)) return owner.context.get(context.id) as T;
	}
	return context.defaultValue;
}

/**
 * Run `fn` in a child owner that provides `value` for `context`. Elements
 * created inside `fn` see it; JSX children evaluated before the call do not.
 */
export function provide<T, R>(context: Context<T>, value: T, fn: () => R): R {
	const owner = new Owner(currentOwner);
	if (currentOwner) (currentOwner.owned ??= []).push(owner);
	owner.context = new Map([[context.id, value]]);
	const prevOwner = currentOwner;
	currentOwner = owner;
	try {
		return fn();
	} finally {
		currentOwner = prevOwner;
	}
}

/** `value`, calling it first when it is a function (any function: for value-typed props and children). */
export function read<T>(value: Reactive<T>): T {
	return typeof value === "function" ? (value as Accessor<T>)() : value;
}
