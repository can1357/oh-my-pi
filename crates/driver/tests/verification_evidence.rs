//! Durable evidence publication through the real Environment and session CAS.

use std::{
	path::{Path, PathBuf},
	process::Command,
	sync::Arc,
	time::Duration,
};

use omp_core::{Hash32, Principal, Str, sf};
use omp_dom::{NodeSpec, Op, PropKey, Tag, Txn, Value};
use omp_driver::verification::{
	CheckOutcome, CheckRequirement, EvidenceError, EvidenceLimits, EvidencePayload,
	EvidenceProvenance, EvidencePublication, EvidenceSubmission, GateVerdict, InconclusiveReason,
	SnapshotContext, VerificationPolicy, VerificationSnapshot, capture_verification_snapshot,
	evidence_observation, evidence_publications, load_evidence, publish_evidence,
};
use omp_env::EnvClient;
use omp_envd::{EnvServer, RegistryBridges, exthost::ConvarControlFactory, worker::ExtHostConfig};
use omp_journal::{
	blob::{BlobRef, BlobStore, GcPolicy},
	gc::collect_blobs,
	idempotency::IdempotencyKey,
};
use omp_proto::env::v1 as pb;
use omp_session::{ComponentRegistry, Session};
use omp_tool::Registry;
use tokio_util::sync::CancellationToken;

const SOURCE: &[u8] = b"pub fn answer() -> u32 { 42 }\n";
const OUTPUT: &[u8] = b"package checks completed: exit 0, 3 selected tests\n";

struct Fixture {
	_temp:   tempfile::TempDir,
	root:    PathBuf,
	journal: PathBuf,
	client:  EnvClient,
	serving: tokio::task::JoinHandle<()>,
}

impl Fixture {
	async fn new() -> Self {
		let temp = tempfile::tempdir().expect("scratch directory");
		let root = temp.path().join("source");
		std::fs::create_dir(&root).unwrap();
		git(&root, &["init", "--initial-branch=main"]);
		git(&root, &["config", "user.email", "verification@example.invalid"]);
		git(&root, &["config", "user.name", "Verification Test"]);
		std::fs::write(root.join("source.rs"), SOURCE).unwrap();
		std::fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
		git(&root, &["add", "."]);
		git(&root, &["commit", "-m", "fixture"]);
		let state = temp.path().join("native-state");
		std::fs::create_dir(&state).unwrap();
		let session_root = temp.path().join("session");
		std::fs::create_dir(&session_root).unwrap();
		let con = Arc::new(omp_con::Ctx::new());
		let server = Arc::new(
			EnvServer::open_local(
				&root,
				&state,
				Registry::new(),
				ExtHostConfig::new(
					PathBuf::from("unused"),
					Principal::new(sf!("evidence-test"), sf!("Evidence Test")),
					sf!("evidence-session"),
					1,
				),
				&con,
				Arc::new(ConvarControlFactory::new(Arc::clone(&con))),
				RegistryBridges::default(),
			)
			.await
			.expect("native Environment"),
		);
		let (client, transport) = EnvClient::in_process(64);
		let serving = tokio::spawn(async move { server.serve_in_process(transport).await });
		client
			.hello(pb::ClientHello {
				client: "evidence-contract-tests".into(),
				schema_rev: omp_proto::SCHEMA_REV,
				..Default::default()
			})
			.await
			.expect("native handshake");
		Self { _temp: temp, root, journal: session_root.join("evidence.oms"), client, serving }
	}

	fn create_session(&self) -> Session {
		Session::create(&self.journal, ComponentRegistry::default()).expect("session creates")
	}

	fn reopen_session(&self) -> Session {
		Session::open(&self.journal, ComponentRegistry::default()).expect("session replays")
	}

	async fn capture(&self) -> VerificationSnapshot {
		let known = Some(Hash32::sum(b"explicitly admitted fixture inputs"));
		capture_verification_snapshot(
			&self.client,
			&SnapshotContext {
				dependencies:      known,
				toolchain:         known,
				environment:       known,
				tests:             known,
				requirements:      known,
				policy:            known,
				verifier:          known,
				required_paths:    Arc::from([Str::new_static("source.rs")]),
				unresolved_inputs: Arc::from([]),
			},
			&CancellationToken::new(),
		)
		.await
		.expect("complete snapshot")
	}

