/**
 * Contract: the AgentKind capability taxonomy — the single source of truth for the
 * class differences callers care about (peer vs local-session vs local-presence).
 * Locks each kind's membership so changing a predicate, or adding a kind, is a
 * deliberate, tested decision rather than a silently-leaking denylist.
 */
import { describe, expect, it } from "bun:test";
import {
	type AgentKind,
	hasLocalPresence,
	isLocalSession,
	isMessageablePeer,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

const KINDS: AgentKind[] = ["main", "sub", "advisor", "remote"];

describe("AgentKind capability taxonomy", () => {
	it("isMessageablePeer — roster + broadcast peers are everything but advisor", () => {
		expect(KINDS.filter(isMessageablePeer)).toEqual(["main", "sub", "remote"]);
	});

	it("isLocalSession — locally-managed sessions are main | sub only", () => {
		expect(KINDS.filter(isLocalSession)).toEqual(["main", "sub"]);
	});

	it("hasLocalPresence — a local session or transcript excludes only remote proxies", () => {
		expect(KINDS.filter(hasLocalPresence)).toEqual(["main", "sub", "advisor"]);
	});

	it("remote is a peer but neither a local session nor locally present", () => {
		expect(isMessageablePeer("remote")).toBe(true);
		expect(isLocalSession("remote")).toBe(false);
		expect(hasLocalPresence("remote")).toBe(false);
	});

	it("advisor is locally present (read-only) but never a peer or a managed session", () => {
		expect(isMessageablePeer("advisor")).toBe(false);
		expect(isLocalSession("advisor")).toBe(false);
		expect(hasLocalPresence("advisor")).toBe(true);
	});
});
