import { getTeamClient } from "../thread/services/team-client";
import type { ToolSession } from "../tools";
import type {
	InternalResource,
	InternalUrl,
	InternalWriteResult,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	WriteContext,
} from "./types";

function parseTarget(url: InternalUrl): { team: string; id?: string; action?: "claim" | "release" | "done" } {
	const team = url.rawHost;
	const pathname = url.rawPathname ?? url.pathname;
	const match = /^\/tasks(?:\/([1-9][0-9]*)\/(claim|release|done))?$/.exec(pathname);
	if (!team || !match || url.search || url.hash) throw new Error("Invalid team task URL");
	return { team, id: match[1], action: match[2] as "claim" | "release" | "done" | undefined };
}

async function caller(session: ToolSession | undefined, team: string) {
	const key = session?.getSessionInstanceKey?.();
	if (!key) throw new Error("team:// requires a registered caller session");
	const client = getTeamClient();
	const identity = session?.teamIdentity ?? (await client.leadIdentity(key, team));
	if (!identity || identity.team !== team) throw new Error("Caller is not a member of this team");
	return { client, key, identity };
}

export class TeamProtocolHandler implements ProtocolHandler {
	readonly scheme = "team";
	readonly spec: SchemeSpec = {
		backing: "virtual",
		selectors: "lines",
		immutable: true,
		singleSlashAlias: true,
		write: { via: "handler", payload: "verbatim", scope: "coordination", tier: () => "write" },
	};

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const target = parseTarget(url);
		if (target.id) throw new Error("Only team task lists can be read");
		const { client, key, identity } = await caller(context?.session, target.team);
		const content = JSON.stringify(await client.readTasks(key, identity), null, 2);
		return { url: url.href, content, contentType: "application/json" };
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		const target = parseTarget(url);
		const { client, key, identity } = await caller(context?.session, target.team);
		let result: unknown;
		if (!target.id) result = await client.addTask(key, identity, content);
		else if (target.action === "claim") {
			const claim = await client.claim(key, identity, target.id);
			if (claim.kind === "conflict") throw new Error(`Task ${target.id} is owned by ${claim.owner}`);
			result = claim;
		} else if (target.action === "release") result = await client.releaseTask(key, identity, target.id);
		else result = await client.completeTask(key, identity, target.id, content);
		return { content: [{ type: "text", text: JSON.stringify(result) }] };
	}
}
