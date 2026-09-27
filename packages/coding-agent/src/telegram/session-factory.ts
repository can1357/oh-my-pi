/**
 * Per-topic session factory: each request clones the launch settings for the
 * topic's cwd and mints an in-process `AgentSession` through the SDK — the
 * replacement for the lifeos bridge spawning `omp --mode rpc-ui` children.
 *
 * Launch-level options are reused, but every field that belongs to the
 * *interactive* session (its manager, buses, preloaded extensions, UI flags,
 * agent id) is dropped: reusing them would route a topic session's tools and
 * events back through the TUI session. The drop is a destructuring, not a
 * delete-list of string keys, so renaming one of these fields in
 * `CreateAgentSessionOptions` is a compile error instead of a silent leak.
 */
import { SessionManager } from "../session/session-manager";
import { createAgentSession, type CreateAgentSessionOptions } from "../sdk";
import { EventBus } from "../utils/event-bus";
import type { TelegramSessionFactory, TelegramSessionFactoryOptions, TelegramSessionHandle } from "./types";

function withoutInteractiveSessionOptions(base: CreateAgentSessionOptions): CreateAgentSessionOptions {
	const {
		sessionManager: _sessionManager,
		eventBus: _eventBus,
		subagentEventBus: _subagentEventBus,
		preloadedExtensions: _preloadedExtensions,
		preloadedPreparedExtensions: _preloadedPreparedExtensions,
		extensions: _extensions,
		settingsApproval: _settingsApproval,
		agentId: _agentId,
		hasUI: _hasUI,
		...launchOptions
	} = base;
	return launchOptions;
}

export function createTelegramSessionFactory(options: TelegramSessionFactoryOptions): TelegramSessionFactory {
	const createSession = options.createSession ?? createAgentSession;
	const base = withoutInteractiveSessionOptions(options.baseOptions);

	return async (request): Promise<TelegramSessionHandle> => {
		const settings = await options.settings.cloneForCwd(request.cwd);
		const sessionManager =
			request.sessionFile === undefined
				? SessionManager.create(request.cwd)
				: await SessionManager.open(request.sessionFile);
		const agentId = `telegram:${sessionManager.getSessionId()}`;
		// The model selector applies to fresh sessions only: a resumed session
		// carries its own model in the header.
		const modelPattern = request.sessionFile === undefined ? request.model : undefined;
		const created = await createSession({
			...base,
			cwd: request.cwd,
			settings,
			authStorage: options.authStorage,
			modelRegistry: options.modelRegistry,
			sessionManager,
			agentId,
			hasUI: false,
			interactivePrompts: true,
			bindProcessState: options.bindProcessState,
			presenceKind: "telegram",
			eventBus: new EventBus(),
			// `telegram.model` replaces the launch model (`--model`) for new topic sessions.
			...(modelPattern === undefined || modelPattern === "" ? {} : { model: undefined, modelPattern }),
		});
		return { session: created.session, setToolUIContext: created.setToolUIContext };
	};
}
