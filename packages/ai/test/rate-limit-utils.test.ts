import { describe, expect, it } from "bun:test";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { classify, Flag, is, isUsageLimit, retriable } from "@oh-my-pi/pi-ai/error/flags";
import {
	calculateRateLimitBackoffMs,
	is402BillingCapBody,
	isConcurrencyCapExclusion,
	isOpaqueStatusBody,
	isUsageLimitOutcome,
	isUsageLimitStatus,
	parseRateLimitReason,
} from "@oh-my-pi/pi-ai/error/rate-limit";

function googleRpc429(reason: string, retryDelay?: string, message = "Resource exhausted"): string {
	const details: Array<Record<string, string>> = [
		{
			"@type": "type.googleapis.com/google.rpc.ErrorInfo",
			reason,
			domain: "cloudcode-pa.googleapis.com",
		},
	];
	if (retryDelay) {
		details.push({
			"@type": "type.googleapis.com/google.rpc.RetryInfo",
			retryDelay,
		});
	}
	return `Cloud Code Assist API error (429): ${JSON.stringify({
		error: {
			code: 429,
			message,
			status: "RESOURCE_EXHAUSTED",
			details,
		},
	})}`;
}

describe("parseRateLimitReason", () => {
	it("classifies Google Quota exceeded as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Cloud Code Assist API error (429): Quota exceeded for aiplatform.googleapis.com"),
		).toBe("QUOTA_EXHAUSTED");
	});

	// ClinePass subscription windows and free-tier caps are account-local quota
	// exhaustion (markers from Cline's own error classifier), not rate limiting.
	it("classifies ClinePass subscription-window limits as QUOTA_EXHAUSTED", () => {
		expect(parseRateLimitReason("clinepass limit reached for this window. please try again later.")).toBe(
			"QUOTA_EXHAUSTED",
		);
	});

	it("classifies Cline free-tier model caps as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("free limit reached on model deepseek/deepseek-v4-flash. try again in 42 minutes"),
		).toBe("QUOTA_EXHAUSTED");
	});

	// "Resource has been exhausted (e.g. check quota)" is a quota/daily-limit error — long wait.
	// Only the literal phrase "resource exhausted" (gRPC status name) is MODEL_CAPACITY.
	it("classifies 'Resource has been exhausted (e.g. check quota)' as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Cloud Code Assist API error (429): Resource has been exhausted (e.g. check quota)."),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies 'resource exhausted' (space phrase) as MODEL_CAPACITY_EXHAUSTED", () => {
		expect(parseRateLimitReason("resource exhausted")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});

	// Connect/gRPC end-streams carry the status name `resource_exhausted` (underscore),
	// not the space phrase. It must classify identically to the space form so the
	// session retry path uses the 45–75s MODEL_CAPACITY backoff instead of the 30-min
	// QUOTA_EXHAUSTED block. Regression for #7032.
	it("classifies bare Connect resource_exhausted as MODEL_CAPACITY_EXHAUSTED", () => {
		expect(parseRateLimitReason("Connect error resource_exhausted: Error")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});

	// parseConnectEndStream repeats the default status phrase in the message body:
	// `Connect error resource_exhausted: resource exhausted`. Both tokens must be
	// stripped so the leftover "exhausted" doesn't trip the generic quota branch.
	it("classifies repeated bare resource-exhausted tokens as MODEL_CAPACITY_EXHAUSTED", () => {
		expect(parseRateLimitReason("Connect error resource_exhausted: resource exhausted")).toBe(
			"MODEL_CAPACITY_EXHAUSTED",
		);
	});

	it("keeps explicit quota details authoritative after resource_exhausted", () => {
		expect(parseRateLimitReason("Connect error resource_exhausted: Quota exceeded for this account")).toBe(
			"QUOTA_EXHAUSTED",
		);
	});

	it("classifies Too many requests as RATE_LIMIT_EXCEEDED", () => {
		expect(parseRateLimitReason("Cloud Code Assist API error (429): Too many requests")).toBe("RATE_LIMIT_EXCEEDED");
	});

	it("classifies per minute errors as RATE_LIMIT_EXCEEDED", () => {
		expect(parseRateLimitReason("Requests per minute limit reached")).toBe("RATE_LIMIT_EXCEEDED");
	});

	it("classifies concurrent request caps separately from rate limits and quota exhaustion", () => {
		expect(parseRateLimitReason("Number of concurrent requests exceeded")).toBe("CONCURRENT_LIMIT");
		expect(parseRateLimitReason("Maximum concurrent invocation limit reached")).toBe("CONCURRENT_LIMIT");
		expect(parseRateLimitReason("concurrent_limit_exceeded")).toBe("CONCURRENT_LIMIT");
		expect(parseRateLimitReason("concurrent_requests_limit_reached")).toBe("CONCURRENT_LIMIT");
		expect(parseRateLimitReason("concurrency_quota_exceeded")).toBe("CONCURRENT_LIMIT");
		expect(parseRateLimitReason("Too many concurrent requests")).toBe("CONCURRENT_LIMIT");
		expect(parseRateLimitReason("Too many concurrent invocations")).toBe("CONCURRENT_LIMIT");
		expect(parseRateLimitReason("Rate limit reached for gpt-4o")).toBe("RATE_LIMIT_EXCEEDED");
		expect(parseRateLimitReason("Your quota will reset at 07-28")).toBe("QUOTA_EXHAUSTED");
	});

	// Deterministic 4xx feature rejections worded with bare concurrency nouns
	// ("concurrent request/invocation is not supported") must not classify as a
	// concurrency cap — doing so would set Flag.Transient and retry the rejection
	// instead of surfacing it. A cap needs an explicit limit/quota/exceeded/reached
	// signal near "concurrent".
	it("does not classify bare concurrency feature rejections as CONCURRENT_LIMIT", () => {
		expect(parseRateLimitReason("Concurrent invocation is not supported")).not.toBe("CONCURRENT_LIMIT");
		expect(parseRateLimitReason("Only one concurrent request is supported")).not.toBe("CONCURRENT_LIMIT");
		// The deterministic rejection must surface as a hard error, not be retried.
		expect(is(classify("Concurrent invocation is not supported"), Flag.Transient)).toBe(false);
	});

	it("classifies overloaded 529 as MODEL_CAPACITY_EXHAUSTED", () => {
		expect(parseRateLimitReason("Service overloaded 529")).toBe("MODEL_CAPACITY_EXHAUSTED");
	});

	it("classifies internal server error as SERVER_ERROR", () => {
		expect(parseRateLimitReason("Internal Server Error (500)")).toBe("SERVER_ERROR");
	});

	it("returns UNKNOWN for unrecognised messages", () => {
		expect(parseRateLimitReason("Something completely unexpected happened")).toBe("UNKNOWN");
	});

	it("classifies Simplified Chinese quota exhaustion as QUOTA_EXHAUSTED", () => {
		// Zhipu Coding Plan returns this exact phrasing (type=1308) when the 5h
		// window is spent. Previously classified UNKNOWN, so the session stayed
		// pinned to the exhausted credential instead of rotating to a sibling key.
		const zhipu =
			"429 已达到 5 小时的使用上限。您的限额将在 2026-08-06 20:06:00 重置。\n已达到 5 小时的使用上限。您的限额将在 2026-08-06 20:06:00 重置。 (type=1308)";
		expect(parseRateLimitReason(zhipu)).toBe("QUOTA_EXHAUSTED");
		expect(parseRateLimitReason("已达到 5 小时的使用上限")).toBe("QUOTA_EXHAUSTED");
		expect(parseRateLimitReason("您的限额将在 2026-08-06 20:06:00 重置")).toBe("QUOTA_EXHAUSTED");
		expect(parseRateLimitReason("今日使用量已达上限，请明天再试")).toBe("QUOTA_EXHAUSTED");
		expect(parseRateLimitReason("额度已用完，请充值")).toBe("QUOTA_EXHAUSTED");
		expect(parseRateLimitReason("配额已用尽")).toBe("QUOTA_EXHAUSTED");
		expect(parseRateLimitReason("额度已耗尽")).toBe("QUOTA_EXHAUSTED");
		expect(parseRateLimitReason("配额用完")).toBe("QUOTA_EXHAUSTED");
		expect(parseRateLimitReason("账户余额不足")).toBe("QUOTA_EXHAUSTED");
	});

	it("keeps Simplified Chinese rate limiting in the transient lane", () => {
		// "速率限制" is a plain throttle, not an account quota cap — must not
		// rotate credentials or classify as QUOTA_EXHAUSTED.
		expect(parseRateLimitReason("429 已达到速率限制")).toBe("UNKNOWN");
		expect(parseRateLimitReason("请求过于频繁，请稍后重试")).toBe("UNKNOWN");
		// "达到…使用上限" requires the 使用 token, so a concurrency/rate cap phrased
		// as "达到…上限" (no 使用) must NOT match — it stays in the upstream-backoff
		// lane instead of burning a credential as a quota exhaustion.
		expect(parseRateLimitReason("并发请求达到上限")).toBe("UNKNOWN");
		expect(parseRateLimitReason("速率达到上限，请稍后重试")).toBe("UNKNOWN");
		// Bare 已达上限 (no 使用 token) is a transient rate/concurrency cap, not a
		// quota — must not rotate. Without this guard it burned a sibling credential.
		expect(parseRateLimitReason("每分钟请求数已达上限，请稍后重试")).toBe("UNKNOWN");
		expect(parseRateLimitReason("并发请求数已达上限，请稍后重试")).toBe("UNKNOWN");
		expect(parseRateLimitReason("API 使用频率已达上限")).toBe("UNKNOWN");
	});

	it("keeps DashScope/Bailian TPM throttle in the transient lane", () => {
		// Bailian reports its per-minute token throttle (429
		// Throttling.AllocationQuota) with OpenAI-compatible billing wording,
		// but links the error-code doc's #token-limit anchor, which documents
		// the error as a transient TPM/TPS cap (clears within the minute
		// window). Must retry on the same credential with a short backoff —
		// previously classified QUOTA_EXHAUSTED, blocking the credential for
		// 30 minutes and stalling the session.
		const throttle =
			"429 You exceeded your current quota, please check your plan and billing details. For details, see: https://help.aliyun.com/zh/model-studio/error-code#token-limit\nYou exceeded your current quota, please check your plan and billing details. For details, see: https://help.aliyun.com/zh/model-studio/error-code#token-limit (type=insufficient_quota param=insufficient_quota)";
		expect(parseRateLimitReason(throttle)).toBe("RATE_LIMIT_EXCEEDED");
		expect(isUsageLimit(throttle)).toBe(false);
		expect(isUsageLimit(Object.assign(new Error(throttle), { status: 429 }))).toBe(false);
		expect(isUsageLimit(new ProviderHttpError(throttle, 429, { code: "insufficient_quota" }))).toBe(false);
		expect(isUsageLimitOutcome(429, throttle)).toBe(false);

		// The identical wording WITHOUT the doc anchor is OpenAI's real
		// account-quota error and stays quota-exhausted.
		const openaiQuota =
			"429 You exceeded your current quota, please check your plan and billing details. For details, see: https://platform.openai.com/account/usage (type=insufficient_quota)";
		expect(parseRateLimitReason(openaiQuota)).toBe("QUOTA_EXHAUSTED");
		expect(isUsageLimitOutcome(429, openaiQuota)).toBe(true);

		// The same DashScope doc anchor also covers permanent free-quota
		// exhaustion. The anchor alone must not turn that into a retry loop.
		const freeQuota =
			"429 Free allocated quota exceeded. For details, see: https://help.aliyun.com/zh/model-studio/error-code#token-limit (type=insufficient_quota)";
		expect(parseRateLimitReason(freeQuota)).toBe("QUOTA_EXHAUSTED");
		expect(isUsageLimit(new ProviderHttpError(freeQuota, 429, { code: "insufficient_quota" }))).toBe(true);
		expect(isUsageLimitOutcome(429, freeQuota)).toBe(true);
	});

	it("classifies Codex usage limit error as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("Codex error event: The usage limit has been reached (code=usage_limit_reached)"),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies account rate limits as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason(
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
			),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies Anthropic monthly spend limits as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason(
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s monthly spend limit. Please try again later."}}',
			),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies OpenCode Go insufficient balance as QUOTA_EXHAUSTED", () => {
		expect(
			parseRateLimitReason("401 Insufficient balance. Manage your billing here: https://opencode.ai/workspace/demo"),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("classifies Antigravity capacity-exhausted as QUOTA_EXHAUSTED, not transient MODEL_CAPACITY", () => {
		// Antigravity returns "You have exhausted your capacity on this model. Your
		// quota will reset after 3h6m38s." The literal "capacity" used to win the
		// classifier race and land in MODEL_CAPACITY_EXHAUSTED (45-75s backoff),
		// blocking the agent from rotating to another OAuth account even though the
		// "quota will reset" suffix is the long-wait, switch-account signal.
		expect(
			parseRateLimitReason(
				"Cloud Code Assist API error (429): You have exhausted your capacity on this model. Your quota will reset after 3h6m38s.",
			),
		).toBe("QUOTA_EXHAUSTED");
	});

	it("uses structured QUOTA_EXHAUSTED before capacity message heuristics", () => {
		const body = googleRpc429(
			"QUOTA_EXHAUSTED",
			"21600s",
			"The model has no capacity available; retry another request later.",
		);
		expect(parseRateLimitReason(body)).toBe("QUOTA_EXHAUSTED");
		expect(isUsageLimitOutcome(429, body)).toBe(true);
	});

	it("keeps structured RATE_LIMIT_EXCEEDED with a 30s delay transient", () => {
		const body = googleRpc429("RATE_LIMIT_EXCEEDED", "30s", "Too many requests");
		expect(parseRateLimitReason(body)).toBe("RATE_LIMIT_EXCEEDED");
		expect(isUsageLimitOutcome(429, body)).toBe(false);
		expect(isUsageLimit(Object.assign(new Error(body), { status: 429 }))).toBe(false);
	});

	it("keeps structured RATE_LIMIT_EXCEEDED without a retry delay transient", () => {
		const body = googleRpc429("RATE_LIMIT_EXCEEDED", undefined, "Too many requests");
		expect(parseRateLimitReason(body)).toBe("RATE_LIMIT_EXCEEDED");
		expect(isUsageLimitOutcome(429, body)).toBe(false);
	});

	it("treats structured RATE_LIMIT_EXCEEDED with a 6h delay as usage exhaustion", () => {
		const body = googleRpc429("RATE_LIMIT_EXCEEDED", "21600s", "Too many requests");
		expect(parseRateLimitReason(body)).toBe("QUOTA_EXHAUSTED");
		expect(isUsageLimitOutcome(429, body)).toBe(true);
	});

	it("treats the five-minute structured rate-limit threshold as usage exhaustion", () => {
		const body = googleRpc429("RATE_LIMIT_EXCEEDED", "300s", "Too many requests");
		expect(parseRateLimitReason(body)).toBe("QUOTA_EXHAUSTED");
		expect(isUsageLimitOutcome(429, body)).toBe(true);
	});

	it("preserves structured INSUFFICIENT_G1_CREDITS_BALANCE while rotating credentials", () => {
		const body = googleRpc429("INSUFFICIENT_G1_CREDITS_BALANCE", undefined, "Credit balance is unavailable");
		expect(parseRateLimitReason(body)).toBe("INSUFFICIENT_G1_CREDITS_BALANCE");
		expect(isUsageLimitOutcome(429, body)).toBe(true);
		expect(isUsageLimit(Object.assign(new Error(body), { status: 429 }))).toBe(true);
	});

	it("falls back to existing text heuristics for non-JSON 429 bodies", () => {
		const body = "Cloud Code Assist API error (429): Too many requests";
		expect(parseRateLimitReason(body)).toBe("RATE_LIMIT_EXCEEDED");
		expect(isUsageLimitOutcome(429, body)).toBe(false);
	});
});

