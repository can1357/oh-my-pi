/**
 * `login` for RPC transports: the provider's browser flow runs against the
 * client's dialogs (open URL, prompt input, notices) instead of a terminal.
 *
 * Shared by the stdio runner and by a terminal-hosted publication that serves
 * the same command on its attach socket.
 */
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import type { PendingExtensionRequest, RpcOutput } from "./rpc-command-surface";
import { requestRpcInput } from "./rpc-dialog-requests";
import type { RpcCommand, RpcExtensionUIRequest, RpcResponse } from "./rpc-types";

export async function loginOverRpc(options: {
	session: Pick<AgentSession, "modelRegistry" | "refreshScopedModels">;
	command: RpcCommand & { type: "login" };
	pendingExtensionRequests: Map<string, PendingExtensionRequest>;
	output: RpcOutput;
	signal?: AbortSignal;
}): Promise<RpcResponse> {
	const { session, command, pendingExtensionRequests, output, signal } = options;
	const knownProvider = getOAuthProviders().find(p => p.id === command.providerId);
	if (!knownProvider) {
		return {
			id: command.id,
			type: "response",
			command: "login",
			success: false,
			error: `Unknown OAuth provider: ${command.providerId}`,
		};
	}
	// Track whether onAuth has fired. Providers that require interactive
	// input before a browser URL cannot be satisfied headlessly; after
	// onAuth, prompt input is the pasted OAuth code/redirect URL path.
	let authEmitted = false;
	try {
		signal?.throwIfAborted();
		await session.modelRegistry.authStorage.oauth.login(command.providerId, {
			signal,
			onAuth: info => {
				signal?.throwIfAborted();
				authEmitted = true;
				output({
					type: "extension_ui_request",
					id: Snowflake.next() as string,
					method: "open_url",
					url: info.url,
					launchUrl: info.launchUrl,
					instructions: info.instructions,
				} as RpcExtensionUIRequest);
			},
			onProgress: message => {
				signal?.throwIfAborted();
				output({
					type: "extension_ui_request",
					id: Snowflake.next() as string,
					method: "notify",
					message,
					notifyType: "info",
				} as RpcExtensionUIRequest);
			},
			onPrompt: async prompt => {
				signal?.throwIfAborted();
				if (prompt.secret) {
					throw new Error(
						`Provider '${command.providerId}' requires secret input, ` +
							"which is not supported in RPC mode. Use the terminal UI to log in.",
					);
				}
				if (!authEmitted) {
					// onPrompt called before any auth URL — provider requires
					// interactive input that cannot be satisfied headlessly.
					return Promise.reject(
						new Error(
							`Provider '${command.providerId}' requires interactive prompts ` +
								"which are not supported in RPC mode. Use the terminal UI to log in.",
						),
					);
				}
				const value = await requestRpcInput(pendingExtensionRequests, output, prompt.message, prompt.placeholder, {
					timeout: 600_000,
					signal,
				});
				signal?.throwIfAborted();
				return value ?? "";
			},
		});
		signal?.throwIfAborted();
		// Provider-scoped online refresh so the just-persisted credential
		// re-runs discovery instead of reusing a fresh authoritative cache
		// row (#5780).
		await session.modelRegistry.refreshProvider(knownProvider.storeCredentialsAs ?? knownProvider.id, "online");
		await session.refreshScopedModels();
		return {
			id: command.id,
			type: "response",
			command: "login",
			success: true,
			data: { providerId: command.providerId },
		};
	} catch (err: unknown) {
		return {
			id: command.id,
			type: "response",
			command: "login",
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
