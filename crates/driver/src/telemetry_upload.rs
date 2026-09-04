//! Bounded consent-only AutoQA delivery worker.

use std::{env, sync::Arc, time, time::Duration};

use http::{HeaderMap, HeaderValue, header::USER_AGENT};
use omp_ai::auth::HeaderPlacement;
use omp_cache::{
	telemetry_cache,
	telemetry_cache::{PendingIssue, TelemetryIndex},
};
use omp_envd::github_url::GithubCredentialBridge;
use serde_json::{Value, json};

const ENDPOINT: &str = "https://qa.omp.sh/v1/grievances";
const BATCH: usize = 4;

/// Result of an explicit grievance upload drain.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ManualPushResult {
	/// Rows durably acknowledged by the remote authority.
	pub pushed: usize,
	/// Whether the entire planning snapshot was acknowledged.
	pub ok:     bool,
}

/// Applies an explicit UI decision against the exact displayed target
/// revision. Model-facing report arguments never reach this authority.
pub fn apply_consent(
	store: &TelemetryIndex,
	intent: omp_cache::telemetry_cache::ConsentIntent,
) -> Result<bool, omp_cache::telemetry_cache::QueryError> {
	match intent.decision {
		telemetry_cache::Decision::Upload => {
			store.consent_upload(&intent.issue_id, &intent.revision, now_ms())
		},
		telemetry_cache::Decision::LocalOnly => {
			store.reject_upload(&intent.issue_id)?;
			Ok(true)
		},
	}
}

/// Starts a nonblocking worker when registry assembly runs inside Tokio.
pub(crate) fn start(store: Arc<TelemetryIndex>, credentials: Arc<GithubCredentialBridge>) {
	use tokio::{runtime, time};

	let Ok(runtime) = runtime::Handle::try_current() else {
		return;
	};
	runtime.spawn(async move {
		let client = omp_http::no_redirect_client();
		loop {
			let now = now_ms();
			if let Ok(pending) = store.pending_uploads(now, BATCH) {
				for issue in pending {
					let _ = deliver_to(&client, ENDPOINT, &store, &credentials, issue, now, false).await;
				}
			}
			time::sleep(Duration::from_secs(15)).await;
		}
	});
}

/// Authenticates and drains every issue selected by explicit manual intent.
pub async fn manual_push(
	store: &TelemetryIndex,
	credentials: &GithubCredentialBridge,
) -> Result<ManualPushResult, omp_cache::telemetry_cache::QueryError> {
	let client = omp_http::no_redirect_client();
	let endpoint = env::var("OMP_AUTO_QA_PUSH_URL").unwrap_or_else(|_| ENDPOINT.to_owned());
	let mut pushed = 0;
	loop {
		let pending = store.pending_manual_uploads(BATCH)?;
		if pending.is_empty() {
			return Ok(ManualPushResult { pushed, ok: true });
		}
		for issue in pending {
			if deliver_to(&client, endpoint.trim(), store, credentials, issue, now_ms(), true).await {
				pushed += 1;
			} else {
				return Ok(ManualPushResult { pushed, ok: false });
			}
		}
	}
}

