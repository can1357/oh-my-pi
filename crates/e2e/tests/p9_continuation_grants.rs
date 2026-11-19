//! P9: continuation authority reaches a user extension only through an
//! operator grant.
//!
//! Each proof runs the production path end to end. The shipped `omp ext grant`
//! (the worker-capable `omp` executable, run as a child) writes the grant, the
//! driver's native admission turns the user extension root and that grant into
//! the extension's `control_grants`, an in-process environment authority spawns
//! the extension host from the admitted spec, and the extension's tool calls
//! the real CONTROL operation `omp.agents.set_continuation_policy`. No test
//! builds `control_grants`.
//!
//! The grant store and the user extension root must lie outside every
//! exec-writable root, and `TMPDIR` and `/tmp` are such roots, so the operator
//! home lives under `$HOME` instead of in a `Scratch`. A user extension's host
//! is a `sandboxed`-tier host launched under the OS sandbox with an exact
//! Unix-socket grant that only Seatbelt enforces, so the proofs skip off macOS
//! and, as in P12, fail on macOS when Seatbelt is unavailable.
#![cfg(unix)]

use std::{collections::BTreeSet, time::Duration};

use bytes::Bytes;
use omp_core::sf;
use omp_e2e::{
	Context as _, Result, error,
	support::{InProcessEnvHarness, OperatorHome, Scratch, install_agents_owner, within},
};
use omp_env::{EnvClient, InvocationEvent};
use omp_proto::env::v1::InvokeTool;
use omp_tool::CallOutcome;
use serde_json::{Value, json};

const EXTENSION: &str = "grantproof";
const CAPABILITY: &str = "agents.continuation";
const STEP_LIMIT: Duration = Duration::from_secs(30);

const SOURCE: &str = r#"
import omp


@omp.tool("set_policy", rev=1)
async def set_policy():
    policy = omp.agents.ContinuationPolicy(max_consecutive=2, max_total=4, on_exhausted="settle")
    try:
        await omp.agents.set_continuation_policy(policy)
    except omp.PolicyDenied as denied:
        return {"parts": [], "details": {"outcome": "denied", "code": denied.code, "reason": denied.reason}}
    return {"parts": [], "details": {"outcome": "set"}}
"#;

fn manifest() -> String {
	format!(
		r#"id = "{EXTENSION}"
version = "0.1.0"
omp_api = 1
entry = "{EXTENSION}"
capabilities = ["{CAPABILITY}"]

[[declarations]]
id = "set_policy"
kind = "soft"
module = "{EXTENSION}"
key = "set_policy@{EXTENSION}.1"
trigger = "lazy"
api = 1
failure = "fault"
"#
	)
}

/// Whether this host can run a user extension's sandboxed host: only Seatbelt
/// enforces its exact Unix-socket grant, so other hosts skip and an
/// unavailable Seatbelt on macOS is an error, as in P12.
fn runs_user_extension_hosts() -> Result<bool> {
	if !cfg!(target_os = "macos") {
		eprintln!(
			"P9 continuation grants skipped: a user extension's host needs the Seatbelt sandbox \
			 backend, which only macOS has"
		);
		return Ok(false);
	}
	if let Some(failure) = omp_sandbox::backend_status(omp_sandbox::Backend::Seatbelt).failure() {
		return Err(error(format!(
			"P9 continuation grants need the Seatbelt sandbox backend, and its probe failed: \
			 {failure} ({failure:?})"
		)));
	}
	Ok(true)
}

fn find_outcome(value: &Value) -> Option<Value> {
	match value {
		Value::Object(map) if map.contains_key("outcome") => Some(value.clone()),
		Value::Object(map) => map.values().find_map(find_outcome),
		Value::Array(items) => items.iter().find_map(find_outcome),
		Value::String(text) => serde_json::from_str::<Value>(text)
			.ok()
			.and_then(|parsed| find_outcome(&parsed)),
		_ => None,
	}
}

