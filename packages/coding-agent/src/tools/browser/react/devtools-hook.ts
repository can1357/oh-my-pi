import { untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Page } from "puppeteer-core";

/** Result returned after enabling React introspection and reloading the page. */
export interface ReactEnableResult {
	installed: boolean;
	reactVersion?: string;
}

/** Error message shared by React helpers when their required hook is absent. */
export const REACT_HOOK_REQUIRED_MESSAGE = "React DevTools hook not installed — call tab.reactEnable() first";

/** Result shape every page-side React helper returns before `requireReactHookResult` unwraps it. */
export interface ReactPageEnvelope<T> {
	missingHook?: boolean;
	notFound?: boolean;
	value?: T;
}

/** Page expression installing the minimal React DevTools hook; safe to run at document start or on a live page. */
export const REACT_HOOK_INIT_SOURCE = `(() => {
	const existing = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
	if (existing && existing.__ompReact) return true;
	const renderers = new Map();
	const roots = new Map();
	const fiberIds = new WeakMap();
	const fibersById = new Map();
	const dynamicSuspenseIds = new Set();
	let nextRendererId = 1;
	let nextFiberId = 1;
	const recording = { active: false, commits: 0, components: new Map() };

	const fiberName = fiber => {
		if (!fiber) return null;
		const type = fiber.type || fiber.elementType;
		if (typeof type === "string") return type;
		if (typeof type === "function") return type.displayName || type.name || "Anonymous";
		if (type && typeof type === "object") {
			const inner = type.type || type.render;
			return type.displayName || (inner && (inner.displayName || inner.name)) || null;
		}
		if (fiber.tag === 13) return "Suspense";
		if (fiber.tag === 7) return "Fragment";
		return null;
	};
	const fiberType = fiber => {
		switch (fiber.tag) {
			case 0:
			case 2:
				return "function";
			case 1:
				return "class";
			case 5:
			case 6:
				return "host";
			case 7:
				return "fragment";
			case 8:
				return "mode";
			case 9:
				return "consumer";
			case 10:
				return "provider";
			case 11:
				return "forwardRef";
			case 12:
				return "profiler";
			case 13:
				return "suspense";
			case 14:
			case 15:
				return "memo";
			case 16:
				return "lazy";
			case 19:
				return "suspense-list";
			case 22:
			case 23:
				return "offscreen";
			default:
				return "other";
		}
	};
	const getFiberId = fiber => {
		let id = fiberIds.get(fiber);
		if (id === undefined && fiber.alternate) id = fiberIds.get(fiber.alternate);
		if (id === undefined) id = nextFiberId++;
		fiberIds.set(fiber, id);
		if (fiber.alternate) fiberIds.set(fiber.alternate, id);
		fibersById.set(id, fiber);
		return id;
	};
	const didRender = fiber => {
		const previous = fiber.alternate;
		return (
			!previous ||
			fiber.flags !== 0 ||
			fiber.memoizedProps !== previous.memoizedProps ||
			fiber.memoizedState !== previous.memoizedState
		);
	};
	const walkCommit = rootFiber => {
		const stack = rootFiber ? [rootFiber] : [];
		while (stack.length > 0) {
			const fiber = stack.pop();
			const id = getFiberId(fiber);
			if (fiber.tag === 13 && fiber.memoizedState != null) dynamicSuspenseIds.add(id);
			if (recording.active && didRender(fiber)) {
				const kind = fiberType(fiber);
				const name = fiberName(fiber);
				if (name && kind !== "host" && kind !== "fragment" && kind !== "mode" && kind !== "offscreen") {
					const previous = recording.components.get(name) || { name, renders: 0, totalMs: 0 };
					previous.renders += 1;
					previous.totalMs += typeof fiber.actualDuration === "number" ? fiber.actualDuration : 0;
					recording.components.set(name, previous);
				}
			}
			if (fiber.sibling) stack.push(fiber.sibling);
			if (fiber.child) stack.push(fiber.child);
		}
	};
	const hook = {
		supportsFiber: true,
		renderers,
		inject(renderer) {
			const id = nextRendererId++;
			renderers.set(id, renderer);
			roots.set(id, new Set());
			return id;
		},
		getFiberRoots(rendererId) {
			let rendererRoots = roots.get(rendererId);
			if (!rendererRoots) {
				rendererRoots = new Set();
				roots.set(rendererId, rendererRoots);
			}
			return rendererRoots;
		},
		onCommitFiberRoot(rendererId, root) {
			this.getFiberRoots(rendererId).add(root);
			walkCommit(root && root.current);
			if (recording.active) recording.commits += 1;
			const vitals = globalThis.__ompBrowserVitals;
			if (vitals && !vitals.hydration) vitals.hydration = { framework: "React", hydratedAt: performance.now() };
		},
		onCommitFiberUnmount(_rendererId, fiber) {
			const id = fiberIds.get(fiber);
			if (id !== undefined) fibersById.delete(id);
		},
	};
	Object.defineProperty(hook, "__ompReact", {
		value: {
			roots,
			fiberIds,
			fibersById,
			dynamicSuspenseIds,
			recording,
			fiberName,
			fiberType,
			getFiberId,
		},
	});
	try {
		Object.defineProperty(globalThis, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
			value: hook,
			configurable: true,
		});
	} catch {
		globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
	}
	return true;
})()`;

