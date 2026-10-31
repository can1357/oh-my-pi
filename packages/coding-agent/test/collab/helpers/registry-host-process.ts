/**
 * Standalone Bun process publishing a fixture Collab host until killed.
 * Used by registry-smoke.test.ts for discovery, explicit link retrieval,
 * crash cleanup, and the real CLI path.
 *
 * argv[2]  metadata dir override; empty/absent → default `~/.omp/run/collab-hosts`.
 * argv[3]  URL marker; falls back to OMP_SMOKE_MARKER, then "smoke".
 * argv[4]  instance ID; falls back to OMP_SMOKE_INSTANCE_ID, then "smoke-host".
 *
 * Emits `READY\n` once published. SIGTERM runs postmortem cleanup, which closes
 * the publication, then exits 143 like every omp process.
 */
import { postmortem } from "@oh-my-pi/pi-utils";
import { type CollabHostRegistrySource, publishCollabHost } from "../../../src/collab/registry";

const dirArg = process.argv[2];
const marker = process.argv[3] ?? process.env.OMP_SMOKE_MARKER ?? "smoke";
const instanceId = process.argv[4] ?? process.env.OMP_SMOKE_INSTANCE_ID ?? "smoke-host";
const dir = dirArg && dirArg.length > 0 ? dirArg : undefined;
const startedAt = Date.now();

const source: CollabHostRegistrySource = {
	snapshot: () => ({
		instanceId,
		generation: 1,
		sessionId: `session-${marker}`,
		sessionName: `Smoke ${marker}`,
		cwd: process.cwd(),
		pid: process.pid,
		model: null,
		startedAt,
		participants: 1,
		relayConnected: true,
		inputRequired: false,
		busy: false,
		access: "control",
	}),
	link: access => `https://collab.example/${access}/${marker}`,
};
const publication = await publishCollabHost(source, { dir, instanceId });

// postmortem owns the signal exit and awaits registered cleanups first; a
// separate signal handler would race its exit against the native close.
postmortem.register("collab-smoke-host", () => publication.close());
process.stdout.write("READY\n");

// Stay alive until a signal arrives (or the parent SIGKILLs us).
await Promise.withResolvers<never>().promise;