	async fn publish(
		&self,
		session: &mut Session,
		snapshot: &VerificationSnapshot,
		policy: &VerificationPolicy,
	) -> EvidencePublication {
		publish_evidence(
			session,
			&self.client,
			submission(snapshot, policy, &[EvidencePayload { name: "stdout", bytes: OUTPUT }]),
			EvidenceLimits::default(),
			&CancellationToken::new(),
		)
		.await
		.expect("evidence publishes")
	}
}

impl Drop for Fixture {
	fn drop(&mut self) {
		self.serving.abort();
	}
}

fn git(root: &Path, args: &[&str]) {
	let output = Command::new("git")
		.args(args)
		.current_dir(root)
		.output()
		.unwrap();
	assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
}

fn configuration() -> Hash32 {
	Hash32::sum(b"explicit package checks and selected test inventory")
}

fn policy(snapshot: &VerificationSnapshot) -> VerificationPolicy {
	snapshot
		.policy(vec![CheckRequirement { id: Str::new_static("package-check"), required: true }])
		.unwrap()
}

fn submission<'a>(
	snapshot: &'a VerificationSnapshot,
	policy: &'a VerificationPolicy,
	payloads: &'a [EvidencePayload<'a>],
) -> EvidenceSubmission<'a> {
	EvidenceSubmission {
		snapshot,
		policy,
		check: "package-check",
		configuration: configuration(),
		outcome: CheckOutcome::Passed,
		provenance: EvidenceProvenance {
			provider: Str::new_static("fixture-native-check"),
			version:  Str::new_static("1"),
		},
		payloads,
	}
}

fn reference(bytes: &[u8]) -> BlobRef {
	BlobRef { hash: Hash32::sum(bytes), size: bytes.len() as u64 }
}

fn no_grace() -> GcPolicy {
	GcPolicy { unreferenced_grace: Duration::ZERO, temporary_grace: Duration::ZERO }
}

#[tokio::test]
async fn retained_failure_and_unknown_effects_preserve_their_gate_meaning() {
	let fixture = Fixture::new().await;
	let snapshot = fixture.capture().await;
	let policy = policy(&snapshot);
	let mut session = fixture.create_session();
	let mut previous_identity = None;
	for (outcome, verdict, bytes) in [
		(CheckOutcome::Failed, GateVerdict::Fail, &b"confirmed invariant violation: exit 1\n"[..]),
		(
			CheckOutcome::Inconclusive(InconclusiveReason::EffectsUnknown),
			GateVerdict::Inconclusive,
			&b"worker disappeared before execution effects settled\n"[..],
		),
	] {
		let payloads = [EvidencePayload { name: "execution", bytes }];
		let mut request = submission(&snapshot, &policy, &payloads);
		request.outcome = outcome;
		let published = publish_evidence(
			&mut session,
			&fixture.client,
			request,
			EvidenceLimits::default(),
			&CancellationToken::new(),
		)
		.await
		.unwrap();
		assert_eq!(load_evidence(&session, published).unwrap().outcome, outcome);
		let observation =
			evidence_observation(&session, published, &snapshot, &policy, configuration())
				.expect("retained original outcome remains applicable");
		assert_eq!(observation.outcome, outcome);
		assert!(observation.evidence.is_some());
		assert_eq!(policy.evaluate(&[observation]).unwrap().verdict, verdict);
		if let Some(previous) = previous_identity {
			assert_ne!(published.identity, previous);
		}
		previous_identity = Some(published.identity);
	}
}

