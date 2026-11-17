//! Immutable verification evidence over the session's journal and blob CAS.

use std::{
	collections::{BTreeMap, BTreeSet},
	io::{self, Read as _},
	sync::Arc,
};

use bytes::Bytes;
use omp_core::{Hash32, Str, sf};
use omp_dom::{Handle, NodeSpec, Op, PropKey, Tag, Txn, Value};
use omp_env::EnvClient;
use omp_exec::{Digest, capture_entries};
use omp_exec_reapi::cas::InputSource as _;
use omp_journal::{
	Entry, EntryId,
	blob::{BlobRef, BlobStore},
	data::Patch,
	idempotency::IdempotencyKey,
	kind,
};
use omp_session::{Session, SessionError};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::{
	CheckObservation, CheckOutcome, SnapshotError, VerificationPolicy, VerificationScope,
	VerificationSnapshot,
};
use crate::exec_composer::EnvironmentInputs;

const LABEL: &str = "verification.evidence";
const VERSION: u32 = 1;
const MAX_BLOBS: usize = 8192;
const MAX_BLOB_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
// The keyed patch stores the receipt twice; reserve 64 KiB for its envelope
// beneath the journal's one-MiB payload ceiling.
const MAX_RECORD_BYTES: usize = 480 * 1024;

/// A raw leaf artifact, such as an execution transcript or diagnostic report.
/// Bytes must not be a manifest requiring undisclosed child artifacts.
pub struct EvidencePayload<'a> {
	/// Stable unique artifact name within this publication.
	pub name:  &'a str,
	/// Complete leaf bytes; limits refuse rather than truncate them.
	pub bytes: &'a [u8],
}

/// Host-admitted provider identity, not proof that a check executed correctly.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceProvenance {
	/// Deterministic or semantic provider identity.
	pub provider: Str,
	/// Actual provider implementation/tool version admitted by the host.
	pub version:  Str,
}

/// One host-admitted result to retain; S3 does not execute or attest the check.
pub struct EvidenceSubmission<'a> {
	/// Captured source and supplemental-input identities.
	pub snapshot:      &'a VerificationSnapshot,
	/// Exact selected required-check policy.
	pub policy:        &'a VerificationPolicy,
	/// Declared check identity.
	pub check:         &'a str,
	/// Exact per-check invocation/configuration identity.
	pub configuration: Hash32,
	/// Result admitted by the host; never inferred from artifact presence.
	pub outcome:       CheckOutcome,
	/// Host-admitted producer identity.
	pub provenance:    EvidenceProvenance,
	/// Nonempty collection of complete raw leaf artifacts.
	pub payloads:      &'a [EvidencePayload<'a>],
}

/// Resource bounds that may tighten, but not exceed, the S3 format limits.
#[derive(Clone, Copy, Debug)]
pub struct EvidenceLimits {
	/// Maximum distinct retained blobs.
	pub max_blobs:        usize,
	/// Maximum bytes in any one source or evidence blob.
	pub max_blob_bytes:   u64,
	/// Maximum distinct retained bytes and aggregate raw-payload input bytes.
	pub max_total_bytes:  u64,
	/// Maximum canonical receipt bytes; journal publication includes two copies.
	pub max_record_bytes: usize,
}

impl Default for EvidenceLimits {
	fn default() -> Self {
		Self {
			max_blobs:        MAX_BLOBS,
			max_blob_bytes:   MAX_BLOB_BYTES,
			max_total_bytes:  MAX_TOTAL_BYTES,
			max_record_bytes: MAX_RECORD_BYTES,
		}
	}
}

/// One immutable artifact address within an evidence receipt.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceArtifact {
	/// Stable name within this publication.
	pub name: Str,
	/// Local session-CAS leaf address.
	pub blob: BlobRef,
}

