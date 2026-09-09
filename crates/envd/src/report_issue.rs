//! Consent-fenced local `AutoQA` issue producer mounted through `dyn`.

use std::{
	collections::BTreeMap,
	sync::Arc,
	time::{SystemTime, UNIX_EPOCH},
};

use async_stream::stream;
use futures::Stream;
use omp_cache::telemetry_cache::{StoredIssue, TelemetryIndex};
use omp_core::{Str, sf};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CommitError, Constraint, DevicePath, Effects, Ev, IncomingParams,
	ParamError, Part, PromptCaps, Rev, Tool, ToolSpec, ToolTerminal,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_SESSION_ID_BYTES: usize = 128;
const MAX_REV_BYTES: usize = 64;
const MAX_VERDICT_BYTES: usize = 16 * 1024;
const MAX_SUMMARY_BYTES: usize = 512;
const MAX_DETAIL_BYTES: usize = 4 * 1024;
const MAX_EVIDENCE_ITEMS: usize = 8;
const MAX_EVIDENCE_BYTES: usize = 2 * 1024;

/// Arguments accepted by the dyn-only `report_issue@1` device.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Session filing the report.
	#[schemars(length(min = 1, max = 128))]
	pub session_id: Str,
	/// Exact tool or dynamic-device path whose result was inconsistent.
	#[schemars(length(min = 1, max = 129))]
	pub device:     Str,
	/// Canonical target revision (`3` or `family.3`).
	#[schemars(length(min = 1, max = 64))]
	pub rev:        Str,
	/// Structured, bounded account of the mismatch.
	pub verdict:    Verdict,
}

/// Structured mismatch evidence. A report is useful even when triage later
/// classifies it as a false positive.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Verdict {
	/// Required one-line account of the suspected mismatch.
	#[schemars(length(min = 1, max = 512))]
	pub summary:  Str,
	/// Documented behavior expected for the supplied parameters.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	#[schemars(length(max = 4096))]
	pub expected: Option<Str>,
	/// Behavior actually observed by the agent.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	#[schemars(length(max = 4096))]
	pub observed: Option<Str>,
	/// Small supporting facts, bounded by count and aggregate encoded size.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	#[schemars(length(max = 8))]
	pub evidence: Vec<Evidence>,
	/// Structured successful outcome returned by the reported call, when known.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub outcome:  Option<BTreeMap<String, Value>>,
	/// Structured typed fault returned by the reported call, when known.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub fault:    Option<BTreeMap<String, Value>>,
}

/// One bounded fact supporting a suspected mismatch.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
	/// Stable short label such as `parameters`, `documentation`, or `result`.
	#[schemars(length(min = 1, max = 64))]
	pub kind:   Str,
	/// Redaction-safe evidence text.
	#[schemars(length(min = 1, max = 2048))]
	pub detail: Str,
}

/// Durable local filing result. External delivery remains impossible until a
/// separate user-owned consent action changes the stored disposition.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Payload {
	/// Stable issue identifier.
	pub issue_id:    Str,
	/// Exact reported `name@rev` identity.
	pub target:      Str,
	/// Session that filed the issue.
	pub session_id:  Str,
	/// Persistence and delivery disposition after this call.
	pub disposition: Disposition,
}

/// External-sharing state observable from the producer result.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Disposition {
	/// Persisted locally; no network or other external side effect occurred.
	LocalOnly,
}

/// Typed terminal rejection from the report producer.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
	/// A field violated its closed contract.
	Invalid {
		/// Rejected field.
		field:      Field,
		/// Stable violated constraint.
		constraint: ConstraintCode,
	},
	/// Local persistence failed at a known stage.
	Storage {
		/// Failed persistence stage.
		operation: StorageOperation,
	},
}

/// Closed report fields used by typed validation faults.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Field {
	/// Session identifier.
	SessionId,
	/// Reported device path.
	Device,
	/// Reported revision.
	Rev,
	/// Verdict object as a whole.
	Verdict,
	/// One-line verdict summary.
	Summary,
	/// Expected behavior.
	Expected,
	/// Observed behavior.
	Observed,
	/// Evidence list or item.
	Evidence,
	/// Mutually exclusive successful outcome.
	Outcome,
	/// Mutually exclusive typed fault.
	Fault,
}

/// Closed validation reasons; presentation never parses prose.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConstraintCode {
	/// Required text was empty.
	Required,
	/// Text or encoded evidence exceeded its documented byte bound.
	TooLarge,
	/// A value was not in its canonical protocol form.
	InvalidFormat,
	/// The supplied session did not match the authenticated invocation.
	SessionMismatch,
	/// Outcome and fault were both supplied for one call.
	MutuallyExclusive,
	/// Summary contained a line break despite its one-line contract.
	OneLine,
}