#[tokio::test]
async fn publication_is_idempotent_after_reopen_and_gc_retains_every_leaf() {
	let fixture = Fixture::new().await;
	let snapshot = fixture.capture().await;
	let policy = policy(&snapshot);
	let mut session = fixture.create_session();
	let before = session.entry_count();
	let published = fixture.publish(&mut session, &snapshot, &policy).await;
	assert_eq!(session.entry_count(), before + 1);
	let record = load_evidence(&session, published).unwrap();
	assert_eq!(record.scope, policy.scope());
	assert_eq!(record.outcome, CheckOutcome::Passed);
	assert!(record.closure.contains(&reference(SOURCE)), "native source leaf must be local");
	assert!(
		record.closure.contains(&reference(b"ignored.txt\n")),
		"every captured file must be rooted"
	);
	assert!(record.closure.contains(&reference(OUTPUT)), "raw evidence must be rooted");
	assert!(
		record
			.closure
			.contains(&reference(snapshot.canonical_bytes()))
	);
	assert_eq!(record.manifest.hash, snapshot.manifest().hash);
	assert!(record.closure.contains(&record.manifest));
	let observation = evidence_observation(&session, published, &snapshot, &policy, configuration())
		.expect("current evidence is applicable");
	assert_eq!(observation.evidence, Some(published.identity));
	assert_eq!(observation.scope, policy.scope());
	let orphan = session.blobs().put(b"unpublished orphan").unwrap();
	drop(session);

	let store = BlobStore::open(fixture.journal.parent().unwrap()).unwrap();
	let gc = collect_blobs(&store, std::slice::from_ref(&fixture.journal), no_grace()).unwrap();
	assert!(gc.storage.blobs_removed >= 1);
	assert!(!store.has(&orphan));
	for leaf in record.closure.iter() {
		assert!(store.verify(leaf).unwrap(), "retained leaf {leaf}");
	}
	let mut reopened = fixture.reopen_session();
	let discovered = evidence_publications(&reopened).expect("restart discovers journal receipts");
	assert_eq!(discovered, vec![published]);
	assert_eq!(load_evidence(&reopened, discovered[0]).unwrap(), record);
	let before_retry = reopened.entry_count();
	let retried = fixture.publish(&mut reopened, &snapshot, &policy).await;
	assert_eq!(retried.entry, published.entry);
	assert_eq!(retried.identity, published.identity);
	assert_eq!(reopened.entry_count(), before_retry, "retry must not append a second receipt");
}

#[tokio::test]
async fn a_large_receipt_keeps_both_journal_copies_within_frame_headroom() {
	let fixture = Fixture::new().await;
	let snapshot = fixture.capture().await;
	let policy = policy(&snapshot);
	let mut session = fixture.create_session();
	let payloads = [EvidencePayload { name: "stdout", bytes: b"ok\n" }];
	let mut request = submission(&snapshot, &policy, &payloads);
	request.provenance.version = Str::from("v".repeat(400 * 1024));
	let published = publish_evidence(
		&mut session,
		&fixture.client,
		request,
		EvidenceLimits::default(),
		&CancellationToken::new(),
	)
	.await
	.expect("large receipt fits the format's bounded journal headroom");
	let record = load_evidence(&session, published).unwrap();
	let receipt_bytes = serde_json::to_vec(&record).unwrap().len();
	assert!(receipt_bytes > 256 * 1024);
	assert!(receipt_bytes < 480 * 1024);
	let entry = session.entry(published.entry).unwrap();
	assert!(entry.data.len() > 2 * 400 * 1024, "both structured receipt copies are journaled");
	assert!(entry.data.len() < 1024 * 1024, "the complete patch stays below the journal hard cap");
	drop(session);
	let reopened = fixture.reopen_session();
	assert_eq!(load_evidence(&reopened, published).unwrap(), record);
}

#[tokio::test]
async fn missing_and_same_size_corrupt_evidence_are_not_admitted() {
	let fixture = Fixture::new().await;
	let snapshot = fixture.capture().await;
	let policy = policy(&snapshot);
	let mut session = fixture.create_session();
	let published = fixture.publish(&mut session, &snapshot, &policy).await;
	let record = load_evidence(&session, published).unwrap();
	let artifact = record.artifacts[0].blob;
	let path = session.blobs().path(&artifact);
	std::fs::write(&path, vec![b'x'; artifact.size as usize]).unwrap();
	assert!(load_evidence(&session, published).is_err(), "length alone cannot prove integrity");
	assert!(evidence_observation(&session, published, &snapshot, &policy, configuration()).is_err());
	std::fs::write(&path, OUTPUT).unwrap();
	assert!(load_evidence(&session, published).is_ok());
	std::fs::remove_file(path).unwrap();
	assert!(load_evidence(&session, published).is_err());
}

#[tokio::test]
async fn source_children_are_verified_not_just_the_receipt_and_output() {
	let fixture = Fixture::new().await;
	let snapshot = fixture.capture().await;
	let policy = policy(&snapshot);
	let mut session = fixture.create_session();
	let published = fixture.publish(&mut session, &snapshot, &policy).await;
	let source = reference(SOURCE);
	let path = session.blobs().path(&source);
	std::fs::write(&path, vec![b'x'; SOURCE.len()]).unwrap();
	assert!(load_evidence(&session, published).is_err());
	std::fs::remove_file(path).unwrap();
	assert!(load_evidence(&session, published).is_err());
}

