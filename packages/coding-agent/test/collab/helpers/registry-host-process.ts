/**
 * Standalone Bun process that publishes a single fixture Collab host to the
 * local registry and then stays alive until killed. Used by the real
 * two-process smoke test (`registry-smoke.test.ts`) — it is spawned, never
 * imported. It exercises the same public {@link publishCollabHost} entry point
 * a real host uses, so the parent test observes cross-process discovery,
 * mode-scoped URLs, crash cleanup, and the full CLI path end to end.
 *
 * argv[2]  metadata dir override; empty/absent → default `~/.omp/run/collab-hosts`.
 * argv[3]  marker string embedded in the fixture URLs (falls back to
 *          `OMP_SMOKE_MARKER` env, then "smoke").
 *
 * Emits `READY\n` to stdout once publish resolves. SIGTERM closes the
 * publication cleanly and exits 0.
 */
import { publishCollabHost } from "../../../src/collab/registry";

const dirArg = process.argv[2];
const marker = process.argv[3] ?? process.env.OMP_SMOKE_MARKER ?? "smoke";
const dir = dirArg && dirArg.length > 0 ? dirArg : undefined;

const startedAt = Date.now();

const publication = await publishCollabHost(
	mode => ({
		sessionId: `session-${marker}`,
		sessionName: `Smoke ${marker}`,
		cwd: process.cwd(),
		pid: process.pid,
		startedAt,
		participants: 1,
		url: mode === "view" ? `https://collab.example/view/${marker}` : `https://collab.example/write/${marker}`,
	}),
	dir ? { dir } : undefined,
);

const shutdown = (): void => {
	publication.close().then(
		() => process.exit(0),
		() => process.exit(0),
	);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

process.stdout.write("READY\n");

// Stay alive until a signal arrives (or the parent SIGKILLs us).
await new Promise<never>(() => {});