describe("isUsageLimit", () => {
	it("detects account rate limits as credential-rotatable usage limits", () => {
		expect(
			isUsageLimit(
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
			),
		).toBe(true);
	});

	it("detects OpenCode Go insufficient balance as a credential-rotatable usage limit", () => {
		expect(
			isUsageLimit("401 Insufficient balance. Manage your billing here: https://opencode.ai/workspace/demo"),
		).toBe(true);
	});

	it("detects Antigravity capacity-exhausted message as a usage-limit error", () => {
		// Without this branch `markUsageLimitReached` is never invoked, so the
		// session sticks to the exhausted OAuth account instead of rotating —
		// see `agent-session.ts` line 8314 and `auth-storage.ts` line 3457.
		expect(
			isUsageLimit(
				"Cloud Code Assist API error (429): You have exhausted your capacity on this model. Your quota will reset after 3h6m38s.",
			),
		).toBe(true);
	});

	// Antigravity / Cloud Code Assist returns this phrasing for an exhausted
	// project quota; `parseRateLimitReason` already maps it to QUOTA_EXHAUSTED
	// via the generic `quota` substring, but `isUsageLimitError` decides
	// whether the auth layer rotates to a sibling OAuth credential, so it
	// must match too — otherwise the session stays pinned to the exhausted
	// account (see issue #2198).
	it("detects Antigravity 'Individual quota reached' as a credential-rotatable usage limit", () => {
		expect(
			isUsageLimit(
				"Cloud Code Assist API error (429): Individual quota reached. Contact your administrator to enable overages.",
			),
		).toBe(true);
	});

	// Anthropic returns a `rate_limit_error` when the account's monthly spend
	// cap is hit ("This request would exceed your account's monthly spend
	// limit."). Without the `spend limit` branch the message classifies as a
	// transient rate limit, so `isProviderRetryableError` retries it until the
	// local deadline instead of surfacing the quota error (issue #4787).
	it("detects Anthropic monthly spend-limit as a credential-rotatable usage limit", () => {
		expect(
			isUsageLimit(
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s monthly spend limit. Please try again later."}}',
			),
		).toBe(true);
	});

	it("detects bare 'quota reached' phrasing", () => {
		expect(isUsageLimit("quota reached")).toBe(true);
		expect(isUsageLimit("quota_reached")).toBe(true);
	});

	it("detects subscription quota insufficient phrasing as usage limit", () => {
		expect(isUsageLimit("403 订阅额度不足或未配置订阅: subscription quota insufficient, need=14447")).toBe(true);
		expect(isUsageLimit("quota insufficient")).toBe(true);
		expect(isUsageLimit("额度耗尽")).toBe(true);
	});

	it("detects Simplified Chinese quota exhaustion as a credential-rotatable usage limit", () => {
		// Zhipu Coding Plan (type=1308). Without this match the error is UNKNOWN,
		// Flag.UsageLimit is never set, and the session sticks to the exhausted
		// api_key credential instead of rotating to the sibling key.
		const zhipu =
			"429 已达到 5 小时的使用上限。您的限额将在 2026-08-06 20:06:00 重置。\n已达到 5 小时的使用上限。您的限额将在 2026-08-06 20:06:00 重置。 (type=1308)";
		expect(isUsageLimit(zhipu)).toBe(true);
		expect(isUsageLimit("已达到 5 小时的使用上限")).toBe(true);
		expect(isUsageLimit("您的限额将在 2026-08-06 20:06:00 重置")).toBe(true);
		expect(isUsageLimit("今日使用量已达上限，请明天再试")).toBe(true);
		expect(isUsageLimit("额度已用完，请充值")).toBe(true);
		expect(isUsageLimit("配额已用尽")).toBe(true);
		expect(isUsageLimit("账户余额不足")).toBe(true);
	});

	it("does not treat Simplified Chinese throttling as a usage limit", () => {
		expect(isUsageLimit("429 已达到速率限制")).toBe(false);
		expect(isUsageLimit("请求过于频繁，请稍后重试")).toBe(false);
		expect(isUsageLimit("API 使用频率已达上限")).toBe(false);
	});

	it("detects xAI Grok SuperGrok credit exhaustion as a credential-rotatable usage limit", () => {
		// xAI returns HTTP 403 with (type=personal-team-blocked:spending-limit), not a
		// 429 usage_limit_reached. Without this match, multi-account xai-oauth pools
		// stick to the exhausted credential instead of rotating siblings.
		const message =
			"403 You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok.\nYou have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok. (type=personal-team-blocked:spending-limit)";
		expect(isUsageLimit(message)).toBe(true);
		expect(isUsageLimit(Object.assign(new Error(message), { status: 403 }))).toBe(true);
		expect(parseRateLimitReason(message)).toBe("QUOTA_EXHAUSTED");
	});

	it("detects OpenAI quota payload codes as credential-rotatable usage limits", () => {
		for (const message of ["insufficient_quota", "usage_limit_exceeded", "usage_limit_reached"]) {
			expect(isUsageLimit(message)).toBe(true);
		}
		expect(isUsageLimitStatus(429)).toBe(true);
		expect(isUsageLimitStatus(400)).toBe(false);
	});

	it("detects structured provider usage codes without quota wording", () => {
		expect(
			isUsageLimit(
				new ProviderHttpError("Generic provider failure", 429, {
					code: "insufficient_quota",
				}),
			),
		).toBe(true);
		expect(
			isUsageLimit(
				new ProviderHttpError("Generic provider failure", 429, {
					code: "rate_limit_error",
				}),
			),
		).toBe(false);
		expect(isUsageLimit(new ProviderHttpError("Payment Required", 402))).toBe(true);
		expect(isUsageLimit(new ProviderHttpError("A subscription is required for this endpoint", 402))).toBe(false);
	});
	it("detects 402 Payment Required and Payment is required as credential-rotatable usage limit", () => {
		expect(isUsageLimit(Object.assign(new Error("Payment Required"), { status: 402 }))).toBe(true);
		expect(isUsageLimit(Object.assign(new Error("Payment is required"), { status: 402 }))).toBe(true);
		expect(
			isUsageLimit(Object.assign(new Error('{"detail":{"code":"deactivated_workspace"}}'), { status: 402 })),
		).toBe(true);
		expect(isUsageLimit({ status: 402 })).toBe(true);
	});
});

