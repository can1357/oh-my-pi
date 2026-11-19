/** Use the socket peer unless the server explicitly trusts its reverse proxy. */
export function resolvePeer(req: Request, socketAddress: string, trustProxyHeaders = false): string {
	if (!trustProxyHeaders) return socketAddress;
	const fwd = req.headers.get("x-forwarded-for");
	if (fwd) return fwd.split(",")[0].trim();
	return req.headers.get("x-real-ip") ?? socketAddress;
}