/// Local persistence stage used by typed storage faults.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageOperation {
	/// Encoding the redacted record.
	Encode,
	/// Appending the private telemetry frame.
	Append,
	/// Indexing the durable issue metadata.
	Index,
}

/// Dyn-mounted `AutoQA` issue recorder.
pub struct ReportIssue {
	spec:  ToolSpec,
	store: Arc<TelemetryIndex>,
}

/// Creates `report_issue@1` over the project-local `AutoQA` store.
pub fn tool(store: Arc<TelemetryIndex>) -> ReportIssue {
	ReportIssue {
		spec: ToolSpec {
			name:            sf!("report_issue"),
			rev:             Rev { family: Default::default(), n: 1 },
			description:     sf!(
				"Records a bounded structured AutoQA verdict against an exact device revision. \
				 Reports are kept locally; only a separate explicit user consent action may deliver \
				 them.",
			),
			schema:          omp_tool::schema::<Params>(),
			constraint:      Constraint::Schema {
				priority:       255,
				on_unsupported: omp_tool::Fallback::Unspecified,
			},
			effects:         Effects::empty(),
			projection_code: omp_tool::native_projection_code(
				env!("CARGO_PKG_NAME"),
				env!("CARGO_PKG_VERSION"),
				include_bytes!("report_issue.rs"),
			)
			.into_bytes(),
		},
		store,
	}
}

impl Tool for ReportIssue {
	type Fault = Fault;
	type Params = Params;
	type Payload = Payload;
	type Update = ();

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<(), Payload, Fault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<Params>().await {
				Ok(params) => params,
				Err(error) => { yield param_event(error); return; },
			};
			let (device, rev) = match validate(&params) {
				Ok(validated) => validated,
				Err(fault) => { yield done(Err(fault)); return; },
			};
			if super::tools::invocation_session_id()
				.is_some_and(|session| session.as_str() != params.session_id.as_str())
			{
				yield done(Err(Fault::Invalid {
					field: Field::SessionId,
					constraint: ConstraintCode::SessionMismatch,
				}));
				return;
			}
			if let Err(error) = incoming.interruptable().committed().await {
				yield commit_event(error);
				return;
			}

			yield done(persist(&self.store, params, &device, &rev, now_ms()));
		}
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, _: &PromptCaps) -> Vec<Part> {
		let value = match view {
			Ok(payload) => serde_json::json!({
				"issue_id": payload.issue_id,
				"target": payload.target,
				"session_id": payload.session_id,
				"disposition": "local_only",
				"delivery": "requires_explicit_user_consent",
			}),
			Err(fault) => serde_json::to_value(fault).expect("typed AutoQA faults must serialize"),
		};
		vec![Part::Text {
			text: Str::from(
				serde_json::to_string(&value).expect("typed AutoQA projections must serialize"),
			),
		}]
	}
}

fn persist(
	store: &TelemetryIndex,
	params: Params,
	device: &DevicePath,
	rev: &Rev,
	now: u64,
) -> Result<Payload, Fault> {
	let fingerprint = serde_json::to_vec(&params)
		.map_err(|_| Fault::Storage { operation: StorageOperation::Encode })?;
	let issue_id = sf!("qa-{}", omp_core::Hash32::sum(&fingerprint).to_hex());
	let revision = Str::from(rev.to_string());
	let canonical_device = Str::from(device.to_string());
	let record = serde_json::json!({
		"issue_id": issue_id.as_str(),
		"session_id": params.session_id.as_str(),
		"device": canonical_device.as_str(),
		"rev": revision.as_str(),
		"verdict": &params.verdict,
		"consent": "local_only",
	});
	let encoded = serde_json::to_string(&record)
		.map_err(|_| Fault::Storage { operation: StorageOperation::Encode })?;
	let redacted = omp_observability::redact::redact_sensitive_credentials(&encoded);
	let payload_len = u32::try_from(redacted.len()).map_err(|_| Fault::Invalid {
		field:      Field::Verdict,
		constraint: ConstraintCode::TooLarge,
	})?;
	let payload_offset = store
		.append(params.session_id.as_str(), "issue_report", now, redacted.as_bytes())
		.map_err(|_| Fault::Storage { operation: StorageOperation::Append })?
		.0;
	let issue = StoredIssue {
		id: issue_id.clone(),
		session_id: params.session_id.clone(),
		device: canonical_device,
		rev: Some(revision.clone()),
		consent: sf!("local_only"),
		created_at_ms: now,
		payload_offset,
		payload_len,
		consent_revision: None,
		attempt_count: 0,
		next_attempt_at_ms: 0,
		terminal: false,
		remote_ack: None,
	};
	store
		.store_issue(&issue)
		.map_err(|_| Fault::Storage { operation: StorageOperation::Index })?;
	Ok(Payload {
		issue_id,
		target: Str::from(format!("{}@{}", device, revision)),
		session_id: params.session_id,
		disposition: Disposition::LocalOnly,
	})
}