#[tokio::test]
async fn same_size_corruption_of_canonical_snapshot_or_native_manifest_refuses_loading() {
	let fixture = Fixture::new().await;
	let snapshot = fixture.capture().await;
	let policy = policy(&snapshot);
	let mut session = fixture.create_session();
	let published = fixture.publish(&mut session, &snapshot, &policy).await;
	let record = load_evidence(&session, published).unwrap();
	for artifact in [record.snapshot, record.manifest] {
		let original = session.blobs().get(&artifact).unwrap();
		let path = session.blobs().path(&artifact);
		std::fs::write(&path, vec![b'x'; artifact.size as usize]).unwrap();
		assert!(
			load_evidence(&session, published).is_err(),
			"corrupt structural evidence {artifact}"
		);
		std::fs::write(path, original).unwrap();
		assert!(load_evidence(&session, published).is_ok());
	}
}

#[tokio::test]
async fn a_self_consistent_receipt_cannot_hide_source_children_or_add_unrelated_roots() {
	let fixture = Fixture::new().await;
	let snapshot = fixture.capture().await;
	let policy = policy(&snapshot);
	let mut session = fixture.create_session();
	let published = fixture.publish(&mut session, &snapshot, &policy).await;
	let original = load_evidence(&session, published).unwrap();
	let mut missing_leaf = original.clone();
	missing_leaf.closure = original
		.closure
		.iter()
		.copied()
		.filter(|leaf| *leaf != reference(SOURCE))
		.collect::<Vec<_>>()
		.into();
	let unrelated = session.blobs().put(b"unrelated retained content").unwrap();
	let mut extra_leaf = original;
	let mut closure = extra_leaf.closure.to_vec();
	closure.push(unrelated);
	closure.sort_unstable_by_key(|leaf| leaf.hash);
	extra_leaf.closure = closure.into();

	for forged in [missing_leaf, extra_leaf] {
		// Recompute both receipt identity and idempotency key, so rejection must
		// enforce the native manifest's exact closure, not just detect hash drift.
		let identity = Hash32::sum(serde_json::to_vec(&forged).unwrap());
		let request = serde_json::value::to_raw_value(&forged).unwrap();
		let txn = Txn {
			cause: session.head().unwrap(),
			label: Some(Str::new_static("verification.evidence")),
			ops:   vec![Op::Ins {
				parent: session.dom().meta(),
				after:  None,
				node:   NodeSpec::new(Tag::Custom(Str::new_static("verification-evidence")))
					.with_prop(PropKey::Custom(Str::new_static("receipt")), Value::Json(request)),
			}],
		};
		let key = IdempotencyKey::new(sf!("verification-evidence:{}", identity.to_hex()));
		let entry = session.patch_keyed(txn, key, &forged).unwrap().entry();
		assert!(load_evidence(&session, EvidencePublication { entry, identity }).is_err());
	}
}

#[tokio::test]
async fn existing_corrupt_deduplicated_blob_cannot_be_published() {
	let fixture = Fixture::new().await;
	let snapshot = fixture.capture().await;
	let policy = policy(&snapshot);
	let mut session = fixture.create_session();
	let expected = session.blobs().put(OUTPUT).unwrap();
	std::fs::write(session.blobs().path(&expected), vec![b'x'; OUTPUT.len()]).unwrap();
	let before = session.entry_count();
	let result = publish_evidence(
		&mut session,
		&fixture.client,
		submission(&snapshot, &policy, &[EvidencePayload { name: "stdout", bytes: OUTPUT }]),
		EvidenceLimits::default(),
		&CancellationToken::new(),
	)
	.await;
	assert!(result.is_err());
	assert_eq!(session.entry_count(), before, "failed integrity must publish no claim");
}

#[tokio::test]
async fn cancellation_and_each_budget_refuse_without_a_journal_claim() {
	let fixture = Fixture::new().await;
	let snapshot = fixture.capture().await;
	let policy = policy(&snapshot);
	let mut session = fixture.create_session();
	let payloads = [EvidencePayload { name: "stdout", bytes: OUTPUT }];
	let cancel = CancellationToken::new();
	cancel.cancel();
	let before = session.entry_count();
	assert!(
		publish_evidence(
			&mut session,
			&fixture.client,
			submission(&snapshot, &policy, &payloads),
			EvidenceLimits::default(),
			&cancel,
		)
		.await
		.is_err()
	);
	for limits in [
		EvidenceLimits { max_blobs: 1, ..Default::default() },
		EvidenceLimits { max_blob_bytes: 1, ..Default::default() },
		EvidenceLimits { max_total_bytes: 1, ..Default::default() },
		EvidenceLimits { max_record_bytes: 1, ..Default::default() },
	] {
		assert!(
			publish_evidence(
				&mut session,
				&fixture.client,
				submission(&snapshot, &policy, &payloads),
				limits,
				&CancellationToken::new(),
			)
			.await
			.is_err()
		);
		assert_eq!(session.entry_count(), before);
	}
}

