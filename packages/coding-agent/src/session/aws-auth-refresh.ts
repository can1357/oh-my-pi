/**
 * Bedrock AWS SSO renewal. When credential resolution fails because the SSO
 * sign-in lapsed (the refresh grant outlived the IAM Identity Center session),
 * `resolveAwsCredentials` asks the host to renew it; this runs the
 * operator-configured `providers.amazon-bedrock.authRefreshCommand` (typically
 * `aws sso login --sso-session <name>`), after which the request retries.
 *
 * Installed on the main thread by `runRootCommand`; subagent workers forward
 * their requests to main's `requestAwsAuthRefresh` (`thread/services/aws-auth-refresh.ts`),
 * so one flight per SSO session covers every thread. The command only runs
 * where its output can reach the user (verification URL, device code): the
 * interactive TUI and print mode install a {@link setAwsAuthRefreshPresenter};
 * RPC and ACP install none and keep the plain error.
 */
import type { AwsAuthRefreshOutcome, AwsAuthRefreshRequest } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import { executeShell } from "@oh-my-pi/pi-natives";
import { getProjectDir, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { effect } from "../config/registry";
import { cfgOperatorBedrockAuthRefreshCommand, cfgProvidersBedrockAuthRefreshCommand } from "./settings";

/** `aws sso login` waits for the user to approve in the browser. */
const REFRESH_TIMEOUT_MS = 5 * 60_000;
/** Output kept for the failure message and log. */
const OUTPUT_TAIL_CHARS = 4_000;

/** Live view of one refresh command run. */
export interface AwsAuthRefreshView {
	output(chunk: string): void;
	/** `error` is set when the command failed. */
	finish(error?: string): void;
}

/** Opens a view when a refresh command starts. */
export type AwsAuthRefreshPresenter = (command: string) => AwsAuthRefreshView;

let presenter: AwsAuthRefreshPresenter | undefined;
/** The process's operator-configured command, like other process-wide operator settings. */
let configuredCommand: string | undefined;
effect(cfgOperatorBedrockAuthRefreshCommand, value => {
	configuredCommand = value?.trim() || undefined;
});

/** Install (or clear) the UI that shows refresh command output; without one the command never runs. */
export function setAwsAuthRefreshPresenter(next: AwsAuthRefreshPresenter | undefined): void {
	presenter = next;
}

/** `AwsAuthRefreshHandler` backed by the configured refresh command. */
export async function runAwsAuthRefresh(request: AwsAuthRefreshRequest): Promise<AwsAuthRefreshOutcome> {
	const view = presenter;
	if (!view) return { refreshed: false };
	const command = configuredCommand;
	if (!command) {
		const quoted = `'${request.loginCommand.replaceAll("'", `'\\''`)}'`;
		return {
			refreshed: false,
			hint: `To have omp run it automatically: omp config set ${cfgProvidersBedrockAuthRefreshCommand.id} ${quoted}`,
		};
	}

	logger.info("aws-auth-refresh: running refresh command", { command, profile: request.sso.profile });
	const run = view(command);
	let tail = "";
	let failure: string | undefined;
	try {
		const result = await executeShell(
			{
				command,
				cwd: getProjectDir(),
				timeoutMs: REFRESH_TIMEOUT_MS,
				// A bare `aws sso login` picks the profile from the environment; point
				// it at the profile that holds the SSO settings, not a role on top of it.
				env: { AWS_PROFILE: request.sso.profile },
			},
			(error, chunk) => {
				if (error) return;
				tail = (tail + chunk).slice(-OUTPUT_TAIL_CHARS);
				run.output(chunk);
			},
		);
		if (result.timedOut) {
			failure = `'${command}' timed out after ${REFRESH_TIMEOUT_MS / 60_000} minutes`;
		} else if (result.cancelled || result.exitCode !== 0) {
			const lastLine = sanitizeText(tail).trim().split("\n").at(-1)?.trim();
			failure = `'${command}' exited with code ${result.exitCode ?? "unknown"}${lastLine ? `: ${lastLine}` : ""}`;
		}
	} catch (error) {
		failure = `'${command}' could not run: ${error instanceof Error ? error.message : String(error)}`;
	}
	run.finish(failure);
	if (failure) {
		logger.warn("aws-auth-refresh: refresh command failed", { command, failure, output: tail });
		throw new Error(failure);
	}
	logger.debug("aws-auth-refresh: refresh command succeeded", { command, output: tail });
	return { refreshed: true };
}