/** Page expression reporting whether the hook is installed and the first renderer's React version (`ReactEnableResult`). */
export const REACT_ENABLE_READ_SOURCE = `(() => {
	const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
	if (!hook || !hook.__ompReact) return { installed: false };
	let reactVersion;
	for (const renderer of hook.renderers.values()) {
		if (renderer && typeof renderer.version === "string") {
			reactVersion = renderer.version;
			break;
		}
	}
	return { installed: true, reactVersion };
})()`;

/** Backend-neutral page access used by the React and Web Vitals helpers. */
export interface ReactPageHost {
	/** Evaluate an expression source in the main frame's page world, awaiting a returned promise. */
	evaluate(source: string, signal?: AbortSignal): Promise<unknown>;
	/** Register an expression source to run at document start of every future document. */
	addInitSource(source: string, signal?: AbortSignal): Promise<void>;
	/** Reload the current document and wait for its load event. */
	reload(signal?: AbortSignal): Promise<void>;
}

/** `ReactPageHost` over a Puppeteer page's main frame. */
export function puppeteerReactHost(page: Page): ReactPageHost {
	return {
		evaluate: (source, signal) => untilAborted(signal, () => page.mainFrame().mainRealm().evaluate(source)),
		async addInitSource(source, signal) {
			await untilAborted(signal, () => page.evaluateOnNewDocument(source));
		},
		async reload(signal) {
			await untilAborted(signal, () => page.reload({ waitUntil: "load" }));
		},
	};
}

/** Enable the minimal React DevTools hook before reloading the current page. */
export async function enableReact(host: ReactPageHost, signal?: AbortSignal): Promise<ReactEnableResult> {
	await host.addInitSource(REACT_HOOK_INIT_SOURCE, signal);
	await host.evaluate(REACT_HOOK_INIT_SOURCE, signal);
	await host.reload(signal);
	const result = (await host.evaluate(REACT_ENABLE_READ_SOURCE, signal)) as ReactEnableResult;
	if (!result.installed) throw new ToolError("Unable to install the React DevTools hook in this document");
	return result;
}

/** Unwrap a page-side React helper result or throw the shared missing-hook error. */
export function requireReactHookResult<T>(result: ReactPageEnvelope<T>): T {
	if (result.missingHook || result.value === undefined) throw new ToolError(REACT_HOOK_REQUIRED_MESSAGE);
	return result.value;
}