describe("isUsageLimitOutcome", () => {
	it("rotates on bare/opaque 429 bodies (status-only fallback)", () => {
		expect(isUsageLimitOutcome(429, undefined)).toBe(true);
		expect(isUsageLimitOutcome(429, "")).toBe(true);
		expect(isUsageLimitOutcome(429, "429")).toBe(true);
		expect(isUsageLimitOutcome(429, "HTTP 429")).toBe(true);
		expect(isUsageLimitOutcome(429, "Error 429")).toBe(true);
		expect(isUsageLimitOutcome(429, "429 status code (no body)")).toBe(true);
		expect(isUsageLimitOutcome(429, "{}")).toBe(true);
	});

	it("rotates on 429 carrying quota payload codes", () => {
		for (const message of ["insufficient_quota", "usage_limit_exceeded", "usage_limit_reached"]) {
			expect(isUsageLimitOutcome(429, message)).toBe(true);
		}
	});

	it("rotates on ClinePass limit markers regardless of status", () => {
		expect(isUsageLimitOutcome(429, "clinepass limit reached for this window. please try again later.")).toBe(true);
		expect(isUsageLimitOutcome(undefined, "clinepass limit reached for this window. please try again later.")).toBe(
			true,
		);
		expect(isUsageLimitOutcome(undefined, "free limit reached on model x/y. try again in 5 minutes")).toBe(true);
	});

	it("keeps informative transient 429s in the upstream-backoff lane", () => {
		// RATE_LIMIT_EXCEEDED — generic throttling.
		expect(isUsageLimitOutcome(429, "Cloud Code Assist API error (429): Too many requests")).toBe(false);
		expect(isUsageLimitOutcome(429, "Requests per minute limit reached")).toBe(false);
		// MODEL_CAPACITY_EXHAUSTED — provider overload, not account quota.
		expect(isUsageLimitOutcome(429, "Service overloaded 529")).toBe(false);
		// UNKNOWN but carries a transient retry hint — body is informative,
		// so we defer to parseRateLimitReason and stay out of the quota lane.
		expect(isUsageLimitOutcome(429, "Please retry in 5s")).toBe(false);
	});

	it("rotates on subscription caps without treating generic rate limits as usage exhaustion", () => {
		const subscriptionCap =
			"429 You've exceeded your subscription rate limits. Upgrade, or try again later. You can view your usage at https://api.synthetic.new/usage";
		expect(parseRateLimitReason(subscriptionCap)).toBe("QUOTA_EXHAUSTED");
		expect(isUsageLimitOutcome(429, subscriptionCap)).toBe(true);
		expect(isUsageLimit(Object.assign(new Error(subscriptionCap), { status: 429 }))).toBe(true);

		const transient = "429 Rate limit exceeded, too many requests";
		expect(parseRateLimitReason(transient)).toBe("RATE_LIMIT_EXCEEDED");
		expect(isUsageLimitOutcome(429, transient)).toBe(false);
		expect(isUsageLimit(Object.assign(new Error(transient), { status: 429 }))).toBe(false);

		const planPerMinuteLimit = "429 Your plan has a rate limit of 60 requests per minute";
		expect(parseRateLimitReason(planPerMinuteLimit)).toBe("RATE_LIMIT_EXCEEDED");
		expect(isUsageLimitOutcome(429, planPerMinuteLimit)).toBe(false);
		expect(isUsageLimit(Object.assign(new Error(planPerMinuteLimit), { status: 429 }))).toBe(false);
	});

	it("still rotates on 429 with explicit account rate-limit framing", () => {
		expect(
			isUsageLimitOutcome(
				429,
				'{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
			),
		).toBe(true);
	});

	it("rotates on usage-limit message regardless of status", () => {
		expect(isUsageLimitOutcome(undefined, "usage_limit_reached")).toBe(true);
		expect(isUsageLimitOutcome(500, "insufficient_quota")).toBe(true);
		expect(
			isUsageLimitOutcome(403, "403 订阅额度不足或未配置订阅: subscription quota insufficient, need=14447"),
		).toBe(true);
	});

	it("rotates on Simplified Chinese quota exhaustion (Zhipu 429)", () => {
		const zhipu =
			"429 已达到 5 小时的使用上限。您的限额将在 2026-08-06 20:06:00 重置。\n已达到 5 小时的使用上限。您的限额将在 2026-08-06 20:06:00 重置。 (type=1308)";
		expect(isUsageLimitOutcome(429, zhipu)).toBe(true);
		expect(isUsageLimitOutcome(429, "已达到 5 小时的使用上限")).toBe(true);
		expect(isUsageLimitOutcome(429, "您的限额将在 2026-08-06 20:06:00 重置")).toBe(true);
		expect(isUsageLimitOutcome(429, "今日使用量已达上限，请明天再试")).toBe(true);
		expect(isUsageLimitOutcome(429, "额度已用完，请充值")).toBe(true);
		expect(isUsageLimitOutcome(429, "配额已用尽")).toBe(true);
		expect(isUsageLimitOutcome(429, "账户余额不足")).toBe(true);
	});

	it("keeps Simplified Chinese throttling in the upstream-backoff lane", () => {
		expect(isUsageLimitOutcome(429, "已达到速率限制")).toBe(false);
		expect(isUsageLimitOutcome(429, "请求过于频繁，请稍后重试")).toBe(false);
		expect(isUsageLimitOutcome(429, "并发请求达到上限")).toBe(false);
		expect(isUsageLimitOutcome(429, "每分钟使用次数已达上限")).toBe(false);
		expect(isUsageLimitOutcome(429, "API 使用频率已达上限")).toBe(false);
	});

	it("treats Simplified Chinese error bodies the classifier can read as informative", () => {
		// A bare 429/empty body is opaque and rotates conservatively, but a body
		// carrying CN quota or throttle phrasing the classifier recognizes defers
		// to parseRateLimitReason instead of being treated as a status-only 429.
		expect(isOpaqueStatusBody("已达到速率限制")).toBe(false);
		expect(isOpaqueStatusBody("请求过于频繁，请稍后重试")).toBe(false);
		expect(isOpaqueStatusBody("429 已达到 5 小时的使用上限")).toBe(false);
		expect(isOpaqueStatusBody("429")).toBe(true);
		expect(isOpaqueStatusBody("")).toBe(true);
		// A Han body the classifier cannot interpret stays opaque so the
		// opaque-429 fallback still rotates. Japanese quota text (e.g. 利用上限に
		// 達しました) is out of scope and must not be treated as informative.
		expect(isOpaqueStatusBody("429 利用上限に達しました")).toBe(true);
	});

	// The MODEL_CAPACITY reclassification of resource_exhausted (#7032) must NOT
	// remove stream/session credential rotation: USAGE_LIMIT_PATTERN's
	// `resource.?exhausted` still flags both forms as a usage-limit outcome so a
	// sibling credential is tried before the short backoff.
	it("still rotates on bare Connect resource_exhausted regardless of status", () => {
		expect(isUsageLimitOutcome(undefined, "Connect error resource_exhausted: Error")).toBe(true);
		expect(isUsageLimitOutcome(undefined, "Connect error resource exhausted: Error")).toBe(true);
	});

	it("rotates on xAI Grok 403 credit/spending-limit exhaustion regardless of status", () => {
		const message =
			"403 You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok. (type=personal-team-blocked:spending-limit)";
		expect(isUsageLimitOutcome(403, message)).toBe(true);
		expect(isUsageLimitOutcome(undefined, message)).toBe(true);
		expect(isUsageLimitOutcome(429, message)).toBe(true);
	});

	it("rotates on Anthropic 402 in-flight credit exhaustion instead of surfacing the retry hint", () => {
		const message =
			"402 This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits. retry-after-ms=120000";
		expect(parseRateLimitReason(message)).toBe("QUOTA_EXHAUSTED");
		expect(is402BillingCapBody(message)).toBe(true);
		expect(isUsageLimitOutcome(402, message)).toBe(true);
		expect(isUsageLimit(message)).toBe(true);
		// OpenRouter's prepaid wording is the same account-local cap.
		expect(
			isUsageLimitOutcome(402, "Insufficient credits. Add more using https://openrouter.ai/settings/credits"),
		).toBe(true);
	});

	it("rotates only account-scoped cap 403s and statusless trailers", () => {
		const devinTrailer =
			"Devin stream error permission_denied: Reached overall message rate limit. Please try again later. Your limit will reset in 13 minutes.";
		// HTTP 403 with the account-scoped body rotates.
		expect(isUsageLimitOutcome(403, devinTrailer)).toBe(true);
		// Devin's Connect trailer carries no HTTP status (a permission_denied
		// ValidationError), so it must rotate on an undefined status too —
		// otherwise the exhausted credential is retried as a transient failure.
		expect(isUsageLimitOutcome(undefined, devinTrailer)).toBe(true);
		expect(isUsageLimit(devinTrailer)).toBe(true);
		expect(isUsageLimitOutcome(403, "Forbidden")).toBe(false);
	});

	// A statusless per-minute reset-window transient ("Rate limit will reset in
	// 30 seconds") is ordinary throttling (RATE_LIMIT_EXCEEDED), not an account
	// usage cap. The reset-window alternative is gated on account scope so it stays
	// in the backoff lane instead of rotating the credential.
	it("does not rotate on a statusless per-minute reset-window transient", () => {
		const message = "Rate limit will reset in 30 seconds";
		expect(parseRateLimitReason(message)).toBe("RATE_LIMIT_EXCEEDED");
		expect(isUsageLimitOutcome(undefined, message)).toBe(false);
		expect(isUsageLimit(message)).toBe(false);
	});

	it("rotates on xAI Grok Build 402 usage-balance exhaustion regardless of status", () => {
		const message = "402 Grok Build usage balance exhausted";
		expect(isUsageLimitOutcome(402, message)).toBe(true);
		expect(isUsageLimitOutcome(undefined, message)).toBe(true);
		expect(isUsageLimit(message)).toBe(true);
	});

	it("treats 402 quota and opaque bodies as credential-rotatable billing caps while preserving non-quota contract", () => {
		expect(isUsageLimitStatus(402)).toBe(true);
		expect(isUsageLimitOutcome(402, undefined)).toBe(true);
		expect(isUsageLimitOutcome(402, "HTTP 402")).toBe(true);
		expect(isUsageLimitOutcome(402, "402 status code (no body)")).toBe(true);
		expect(isUsageLimitOutcome(402, "Payment Required")).toBe(true);
		expect(isUsageLimitOutcome(402, "Payment is required")).toBe(true);
		expect(isUsageLimitOutcome(402, '{"detail":{"code":"deactivated_workspace"}}')).toBe(true);
		expect(isUsageLimitOutcome(402, "A subscription is required for this endpoint")).toBe(false);
		expect(isUsageLimitOutcome(500, "Payment Required")).toBe(false);
		expect(isUsageLimitOutcome(403, "Payment Required")).toBe(false);
		expect(isUsageLimitOutcome(400, "Payment Required")).toBe(false);
		for (const body of [
			"usage_limit_reached",
			"resource_exhausted",
			"usage_not_included",
			"limit_reached",
			"personal-team-blocked",
		]) {
			expect(isUsageLimitOutcome(402, body)).toBe(true);
			expect(isUsageLimit(new ProviderHttpError(body, 402))).toBe(true);
		}
		expect(isUsageLimit(new ProviderHttpError("HTTP 402", 402))).toBe(true);
		expect(isUsageLimit(new ProviderHttpError("402 status code (no body)", 402))).toBe(true);
		expect(isUsageLimit(new ProviderHttpError("", 402))).toBe(true);
		expect(isUsageLimit(new ProviderHttpError("Payment Required", 402))).toBe(true);
		expect(isUsageLimit(new ProviderHttpError("Payment is required", 402))).toBe(true);
		expect(isUsageLimit({ status: 402 })).toBe(true);
		expect(isUsageLimitOutcome(402, "A subscription is required for this endpoint")).toBe(false);
		expect(isUsageLimit(new ProviderHttpError("A subscription is required for this endpoint", 402))).toBe(false);
	});

	it("does not rotate on auth/invalid-request statuses with unrelated bodies", () => {
		expect(isUsageLimitOutcome(401, "Invalid API key")).toBe(false);
		expect(isUsageLimitOutcome(400, "invalid_request_error: model unsupported")).toBe(false);
	});

	// Vertex returns "Online prediction concurrent requests quota exceeded" for a
	// concurrent-request cap. The generic USAGE_LIMIT_PATTERN matches
	// `quota.?exceeded`, but this is a concurrency cap (5s backoff, no rotation),
	// not account quota exhaustion. CONCURRENT_LIMIT must take precedence so the
	// credential is not burned.
	it("does not rotate on Vertex quota-worded concurrency caps", () => {
		const message = "Online prediction concurrent requests quota exceeded";
		expect(parseRateLimitReason(message)).toBe("CONCURRENT_LIMIT");
		expect(isUsageLimitOutcome(429, message)).toBe(false);
		expect(isUsageLimit(message)).toBe(false);
	});

	it("excludes non-billing concurrency caps from credential rotation", () => {
		const message = "concurrent requests limit reached";
		expect(isConcurrencyCapExclusion(403, message)).toBe(true);
		expect(isConcurrencyCapExclusion(undefined, message)).toBe(true);
		expect(isConcurrencyCapExclusion(402, message)).toBe(false);
		expect(isConcurrencyCapExclusion(403, "Forbidden")).toBe(false);
		const classified = classify(new ProviderHttpError(message, 403));
		expect(is(classified, Flag.AuthFailed)).toBe(false);
		expect(is(classified, Flag.Transient)).toBe(true);
	});

	// The same bare concurrency wording can reach turn recovery without a
	// preserved HTTP status (Vertex/Bedrock paths that bypass API-key
	// resolution). The body misses TRANSIENT_TRANSPORT_PATTERN, so without an
	// explicit Flag.Transient the temporary cap classifies as terminal and is
	// never retried. It must stay shed-and-backoff (transient/retriable).
	it("keeps statusless concurrency caps transient and retriable", () => {
		const message = "Online prediction concurrent requests quota exceeded";
		const id = classify(message);
		expect(is(id, Flag.Transient)).toBe(true);
		expect(retriable(id)).toBe(true);
	});

	// HTTP 402 represents an account-billing cap, so a 402 whose body is
	// worded as a concurrency cap still rotates — the billing-cap status wins
	// over the concurrency exclusion. The identical concurrency wording on a
	// quota-worded 429 stays non-rotatable (5s backoff). This pins the
	// 402-billing-cap > concurrency-exclusion precedence in both the rotation
	// decision (isUsageLimitOutcome) and the Flag.UsageLimit classification
	// (isUsageLimit).
	it("rotates on 402 concurrency-worded billing caps but not 429 concurrency caps", () => {
		const message = "concurrent requests limit reached";
		expect(parseRateLimitReason(message)).toBe("CONCURRENT_LIMIT");
		// 402 billing cap wins: rotate.
		expect(isUsageLimitOutcome(402, message)).toBe(true);
		expect(isUsageLimit(Object.assign(new Error(message), { status: 402 }))).toBe(true);
		// 429 concurrency cap: shed-and-backoff, do not rotate.
		expect(isUsageLimitOutcome(429, message)).toBe(false);
		expect(isUsageLimit(Object.assign(new Error(message), { status: 429 }))).toBe(false);
	});
});

