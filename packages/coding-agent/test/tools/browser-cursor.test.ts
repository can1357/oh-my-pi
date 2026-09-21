import { describe, expect, it } from "bun:test";
import {
	CURSOR_MODE_VALUES,
	CursorPreloadManager,
	cursorCleanupSourceForTest,
	cursorHideSourceForTest,
	cursorPreloadSourceForTest,
	cursorShowSourceForTest,
	resolveCursorMode,
} from "@oh-my-pi/pi-coding-agent/tools/browser/cursor";
import { clickElement, isClickActionable } from "@oh-my-pi/pi-coding-agent/tools/browser/interactions";

class FakePage {
	preloadCalls = 0;
	evaluateCalls: string[] = [];
	removedPreloads: string[] = [];
	throwEvaluate = false;
	childFrames: Array<{ evaluate(source: string): Promise<unknown> }> = [];

	async evaluateOnNewDocument(_source: string): Promise<{ identifier: string }> {
		this.preloadCalls++;
		return { identifier: `cursor-${this.preloadCalls}` };
	}

	async removeScriptToEvaluateOnNewDocument(identifier: string): Promise<void> {
		this.removedPreloads.push(identifier);
	}
	frames(): Array<{ evaluate(source: string): Promise<unknown> }> {
		return [this, ...this.childFrames];
	}

	async evaluate(source: string): Promise<unknown> {
		this.evaluateCalls.push(source);
		if (this.throwEvaluate) throw new Error("page closed");
		return true;
	}
}

function evaluateSource(scope: Record<string, unknown>, source: string): unknown {
	const executable = source.replace(/^\/\/!world=main\r?\n/, "");
	return new Function("globalThis", "window", "document", `return ${executable}`)(scope, scope, scope.document);
}

class SyntheticPage {
	preloadCalls = 0;
	evaluateCalls = 0;
	removedPreloads: string[] = [];
	childFrames: Array<{ evaluate(source: string): Promise<unknown> }> = [];
	constructor(readonly scope: Record<string, unknown>) {}

	async evaluateOnNewDocument(_source: string): Promise<{ identifier: string }> {
		this.preloadCalls++;
		return { identifier: `cursor-${this.preloadCalls}` };
	}

	async removeScriptToEvaluateOnNewDocument(identifier: string): Promise<void> {
		this.removedPreloads.push(identifier);
	}
	frames(): Array<{ evaluate(source: string): Promise<unknown> }> {
		return [this, ...this.childFrames];
	}

	async evaluate(source: string): Promise<unknown> {
		this.evaluateCalls++;
		return evaluateSource(this.scope, source);
	}
}

class FakeAnimation {
	readonly duration: number;
	readonly keyframes: unknown;
	#resolve!: () => void;
	readonly finished = new Promise<void>(resolve => {
		this.#resolve = resolve;
	});

	constructor(keyframes: unknown, options: { duration: number }) {
		this.keyframes = keyframes;
		this.duration = options.duration;
	}

	cancel(): void {
		this.#resolve();
	}

	resolve(): void {
		this.#resolve();
	}
}

class FakeStyle {
	cssText = "";
	transform = "";
	opacity = "";
	readonly properties = new Map<string, string>();

	setProperty(name: string, value: string): void {
		this.properties.set(name, value);
	}
}

class FakeShadowRoot {
	children: FakeElement[] = [];

	appendChild(child: FakeElement): void {
		this.children.push(child);
	}
}

class FakeElement {
	readonly style = new FakeStyle();
	readonly animations: FakeAnimation[] = [];
	readonly attributes = new Map<string, string>();
	shadowRoot: null = null;
	isConnected = false;
	closedShadow?: FakeShadowRoot;

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	attachShadow(_options: { mode: "closed" }): FakeShadowRoot {
		this.closedShadow = new FakeShadowRoot();
		return this.closedShadow;
	}

	getAnimations(): FakeAnimation[] {
		return this.animations;
	}

	animate(keyframes: unknown, options: { duration: number }): FakeAnimation {
		const animation = new FakeAnimation(keyframes, options);
		this.animations.push(animation);
		return animation;
	}

	remove(): void {
		this.isConnected = false;
	}
}

class FakeDocument {
	visibilityState: "visible" | "hidden" = "visible";
	readonly created: FakeElement[] = [];
	readonly documentElement = {
		appendChild: (element: FakeElement) => {
			element.isConnected = true;
		},
	};