/// Content-addressed receipt whose complete retention closure is inline.
/// Supplemental S2 hashes identify inputs; this does not retain undisclosed
/// dependency bytes or establish producer trust, coverage or execution truth.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceRecord {
	/// Evidence format version.
	pub version:       u32,
	/// Source and selected-policy identity.
	pub scope:         VerificationScope,
	/// Declared check identity.
	pub check:         Str,
	/// Exact per-check configuration identity.
	pub configuration: Hash32,
	/// S2 full-input action key.
	pub applicability: Hash32,
	/// Host-admitted producer metadata.
	pub provenance:    EvidenceProvenance,
	/// Original admitted outcome; reuse never relabels it.
	pub outcome:       CheckOutcome,
	/// Canonical S2 snapshot bytes in the local session CAS.
	pub snapshot:      BlobRef,
	/// Native source manifest imported into the local session CAS.
	pub manifest:      BlobRef,
	/// Raw named leaf artifacts, ordered by name.
	pub artifacts:     Arc<[EvidenceArtifact]>,
	/// Exact sorted, deduplicated source/snapshot/artifact closure.
	pub closure:       Arc<[BlobRef]>,
}

/// Durable journal identity and canonical receipt digest, not a gate verdict.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EvidencePublication {
	/// Journal entry publishing the immutable receipt.
	pub entry:    EntryId,
	/// SHA-256 of canonical receipt bytes.
	pub identity: Hash32,
}