fn validate(params: &Params) -> Result<(DevicePath, Rev), Fault> {
	let session = params.session_id.trim();
	if session.is_empty() {
		return Err(Fault::Invalid {
			field:      Field::SessionId,
			constraint: ConstraintCode::Required,
		});
	}
	if session.len() != params.session_id.len()
		|| session.len() > MAX_SESSION_ID_BYTES
		|| session.bytes().any(|byte| byte.is_ascii_control())
	{
		return Err(Fault::Invalid {
			field:      Field::SessionId,
			constraint: ConstraintCode::InvalidFormat,
		});
	}
	let device = DevicePath::parse(params.device.as_str()).map_err(|_| Fault::Invalid {
		field:      Field::Device,
		constraint: ConstraintCode::InvalidFormat,
	})?;
	if device.claimant.is_some() || device.to_string().as_str() != params.device.as_str() {
		return Err(Fault::Invalid {
			field:      Field::Device,
			constraint: ConstraintCode::InvalidFormat,
		});
	}
	if params.rev.len() > MAX_REV_BYTES {
		return Err(Fault::Invalid { field: Field::Rev, constraint: ConstraintCode::TooLarge });
	}
	let rev = params.rev.parse::<Rev>().map_err(|_| Fault::Invalid {
		field:      Field::Rev,
		constraint: ConstraintCode::InvalidFormat,
	})?;
	if rev.to_string().as_str() != params.rev.as_str() {
		return Err(Fault::Invalid {
			field:      Field::Rev,
			constraint: ConstraintCode::InvalidFormat,
		});
	}
	let summary = params.verdict.summary.trim();
	if summary.is_empty() {
		return Err(Fault::Invalid {
			field:      Field::Summary,
			constraint: ConstraintCode::Required,
		});
	}
	if summary.bytes().any(|byte| matches!(byte, b'\n' | b'\r')) {
		return Err(Fault::Invalid {
			field:      Field::Summary,
			constraint: ConstraintCode::OneLine,
		});
	}
	if summary.len() > MAX_SUMMARY_BYTES {
		return Err(Fault::Invalid {
			field:      Field::Summary,
			constraint: ConstraintCode::TooLarge,
		});
	}
	for (field, value) in [
		(Field::Expected, params.verdict.expected.as_deref()),
		(Field::Observed, params.verdict.observed.as_deref()),
	] {
		if value.is_some_and(|value| value.len() > MAX_DETAIL_BYTES) {
			return Err(Fault::Invalid { field, constraint: ConstraintCode::TooLarge });
		}
	}
	if params.verdict.evidence.len() > MAX_EVIDENCE_ITEMS {
		return Err(Fault::Invalid {
			field:      Field::Evidence,
			constraint: ConstraintCode::TooLarge,
		});
	}
	for evidence in &params.verdict.evidence {
		if evidence.kind.trim().is_empty() || evidence.detail.trim().is_empty() {
			return Err(Fault::Invalid {
				field:      Field::Evidence,
				constraint: ConstraintCode::Required,
			});
		}
		if evidence.kind.len() > 64 || evidence.detail.len() > MAX_EVIDENCE_BYTES {
			return Err(Fault::Invalid {
				field:      Field::Evidence,
				constraint: ConstraintCode::TooLarge,
			});
		}
	}
	if params.verdict.outcome.is_some() && params.verdict.fault.is_some() {
		return Err(Fault::Invalid {
			field:      Field::Verdict,
			constraint: ConstraintCode::MutuallyExclusive,
		});
	}
	let encoded = serde_json::to_vec(&params.verdict)
		.map_err(|_| Fault::Storage { operation: StorageOperation::Encode })?;
	if encoded.len() > MAX_VERDICT_BYTES {
		return Err(Fault::Invalid {
			field:      Field::Verdict,
			constraint: ConstraintCode::TooLarge,
		});
	}
	Ok((device, rev))
}

const fn done(result: Result<Payload, Fault>) -> Ev<(), Payload, Fault> {
	Ev::Done(ToolTerminal::Done { result, useless: false })
}