async fn deliver_to(
	client: &omp_http::Client,
	endpoint: &str,
	store: &TelemetryIndex,
	credentials: &GithubCredentialBridge,
	pending: PendingIssue,
	now: u64,
	bypass_consent: bool,
) -> bool {
	let revision = if bypass_consent {
		pending.issue.rev.as_deref()
	} else {
		pending.issue.consent_revision.as_deref()
	};
	let Some(revision) = revision else {
		let _ = store.reject_upload(&pending.issue.id);
		return false;
	};
	if !bypass_consent && pending.issue.rev.as_deref() != Some(revision) {
		let _ = store.reject_upload(&pending.issue.id);
		return false;
	}
	let body = json!({
		"issue_id": pending.issue.id,
		"session_id": pending.issue.session_id,
		"device": pending.issue.device,
		"revision": revision,
		"payload": omp_observability::autoqa::project_payload(&pending.payload),
	});
	let mut headers = HeaderMap::new();
	headers.insert(USER_AGENT, HeaderValue::from_static("omp-autoqa/1"));
	let Ok(idempotency) = HeaderValue::from_str(&pending.issue.id) else {
		let _ = store.reject_upload(&pending.issue.id);
		return false;
	};
	headers.insert("idempotency-key", idempotency);
	let Ok(Some(lease)) = credentials.lease_for("autoqa").await else {
		let _ = retry(store, &pending, now);
		return false;
	};
	if lease
		.apply_header(&HeaderPlacement::bearer(), &mut headers)
		.is_err()
	{
		let _ = retry(store, &pending, now);
		return false;
	}
	let response = client
		.post(endpoint)
		.headers(headers)
		.json(&body)
		.send()
		.await;
	let Ok(response) = response else {
		let _ = retry(store, &pending, now);
		return false;
	};
	let status = response.status().as_u16();
	if (200..300).contains(&status) {
		let acknowledgement = response
			.json::<Value>()
			.await
			.ok()
			.and_then(|value| {
				value
					.get("acknowledgement")
					.and_then(Value::as_str)
					.map(str::to_owned)
			})
			.unwrap_or_else(|| pending.issue.id.to_string());
		commit_acknowledgement(store, &pending.issue.id, &acknowledgement)
	} else if status == 408 || status == 429 || status >= 500 {
		let _ = retry(store, &pending, now);
		false
	} else {
		let _ = store.reject_upload(&pending.issue.id);
		false
	}
}

fn commit_acknowledgement(store: &TelemetryIndex, id: &str, acknowledgement: &str) -> bool {
	store
		.acknowledge_upload(id, acknowledgement)
		.unwrap_or(false)
}

fn retry(
	store: &TelemetryIndex,
	pending: &PendingIssue,
	now: u64,
) -> Result<(), omp_cache::telemetry_cache::QueryError> {
	let exponent = pending.issue.attempt_count.min(10);
	let delay = 1_000u64
		.checked_shl(exponent)
		.unwrap_or(3_600_000)
		.min(3_600_000);
	store.record_upload_failure(&pending.issue.id, now.saturating_add(delay))
}

fn now_ms() -> u64 {
	time::SystemTime::now()
		.duration_since(time::UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}
#[cfg(test)]
mod tests {
	use omp_cache::telemetry_cache::StoredIssue;
	use omp_core::sf;
	use tempfile::tempdir;

	use super::*;

	#[test]
	fn upload_response_commits_exactly_one_acknowledgement() {
		let directory = tempdir().unwrap();
		let store =
			TelemetryIndex::open(directory.path(), &directory.path().join("telemetry.sqlite"))
				.unwrap();
		let payload = br#"{"report":"redacted"}"#;
		let offset = store
			.append("session-a", "issue_report", 1, payload)
			.unwrap();
		store
			.store_issue(&StoredIssue {
				id:                 sf!("qa-a"),
				session_id:         sf!("session-a"),
				device:             sf!("read"),
				rev:                Some(sf!("1")),
				consent:            sf!("upload"),
				created_at_ms:      1,
				payload_offset:     offset.0,
				payload_len:        payload.len().try_into().unwrap(),
				consent_revision:   Some(sf!("1")),
				attempt_count:      0,
				next_attempt_at_ms: 0,
				terminal:           false,
				remote_ack:         None,
			})
			.unwrap();

		assert!(commit_acknowledgement(&store, "qa-a", "remote-a"));
		assert!(!commit_acknowledgement(&store, "qa-a", "remote-b"));
		let issue = store.issue("qa-a").unwrap().unwrap();
		assert_eq!(issue.remote_ack.as_deref(), Some("remote-a"));
		assert_eq!(issue.attempt_count, 1);
	}
}