/// Evidence could not be retained, authenticated or applied to current inputs.
#[derive(Debug, thiserror::Error)]
pub enum EvidenceError {
	/// Journal and CAS do not share the namespace protected by the journal
	/// lease.
	#[error("verification evidence requires a co-located session journal and CAS")]
	NamespaceMismatch,
	/// A name/provenance is blank, an artifact is duplicated, or limits are
	/// invalid.
	#[error("verification evidence submission is invalid")]
	InvalidSubmission,
	/// A configured resource bound would be exceeded; no truncation is
	/// permitted.
	#[error("verification evidence exceeds {resource} limit {limit}: {actual}")]
	Limit {
		/// Resource whose bound was exceeded.
		resource: &'static str,
		/// Admitted maximum.
		limit:    u64,
		/// Observed requirement.
		actual:   u64,
	},
	/// An immutable blob's consumed bytes do not match its address.
	#[error("verification evidence blob is corrupt: {hash}")]
	CorruptBlob {
		/// Expected content address.
		hash: Hash32,
	},
	/// Receipt/schema/retention closure is inconsistent with the publication.
	#[error("verification evidence receipt is malformed")]
	InvalidRecord,
	/// A receipt does not belong to the session's selected live ancestry.
	#[error("verification evidence is not in the selected journal ancestry")]
	NotLive,
	/// Input, policy or invocation identity differs from the original evidence.
	#[error("verification evidence does not apply to current inputs")]
	NotApplicable,
	/// Publication was cancelled before its journal commit.
	#[error("verification evidence publication was cancelled")]
	Cancelled,
	/// Native source capture could not be read.
	#[error("verification source evidence could not be read")]
	Source(#[from] io::Error),
	/// Session-CAS operation failed.
	#[error("verification evidence blob operation failed")]
	Blob(#[from] omp_journal::blob::Error),
	/// Receipt JSON could not be encoded or decoded.
	#[error("verification evidence JSON is invalid")]
	Json(#[from] serde_json::Error),
	/// Session transaction failed; no independent evidence database is used.
	#[error("verification evidence journal transaction failed")]
	Session(#[from] SessionError),
	/// S2 rejected policy/action applicability.
	#[error("verification evidence snapshot is invalid")]
	Snapshot(#[from] SnapshotError),
}

fn namespace(session: &Session) -> Result<(), EvidenceError> {
	if session.journal_path().parent() != Some(session.blobs().root()) {
		return Err(EvidenceError::NamespaceMismatch);
	}
	Ok(())
}

fn bound(resource: &'static str, actual: u64, limit: u64) -> Result<(), EvidenceError> {
	if actual > limit {
		return Err(EvidenceError::Limit { resource, limit, actual });
	}
	Ok(())
}

fn checked_limits(limits: EvidenceLimits) -> Result<(), EvidenceError> {
	if limits.max_blobs > MAX_BLOBS
		|| limits.max_blob_bytes > MAX_BLOB_BYTES
		|| limits.max_total_bytes > MAX_TOTAL_BYTES
		|| limits.max_record_bytes > MAX_RECORD_BYTES
	{
		return Err(EvidenceError::InvalidSubmission);
	}
	Ok(())
}

fn read_verified(store: &BlobStore, reference: BlobRef) -> Result<Bytes, EvidenceError> {
	bound("blob-bytes", reference.size, MAX_BLOB_BYTES)?;
	let range = store.open_range(reference.hash, 0, reference.size)?;
	if range.reference() != reference {
		return Err(EvidenceError::CorruptBlob { hash: reference.hash });
	}
	let mut bytes = Vec::with_capacity(reference.size as usize);
	range
		.into_file()
		.take(reference.size + 1)
		.read_to_end(&mut bytes)
		.map_err(omp_journal::blob::Error::from)?;
	if bytes.len() as u64 != reference.size || Hash32::sum(&bytes) != reference.hash {
		return Err(EvidenceError::CorruptBlob { hash: reference.hash });
	}
	Ok(Bytes::from(bytes))
}

struct Retention {
	refs:   BTreeMap<Hash32, BlobRef>,
	bytes:  u64,
	limits: EvidenceLimits,
}

impl Retention {
	fn admit(&mut self, reference: BlobRef) -> Result<(), EvidenceError> {
		bound("blob-bytes", reference.size, self.limits.max_blob_bytes)?;
		if let Some(existing) = self.refs.get(&reference.hash) {
			if *existing != reference {
				return Err(EvidenceError::InvalidRecord);
			}
			return Ok(());
		}
		bound("blob-count", self.refs.len() as u64 + 1, self.limits.max_blobs as u64)?;
		let bytes = self
			.bytes
			.checked_add(reference.size)
			.ok_or(EvidenceError::InvalidRecord)?;
		bound("total-bytes", bytes, self.limits.max_total_bytes)?;
		self.bytes = bytes;
		self.refs.insert(reference.hash, reference);
		Ok(())
	}

	fn put(&mut self, store: &BlobStore, bytes: &[u8]) -> Result<BlobRef, EvidenceError> {
		bound("blob-bytes", bytes.len() as u64, self.limits.max_blob_bytes)?;
		let reference = BlobRef { hash: Hash32::sum(bytes), size: bytes.len() as u64 };
		self.admit(reference)?;
		let stored = store.put(bytes)?;
		if stored != reference || read_verified(store, reference)?.as_ref() != bytes {
			return Err(EvidenceError::CorruptBlob { hash: reference.hash });
		}
		Ok(reference)
	}
}

/// Imports and verifies source/leaf evidence before one idempotent session
/// patch. Holding `&mut Session` retains its existing journal namespace lease
/// throughout asynchronous source import. Cancellation observed before
/// synchronous publication leaves only orphan blobs; once publication starts,
/// its completion is returned without another await.
pub async fn publish_evidence(
	session: &mut Session,
	environment: &EnvClient,
	submission: EvidenceSubmission<'_>,
	limits: EvidenceLimits,
	cancel: &CancellationToken,
) -> Result<EvidencePublication, EvidenceError> {
	tokio::select! {
		biased;
		() = cancel.cancelled() => Err(EvidenceError::Cancelled),
		result = publish(session, environment, submission, limits, cancel) => result,
	}
}

async fn publish(
	session: &mut Session,
	environment: &EnvClient,
	submission: EvidenceSubmission<'_>,
	limits: EvidenceLimits,
	cancel: &CancellationToken,
) -> Result<EvidencePublication, EvidenceError> {
	namespace(session)?;
	checked_limits(limits)?;
	bound("artifact-count", submission.payloads.len() as u64, MAX_BLOBS as u64)?;
	let mut metadata_bytes = submission.check.len() as u64;
	for length in std::iter::once(submission.provenance.provider.len())
		.chain(std::iter::once(submission.provenance.version.len()))
		.chain(submission.payloads.iter().map(|payload| payload.name.len()))
	{
		metadata_bytes = metadata_bytes
			.checked_add(length as u64)
			.ok_or(EvidenceError::InvalidSubmission)?;
	}
	bound("metadata-bytes", metadata_bytes, limits.max_record_bytes as u64)?;
	let mut payload_bytes = 0_u64;
	for payload in submission.payloads {
		bound("blob-bytes", payload.bytes.len() as u64, limits.max_blob_bytes)?;
		payload_bytes = payload_bytes
			.checked_add(payload.bytes.len() as u64)
			.ok_or(EvidenceError::InvalidSubmission)?;
	}
	bound("payload-bytes", payload_bytes, limits.max_total_bytes)?;
	if submission.check.trim().is_empty()
		|| submission.provenance.provider.trim().is_empty()
		|| submission.provenance.version.trim().is_empty()
		|| submission.payloads.is_empty()
	{
		return Err(EvidenceError::InvalidSubmission);
	}
	bound("artifact-count", submission.payloads.len() as u64, limits.max_blobs as u64)?;
	let mut names = BTreeSet::new();
	for payload in submission.payloads {
		bound("artifact-name-bytes", payload.name.len() as u64, limits.max_record_bytes as u64)?;
		if payload.name.trim().is_empty() || !names.insert(payload.name) {
			return Err(EvidenceError::InvalidSubmission);
		}
	}
	let applicability = submission.snapshot.applicability_key(
		submission.policy,
		submission.check,
		submission.configuration,
	)?;
	let mut retention = Retention { refs: BTreeMap::new(), bytes: 0, limits };
	let snapshot = retention.put(session.blobs(), submission.snapshot.canonical_bytes())?;
	let native = EnvironmentInputs::new(environment.clone());
	let digest = submission.snapshot.manifest();
	bound("blob-bytes", digest.size, limits.max_blob_bytes)?;
	let manifest_bytes = native.bytes(digest).await?;
	let source_entries = capture_entries(&manifest_bytes)?;
	bound("source-paths", source_entries.len() as u64, limits.max_blobs as u64)?;
	let manifest = retention.put(session.blobs(), &manifest_bytes)?;
	for file in native.files(digest).await? {
		let reference = BlobRef { hash: file.digest.hash, size: file.digest.size };
		let already_verified = retention.refs.contains_key(&reference.hash);
		retention.admit(reference)?;
		if already_verified {
			continue;
		}
		if session.blobs().has(&reference) {
			read_verified(session.blobs(), reference)?;
		} else {
			let bytes = native.bytes(file.digest).await?;
			retention.put(session.blobs(), &bytes)?;
		}
	}
	let mut artifacts = Vec::with_capacity(submission.payloads.len());
	for payload in submission.payloads {
		let blob = retention.put(session.blobs(), payload.bytes)?;
		artifacts.push(EvidenceArtifact { name: Str::new(payload.name), blob });
	}
	artifacts.sort_unstable_by(|left, right| left.name.cmp(&right.name));
	let record = EvidenceRecord {
		version: VERSION,
		scope: submission.policy.scope(),
		check: Str::new(submission.check),
		configuration: submission.configuration,
		applicability,
		provenance: submission.provenance,
		outcome: submission.outcome,
		snapshot,
		manifest,
		artifacts: artifacts.into(),
		closure: retention.refs.into_values().collect::<Vec<_>>().into(),
	};
	let encoded = serde_json::to_vec(&record)?;
	bound("record-bytes", encoded.len() as u64, limits.max_record_bytes as u64)?;
	let identity = Hash32::sum(&encoded);
	let key = IdempotencyKey::new(sf!("verification-evidence:{}", identity.to_hex()));
	let cause = session.head().ok_or(EvidenceError::InvalidRecord)?;
	let txn = Txn {
		cause,
		label: Some(Str::new_static(LABEL)),
		ops: vec![Op::Ins {
			parent: session.dom().meta(),
			after:  None,
			node:   NodeSpec::new(Tag::Custom(Str::new_static("verification-evidence"))).with_prop(
				PropKey::Custom(Str::new_static("receipt")),
				Value::Json(serde_json::value::to_raw_value(&record)?),
			),
		}],
	};
	if cancel.is_cancelled() {
		return Err(EvidenceError::Cancelled);
	}
	let entry = session.patch_keyed(txn, key, &record)?.entry();
	Ok(EvidencePublication { entry, identity })
}

/// Loads immutable evidence only from selected live ancestry and verifies every
/// consumed blob's bytes. A journal identity is not proof of provider honesty.
pub fn load_evidence(
	session: &Session,
	publication: EvidencePublication,
) -> Result<EvidenceRecord, EvidenceError> {
	namespace(session)?;
	let entry = session
		.live_entries()
		.find(|entry| entry.id == publication.entry)
		.ok_or(EvidenceError::NotLive)?;
	let (record, identity) = decode_record(entry, session.dom().meta())?;
	if identity != publication.identity {
		return Err(EvidenceError::InvalidRecord);
	}
	validate_record(session.blobs(), &record)?;
	Ok(record)
}

/// Discovers committed evidence after restart, including publication whose
/// caller did not receive an acknowledgement. This validates receipt metadata;
/// [`load_evidence`] must still verify all bytes before use.
pub fn evidence_publications(session: &Session) -> Result<Vec<EvidencePublication>, EvidenceError> {
	namespace(session)?;
	let mut publications = Vec::new();
	for entry in session
		.live_entries()
		.filter(|entry| entry.label.as_deref() == Some(LABEL))
	{
		let (record, identity) = decode_record(entry, session.dom().meta())?;
		validate_metadata(&record)?;
		publications.push(EvidencePublication { entry: entry.id, identity });
	}
	Ok(publications)
}

fn decode_record(entry: &Entry, meta: Handle) -> Result<(EvidenceRecord, Hash32), EvidenceError> {
	if entry.kind.name.as_str() != kind::PATCH
		|| entry.kind.rev != 1
		|| entry.label.as_deref() != Some(LABEL)
	{
		return Err(EvidenceError::InvalidRecord);
	}
	let patch: Patch = serde_json::from_str(entry.data.as_str())?;
	let keyed = patch.idempotency.ok_or(EvidenceError::InvalidRecord)?;
	bound("record-bytes", keyed.request.get().len() as u64, MAX_RECORD_BYTES as u64)?;
	let record: EvidenceRecord = serde_json::from_str(keyed.request.get())?;
	let ops: Vec<Op> = serde_json::from_str(patch.ops.get())?;
	let [Op::Ins { parent, after: None, node }] = ops.as_slice() else {
		return Err(EvidenceError::InvalidRecord);
	};
	if *parent != meta || node.tag.as_str() != "verification-evidence" || node.content.is_some() {
		return Err(EvidenceError::InvalidRecord);
	}
	let [(PropKey::Custom(prop), Value::Json(value))] = node.props.as_ref() else {
		return Err(EvidenceError::InvalidRecord);
	};
	if prop != "receipt" || serde_json::from_str::<EvidenceRecord>(value.get())? != record {
		return Err(EvidenceError::InvalidRecord);
	}
	let canonical = serde_json::to_vec(&record)?;
	let identity = Hash32::sum(&canonical);
	if record.version != VERSION
		|| keyed.key.as_str() != sf!("verification-evidence:{}", identity.to_hex()).as_str()
	{
		return Err(EvidenceError::InvalidRecord);
	}
	Ok((record, identity))
}

fn validate_metadata(record: &EvidenceRecord) -> Result<BTreeMap<Hash32, BlobRef>, EvidenceError> {
	if record.check.trim().is_empty()
		|| record.provenance.provider.trim().is_empty()
		|| record.provenance.version.trim().is_empty()
		|| record.artifacts.is_empty()
	{
		return Err(EvidenceError::InvalidRecord);
	}
	let mut retained =
		Retention { refs: BTreeMap::new(), bytes: 0, limits: EvidenceLimits::default() };
	let mut previous = None;
	for reference in record.closure.iter().copied() {
		if previous.is_some_and(|hash| hash >= reference.hash) {
			return Err(EvidenceError::InvalidRecord);
		}
		previous = Some(reference.hash);
		retained.admit(reference)?;
	}
	let mut names = BTreeSet::new();
	let mut previous_name: Option<&Str> = None;
	for artifact in record.artifacts.iter() {
		if artifact.name.trim().is_empty()
			|| !names.insert(&artifact.name)
			|| previous_name.is_some_and(|name| name >= &artifact.name)
		{
			return Err(EvidenceError::InvalidRecord);
		}
		previous_name = Some(&artifact.name);
		if retained.refs.get(&artifact.blob.hash) != Some(&artifact.blob) {
			return Err(EvidenceError::InvalidRecord);
		}
	}
	if retained.refs.get(&record.snapshot.hash) != Some(&record.snapshot)
		|| retained.refs.get(&record.manifest.hash) != Some(&record.manifest)
	{
		return Err(EvidenceError::InvalidRecord);
	}
	Ok(retained.refs)
}

fn validate_record(store: &BlobStore, record: &EvidenceRecord) -> Result<(), EvidenceError> {
	let retained = validate_metadata(record)?;
	let snapshot_bytes = read_verified(store, record.snapshot)?;
	if Hash32::sum(&snapshot_bytes) != record.scope.inputs {
		return Err(EvidenceError::InvalidRecord);
	}
	#[derive(Deserialize)]
	struct SnapshotManifest {
		domain:   Str,
		version:  u32,
		manifest: Digest,
		files:    u64,
		bytes:    u64,
	}
	let snapshot: SnapshotManifest = serde_json::from_slice(&snapshot_bytes)?;
	if snapshot.domain != super::snapshot::SNAPSHOT_DOMAIN
		|| snapshot.version != super::snapshot::KEY_VERSION
		|| snapshot.files == 0
		|| snapshot.manifest.hash != record.manifest.hash
		|| snapshot.manifest.size != record.manifest.size
	{
		return Err(EvidenceError::InvalidRecord);
	}
	let manifest_bytes = read_verified(store, record.manifest)?;
	let entries = capture_entries(&manifest_bytes)?;
	bound("source-paths", entries.len() as u64, MAX_BLOBS as u64)?;
	if snapshot.files != entries.len() as u64 {
		return Err(EvidenceError::InvalidRecord);
	}
	let mut expected = BTreeSet::from([record.snapshot.hash, record.manifest.hash]);
	let mut paths = BTreeSet::new();
	let mut bytes = 0_u64;
	for entry in entries {
		if !super::snapshot::valid_path(&entry.path) || !paths.insert(entry.path) {
			return Err(EvidenceError::InvalidRecord);
		}
		let reference = retained
			.get(&entry.hash)
			.ok_or(EvidenceError::InvalidRecord)?;
		bytes = bytes
			.checked_add(reference.size)
			.ok_or(EvidenceError::InvalidRecord)?;
		expected.insert(entry.hash);
	}
	if snapshot.bytes != bytes {
		return Err(EvidenceError::InvalidRecord);
	}
	for artifact in record.artifacts.iter() {
		expected.insert(artifact.blob.hash);
	}
	if expected.len() != retained.len() || expected.iter().any(|hash| !retained.contains_key(hash)) {
		return Err(EvidenceError::InvalidRecord);
	}
	for reference in record.closure.iter().copied() {
		read_verified(store, reference)?;
	}
	Ok(())
}

/// Produces a retained observation only for identical supplied input, policy
/// and invocation identities. The caller must establish snapshot freshness or
/// frozen execution inputs; this function does not recapture the live tree.
/// Changed revisions need fresh evidence and are never relabeled as checked.
pub fn evidence_observation(
	session: &Session,
	publication: EvidencePublication,
	snapshot: &VerificationSnapshot,
	policy: &VerificationPolicy,
	configuration: Hash32,
) -> Result<CheckObservation, EvidenceError> {
	let record = load_evidence(session, publication)?;
	let current = snapshot.applicability_key(policy, &record.check, configuration)?;
	if record.scope != policy.scope()
		|| record.configuration != configuration
		|| record.applicability != current
	{
		return Err(EvidenceError::NotApplicable);
	}
	Ok(CheckObservation {
		id:       record.check,
		scope:    record.scope,
		evidence: Some(publication.identity),
		outcome:  record.outcome,
	})
}