fn param_event(error: ParamError) -> Ev<(), Payload, Fault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn commit_event(error: CommitError) -> Ev<(), Payload, Fault> {
	match error {
		CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		CommitError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed JSON argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  None,
		found:    Some(message),
	}
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn params(verdict: Verdict) -> Params {
		Params { session_id: sf!("session-a"), device: sf!("read"), rev: sf!("hl.3"), verdict }
	}

	fn verdict() -> Verdict {
		Verdict {
			summary:  sf!("Result contradicted the documented selector semantics"),
			expected: Some(sf!("one selected range")),
			observed: Some(sf!("an empty result")),
			evidence: vec![Evidence { kind: sf!("parameters"), detail: sf!("path=a.rs:2-3") }],
			outcome:  Some(BTreeMap::from([("ranges".to_owned(), serde_json::json!([]))])),
			fault:    None,
		}
	}

	#[test]
	fn schema_is_closed_and_names_the_exact_contract() {
		let root = tempfile::tempdir().unwrap();
		let store = TelemetryIndex::open(root.path(), &root.path().join("telemetry.sqlite")).unwrap();
		let report = tool(Arc::new(store));
		assert_eq!(report.spec().name, "report_issue");
		assert_eq!(report.spec().rev, Rev { family: Str::default(), n: 1 });
		let schema: Value = serde_json::from_slice(&report.spec().schema).unwrap();
		assert_eq!(
			schema["required"],
			serde_json::json!(["i", "session_id", "device", "rev", "verdict"])
		);
		assert_eq!(schema["additionalProperties"], false);
		assert_eq!(schema["properties"]["session_id"]["maxLength"], 128);
		assert_eq!(schema["properties"]["rev"]["maxLength"], 64);
		assert_eq!(schema["properties"]["verdict"]["type"], "object");
		assert_eq!(schema["properties"]["verdict"]["required"], serde_json::json!(["summary"]));
		assert_eq!(schema["properties"]["verdict"]["additionalProperties"], false);
		assert_eq!(schema["properties"]["verdict"]["properties"]["summary"]["maxLength"], 512);
		assert_eq!(schema["properties"]["verdict"]["properties"]["evidence"]["maxItems"], 8);
	}

	#[test]
	fn validation_accepts_false_positives_but_bounds_evidence() {
		assert!(validate(&params(verdict())).is_ok());
		let mut noisy = verdict();
		noisy.summary = sf!("A report that triage may classify as a false positive");
		assert!(validate(&params(noisy)).is_ok());

		let mut noncanonical = params(verdict());
		noncanonical.rev = sf!("03");
		assert_eq!(
			validate(&noncanonical),
			Err(Fault::Invalid { field: Field::Rev, constraint: ConstraintCode::InvalidFormat })
		);

		let mut excessive = verdict();
		excessive.evidence = (0..=MAX_EVIDENCE_ITEMS)
			.map(|_| Evidence { kind: sf!("result"), detail: sf!("x") })
			.collect();
		assert_eq!(
			validate(&params(excessive)),
			Err(Fault::Invalid { field: Field::Evidence, constraint: ConstraintCode::TooLarge })
		);
	}

	#[test]
	fn outcome_and_fault_are_typed_exclusive_evidence() {
		let mut both = verdict();
		both.fault = Some(BTreeMap::from([("code".to_owned(), serde_json::json!("failed"))]));
		assert_eq!(
			validate(&params(both)),
			Err(Fault::Invalid {
				field:      Field::Verdict,
				constraint: ConstraintCode::MutuallyExclusive,
			})
		);

		assert!(
			serde_json::from_value::<Params>(serde_json::json!({
				"session_id": "session-a",
				"device": "read",
				"rev": "1",
				"verdict": {"summary": "mismatch", "outcome": true}
			}))
			.is_err()
		);
	}

	#[test]
	fn persistence_is_redacted_local_only_and_not_delivery_eligible() {
		let root = tempfile::tempdir().unwrap();
		let store = TelemetryIndex::open(root.path(), &root.path().join("telemetry.sqlite")).unwrap();
		let mut report = params(verdict());
		report.verdict.evidence[0].detail =
			Str::from(format!("authorization: Bearer ghp_{}", "A".repeat(36)));
		let (device, rev) = validate(&report).unwrap();
		let payload = persist(&store, report, &device, &rev, 7).unwrap();

		assert_eq!(payload.disposition, Disposition::LocalOnly);
		let issue = store.issue(&payload.issue_id).unwrap().unwrap();
		assert_eq!(issue.consent, "local_only");
		assert_eq!(issue.consent_revision, None);
		assert_eq!(issue.remote_ack, None);
		assert!(store.pending_uploads(7, 10).unwrap().is_empty());

		let findings = store
			.issue_inventory(&omp_cache::telemetry_cache::IssueInventoryFilter {
				limit: 1,
				..Default::default()
			})
			.unwrap();
		let [finding] = findings.as_slice() else {
			panic!("one local issue")
		};
		let saved = String::from_utf8_lossy(&finding.payload);
		assert!(saved.contains("[REDACTED]"));
		assert!(!saved.contains("ghp_"));
	}
}