	createElement(_tag: string): FakeElement {
		const element = new FakeElement();
		this.created.push(element);
		return element;
	}
}

function makeScope(options: { hidden?: boolean; reduced?: boolean } = {}): Record<string, unknown> {
	const document = new FakeDocument();
	if (options.hidden) document.visibilityState = "hidden";
	const listeners = new Map<string, (event: { persisted?: boolean }) => void>();
	const scope: Record<string, unknown> = {
		document,
		innerWidth: 1200,
		innerHeight: 800,
		matchMedia: () => ({ matches: options.reduced === true }),
		addEventListener: (type: string, listener: (event: { persisted?: boolean }) => void) =>
			listeners.set(type, listener),
		removeEventListener: (type: string, listener: (event: { persisted?: boolean }) => void) => {
			if (listeners.get(type) === listener) listeners.delete(type);
		},
		listeners,
	};
	scope.window = scope;
	return scope;
}

function runPreload(scope: Record<string, unknown>): FakeElement {
	new Function("globalThis", "window", "document", cursorPreloadSourceForTest())(scope, scope, scope.document);
	return (scope.document as FakeDocument).created[0]!;
}

async function runShow(scope: Record<string, unknown>, x: number, y: number, mode: "instant" | "animated") {
	return await new Function(
		"globalThis",
		"window",
		"document",
		`return (${cursorShowSourceForTest()})(${x},${y},${JSON.stringify(mode)})`,
	)(scope, scope, scope.document);
}

function runHide(scope: Record<string, unknown>): void {
	new Function("globalThis", "window", "document", `return (${cursorHideSourceForTest()})()`)(
		scope,
		scope,
		scope.document,
	);
}

function runCleanup(scope: Record<string, unknown>): void {
	new Function("globalThis", "window", "document", `return (${cursorCleanupSourceForTest()})()`)(
		scope,
		scope,
		scope.document,
	);
}

