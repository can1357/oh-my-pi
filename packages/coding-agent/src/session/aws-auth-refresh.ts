/**
 * Bedrock AWS SSO renewal. When credential resolution fails because the SSO
 * sign-in lapsed (the refresh grant outlived the IAM Identity Center session),
 * `resolveAwsCredentials` asks the host to renew it; this signs that session in
 * again with `loginAwsSso`, after which the request retries.
 *
 * Installed on the main thread by `runRootCommand`; subagent workers forward
 * their requests to main's `requestAwsAuthRefresh` (`thread/services/aws-auth-refresh.ts`),
 * so one sign-in per SSO session covers every thread. The sign-in only starts
 * where its URL can reach the user: the interactive TUI, print mode and RPC
 * install a {@link setAwsAuthRefreshPresenter}; ACP installs none and keeps the
 * plain error. `providers.amazon-bedrock.ssoSignIn: false` turns it off.
 */
import type { AwsSsoSession } from "@oh-my-pi/pi-ai/error";
import type { OAuthController } from "@oh-my-pi/pi-ai/oauth/types";
import type { AwsAuthRefreshOutcome, AwsAuthRefreshRequest } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import { loginAwsSso } from "@oh-my-pi/pi-ai/providers/aws-sso-login";
import { isSsh } from "@oh-my-pi/pi-tui/driver/mux/detect";
import { logger } from "@oh-my-pi/pi-utils";
import { effect } from "../config/registry";
import { cfgProvidersBedrockSsoSignIn } from "./settings";

/** Live view of one sign-in: the verification URL, progress, and the outcome. */
export interface AwsAuthRefreshView extends Required<Pick<OAuthController, "onAuth">> {
	onProgress?(message: string): void;
	/** `error` is set when the sign-in failed or was cancelled. */
	finish(error?: string): void;
}

/** Opens a view when a sign-in starts. */
export type AwsAuthRefreshPresenter = (sso: AwsSsoSession) => AwsAuthRefreshView;

let presenter: AwsAuthRefreshPresenter | undefined;
let enabled = true;
effect(cfgProvidersBedrockSsoSignIn, value => {
	enabled = value;
});

/** Install (or clear) the UI that shows the sign-in; without one no sign-in starts. */
export function setAwsAuthRefreshPresenter(next: AwsAuthRefreshPresenter | undefined): void {
	presenter = next;
}

/** `AwsAuthRefreshHandler`: sign the failed session in again. */
export async function runAwsAuthRefresh(
	request: AwsAuthRefreshRequest,
	signal: AbortSignal,
): Promise<AwsAuthRefreshOutcome> {
	const present = presenter;
	if (!enabled || !present) return { refreshed: false };
	const { sso } = request;
	logger.info("aws-auth-refresh: signing in to AWS SSO", { startUrl: sso.startUrl, session: sso.sessionName });
	const view = present(sso);
	try {
		await loginAwsSso(
			sso,
			{ onAuth: info => view.onAuth(info), onProgress: message => view.onProgress?.(message), signal },
			// A loopback redirect only reaches omp when the browser runs on this machine.
			{ remote: isSsh(process.env) },
		);
	} catch (error) {
		const detail = signal.aborted ? "cancelled" : error instanceof Error ? error.message : String(error);
		logger.warn("aws-auth-refresh: AWS SSO sign-in failed", { startUrl: sso.startUrl, error: detail });
		view.finish(detail);
		throw error;
	}
	view.finish();
	return { refreshed: true };
}
