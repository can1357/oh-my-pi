/**
 * Bedrock AWS SSO renewal bridged into subagent workers. A worker's lapsed SSO
 * sign-in goes through main's `requestAwsAuthRefresh`, which owns the one
 * flight per SSO session shared by main and every worker, and runs main's
 * registered handler (none: the worker keeps the plain error). The renewed
 * token reaches every thread through `~/.aws/sso/cache`.
 */
import {
	type AwsAuthRefreshOutcome,
	type AwsAuthRefreshRequest,
	requestAwsAuthRefresh,
	setAwsAuthRefreshHandler,
} from "@oh-my-pi/pi-ai/providers/aws-credentials";
import type { WorkerThreadLink } from "../protocol";
import type { RemoteObject, RpcMethod } from "../rpc";
import type { ThreadService } from "../services";

/** Exported-class kind of the main thread's refresher. */
export const AWS_AUTH_REFRESHER_KIND = "aws-auth-refresher";

/** Methods of the main thread's refresher. */
export type AwsAuthRefresherProtocol = {
	refresh: RpcMethod<[request: AwsAuthRefreshRequest], AwsAuthRefreshOutcome>;
};

/** Main-thread refresher; crosses to workers by reference. */
export class MainAwsAuthRefresher {}

const mainRefresher = new MainAwsAuthRefresher();

/** Worker-side proxy of {@link MainAwsAuthRefresher}. */
export class RemoteAwsAuthRefresher {
	readonly #remote: RemoteObject<AwsAuthRefresherProtocol>;

	constructor(remote: RemoteObject<AwsAuthRefresherProtocol>) {
		this.#remote = remote;
	}

	refresh(request: AwsAuthRefreshRequest): Promise<AwsAuthRefreshOutcome> {
		return this.#remote.call("refresh", request);
	}
}

function isRefresherGlobals(value: unknown): value is { refresher: unknown } {
	return typeof value === "object" && value !== null && "refresher" in value;
}

/** Installs a worker's AWS SSO renewal hook that runs on main. */
export const awsAuthRefreshThreadService: ThreadService = {
	name: "aws-auth-refresh",

	installMain(peer): void {
		peer.link.exportClass<MainAwsAuthRefresher, AwsAuthRefresherProtocol>(
			AWS_AUTH_REFRESHER_KIND,
			(value): value is MainAwsAuthRefresher => value instanceof MainAwsAuthRefresher,
			{ refresh: (_refresher, request) => requestAwsAuthRefresh(request) },
		);
	},

	globals(): { refresher: MainAwsAuthRefresher } {
		return { refresher: mainRefresher };
	},

	installWorker(link: WorkerThreadLink): void {
		link.importClass<RemoteAwsAuthRefresher, AwsAuthRefresherProtocol>(
			AWS_AUTH_REFRESHER_KIND,
			remote => new RemoteAwsAuthRefresher(remote),
		);
	},

	boot(globals: unknown): void {
		if (!isRefresherGlobals(globals) || !(globals.refresher instanceof RemoteAwsAuthRefresher)) {
			throw new Error("aws-auth-refresh service: boot globals lack the main thread's refresher");
		}
		const refresher = globals.refresher;
		setAwsAuthRefreshHandler(request => refresher.refresh(request));
	},
};
