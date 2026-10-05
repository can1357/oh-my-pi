/**
 * Internal follow-up verification scope for Action Fusion.
 *
 * Fusion wraps a nested, already-approved Bash `execute` in
 * {@link withFollowUpVerification} so Bash can force foreground /
 * noninteractive / isolated-shell execution without a public schema flag.
 * Not part of the Bash tool model.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface FollowUpVerification {
	callId: string;
}

const followUpVerification = new AsyncLocalStorage<FollowUpVerification>();

export function withFollowUpVerification<T>(callId: string, fn: () => T): T {
	return followUpVerification.run({ callId }, fn);
}

export function getFollowUpVerification(): FollowUpVerification | undefined {
	return followUpVerification.getStore();
}