describe("native browser cursor", () => {
	it("resolves auto only for relay-headed tabs", () => {
		expect(CURSOR_MODE_VALUES).toEqual(["off", "instant", "animated"]);
		expect(resolveCursorMode(undefined, true)).toBe("animated");
		expect(resolveCursorMode(undefined, false)).toBe("off");
		expect(resolveCursorMode("instant", true)).toBe("instant");
	});

	it("deduplicates preload state and bootstraps each page through the manager", async () => {
		const scope = makeScope();
		const page = new SyntheticPage(scope);
		const manager = new CursorPreloadManager();
		await manager.install(page as never, "animated");
		await manager.install(page as never, "animated");
		expect(page.preloadCalls).toBe(1);
		expect(page.evaluateCalls).toBe(2);
		expect((scope.document as FakeDocument).created).toHaveLength(2);
		expect((scope.document as FakeDocument).created[0]?.isConnected).toBe(true);
	});

	it("renders a centered inert closed-shadow cursor and travels with pulse timing", async () => {
		const scope = makeScope();
		const root = runPreload(scope);
		const document = scope.document as FakeDocument;
		expect(root.attributes.get("aria-hidden")).toBe("true");
		expect(root.attributes.get("data-omp-native-cursor")).toBe("omp-native-cursor-v1");
		expect(root.closedShadow?.children).toHaveLength(1);
		expect(root.shadowRoot).toBeNull();
		expect(root.style.cssText).toContain("transform:translate(50vw,50vh)");
		const pending = runShow(scope, 300, 200, "animated");
		expect(root.animations).toHaveLength(1);
		expect(root.closedShadow?.children[0]?.animations).toHaveLength(1);
		expect(root.animations[0]?.duration).toBe(600);
		expect(root.closedShadow?.children[0]?.animations[0]?.duration).toBe(100);
		for (const animation of [...root.animations, ...root.closedShadow!.children[0]!.animations]) animation.resolve();
		await expect(pending).resolves.toBe(true);
		expect(document.created).toHaveLength(2);
	});

	it("hides after an action and remains reusable for the next action", async () => {
		const scope = makeScope();
		const root = runPreload(scope);
		const first = runShow(scope, 300, 200, "instant");
		root.closedShadow!.children[0]!.animations.at(-1)!.resolve();
		await expect(first).resolves.toBe(true);
		runHide(scope);
		expect(root.style.opacity).toBe("0");
		expect(root.isConnected).toBe(true);
		const second = runShow(scope, 500, 400, "instant");
		root.closedShadow!.children[0]!.animations.at(-1)!.resolve();
		await expect(second).resolves.toBe(true);
		expect(root.style.opacity).toBe("1");
	});

	it("forces instant travel for hidden and reduced-motion pages", async () => {
		for (const options of [{ hidden: true }, { reduced: true }]) {
			const scope = makeScope(options);
			const root = runPreload(scope);
			const pending = runShow(scope, 300, 200, "animated");
			expect(root.animations).toHaveLength(0);
			expect(root.closedShadow?.children[0]?.animations).toHaveLength(1);
			root.closedShadow!.children[0]!.animations[0]!.resolve();
			await expect(pending).resolves.toBe(true);
			expect(root.style.transform).toContain("300px");
		}
	});

	it("cleans up cursor state and tolerates page teardown", async () => {
		const scope = makeScope();
		const root = runPreload(scope);
		(root.closedShadow?.children[0]?.animations ?? []).forEach(animation => animation.resolve());
		runCleanup(scope);
		expect(root.isConnected).toBe(false);
		expect(scope.__ompNativeCursor).toBeUndefined();
		const page = new FakePage();
		const manager = new CursorPreloadManager();
		await manager.install(page as never, "instant");
		page.throwEvaluate = true;
		await manager.cleanup(page as never);
		expect(page.removedPreloads).toEqual(["cursor-1"]);
	});

	it("removes cursor state from every extant frame while tolerating a detached sibling", async () => {
		const mainScope = makeScope();
		const childScope = makeScope();
		const page = new SyntheticPage(mainScope);
		const child = new SyntheticPage(childScope);
		page.childFrames.push(
			{
				evaluate: async () => {
					throw new Error("frame detached");
				},
			},
			child,
		);
		const manager = new CursorPreloadManager();
		await manager.install(page as never, "instant");
		const childRoot = runPreload(childScope);
		(childScope.document as FakeDocument).documentElement.appendChild(childRoot);
		await manager.cleanup(page as never);
		expect(mainScope.__ompNativeCursor).toBeUndefined();
		expect(childScope.__ompNativeCursor).toBeUndefined();
		expect(childRoot.isConnected).toBe(false);
		expect(page.removedPreloads).toEqual(["cursor-1"]);
	});

	it("hides on pagehide without deleting state before the next document is ready", () => {
		const scope = makeScope();
		const root = runPreload(scope);
		root.isConnected = true;
		root.style.opacity = "1";
		const listeners = scope.listeners as Map<string, () => void>;
		listeners.get("pagehide")!();
		expect(root.style.opacity).toBe("0");
		expect(root.isConnected).toBe(true);
		expect(scope.__ompNativeCursor).toBeDefined();
		runCleanup(scope);
		expect(root.isConnected).toBe(false);
		expect(scope.__ompNativeCursor).toBeUndefined();
		expect(listeners.has("pagehide")).toBe(false);
	});

	it("accepts a shadow target without accepting an unrelated light-DOM ancestor", async () => {
		class TestElement {
			readonly descendants = new Set<TestElement>();
			readonly tagName = "DIV";
			readonly id = "";
			readonly classList: string[] = [];
			constructor(readonly root: object) {}
			getRootNode(): object {
				return this.root;
			}
			getBoundingClientRect() {
				return { left: 10, right: 30, top: 20, bottom: 40, width: 20, height: 20 };
			}
			contains(other: unknown): boolean {
				return this.descendants.has(other as TestElement);
			}
		}
		class TestShadowRoot {
			hit!: TestElement;
			constructor(readonly host: TestElement) {}
			elementFromPoint(): TestElement {
				return this.hit;
			}
		}
		let documentHit: TestElement;
		const documentRoot = { elementFromPoint: () => documentHit };
		const host = new TestElement(documentRoot);
		documentHit = host;
		const shadowRoot = new TestShadowRoot(host);
		const target = new TestElement(shadowRoot);
		shadowRoot.hit = target;
		const prior = new Map<string, PropertyDescriptor | undefined>();
		for (const key of ["ShadowRoot", "document", "getComputedStyle", "innerWidth", "innerHeight"]) {
			prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		}
		Object.defineProperties(globalThis, {
			ShadowRoot: { configurable: true, value: TestShadowRoot },
			document: { configurable: true, value: documentRoot },
			getComputedStyle: {
				configurable: true,
				value: () => ({ display: "block", visibility: "visible", pointerEvents: "auto", opacity: "1" }),
			},
			innerWidth: { configurable: true, value: 100 },
			innerHeight: { configurable: true, value: 100 },
		});
		const handle = { evaluate: async (callback: (element: TestElement) => unknown) => callback(target) } as never;
		try {
			await expect(isClickActionable(handle)).resolves.toEqual({ ok: true, x: 20, y: 30 });
			const ancestor = new TestElement(documentRoot);
			documentRoot.elementFromPoint = () => ancestor;
			documentHit = ancestor;
			await expect(isClickActionable(handle)).resolves.toMatchObject({ ok: false, reason: "covered" });
		} finally {
			for (const [key, descriptor] of prior) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
	});

	it("leaves disabled pages completely inert", async () => {
		const page = new FakePage();
		const manager = new CursorPreloadManager();
		await expect(manager.install(page as never, "off")).resolves.toBe(false);
		expect(page.preloadCalls).toBe(0);
		expect(page.evaluateCalls).toEqual([]);
		expect(page.removedPreloads).toEqual([]);
	});

	it("re-resolves moving below-fold and clipped targets before dispatching the synchronized final point", async () => {
		const cursorPage = new FakePage();
		const manager = new CursorPreloadManager();
		await manager.install(cursorPage as never, "instant");
		cursorPage.throwEvaluate = true;
		for (const scenario of [
			{
				initialTop: 150,
				settledTop: 20,
				movedTop: 50,
				initialPoint: { x: 40, y: 40 },
				finalPoint: { x: 40, y: 70 },
			},
			{
				initialTop: -10,
				settledTop: -10,
				movedTop: -10,
				initialPoint: { x: 40, y: 15 },
				finalPoint: { x: 40, y: 15 },
			},
		]) {
			const order: string[] = [];
			let top = scenario.initialTop;
			let scrolls = 0;
			const documentRoot = { elementFromPoint: () => element };
			const element = {
				tagName: "BUTTON",
				id: "target",
				classList: [] as string[],
				parentElement: null,
				getRootNode: () => documentRoot,
				getBoundingClientRect: () => ({ left: 20, right: 60, top, bottom: top + 40, width: 40, height: 40 }),
				scrollIntoView: () => {
					order.push("scroll");
					if (scrolls++ === 0) top = scenario.settledTop;
				},
			};
			const clicks: Array<{ x: number; y: number }> = [];
			const page = {
				mouse: {
					click: async (x: number, y: number) => {
						order.push("click");
						clicks.push({ x, y });
					},
				},
			};
			const handle = {
				evaluate: async (callback: (target: typeof element) => unknown) => callback(element),
				boundingBox: async () => ({ x: 20, y: top, width: 40, height: 40 }),
				frame: { page: () => page },
			} as never;
			const prior = new Map<string, PropertyDescriptor | undefined>();
			for (const key of ["document", "getComputedStyle", "innerWidth", "innerHeight"]) {
				prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			}
			Object.defineProperties(globalThis, {
				document: { configurable: true, value: documentRoot },
				getComputedStyle: {
					configurable: true,
					value: () => ({ display: "block", visibility: "visible", pointerEvents: "auto", opacity: "1" }),
				},
				innerWidth: { configurable: true, value: 100 },
				innerHeight: { configurable: true, value: 100 },
			});
			try {
				await clickElement(
					handle,
					"target",
					undefined,
					{},
					{
						beforeClick: async point => {
							order.push("decorate");
							expect(point).toEqual(scenario.initialPoint);
							expect(await manager.show(cursorPage as never, point.x, point.y, "instant")).toBe(false);
							top = scenario.movedTop;
							return true;
						},
						beforeDispatch: point => {
							order.push("synchronize");
							expect(point).toEqual(scenario.finalPoint);
						},
					},
				);
				expect(clicks).toEqual([scenario.finalPoint]);
				expect(order).toEqual(["scroll", "decorate", "scroll", "synchronize", "click"]);
			} finally {
				for (const [key, descriptor] of prior) {
					if (descriptor) Object.defineProperty(globalThis, key, descriptor);
					else Reflect.deleteProperty(globalThis, key);
				}
			}
		}
	});
});