describe("calculateRateLimitBackoffMs", () => {
	it("returns 45–75s range for MODEL_CAPACITY_EXHAUSTED (jitter)", () => {
		for (let i = 0; i < 20; i++) {
			const ms = calculateRateLimitBackoffMs("MODEL_CAPACITY_EXHAUSTED");
			expect(ms).toBeGreaterThanOrEqual(45_000);
			expect(ms).toBeLessThanOrEqual(75_000);
		}
	});

	it("returns a short backoff for CONCURRENT_LIMIT", () => {
		expect(calculateRateLimitBackoffMs("CONCURRENT_LIMIT")).toBe(5_000);
	});
});

describe("is402BillingCapBody", () => {
	it("returns true for undefined or opaque bodies", () => {
		expect(is402BillingCapBody(undefined)).toBe(true);
		expect(is402BillingCapBody("")).toBe(true);
		expect(is402BillingCapBody("HTTP 402")).toBe(true);
		expect(is402BillingCapBody("402 status code (no body)")).toBe(true);
	});

	it("returns true for payment, deactivation, and balance wording", () => {
		expect(is402BillingCapBody("Payment Required")).toBe(true);
		expect(is402BillingCapBody('{"detail":{"code":"deactivated_workspace"}}')).toBe(true);
		expect(is402BillingCapBody("Insufficient balance in account")).toBe(true);
	});

	it("returns true for quota exhaustion and concurrent limit reasons", () => {
		expect(is402BillingCapBody("quota exceeded")).toBe(true);
		expect(is402BillingCapBody("insufficient_quota")).toBe(true);
		expect(is402BillingCapBody("concurrent requests limit reached")).toBe(true);
	});

	it("returns false for non-quota informative bodies", () => {
		expect(is402BillingCapBody("A subscription is required for this endpoint")).toBe(false);
		expect(is402BillingCapBody("Rate limit exceeded, too many requests")).toBe(false);
	});
});
