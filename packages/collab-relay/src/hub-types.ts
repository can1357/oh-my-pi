/**
 * Hub relay binding contracts — abstracted from R2/KV so the service can be
 * unit-tested against in-memory stores.
 */

export interface HubStoredObject {
	readonly key: string;
	readonly uploaded: Date;
}

export interface HubStoredValue {
	readonly accountId: string;
	readonly hubId: string;
	readonly deviceId: string;
	readonly displayName: string;
	readonly title: string;
	readonly sealed: Uint8Array;
	readonly entryCount: number;
	readonly uploaded: Date;
}

export interface HubBucketBinding {
	get(key: string): Promise<HubStoredValue | null>;
	put(key: string, value: HubStoredValue): Promise<unknown>;
	delete(keys: string | string[]): Promise<void>;
	list(options: {
		prefix: string;
		limit: number;
		cursor?: string;
	}): Promise<{ objects: HubStoredObject[]; truncated: boolean; cursor?: string }>;
}

export interface HubAccessToken {
	readonly accountId: string;
	readonly displayName: string;
	readonly createdAt: string;
}

export interface HubTokenBinding {
	get(token: string): Promise<HubAccessToken | null>;
	put(token: string, value: HubAccessToken): Promise<void>;
}

export interface HubServiceDependencies {
	readonly hubs: HubBucketBinding;
	readonly tokens: HubTokenBinding;
	readonly claimUpload: (request: Request) => Promise<Response | null>;
	/** Worker secret (`HUB_ADMIN_TOKEN`) used only to mint account access tokens. */
	readonly adminToken?: string;
	readonly now?: () => number;
}