#[tokio::test]
async fn metadata_and_repeated_payload_work_budgets_are_checked_before_environment_io() {
	let fixture = Fixture::new().await;
	let snapshot = fixture.capture().await;
	let policy = policy(&snapshot);
	let mut session = fixture.create_session();
	let before = session.entry_count();
	let (closed_environment, transport) = EnvClient::in_process(1);
	drop(transport);
	let long_name = "oversized-artifact-name".repeat(16);
	let payloads = [EvidencePayload { name: &long_name, bytes: b"same" }];
	let metadata = publish_evidence(
		&mut session,
		&closed_environment,
		submission(&snapshot, &policy, &payloads),
		EvidenceLimits { max_record_bytes: 128, ..Default::default() },
		&CancellationToken::new(),
	)
	.await;
	assert!(matches!(
		metadata,
		Err(EvidenceError::Limit { resource: "metadata-bytes", limit: 128, .. })
	));
	let repeated = [
		EvidencePayload { name: "a", bytes: b"same" },
		EvidencePayload { name: "b", bytes: b"same" },
		EvidencePayload { name: "c", bytes: b"same" },
	];
	let work = publish_evidence(
		&mut session,
		&closed_environment,
		submission(&snapshot, &policy, &repeated),
		EvidenceLimits { max_total_bytes: 8, ..Default::default() },
		&CancellationToken::new(),
	)
	.await;
	assert!(matches!(
		work,
		Err(EvidenceError::Limit { resource: "payload-bytes", limit: 8, actual: 12 })
	));
	assert_eq!(session.entry_count(), before);
	assert!(!session.blobs().has(&reference(snapshot.canonical_bytes())));
	assert!(!session.blobs().has(&reference(b"same")));
}

#[tokio::test]
async fn oversized_sparse_source_or_output_blobs_refuse_loading_by_size() {
	let fixture = Fixture::new().await;
	let snapshot = fixture.capture().await;
	let policy = policy(&snapshot);
	let mut session = fixture.create_session();
	let published = fixture.publish(&mut session, &snapshot, &policy).await;
	let record = load_evidence(&session, published).unwrap();
	for artifact in [reference(SOURCE), record.artifacts[0].blob] {
		let original = session.blobs().get(&artifact).unwrap();
		let path = session.blobs().path(&artifact);
		std::fs::OpenOptions::new()
			.write(true)
			.open(&path)
			.unwrap()
			.set_len(16 * 1024 * 1024)
			.unwrap();
		assert!(matches!(
			load_evidence(&session, published),
			Err(EvidenceError::CorruptBlob { hash }) if hash == artifact.hash
		));
		std::fs::write(path, original).unwrap();
		assert!(load_evidence(&session, published).is_ok());
	}
}

#[tokio::test]
async fn missing_provenance_and_ambiguous_payload_inventory_refuse_publication() {
	let fixture = Fixture::new().await;
	let snapshot = fixture.capture().await;
	let policy = policy(&snapshot);
	let mut session = fixture.create_session();
	let payloads = [EvidencePayload { name: "stdout", bytes: OUTPUT }];
	let before = session.entry_count();
	for invalid in ["", "   "] {
		let mut request = submission(&snapshot, &policy, &payloads);
		request.provenance.provider = Str::new(invalid);
		assert!(
			publish_evidence(
				&mut session,
				&fixture.client,
				request,
				EvidenceLimits::default(),
				&CancellationToken::new(),
			)
			.await
			.is_err()
		);
	}
	let mut no_version = submission(&snapshot, &policy, &payloads);
	no_version.provenance.version = Str::default();
	assert!(
		publish_evidence(
			&mut session,
			&fixture.client,
			no_version,
			EvidenceLimits::default(),
			&CancellationToken::new(),
		)
		.await
		.is_err()
	);
	for payloads in [
		Vec::new(),
		vec![EvidencePayload { name: "", bytes: OUTPUT }],
		vec![EvidencePayload { name: "   ", bytes: OUTPUT }],
		vec![EvidencePayload { name: "stdout", bytes: OUTPUT }, EvidencePayload {
			name:  "stdout",
			bytes: b"different bytes",
		}],
	] {
		assert!(
			publish_evidence(
				&mut session,
				&fixture.client,
				submission(&snapshot, &policy, &payloads),
				EvidenceLimits::default(),
				&CancellationToken::new(),
			)
			.await
			.is_err()
		);
	}
	assert_eq!(session.entry_count(), before);
}

