/**
 * Hook loader - loads TypeScript hook modules using native Bun import.
 */
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import * as zod from "@oh-my-pi/omptype/zod";
import { logger } from "@oh-my-pi/pi-utils";
import { hookCapability } from "../../capability/hook";
import type { Hook } from "../../discovery";
import { loadCapability } from "../../discovery";
// Runtime self-reference: dereference this namespace only inside loader functions to keep the index.ts cycle safe.
import * as PiCodingAgent from "../../index";
import type { CustomMessagePayload } from "../../session/messages";
import * as typebox from "../legacy-typebox";
import { resolvePath, withHostGuard } from "../utils";
import { execCommand } from "./runner";
import type { ExecOptions, HookAPI, HookFactory, HookMessageRenderer, RegisteredCommand } from "./types";

/**
 * Generic handler function type.
 */
type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Send message handler type for pi.sendMessage().
 */
export type SendMessageHandler = <T = unknown>(
	message: CustomMessagePayload<T>,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
) => void;

/**
 * Append entry handler type for pi.appendEntry().
 */
export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

// Session-lifecycle handler types live once in session-handler-types; re-exported
// here because hooks/runner.ts imports them from this module.
export type { BranchHandler, NavigateTreeHandler, NewSessionHandler } from "../session-handler-types";

/**
 * Registered handlers for a loaded hook.
 */
export interface LoadedHook {
	/** Original path from config */
	path: string;
	/** Resolved absolute path */
	resolvedPath: string;
	/** Map of event type to handler functions */
	handlers: Map<string, HandlerFn[]>;
	/** Map of customType to hook message renderer */
	messageRenderers: Map<string, HookMessageRenderer>;
	/** Map of command name to registered command */
	commands: Map<string, RegisteredCommand>;
	/** Set the send message handler for this hook's pi.sendMessage() */
	setSendMessageHandler: (handler: SendMessageHandler) => void;
	/** Set the append entry handler for this hook's pi.appendEntry() */
	setAppendEntryHandler: (handler: AppendEntryHandler) => void;
}

/**
 * Result of loading hooks.
 */
export interface LoadHooksResult {
	/** Successfully loaded hooks */
	hooks: LoadedHook[];
	/** Errors encountered during loading */
	errors: Array<{ path: string; error: string }>;
}

/**
 * Create a HookAPI instance that collects handlers, renderers, and commands.
 * Returns the API, maps, and functions to set handlers later.
 */
async function createHookAPI(
	handlers: Map<string, HandlerFn[]>,
	cwd: string,
): Promise<{
	api: HookAPI;
	messageRenderers: Map<string, HookMessageRenderer>;
	commands: Map<string, RegisteredCommand>;
	setSendMessageHandler: (handler: SendMessageHandler) => void;
	setAppendEntryHandler: (handler: AppendEntryHandler) => void;
}> {
	let sendMessageHandler: SendMessageHandler | null = null;
	let appendEntryHandler: AppendEntryHandler | null = null;
	const messageRenderers = new Map<string, HookMessageRenderer>();
	const commands = new Map<string, RegisteredCommand>();

	// Cast to HookAPI - the implementation is more general (string event names)
	// but the interface has specific overloads for type safety in hooks
	const api = {
		on(event: string, handler: HandlerFn): void {
			if (!handlers.has(event)) {
				handlers.set(event, []);
			}
			handlers.get(event)!.push(handler);
		},
		sendMessage<T = unknown>(
			message: CustomMessagePayload<T>,
			options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
		): void {
			if (!sendMessageHandler) {
				throw new Error("sendMessage handler not initialized");
			}
			sendMessageHandler(message, options);
		},
		appendEntry<T = unknown>(customType: string, data?: T): void {
			if (!appendEntryHandler) {
				throw new Error("appendEntry handler not initialized");
			}
			appendEntryHandler(customType, data);
		},
		registerMessageRenderer<T = unknown>(customType: string, renderer: HookMessageRenderer<T>): void {
			messageRenderers.set(customType, renderer as HookMessageRenderer);
		},
		registerCommand(name: string, options: { description?: string; handler: RegisteredCommand["handler"] }): void {
			commands.set(name, { name, ...options });
		},
		exec(command: string, args: string[], options?: ExecOptions) {
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},
		logger,
		typebox,
		arktype: type,
		zod,
		pi: PiCodingAgent,
	} as HookAPI;

	return {
		api,
		messageRenderers,
		commands,
		setSendMessageHandler: (handler: SendMessageHandler) => {
			sendMessageHandler = handler;
		},
		setAppendEntryHandler: (handler: AppendEntryHandler) => {
			appendEntryHandler = handler;
		},
	};
}

/**
 * Load a single hook module using native Bun import.
 */
async function loadHook(hookPath: string, cwd: string): Promise<{ hook: LoadedHook | null; error: string | null }> {
	const resolvedPath = resolvePath(hookPath, cwd);

	try {
		// Import the module using native Bun import
		const module = await withHostGuard(() => import(resolvedPath));
		const factory = module.default as HookFactory;

		if (typeof factory !== "function") {
			return { hook: null, error: "Hook must export a default function" };
		}

		// Create handlers map and API
		const handlers = new Map<string, HandlerFn[]>();
		const { api, messageRenderers, commands, setSendMessageHandler, setAppendEntryHandler } = await createHookAPI(
			handlers,
			cwd,
		);

		// Call factory to register handlers
		await withHostGuard(async () => factory(api));

		return {
			hook: {
				path: hookPath,
				resolvedPath,
				handlers,
				messageRenderers,
				commands,
				setSendMessageHandler,
				setAppendEntryHandler,
			},
			error: null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { hook: null, error: `Failed to load hook: ${message}` };
	}
}

/**
 * Load all hooks from configuration.
 * @param paths - Array of hook file paths
 * @param cwd - Current working directory for resolving relative paths
 */
export async function loadHooks(paths: string[], cwd: string): Promise<LoadHooksResult> {
	const hooks: LoadedHook[] = [];
	const errors: Array<{ path: string; error: string }> = [];

	for (const hookPath of paths) {
		const { hook, error } = await loadHook(hookPath, cwd);

		if (error) {
			errors.push({ path: hookPath, error });
			continue;
		}

		if (hook) {
			hooks.push(hook);
		}
	}

	return { hooks, errors };
}

/**
 * Discover and load hooks from all registered providers.
 * Uses the capability API to discover hook paths from:
 * 1. OMP native configs (.omp/.pi hooks/)
 * 2. Installed plugins
 * 3. Other editor/IDE configurations
 *
 * Plus any explicitly configured paths from settings.
 */
export async function discoverAndLoadHooks(configuredPaths: string[], cwd: string): Promise<LoadHooksResult> {
	const allPaths: string[] = [];
	const seen = new Set<string>();

	// Helper to add paths without duplicates
	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	// 1. Discover hooks via capability API
	const discovered = await loadCapability<Hook>(hookCapability.id, { cwd });
	addPaths(discovered.items.map(hook => hook.path));

	// 2. Explicitly configured paths (can override/add)
	addPaths(configuredPaths.map(p => resolvePath(p, cwd)));

	return loadHooks(allPaths, cwd);
}
