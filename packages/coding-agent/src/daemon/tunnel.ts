import type { DaemonClient, DaemonTunnel, OpenRequest } from "./protocol";

/**
 * Open (find-or-start) a module unit and attach a tunnel to it. The lease is
 * given back when the attach fails, so a failed attempt never keeps the unit alive.
 */
export async function openTunnel(
	daemon: Pick<DaemonClient, "open" | "attach" | "release">,
	request: OpenRequest,
	signal?: AbortSignal,
): Promise<{ tunnel: DaemonTunnel; lease: string | undefined }> {
	const opened = await daemon.open(request, signal);
	try {
		return { tunnel: await daemon.attach(opened.unit.id, undefined, signal), lease: opened.lease };
	} catch (error) {
		if (opened.lease) void daemon.release(opened.lease).catch(() => {});
		throw error;
	}
}
