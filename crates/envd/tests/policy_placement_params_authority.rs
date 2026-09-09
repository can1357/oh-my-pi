//! Proves policy, placement, parameter, and filesystem domains delegate with
//! authority fences.
use std::{
	collections::BTreeSet,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::Duration,
};

use async_trait::async_trait;
use bytes::Bytes;
use omp_agent::{ApprovalBook, ApprovalRoute, ApprovalSpec, ApprovalTicket};
use omp_core::{InvocationPhase, LifecyclePhase, Principal, Str, sf};
use omp_envd::{
	exthost::{
		control::{
			AuditedDirectFilesystemRequest, ControlAuthority, ControlConnectionIdentity,
			ControlInvocationAuthority, ControlRequestContext,
		},
		params::{
			DirectFilesystemAuthorityError, DirectFilesystemControlOwner, DirectFilesystemExecutor,
			DirectFilesystemJournal, DirectFilesystemOutput, ParameterAuthorityError,
			ParameterControlOwner, ParameterPullRequest, ParameterPullResult, ParameterSource,
		},
	},
	policy::{
		InstalledSandboxProfile, PolicyAuditSink, PolicyControlFailure, PolicyControlOwner,
		PolicyScope, SandboxCapabilities, SandboxEnforcement, SandboxPolicyRuntime, SandboxProfile,
	},
	worker_pool::{
		WorkerControlFailure, WorkerControlOwner, WorkerObservation, WorkerProcessAuthority,
		WorkerRoute, WorkerSessionEndpoint, WorkerSite, WorkerSupervisor,
	},
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

fn identity() -> Arc<ControlConnectionIdentity> {
	Arc::new(ControlConnectionIdentity {
		extension:          sf!("fixture.extension"),
		principal:          Principal::new(sf!("fixture"), sf!("Fixture")),
		artifact_digest:    sf!("sha256:fixture"),
		layer:              sf!("project"),
		tier:               sf!("trusted"),
		trust:              sf!("trusted"),
		host_generation:    7,
		session_generation: 11,
		capabilities:       Arc::new(BTreeSet::from([
			sf!("policy.write"),
			sf!("approvals.decide"),
			sf!("workers.manage"),
			sf!("trusted.direct-filesystem"),
		])),
	})
}

fn context(identity: Arc<ControlConnectionIdentity>) -> ControlRequestContext {
	ControlRequestContext {
		connection: identity,
		request_id: 9,
		invocation: Some(ControlInvocationAuthority {
			invocation:        sf!("call-1"),
			phase:             InvocationPhase::EffectsAuthorized,
			session:           sf!("session-1"),
			turn:              Some(1),
			event:             None,
			call:              Some(sf!("call-1")),
			device:            Some(sf!("device")),
			effects:           Box::new([]),
			place_kind:        sf!("host"),
			lifecycle:         LifecyclePhase::Active,
			roots:             Box::new([sf!("/workspace")]),
			remote:            false,
			has_ui:            true,
			headless:          false,
			settings:          serde_json::Map::new(),
			secret_settings:   Box::new([]),
			data:              None,
			direct_filesystem: Some(json!({
				"extension_id": "fixture.extension",
				"publisher": "fixture.publisher",
				"capability_digest": "digest-1",
				"grant_id": "grant-1",
				"granted_at": "2026-08-22T00:00:00Z",
				"generation": 7,
			})),
		}),
	}
}

struct PolicyRuntime;

#[async_trait]
impl SandboxPolicyRuntime for PolicyRuntime {
	async fn capabilities(&self) -> Result<SandboxCapabilities, PolicyControlFailure> {
		Ok(SandboxCapabilities {
			backends:         vec![sf!("seatbelt")],
			landlock_abi:     None,
			filesystem:       true,
			network:          false,
			domain_filtering: false,
			resource_limits:  true,
			degraded:         vec![sf!("network unavailable")],
		})
	}

	async fn effective_profile(
		&self,
		_session: &str,
	) -> Result<SandboxProfile, PolicyControlFailure> {
		Ok(SandboxProfile { label: sf!("effective"), ..SandboxProfile::default() })
	}

	async fn enforcement(&self, _session: &str) -> Result<SandboxEnforcement, PolicyControlFailure> {
		Ok(SandboxEnforcement {
			filesystem:       sf!("hard"),
			network:          sf!("none"),
			process:          sf!("partial"),
			backend:          sf!("seatbelt"),
			degraded_reasons: vec![sf!("network unavailable")],
		})
	}

	async fn install(
		&self,
		_owner: &str,
		_session: &str,
		mut profile: SandboxProfile,
		_scope: PolicyScope,
	) -> Result<InstalledSandboxProfile, PolicyControlFailure> {
		profile.label = sf!("installed");
		Ok(InstalledSandboxProfile { handle_id: sf!("profile-1"), profile })
	}

	async fn revoke(&self, _owner: &str, _handle_id: &str) -> Result<(), PolicyControlFailure> {
		Ok(())
	}

	async fn amend(
		&self,
		_owner: &str,
		_session: &str,
		_patch: SandboxProfile,
		_scope: PolicyScope,
		_reason: Str,
		_approval: Option<ApprovalSpec>,
	) -> Result<(), PolicyControlFailure> {
		Ok(())
	}
}

struct PolicyAudit(AtomicBool);

#[async_trait]
impl PolicyAuditSink for PolicyAudit {
	async fn approval_decided(&self, _ticket: &ApprovalTicket) -> Result<(), PolicyControlFailure> {
		self.0.store(true, Ordering::Release);
		Ok(())
	}
}

struct ParamsSource;

#[async_trait]
impl ParameterSource for ParamsSource {
	async fn pull(
		&self,
		request: ParameterPullRequest,
		_cancel: CancellationToken,
	) -> Result<ParameterPullResult, ParameterAuthorityError> {
		Ok(ParameterPullResult(json!({
			"value": request.invocation_id,
			"phase": "EFFECTS_AUTHORIZED",
		})))
	}
}

struct WorkerProcesses;

fn worker_observation(route: &WorkerRoute) -> WorkerObservation {
	WorkerObservation {
		name:            route.key.name.clone(),
		generation:      route.generation,
		state:           sf!("ready"),
		site:            WorkerSite::default(),
		pid:             Some(41),
		spawned_at_ms:   1,
		last_call_at_ms: None,
		calls:           0,
		in_flight:       0,
		code_cached:     0,
		enforced:        vec![sf!("memory_bytes")],
		fault:           None,
	}
}

#[async_trait]
impl WorkerProcessAuthority for WorkerProcesses {
	async fn ensure(
		&self,
		route: &WorkerRoute,
		_cancel: CancellationToken,
	) -> Result<WorkerObservation, WorkerControlFailure> {
		Ok(worker_observation(route))
	}

	async fn observe(&self, route: &WorkerRoute) -> Result<WorkerObservation, WorkerControlFailure> {
		Ok(worker_observation(route))
	}

	async fn warm(
		&self,
		route: &WorkerRoute,
		_cancel: CancellationToken,
	) -> Result<WorkerObservation, WorkerControlFailure> {
		Ok(worker_observation(route))
	}

	async fn stop(
		&self,
		_route: &WorkerRoute,
		_grace: Duration,
		_cancel: CancellationToken,
	) -> Result<(), WorkerControlFailure> {
		Ok(())
	}

	async fn session(
		&self,
		route: &WorkerRoute,
		_cancel: CancellationToken,
	) -> Result<WorkerSessionEndpoint, WorkerControlFailure> {
		Ok(WorkerSessionEndpoint {
			generation: route.generation,
			family:     sf!("unix"),
			address:    Value::String("/tmp/fixture-worker.sock".to_owned()),
			authkey:    Some(Bytes::from_static(b"secret")),
		})
	}
}

struct FilesystemJournal(Arc<AtomicBool>);

#[async_trait]
impl DirectFilesystemJournal for FilesystemJournal {
	async fn append_request(
		&self,
		_context: &ControlRequestContext,
		request: &AuditedDirectFilesystemRequest,
	) -> Result<Str, DirectFilesystemAuthorityError> {
		assert_eq!(request.grant.grant_id, "grant-1");
		self.0.store(true, Ordering::Release);
		Ok(sf!("journal:17"))
	}
}

struct FilesystemExecutor(Arc<AtomicBool>);

#[async_trait]
impl DirectFilesystemExecutor for FilesystemExecutor {
	async fn execute(
		&self,
		request: AuditedDirectFilesystemRequest,
		_cancel: CancellationToken,
	) -> Result<DirectFilesystemOutput, DirectFilesystemAuthorityError> {
		assert!(self.0.load(Ordering::Acquire), "audit must precede execution");
		assert_eq!(request.operation, "read");
		Ok(DirectFilesystemOutput::Bytes(Bytes::from_static(b"contents")))
	}
}

#[tokio::test]
async fn domains_delegate_to_native_owners_with_generation_and_audit_fences() {
	let identity = identity();
	let context = context(Arc::clone(&identity));

	let approvals = Arc::new(ApprovalBook::new());
	let (approval_route, _approval_inbox) = ApprovalRoute::new(approvals, None);
	let audit = Arc::new(PolicyAudit(AtomicBool::new(false)));
	let policy = PolicyControlOwner::new(
		Arc::clone(&identity),
		Arc::new(PolicyRuntime),
		approval_route,
		audit,
	);
	let parsed = policy
		.request(
			context.clone(),
			sf!("omp.policy.parse"),
			serde_json::Map::from_iter([
				("script".to_owned(), Value::String("echo ok".to_owned())),
				("cwd".to_owned(), Value::String("/workspace".to_owned())),
			]),
		)
		.await
		.expect("native parser owns policy.parse");
	assert_eq!(parsed["rev"], "omp.policy.v1");
	let capabilities = policy
		.request(context.clone(), sf!("omp.policy.capabilities"), serde_json::Map::new())
		.await
		.expect("sandbox runtime owns capabilities");
	assert_eq!(capabilities["backends"][0], "seatbelt");

	let params = ParameterControlOwner::new(Arc::clone(&identity), Arc::new(ParamsSource));
	let pulled = params
		.request(
			context.clone(),
			sf!("omp.params.pull"),
			serde_json::Map::from_iter([
				("invocation_id".to_owned(), Value::String("call-1".to_owned())),
				("path".to_owned(), json!(["value"])),
				("mode".to_owned(), Value::String("value".to_owned())),
			]),
		)
		.await
		.expect("live invocation feed owns parameter pull");
	assert_eq!(pulled["value"], "call-1");

	let workers = WorkerControlOwner::new(
		Arc::clone(&identity),
		Arc::new(WorkerSupervisor::new(4, 2)),
		Arc::new(WorkerProcesses),
	);
	let worker = workers
		.request(
			context.clone(),
			sf!("omp.workers.get"),
			serde_json::Map::from_iter([("name".to_owned(), Value::String("index".to_owned()))]),
		)
		.await
		.expect("worker process owner warms selected generation");
	assert_eq!(worker["generation"], 1);

	let journaled = Arc::new(AtomicBool::new(false));
	let direct = DirectFilesystemControlOwner::new(
		identity,
		Arc::new(FilesystemJournal(Arc::clone(&journaled))),
		Arc::new(FilesystemExecutor(journaled)),
	);
	let output = direct
		.request(
			context,
			sf!("omp.direct_filesystem.request"),
			serde_json::Map::from_iter([
				("operation".to_owned(), Value::String("read".to_owned())),
				("path".to_owned(), Value::String("/private/fixture".to_owned())),
				("data".to_owned(), Value::Null),
				(
					"grant".to_owned(),
					json!({
						"extension_id": "fixture.extension",
						"publisher": "fixture.publisher",
						"capability_digest": "digest-1",
						"grant_id": "grant-1",
						"generation": 7,
					}),
				),
			]),
		)
		.await
		.expect("audited exceptional filesystem owner executes request");
	assert_eq!(output["audit_receipt"], "journal:17");
	assert!(output["data"]["$bytes"].is_string());
}

fn approval_spec(require_human: bool) -> ApprovalSpec {
	ApprovalSpec {
		title: sf!("Push"),
		body: sf!("git push origin main"),
		subject: sf!("git push"),
		kind: sf!("exec"),
		scopes: vec![sf!("once")],
		default: None,
		route: sf!("user"),
		approver: None,
		timeout_ms: 0,
		unreachable: sf!("fail_closed"),
		require_human,
		pattern: None,
		evidence: Vec::new(),
	}
}

fn decision(source: &str) -> Value {
	json!({
		"approved": true,
		"scope": "once",
		"source": source,
		"decided_by": "fixture",
		"reason": null,
		"audited": false,
	})
}

/// Every decision source obeys the merged ticket's human-only requirement.
#[tokio::test]
async fn require_human_is_enforced_for_every_decision_source() {
	let sources = [
		("user", true),
		("external", true),
		("forwarded", false),
		("config", false),
		("extension", false),
		("timeout", false),
		("unavailable", false),
	];
	for require_human in [false, true] {
		for (source, human) in sources {
			let identity = identity();
			let context = context(Arc::clone(&identity));
			let (approval_route, inbox) = ApprovalRoute::new(Arc::new(ApprovalBook::new()), None);
			let audit = Arc::new(PolicyAudit(AtomicBool::new(false)));
			let audit_sink: Arc<dyn PolicyAuditSink> = audit.clone();
			let policy = PolicyControlOwner::new(
				Arc::clone(&identity),
				Arc::new(PolicyRuntime),
				approval_route.clone(),
				audit_sink,
			);
			let requester = approval_route.clone();
			let pending = tokio::spawn(async move {
				requester
					.request(
						Some(sf!("call-1")),
						vec![approval_spec(false), approval_spec(require_human)],
						1,
					)
					.await
			});
			let request = inbox.recv().await.expect("prompt dispatched");
			let ticket_id = request.ticket.ticket_id.clone();
			let arguments = serde_json::Map::from_iter([
				("ticket_id".to_owned(), Value::String(ticket_id.to_string())),
				("decision".to_owned(), decision(source)),
			]);

			let result = policy
				.request(context, sf!("omp.policy.decide"), arguments)
				.await;
			let allowed = !require_human || human;
			if allowed {
				result.expect("permitted source settles the ticket");
				let ticket = pending.await.expect("request task");
				assert!(ticket.decision.expect("decided").approved);
				assert!(audit.0.load(Ordering::Acquire));
			} else {
				let rejected = result.expect_err("non-human source must be rejected");
				assert_eq!(rejected.code, "ApprovalHumanRequired");
				assert!(!audit.0.load(Ordering::Acquire), "rejected decisions are never audited");
				assert_eq!(approval_route.pending().len(), 1, "ticket stays pending");
				pending.abort();
				assert!(
					pending
						.await
						.expect_err("request task was cancelled")
						.is_cancelled()
				);
				assert!(approval_route.pending().is_empty(), "cancelled request is withdrawn");
			}
		}
	}
}