async fn call_set_policy(client: &EnvClient) -> Result<Value> {
	let mut invocation = within(
		"open extension invocation",
		STEP_LIMIT,
		client.invoke(InvokeTool {
			invocation_id: "p9-grants-set-policy".to_owned(),
			name: "set_policy".to_owned(),
			rev: format!("{EXTENSION}.1"),
			..InvokeTool::default()
		}),
	)
	.await??;
	match within("extension acceptance", STEP_LIMIT, invocation.next_event()).await?? {
		Some(InvocationEvent::Accepted(_)) => {},
		other => return Err(error(format!("expected extension acceptance, got {other:?}"))),
	}
	within(
		"commit extension arguments",
		STEP_LIMIT,
		invocation.commit_args(
			Bytes::from(serde_json::to_vec(&json!({}))?),
			Bytes::from_static(b"p9-grants-token"),
			1000,
			None,
		),
	)
	.await??;
	let payload = loop {
		match within("extension verdict", STEP_LIMIT, invocation.next_event()).await?? {
			Some(InvocationEvent::Verdict(verdict)) => {
				let outcome: CallOutcome<Value, Value> = serde_json::from_slice(&verdict.json)?;
				match outcome {
					CallOutcome::Ok(value) => break value,
					other => return Err(error(format!("extension tool returned {other:?}"))),
				}
			},
			Some(InvocationEvent::Update(_)) => {},
			Some(other) => return Err(error(format!("unexpected extension event {other:?}"))),
			None => return Err(error("extension invocation closed before its verdict")),
		}
	};
	find_outcome(&payload)
		.with_context(|| format!("the extension tool answered {payload} without an outcome"))
}

#[tokio::test]
async fn granted_user_extension_sets_continuation_policy() -> Result<()> {
	if !runs_user_extension_hosts()? {
		return Ok(());
	}
	let operator = OperatorHome::new()?;
	let scratch = Scratch::new()?;
	operator.install_extension(EXTENSION, &manifest(), SOURCE)?;
	operator.grant(scratch.project(), EXTENSION).await?;
	assert!(operator.grants_file().is_file(), "omp ext grant wrote no grant store");
	let admission = operator.admit(scratch.project(), EXTENSION)?;
	assert!(
		admission.sandbox.confines(),
		"the Seatbelt probe passed, so admission must see a confining sandbox: {:?}",
		admission.sandbox
	);
	assert_eq!(
		admission.extension.spec.control_grants,
		BTreeSet::from([sf!("agents.continuation")]),
		"admission must turn the operator grant into the declared control capability"
	);

	let harness =
		InProcessEnvHarness::spawn_with_admitted_extension(scratch, &admission.extension).await?;
	let _agents = install_agents_owner(harness.server());
	let answer = call_set_policy(harness.client()).await?;
	assert_eq!(
		answer["outcome"], "set",
		"the granted extension must set its continuation policy: {answer}"
	);
	let identities = harness.server().extension_control_identities();
	let [identity] = identities.as_slice() else {
		return Err(error(format!(
			"expected one authenticated CONTROL child, got {}",
			identities.len()
		)));
	};
	assert!(
		identity.capabilities.contains(CAPABILITY),
		"the CONTROL child must carry the admitted grant: {:?}",
		identity.capabilities
	);

	harness.shutdown().await;
	Ok(())
}

#[tokio::test]
async fn ungranted_user_extension_gets_policy_denied() -> Result<()> {
	if !runs_user_extension_hosts()? {
		return Ok(());
	}
	let operator = OperatorHome::new()?;
	let scratch = Scratch::new()?;
	operator.install_extension(EXTENSION, &manifest(), SOURCE)?;
	assert!(!operator.grants_file().exists(), "no grant may exist before admission");
	let admission = operator.admit(scratch.project(), EXTENSION)?;
	assert!(
		admission.extension.spec.control_grants.is_empty(),
		"no grant was written, so admission must withhold CONTROL: {:?}",
		admission.extension.spec.control_grants
	);

	let harness =
		InProcessEnvHarness::spawn_with_admitted_extension(scratch, &admission.extension).await?;
	let _agents = install_agents_owner(harness.server());
	let answer = call_set_policy(harness.client()).await?;
	assert_eq!(
		answer["outcome"], "denied",
		"the ungranted extension must be denied its continuation policy: {answer}"
	);
	assert_eq!(answer["code"], "capability_denied", "denial code: {answer}");
	assert!(
		answer["reason"]
			.as_str()
			.is_some_and(|reason| reason.contains(CAPABILITY)),
		"the denial must name the missing capability: {answer}"
	);
	let identities = harness.server().extension_control_identities();
	let [identity] = identities.as_slice() else {
		return Err(error(format!(
			"expected one authenticated CONTROL child, got {}",
			identities.len()
		)));
	};
	assert!(
		!identity.capabilities.contains(CAPABILITY),
		"the CONTROL child must not carry an ungranted capability: {:?}",
		identity.capabilities
	);

	harness.shutdown().await;
	Ok(())
}
