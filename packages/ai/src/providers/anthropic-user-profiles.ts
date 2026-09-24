import { type } from "@oh-my-pi/omptype";
import { AnthropicHttpClient, type AnthropicClientOptions, type AnthropicRequestOptions } from "./anthropic-client";

const USER_PROFILES_BETA = "user-profiles-2026-09-04";

/** Types use Anthropic's snake_case wire names so request and response bodies are unchanged. */
export type UserProfileAccessType = "application" | "passthrough";
export type UserProfileAccountStatus = "active" | "suspended" | "blocked";
export type UserProfileEntityType = "individual" | "business" | "non_profit" | "government";

export interface UserProfileExternalUserDetailsParams {
	account_status?: UserProfileAccountStatus | null;
	country?: string | null;
	email_hash?: string | null;
	entity_type?: UserProfileEntityType | null;
	name_hash?: string | null;
	onboarded_at?: string;
	reference_id?: string | null;
}

export interface UserProfileExternalUserDetails {
	account_status: UserProfileAccountStatus | null;
	country: string | null;
	email_hash: string | null;
	entity_type: UserProfileEntityType | null;
	name_hash: string | null;
	onboarded_at: string | null;
	reference_id: string | null;
}

/** Update accepts only supplied, non-null detail values; existing values cannot be cleared. */
export type UserProfileExternalUserDetailsUpdateParams = {
	[K in keyof UserProfileExternalUserDetails]?: NonNullable<UserProfileExternalUserDetails[K]>;
};

export interface UserProfile {
	type: "user_profile";
	id: string;
	created_at: string;
	updated_at: string;
	metadata: Record<string, string>;
	trust_grants: Record<string, { status: "active" | "pending" | "rejected" }>;
	access_type?: UserProfileAccessType;
	external_user_details?: UserProfileExternalUserDetails;
	external_user_onboarded_at?: string | null;
	name?: string | null;
}

export interface CreateUserProfileParams {
	access_type?: UserProfileAccessType;
	external_user_details?: UserProfileExternalUserDetailsParams;
	external_user_onboarded_at?: string;
	metadata?: Record<string, string>;
	name?: string | null;
}

export interface UpdateUserProfileParams {
	access_type?: UserProfileAccessType | null;
	/** Sent fields replace existing values; null is rejected by the 2026-09-04 API. */
	external_user_details?: UserProfileExternalUserDetailsUpdateParams;
	external_user_onboarded_at?: string;
	/** Empty values remove existing metadata keys. */
	metadata?: Record<string, string>;
	name?: string | null;
}

export interface ListUserProfilesParams {
	limit?: number;
	order?: "asc" | "desc";
	order_by?: "created_at" | "name";
	page?: string;
}

export interface UserProfilePage {
	data: UserProfile[];
	next_page: string | null;
}

export interface UserProfileEnrollmentUrl {
	type: "enrollment_url";
	expires_at: string;
	url: string;
}

/** Optional Workspace selection and transport overrides for any profile operation. */
export interface UserProfileRequestOptions extends AnthropicRequestOptions {
	workspaceId?: string;
}

const externalUserDetailsSchema = type({
	account_status: "'active' | 'suspended' | 'blocked' | null",
	country: "string | null",
	email_hash: "string | null",
	entity_type: "'individual' | 'business' | 'non_profit' | 'government' | null",
	name_hash: "string | null",
	onboarded_at: "string | null",
	reference_id: "string | null",
});
const userProfileSchema = type({
	type: "'user_profile'",
	id: "string",
	created_at: "string",
	updated_at: "string",
	metadata: { "[string]": "string" },
	trust_grants: { "[string]": { status: "'active' | 'pending' | 'rejected'" } },
	"access_type?": "'application' | 'passthrough'",
	"external_user_details?": externalUserDetailsSchema,
	"external_user_onboarded_at?": "string | null",
	"name?": "string | null",
});
const userProfilePageSchema = type({ data: userProfileSchema.array(), next_page: "string | null" });
const enrollmentUrlSchema = type({ type: "'enrollment_url'", expires_at: "string", url: "string" });

/** Beta User Profiles REST API. Uses the same authentication, retries and errors as Messages. */
export class AnthropicUserProfilesClient {
	#http: AnthropicHttpClient;

	constructor(options: AnthropicClientOptions) {
		this.#http = new AnthropicHttpClient(options);
	}

	async #request<T>(
		method: "GET" | "POST",
		path: string,
		params: unknown,
		parse: (value: unknown) => T | type.errors,
		options?: UserProfileRequestOptions,
	): Promise<T> {
		const requestHeaders = new Headers(options?.headers);
		requestHeaders.set("anthropic-version", "2023-06-01");
		requestHeaders.set("anthropic-beta", USER_PROFILES_BETA);
		if (params !== undefined) requestHeaders.set("content-type", "application/json");
		if (options?.workspaceId) requestHeaders.set("anthropic-workspace-id", options.workspaceId);
		const headers: Record<string, string> = {};
		requestHeaders.forEach((value, key) => {
			headers[key] = value;
		});
		const response = await this.#http.request(method, path, params, { ...options, headers });
		const parsed = parse(await response.json());
		if (parsed instanceof type.errors) throw new Error(`Invalid Anthropic user profile response: ${parsed.summary}`);
		return parsed;
	}

	createUserProfile(params: CreateUserProfileParams = {}, options?: UserProfileRequestOptions): Promise<UserProfile> {
		return this.#request("POST", "/v1/user_profiles", params, userProfileSchema, options);
	}

	listUserProfiles(
		params: ListUserProfilesParams = {},
		options?: UserProfileRequestOptions,
	): Promise<UserProfilePage> {
		const query = new URLSearchParams();
		if (params.limit !== undefined) query.set("limit", String(params.limit));
		if (params.order !== undefined) query.set("order", params.order);
		if (params.order_by !== undefined) query.set("order_by", params.order_by);
		if (params.page !== undefined) query.set("page", params.page);
		const suffix = query.size ? `?${query}` : "";
		return this.#request("GET", `/v1/user_profiles${suffix}`, undefined, userProfilePageSchema, options);
	}

	/** Fetch all pages in cursor order, without buffering the complete list. */
	async *iterateUserProfilePages(
		params: ListUserProfilesParams = {},
		options?: UserProfileRequestOptions,
	): AsyncGenerator<UserProfilePage> {
		let page = params.page;
		do {
			const result = await this.listUserProfiles({ ...params, page }, options);
			yield result;
			page = result.next_page ?? undefined;
		} while (page !== undefined);
	}

	getUserProfile(id: string, options?: UserProfileRequestOptions): Promise<UserProfile> {
		return this.#request("GET", `/v1/user_profiles/${encodeURIComponent(id)}`, undefined, userProfileSchema, options);
	}

	updateUserProfile(
		id: string,
		params: UpdateUserProfileParams,
		options?: UserProfileRequestOptions,
	): Promise<UserProfile> {
		return this.#request("POST", `/v1/user_profiles/${encodeURIComponent(id)}`, params, userProfileSchema, options);
	}

	createEnrollmentUrl(id: string, options?: UserProfileRequestOptions): Promise<UserProfileEnrollmentUrl> {
		return this.#request(
			"POST",
			`/v1/user_profiles/${encodeURIComponent(id)}/enrollment_url`,
			undefined,
			enrollmentUrlSchema,
			options,
		);
	}
}