#[tokio::test]
async fn an_interrupted_put_has_no_replayed_claim_and_is_collectible() {
	let fixture = Fixture::new().await;
	let session = fixture.create_session();
	let before = session.entry_count();
	// Models a crash after the native CAS finalizes bytes, before patch
	// publication.
	let orphan = session.blobs().put(b"interrupted verifier output").unwrap();
	drop(session);
	let reopened = fixture.reopen_session();
	assert_eq!(reopened.entry_count(), before);
	assert!(
		!reopened
			.entries()
			.any(|entry| entry.label.as_deref() == Some("verification.evidence"))
	);
	drop(reopened);
	let store = BlobStore::open(fixture.journal.parent().unwrap()).unwrap();
	collect_blobs(&store, std::slice::from_ref(&fixture.journal), no_grace()).unwrap();
	assert!(!store.has(&orphan));
}

#[tokio::test]
async fn rewound_evidence_is_historical_until_republished_on_the_selected_branch() {
	let fixture = Fixture::new().await;
	let snapshot = fixture.capture().await;
	let policy = policy(&snapshot);
	let mut session = fixture.create_session();
	let genesis = session.head().unwrap();
	let published = fixture.publish(&mut session, &snapshot, &policy).await;
	session.rewind(genesis).unwrap();
	assert!(
		!session
			.live_entries()
			.any(|entry| entry.id == published.entry)
	);
	assert!(load_evidence(&session, published).is_err());
	session
		.patch(Txn {
			cause: genesis,
			label: Some(Str::new_static("selected-branch")),
			ops:   Vec::new(),
		})
		.unwrap();
	drop(session);
	let mut reopened = fixture.reopen_session();
	assert!(load_evidence(&reopened, published).is_err());
	let current = fixture.publish(&mut reopened, &snapshot, &policy).await;
	assert!(
		reopened
			.live_entries()
			.any(|entry| entry.id == current.entry)
	);
	assert!(load_evidence(&reopened, current).is_ok());
}

#[tokio::test]
async fn current_snapshot_and_configuration_are_required_without_relabeling_old_evidence() {
	let fixture = Fixture::new().await;
	let snapshot = fixture.capture().await;
	let policy = policy(&snapshot);
	let mut session = fixture.create_session();
	let published = fixture.publish(&mut session, &snapshot, &policy).await;
	let original = load_evidence(&session, published).unwrap();
	assert!(
		evidence_observation(
			&session,
			published,
			&snapshot,
			&policy,
			Hash32::sum(b"another command"),
		)
		.is_err()
	);
	std::fs::write(fixture.root.join("source.rs"), "pub fn answer() -> u32 { 43 }\n").unwrap();
	let next = fixture.capture().await;
	let next_policy = self::policy(&next);
	assert!(
		evidence_observation(&session, published, &next, &next_policy, configuration()).is_err()
	);
	assert_eq!(load_evidence(&session, published).unwrap(), original);
	let forged = EvidencePublication { entry: published.entry, identity: Hash32::sum(b"forged") };
	assert!(load_evidence(&session, forged).is_err());
}

#[tokio::test]
async fn a_foreign_blob_namespace_cannot_borrow_the_journal_gc_lease() {
	let fixture = Fixture::new().await;
	let snapshot = fixture.capture().await;
	let policy = policy(&snapshot);
	let foreign = BlobStore::open(fixture._temp.path().join("foreign-cas")).unwrap();
	let mut session =
		Session::create_with_blob_store(&fixture.journal, ComponentRegistry::default(), foreign)
			.unwrap();
	let before = session.entry_count();
	assert!(
		publish_evidence(
			&mut session,
			&fixture.client,
			submission(&snapshot, &policy, &[EvidencePayload { name: "stdout", bytes: OUTPUT }]),
			EvidenceLimits::default(),
			&CancellationToken::new(),
		)
		.await
		.is_err()
	);
	assert_eq!(session.entry_count(), before);
}
