//! `omp-tools` adapters over the app-owned document and blob hosts.

use std::{
	borrow::Cow,
	collections::{BTreeMap, BTreeSet, HashSet},
	fs::{self as std_fs, OpenOptions},
	future::{Future, ready},
	io,
	path::{self, Component, Path, PathBuf},
	process, str,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time::{SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use flate2::{read::GzDecoder, write::GzEncoder};
use omp_core::{
	Hash32, Str, dirs::home_dir, encoding::hex, fs::replace_file_atomically, sf, shorten_home_path,
};
use omp_edit::{
	modes::hashline::{
		mismatch::{MismatchDetails, format_mismatch_message},
		patcher::{no_change_diagnostic, no_change_loop_diagnostic},
	},
	store::{Clipboard, EditStore, Snapshot, file_hash, payload_hash},
	text::{normalize_to_lf, strip_bom},
};
use omp_proto::document::v1::{
	self as pb, commit_transaction_response, document_mutation, document_target,
	read_document_response, read_selection, text_mutation,
};
use omp_tool::BlobRef;
use omp_tools::{
	edit::{
		CommitResult, CommittedSection, Conflict, EditAction, EditCommitError, EditDiagnostic,
		EditDiagnosticSeverity, EditDocuments, EditPrepared, EditProposal, EditSnapshotStore,
		Fault as EditFault, FormatPolicy, NoopResult, PathRecovery, PathRecoveryHow, PrepareRequest,
		RejectionReason, SnapshotFault, StalePolicy,
	},
	read::{
		Fault as ReadFault, ReadBlobs, SNAPSHOT_MAX_BYTES, StoredArtifact, archive,
		conflicts::{splice_registered, splice_registered_bulk},
		mutation::{MutationCapability, ResourceMutationReceipt, ResourceMutationRequest},
		notebook, selector,
	},
	write::{
		ConflictBulkFileRequest, ConflictBulkFileResult, ConflictSpliceRequest, ConflictSpliceResult,
		Fault as WriteFault, PlainWriteRequest, PlainWriteResult, SpecialWriteControl,
		WriteCommitError, WriteDisposition, WriteDocuments, WriteOperation, backends,
	},
};
use parking_lot::Mutex;
use tokio::task;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::{
	blobs::BlobHost,
	docs::{DocumentError, DocumentHost, DocumentLease, lease_target},
	tool_url::ssh,
};
use crate::docserver::fs::{self, LocalFs};

static NEXT_TRANSACTION: AtomicU64 = AtomicU64::new(1);

/// Permission outcomes which qualify for the attributed privileged path.
#[derive(Debug, thiserror::Error)]
pub(super) enum PrivilegedMutationFault {
	/// POSIX `EPERM`.
	#[error("operation not permitted")]
	OperationNotPermitted {
		/// Filesystem failure retaining the exact target and source errno.
		#[source]
		source: crate::docserver::Error,
	},
	/// POSIX `EACCES`.
	#[error("permission denied")]
	PermissionDenied {
		/// Filesystem failure retaining the exact target and source errno.
		#[source]
		source: crate::docserver::Error,
	},
	/// POSIX `EROFS`.
	#[error("read-only filesystem")]
	ReadOnlyFilesystem {
		/// Filesystem failure retaining the exact target and source errno.
		#[source]
		source: crate::docserver::Error,
	},
	/// A non-permission document or filesystem failure.
	#[error("privileged mutation failed")]
	Other {
		/// Typed document failure.
		#[source]
		source: crate::docserver::Error,
	},
	/// The supplied expected revision did not identify the current exact bytes.
	#[error("privileged mutation expected revision is stale")]
	StaleRevision,
}

/// Executes one approved write through the capability-rooted document
/// filesystem, with an exact presence/content precondition.
pub(super) fn privileged_write(
	root: &Path,
	target: &Path,
	content: Bytes,
	expected_present: bool,
	expected_hash: Option<&[u8; 32]>,
	mode: u32,
) -> Result<fs::DiskState, PrivilegedMutationFault> {
	use crate::docserver::fs::DiskExpectation;

	let config = crate::docserver::ServerConfig::new(root).map_err(classify_privileged)?;
	let filesystem = LocalFs::new(&config).map_err(classify_privileged)?;
	let expected = match (expected_present, filesystem.stable_read(target)) {
		(true, Ok(fs::DiskState::Present { content, fingerprint })) => {
			if expected_hash.is_some_and(|hash| Hash32::sum(&content).as_bytes() != hash) {
				return Err(PrivilegedMutationFault::StaleRevision);
			}
			DiskExpectation::Present(fingerprint)
		},
		(false, Ok(fs::DiskState::Missing)) => DiskExpectation::Missing,
		(true, Ok(fs::DiskState::Missing)) | (false, Ok(fs::DiskState::Present { .. })) => {
			return Err(PrivilegedMutationFault::StaleRevision);
		},
		(_, Err(error)) => return Err(classify_privileged(error)),
	};
	let prepared = filesystem
		.prepare_write_with_mode(target, content, expected, mode)
		.map_err(classify_privileged)?;
	filesystem
		.commit_prepared(prepared)
		.map_err(classify_privileged)
}

/// Executes one approved unlink through an already-open parent handle without
/// following the final component.
pub(super) fn privileged_unlink(
	root: &Path,
	target: &Path,
	expected_present: bool,
	expected_hash: Option<&[u8; 32]>,
	recursive: bool,
) -> Result<fs::DiskState, PrivilegedMutationFault> {
	let config = crate::docserver::ServerConfig::new(root).map_err(classify_privileged)?;
	let filesystem = LocalFs::new(&config).map_err(classify_privileged)?;
	if let Some(expected_hash) = expected_hash {
		let state = filesystem
			.stable_read(target)
			.map_err(classify_privileged)?;
		let Some(content) = state.content() else {
			return Err(PrivilegedMutationFault::StaleRevision);
		};
		if Hash32::sum(content).as_bytes() != expected_hash {
			return Err(PrivilegedMutationFault::StaleRevision);
		}
	}
	filesystem
		.remove_no_follow_if(target, expected_present, recursive)
		.map_err(classify_privileged)
}

fn classify_privileged(error: crate::docserver::Error) -> PrivilegedMutationFault {
	let errno = match &error {
		crate::docserver::Error::Persistence { source, .. }
		| crate::docserver::Error::Io { source, .. } => source.raw_os_error(),
		_ => None,
	};
	match errno {
		Some(libc::EPERM) => PrivilegedMutationFault::OperationNotPermitted { source: error },
		Some(libc::EACCES) => PrivilegedMutationFault::PermissionDenied { source: error },
		Some(libc::EROFS) => PrivilegedMutationFault::ReadOnlyFilesystem { source: error },
		_ => PrivilegedMutationFault::Other { source: error },
	}
}

struct ResolvedDestination {
	uri:  Str,
	path: Str,
}
#[derive(Debug)]
pub(super) struct ResolvedDocument {
	pub(super) uri: Str,
}

#[derive(Clone, Copy, Debug)]
enum BatchOperationRole {
	Write(usize),
	Delete(usize),
	Move(usize),
}
/// Prepared hashline edit retaining its exact protocol lease, live bytes, and
/// the retained snapshot named by the authored section tag.
#[derive(Debug)]
pub struct PreparedDocument {
	lease:           DocumentLease,
	path:            Str,
	display_path:    Str,
	base_revision:   Str,
	base_bytes:      Bytes,
	authored_bytes:  Bytes,
	raw_base_bytes:  Bytes,
	exists:          bool,
	notebook:        bool,
	path_recoveries: Vec<PathRecovery>,
}

impl EditSnapshotStore for BlobHost {
	async fn store_snapshot(&self, bytes: Bytes) -> Result<BlobRef, SnapshotFault> {
		let id = self.put(&bytes).map_err(|_| SnapshotFault::Store)?;
		Ok(BlobRef {
			hash:       Str::from(hex::encode_n(&id.hash).as_str()),
			media_type: sf!("application/octet-stream"),
			byte_len:   id.size,
		})
	}
}

/// Session-bound blob and artifact adoption authority for read-family spills.
#[derive(Clone)]
pub(crate) struct SessionReadBlobs {
	blobs: BlobHost,
}

impl SessionReadBlobs {
	/// Binds read-family spills to the journal blob store.
	pub(crate) fn open(blobs: BlobHost, _session_id: &str) -> Result<Self, Str> {
		Ok(Self { blobs })
	}
}

impl ReadBlobs for SessionReadBlobs {
	fn store(
		&self,
		bytes: Bytes,
		media_type: Str,
	) -> impl Future<Output = Result<BlobRef, ReadFault>> + Send + '_ {
		let result = self
			.blobs
			.put(&bytes)
			.map_err(|error| ReadFault::Blob { message: Str::from(error.to_string()) })
			.map(|id| BlobRef {
				hash: Str::from(hex::encode_n(&id.hash).as_str()),
				media_type,
				byte_len: id.size,
			});
		ready(result)
	}

	fn store_artifact(
		&self,
		bytes: Bytes,
		media_type: Str,
	) -> impl Future<Output = Result<StoredArtifact, ReadFault>> + Send + '_ {
		let result = (|| {
			let id = self
				.blobs
				.put(&bytes)
				.map_err(|error| ReadFault::Blob { message: Str::from(error.to_string()) })?;
			let digest = hex::encode_n(&id.hash);
			Ok(StoredArtifact {
				blob: BlobRef {
					hash: Str::from(hex::encode_n(&id.hash).as_str()),
					media_type,
					byte_len: id.size,
				},
				uri:  Str::from(format!("artifact://sha256/{digest}")),
			})
		})();
		ready(result)
	}
}

impl EditPrepared for PreparedDocument {
	fn path(&self) -> &Str {
		&self.path
	}

	fn display_path(&self) -> &Str {
		&self.display_path
	}

	fn base_revision(&self) -> &Str {
		&self.base_revision
	}

	fn base_bytes(&self) -> &Bytes {
		&self.base_bytes
	}

	fn exists(&self) -> bool {
		self.exists
	}

	fn path_recoveries(&self) -> &[PathRecovery] {
		&self.path_recoveries
	}

	fn authored_bytes(&self) -> &Bytes {
		&self.authored_bytes
	}
}

impl EditDocuments for DocumentHost {
	type Prepared = PreparedDocument;

	async fn prepare(&self, request: PrepareRequest) -> Result<Self::Prepared, EditFault> {
		if request.file_hash.is_none() && !request.allow_unpinned {
			return Err(edit_invalid(format!(
				"Missing hashline snapshot tag for {}; use `[{}#tag]` from your latest read/search \
				 output. To create a new file, use the write tool.",
				request.path, request.path
			)));
		}
		let (resolved, path_recoveries, display_path) =
			match resolve_document_for_prepare(self, &request.path, request.allow_missing) {
				Ok(resolved) => (resolved, Vec::new(), request.path.clone()),
				Err(error) => match recover_workspace_suffix(self, &request.path) {
					Ok(Some(recovered)) => recovered,
					Ok(None) | Err(_) => {
						let Some(tag) = request.file_hash.as_deref() else {
							return Err(edit_invalid(error));
						};
						match recover_edit_path(self, &request.path, tag) {
							Some(recovered) => recovered,
							None => return Err(edit_invalid(error)),
						}
					},
				},
			};
		let lease = Self::open(self, resolved.uri, None, &CancellationToken::new())
			.await
			.map_err(|error| edit_invalid(error.to_string()))?;
		if pb::DocumentKind::try_from(lease.head().kind) != Ok(pb::DocumentKind::Text) {
			return Err(edit_invalid("hashline edits require a text document"));
		}
		let base_revision = revision_identity(lease.head()).map_err(edit_invalid)?;
		let exists = lease.head().presence == pb::DocumentPresence::Present as i32;
		if !exists && !request.allow_missing {
			return Err(edit_invalid(format!("document does not exist: {}", request.path)));
		}
		let canonical_path = document_path(lease.head()).map_err(edit_invalid)?;
		let raw_base_bytes = read_whole(self, &lease)
			.await
			.map_err(|error| edit_invalid(error.to_string()))?;
		if request.guard_generated
			&& auto_generated_file(Path::new(canonical_path.as_str()), &raw_base_bytes)
		{
			return Err(edit_invalid(format!(
				"Refusing to edit auto-generated file {}; change its generator input instead",
				request.path
			)));
		}
		let notebook = canonical_path.ends_with(".ipynb");
		let base_bytes = if notebook {
			let rendered = notebook::render(&raw_base_bytes, &request.path)
				.map_err(|error| edit_invalid(error.to_string()))?;
			Bytes::from(rendered.text)
		} else {
			raw_base_bytes.clone()
		};
		let base_text = snapshot_text(&base_bytes)
			.ok_or_else(|| edit_invalid("hashline edits require UTF-8 document content"))?;
		let authored_bytes = if let Some(tag) = &request.file_hash {
			let snapshots = self.snapshot_store();
			let Some(snapshot) = snapshots.by_hash(Path::new(canonical_path.as_str()), tag) else {
				let lines = base_text.lines().map(str::to_owned).collect();
				let message = format_mismatch_message(&MismatchDetails {
					path:               Some(request.path.to_string()),
					expected_file_hash: tag.to_string(),
					actual_file_hash:   file_hash(&base_text),
					file_lines:         lines,
					anchor_lines:       request
						.anchor_lines
						.iter()
						.filter_map(|&line| u32::try_from(line).ok())
						.collect(),
					hash_recognized:    false,
				});
				return Err(edit_stale(message));
			};
			validate_seen_lines(snapshots, &snapshot, &request.path, tag, &request.anchor_lines)?;
			if snapshot.text.as_ref() == base_text.as_ref() {
				base_bytes.clone()
			} else {
				Bytes::copy_from_slice(snapshot.text.as_bytes())
			}
		} else {
			base_bytes.clone()
		};
		Ok(PreparedDocument {
			lease,
			path: canonical_path,
			display_path,
			base_revision,
			base_bytes,
			authored_bytes,
			raw_base_bytes,
			exists,
			notebook,
			path_recoveries,
		})
	}

	fn start_clipboard_batch(&self) -> Clipboard {
		self.snapshot_store().start_clipboard_batch()
	}

	fn record_noop(&self, canonical_path: &str, display_path: &str, input: Bytes) -> NoopResult {
		let (count, escalate) = self.snapshot_store().record_noop(
			Path::new(canonical_path),
			payload_hash(str::from_utf8(&input).expect("edit input is UTF-8")),
		);
		let diagnostic = if escalate {
			no_change_loop_diagnostic(display_path, count)
		} else {
			no_change_diagnostic(display_path)
		};
		NoopResult { diagnostic: diagnostic.into(), escalate }
	}

	fn reset_noop(&self, canonical_path: &str) {
		self.snapshot_store().reset_noop(Path::new(canonical_path));
	}

	async fn commit<'a>(
		&'a self,
		prepared: Vec<&'a mut Self::Prepared>,
		proposals: Vec<EditProposal>,
		clipboard: Clipboard,
	) -> Result<CommitResult, EditCommitError> {
		if prepared.len() != proposals.len() {
			return Err(edit_unknown("prepared section and proposal counts differ"));
		}
		let mut operations = Vec::with_capacity(proposals.len().saturating_mul(2));
		let mut operation_roles = Vec::with_capacity(proposals.len().saturating_mul(2));
		let mut terminal_indices = Vec::with_capacity(proposals.len());
		let mut persisted = Vec::with_capacity(proposals.len());
		let mut move_paths = Vec::with_capacity(proposals.len());
		for (section_index, (prepared, proposal)) in prepared.iter().zip(&proposals).enumerate() {
			if proposal.base_revision != prepared.base_revision {
				return Err(EditCommitError::Rejected(edit_stale(
					"prepared edit revision changed before commit",
				)));
			}
			let revision = prepared
				.lease
				.head()
				.revision
				.clone()
				.ok_or_else(|| edit_unknown("document head omitted its revision"))?;
			let target = lease_target(&prepared.lease);
			match &proposal.action {
				EditAction::Write { content } => {
					let raw = persisted_edit_bytes(prepared, content)?;
					operations.push(pb::DocumentMutation {
						document:  Some(target),
						operation: Some(document_mutation::Operation::Text(proposed_text_mutation(
							raw.clone(),
							revision.clone(),
							proposal.stale_policy,
							proposal.format_policy,
						))),
					});
					operation_roles.push(BatchOperationRole::Write(section_index));
					terminal_indices.push(operations.len() - 1);
					persisted.push(Some(content.clone()));
					move_paths.push(None);
				},
				EditAction::Delete => {
					operations.push(pb::DocumentMutation {
						document:  Some(target),
						operation: Some(document_mutation::Operation::Delete(pb::DeleteMutation {
							base_revision: Some(revision),
						})),
					});
					operation_roles.push(BatchOperationRole::Delete(section_index));
					terminal_indices.push(operations.len() - 1);
					persisted.push(None);
					move_paths.push(None);
				},
				EditAction::Move { destination, content } => {
					let raw = persisted_edit_bytes(prepared, content)?;
					let destination_uri =
						resolve_move_destination(self, destination).map_err(edit_invalid_commit)?;
					let operation = proposed_move_mutation(
						raw,
						&prepared.raw_base_bytes,
						revision,
						destination_uri.uri.to_string(),
						proposal.format_policy,
					);
					operations.push(pb::DocumentMutation {
						document:  Some(target),
						operation: Some(operation),
					});
					operation_roles.push(BatchOperationRole::Move(section_index));
					terminal_indices.push(operations.len() - 1);
					persisted.push(Some(content.clone()));
					move_paths.push(Some(destination_uri.path));
				},
			}
		}

		let _late_diagnostics =
			self.begin_late_diagnostics(prepared.iter().map(|document| document.lease.head()));
		let transaction_id = transaction_id(self.hello().server_epoch.as_ref());
		let response = self
			.commit_transaction(transaction_id.clone(), operations, &CancellationToken::new())
			.await
			.map_err(|error| edit_unknown(error.to_string()))?;
		let committed = match response.outcome {
			Some(commit_transaction_response::Outcome::Committed(committed))
				if committed.transaction_id == transaction_id =>
			{
				committed
			},
			Some(commit_transaction_response::Outcome::Rejected(rejected))
				if rejected.transaction_id == transaction_id =>
			{
				let base = prepared
					.first()
					.map_or_else(Bytes::new, |prepared| prepared.base_bytes.clone());
				return Err(EditCommitError::Rejected(map_rejection(&rejected, &base)));
			},
			Some(commit_transaction_response::Outcome::PartiallyCommitted(partial))
				if partial.transaction_id == transaction_id =>
			{
				let base = prepared
					.first()
					.map_or_else(Bytes::new, |prepared| prepared.base_bytes.clone());
				let original_fault = map_partial_rejection(&partial, &base);
				match rollback_partial_commit(self, &prepared, &operation_roles, &partial).await {
					Ok(()) => return Err(EditCommitError::Rejected(original_fault)),
					Err(reason) => return Err(EditCommitError::EffectsUnknown { reason }),
				}
			},
			Some(_) => return Err(edit_unknown("document transaction identity did not match")),
			None => return Err(edit_unknown("document transaction omitted its outcome")),
		};

		let mut sections = Vec::with_capacity(prepared.len());
		for (section_index, operation_index) in terminal_indices.into_iter().enumerate() {
			let operation = committed
				.operations
				.iter()
				.find(|operation| operation.operation_index as usize == operation_index)
				.ok_or_else(|| edit_unknown("document transaction omitted a section result"))?;
			let deleted = matches!(&proposals[section_index].action, EditAction::Delete);
			let (new_revision, content) = if deleted {
				(None, None)
			} else {
				let head = operation
					.head
					.as_ref()
					.ok_or_else(|| edit_unknown("committed operation omitted its document head"))?;
				validate_committed_metadata(operation, head).map_err(edit_unknown)?;
				let revision = revision_identity(head).map_err(edit_unknown)?;
				let content = read_committed_view(
					self,
					head,
					prepared[section_index].notebook,
					&prepared[section_index].path,
				)
				.await?;
				persisted[section_index] = Some(content.clone());
				(Some(revision), Some(content))
			};
			let (diagnostics, diagnostics_complete) = committed_diagnostics(operation);
			if let Some(head) = operation.head.as_ref() {
				self.expect_late_diagnostics(head, diagnostics_complete);
			}
			sections.push(CommittedSection {
				new_revision,
				rebased: operation.rebased,
				content,
				diagnostics,
				diagnostics_complete,
			});
		}

		let snapshots = self.snapshot_store();
		for (index, proposal) in proposals.iter().enumerate() {
			omp_walker::invalidate_path(Path::new(&prepared[index].path));
			match &proposal.action {
				EditAction::Delete => snapshots.invalidate(Path::new(prepared[index].path.as_str())),
				EditAction::Move { .. } => {
					let destination = move_paths[index]
						.as_ref()
						.expect("move proposals retain a canonical destination");
					omp_walker::invalidate_path(Path::new(destination));
					snapshots.relocate(
						Path::new(prepared[index].path.as_str()),
						Path::new(destination.as_str()),
					);
					if let Some(bytes) = persisted[index].clone() {
						record_committed_snapshot(snapshots, destination.clone(), bytes)?;
					}
				},
				EditAction::Write { .. } => {
					if let Some(bytes) = persisted[index].clone() {
						record_committed_snapshot(snapshots, prepared[index].path.clone(), bytes)?;
					}
				},
			}
		}
		self.snapshot_store().commit_clipboard(&clipboard);
		Ok(CommitResult { sections })
	}
}

async fn rollback_partial_commit(
	host: &DocumentHost,
	prepared: &[&mut PreparedDocument],
	roles: &[BatchOperationRole],
	partial: &pb::TransactionPartiallyCommitted,
) -> Result<(), Str> {
	let mut compensation = Vec::new();
	let mut restored_sections = HashSet::new();
	let mut affected_paths = BTreeSet::new();
	for operation in partial.committed_operations.iter().rev() {
		let Some(role) = roles.get(operation.operation_index as usize).copied() else {
			return Err(
				"partial transaction named an unknown operation; rollback could not be planned".into(),
			);
		};
		let section = match role {
			BatchOperationRole::Write(section)
			| BatchOperationRole::Delete(section)
			| BatchOperationRole::Move(section) => section,
		};
		if !restored_sections.insert(section) {
			continue;
		}
		let source = prepared
			.get(section)
			.ok_or_else(|| sf!("partial transaction named an unknown section"))?;
		let source_uri = source
			.lease
			.head()
			.document
			.as_ref()
			.ok_or_else(|| sf!("prepared document omitted its source URI"))?
			.uri
			.clone();
		affected_paths.insert(source.path.to_string());
		match role {
			BatchOperationRole::Write(_) => {
				let head = operation
					.head
					.as_ref()
					.ok_or_else(|| sf!("landed write omitted its current head"))?;
				compensation.push(pb::DocumentMutation {
					document:  Some(uri_target(
						head
							.document
							.as_ref()
							.ok_or_else(|| sf!("landed write omitted its URI"))?
							.uri
							.clone(),
					)),
					operation: Some(document_mutation::Operation::Text(restore_text_mutation(
						source.raw_base_bytes.clone(),
						head
							.revision
							.clone()
							.ok_or_else(|| sf!("landed write omitted its revision"))?,
					))),
				});
			},
			BatchOperationRole::Delete(_) => {
				compensation.push(pb::DocumentMutation {
					document:  Some(uri_target(source_uri)),
					operation: Some(document_mutation::Operation::Create(pb::CreateMutation {
						content:           source.raw_base_bytes.clone(),
						existing_document: pb::ExistingDocumentPolicy::FailIfExists as i32,
						format_policy:     pb::FormatPolicy::Disabled as i32,
					})),
				});
			},
			BatchOperationRole::Move(_) => {
				let head = operation
					.head
					.as_ref()
					.ok_or_else(|| sf!("landed move omitted its destination head"))?;
				let destination = head
					.document
					.as_ref()
					.ok_or_else(|| sf!("landed move omitted its destination URI"))?
					.uri
					.clone();
				if let Ok(uri) = Url::parse(&destination)
					&& let Ok(path) = uri.to_file_path()
				{
					affected_paths.insert(path.to_string_lossy().into_owned());
				}
				compensation.push(pb::DocumentMutation {
					document:  Some(uri_target(source_uri)),
					operation: Some(document_mutation::Operation::Create(pb::CreateMutation {
						content:           source.raw_base_bytes.clone(),
						existing_document: pb::ExistingDocumentPolicy::FailIfExists as i32,
						format_policy:     pb::FormatPolicy::Disabled as i32,
					})),
				});
				compensation.push(pb::DocumentMutation {
					document:  Some(uri_target(destination)),
					operation: Some(document_mutation::Operation::Delete(pb::DeleteMutation {
						base_revision: Some(
							head
								.revision
								.clone()
								.ok_or_else(|| sf!("landed move omitted its revision"))?,
						),
					})),
				});
			},
		}
	}
	if compensation.is_empty() {
		return Ok(());
	}
	let rollback_id = transaction_id(host.hello().server_epoch.as_ref());
	let outcome = host
		.commit_transaction(rollback_id.clone(), compensation, &CancellationToken::new())
		.await
		.map_err(|error| {
			sf!(
				"rollback failed for paths {}: {}",
				affected_paths
					.iter()
					.cloned()
					.collect::<Vec<_>>()
					.join(", "),
				error
			)
		})?;
	match outcome.outcome {
		Some(commit_transaction_response::Outcome::Committed(committed))
			if committed.transaction_id == rollback_id =>
		{
			Ok(())
		},
		Some(commit_transaction_response::Outcome::Rejected(rejected)) => Err(sf!(
			"rollback rejected for paths {}: {}",
			affected_paths
				.iter()
				.cloned()
				.collect::<Vec<_>>()
				.join(", "),
			rejected.message
		)),
		Some(commit_transaction_response::Outcome::PartiallyCommitted(rollback)) => Err(sf!(
			"rollback partially failed for paths {} before operation {}: {}",
			affected_paths
				.iter()
				.cloned()
				.collect::<Vec<_>>()
				.join(", "),
			rollback.failed_operation_index,
			rollback.message
		)),
		Some(_) | None => Err(sf!(
			"rollback returned an invalid outcome for paths {}",
			affected_paths
				.iter()
				.cloned()
				.collect::<Vec<_>>()
				.join(", ")
		)),
	}
}

const fn uri_target(uri: String) -> pb::DocumentTarget {
	pb::DocumentTarget { target: Some(document_target::Target::Uri(uri)) }
}

const fn restore_text_mutation(content: Bytes, revision: pb::Revision) -> pb::TextMutation {
	pb::TextMutation {
		base_revision: Some(revision),
		change:        Some(text_mutation::Change::ProposedContent(content)),
		stale_policy:  pb::StalePolicy::Fail as i32,
		format_policy: pb::FormatPolicy::Disabled as i32,
	}
}

fn map_partial_rejection(partial: &pb::TransactionPartiallyCommitted, base: &[u8]) -> EditFault {
	map_rejection(
		&pb::TransactionRejected {
			transaction_id: partial.transaction_id.clone(),
			reason:         partial.reason,
			message:        partial.message.clone(),
			conflicts:      Vec::new(),
		},
		base,
	)
}

pub(super) async fn read_whole(
	host: &DocumentHost,
	lease: &DocumentLease,
) -> Result<Bytes, DocumentError> {
	let response = host
		.read(
			lease,
			pb::ReadSelection {
				selection: Some(read_selection::Selection::Whole(pb::WholeDocument {})),
			},
			&CancellationToken::new(),
		)
		.await?;
	match response.body {
		Some(read_document_response::Body::Content(content)) => Ok(content),
		_ => {
			Err(DocumentError::MalformedResponse(sf!("whole document read did not return content",)))
		},
	}
}

async fn read_committed_view(
	host: &DocumentHost,
	head: &pb::DocumentHead,
	notebook: bool,
	display_path: &str,
) -> Result<Bytes, EditCommitError> {
	let uri = head
		.document
		.as_ref()
		.ok_or_else(|| edit_unknown("committed operation omitted its document reference"))?
		.uri
		.as_str();
	let lease = DocumentHost::open(host, uri.into(), None, &CancellationToken::new())
		.await
		.map_err(|error| edit_unknown(error.to_string()))?;
	let raw = read_whole(host, &lease)
		.await
		.map_err(|error| edit_unknown(error.to_string()))?;
	if notebook {
		let rendered =
			notebook::render(&raw, display_path).map_err(|error| edit_unknown(error.to_string()))?;
		Ok(Bytes::from(rendered.text))
	} else {
		Ok(raw)
	}
}

fn resolve_document(host: &DocumentHost, input: &str) -> Result<ResolvedDocument, String> {
	resolve_document_for_prepare(host, input, false)
}

fn resolve_document_for_prepare(
	host: &DocumentHost,
	input: &str,
	allow_missing: bool,
) -> Result<ResolvedDocument, String> {
	let root_url = Url::parse(host.hello().root_uri.as_str())
		.map_err(|error| format!("document workspace root is not a valid URI: {error}"))?;
	if root_url.scheme() != "file" {
		return Err("document workspace root is not a file URI".into());
	}
	if root_url.query().is_some() || root_url.fragment().is_some() {
		return Err("document workspace root file URI cannot contain a query or fragment".into());
	}
	let root_path = root_url
		.to_file_path()
		.map_err(|()| "document workspace root is not a local file URI".to_owned())?;
	let root_path = normalize_absolute(&root_path)?;
	let parsed = Url::parse(input).ok();
	let (candidate, preserve_uri) = if let Some(uri) = parsed {
		if uri.scheme() != "file" || uri.query().is_some() || uri.fragment().is_some() {
			return Err("document URI must be a query-free file URI inside the workspace".into());
		}
		let path = uri
			.to_file_path()
			.map_err(|()| "document URI is not a local file URI".to_owned())?;
		(normalize_absolute(&path)?, Some(uri))
	} else {
		let relative = normalize_relative(Path::new(input))?;
		(root_path.join(relative), None)
	};
	if candidate == root_path || !candidate.starts_with(&root_path) {
		return Err("document path escapes or names the workspace root".into());
	}
	ensure_canonical_containment(&root_path, &candidate, allow_missing)?;
	let uri = match preserve_uri {
		Some(uri) => uri,
		None => Url::from_file_path(&candidate)
			.map_err(|()| "document path cannot be represented as a file URI".to_owned())?,
	};
	Ok(ResolvedDocument { uri: Str::from(uri.as_str()) })
}

fn recover_edit_path(
	host: &DocumentHost,
	authored_path: &str,
	tag: &str,
) -> Option<(ResolvedDocument, Vec<PathRecovery>, Str)> {
	if Url::parse(authored_path).is_ok() || normalize_relative(Path::new(authored_path)).is_err() {
		return None;
	}
	let authored_name = Path::new(authored_path).file_name()?;
	let mut candidates = host
		.snapshot_store()
		.find_by_hash(tag)
		.into_iter()
		.filter(|snapshot| snapshot.path.file_name() == Some(authored_name))
		.map(|snapshot| Str::from(snapshot.path.to_string_lossy().into_owned()))
		.collect::<Vec<_>>();
	candidates.sort_unstable();
	candidates.dedup();
	let resolved_path = candidates.pop()?;
	if !candidates.is_empty() {
		return None;
	}
	let uri = Url::from_file_path(resolved_path.as_str()).ok()?;
	let resolved = resolve_document(host, uri.as_str()).ok()?;
	let recovery = PathRecovery {
		authored: Str::new(authored_path),
		resolved: resolved_path.clone(),
		how:      PathRecoveryHow::FilenameSnapshotTag,
	};
	Some((resolved, vec![recovery], resolved_path))
}

fn recover_workspace_suffix(
	host: &DocumentHost,
	authored_path: &str,
) -> Result<Option<(ResolvedDocument, Vec<PathRecovery>, Str)>, String> {
	if Url::parse(authored_path).is_ok() {
		return Ok(None);
	}
	let suffix = normalize_relative(Path::new(authored_path))?;
	let root_url = Url::parse(host.hello().root_uri.as_str())
		.map_err(|error| format!("document workspace root is not a valid URI: {error}"))?;
	let root = root_url
		.to_file_path()
		.map_err(|()| "document workspace root is not a local file URI".to_owned())?;
	let Some(path) = find_unique_workspace_suffix(&root, &suffix)? else {
		return Ok(None);
	};
	let relative = path
		.strip_prefix(&root)
		.map_err(|_| "recovered path escaped workspace root".to_owned())?;
	let display = Str::from(relative.to_string_lossy().replace('\\', "/"));
	let uri = Url::from_file_path(&path)
		.map_err(|()| "recovered path cannot be represented as a file URI".to_owned())?;
	let resolved = resolve_document(host, uri.as_str())?;
	let recovery = PathRecovery {
		authored: Str::new(authored_path),
		resolved: display.clone(),
		how:      PathRecoveryHow::WorkspaceSuffix,
	};
	Ok(Some((resolved, vec![recovery], display)))
}

fn find_unique_workspace_suffix(root: &Path, suffix: &Path) -> Result<Option<PathBuf>, String> {
	let mut pending = vec![root.to_path_buf()];
	let mut matches = Vec::new();
	let mut visited = 0_usize;
	while let Some(directory) = pending.pop() {
		let entries = match std_fs::read_dir(&directory) {
			Ok(entries) => entries,
			Err(_) => continue,
		};
		for entry in entries.flatten() {
			visited += 1;
			if visited > 100_000 {
				return Err("workspace suffix recovery exceeded its 100000-entry bound".to_owned());
			}
			let path = entry.path();
			let name = entry.file_name();
			if name == ".git" || name == "node_modules" || name == "target" {
				continue;
			}
			let Ok(kind) = entry.file_type() else {
				continue;
			};
			if kind.is_dir() {
				pending.push(path);
			} else if kind.is_file()
				&& path
					.strip_prefix(root)
					.is_ok_and(|relative| relative.ends_with(suffix))
			{
				matches.push(path);
				if matches.len() > 1 {
					return Ok(None);
				}
			}
		}
	}
	Ok(matches.pop())
}

fn resolve_move_destination(
	host: &DocumentHost,
	input: &str,
) -> Result<ResolvedDestination, String> {
	let root_url = Url::parse(host.hello().root_uri.as_str())
		.map_err(|error| format!("document workspace root is not a valid URI: {error}"))?;
	let root_path = root_url
		.to_file_path()
		.map_err(|()| "document workspace root is not a local file URI".to_owned())?;
	let root_path = normalize_absolute(&root_path)?;
	let candidate = match Url::parse(input).ok() {
		Some(uri) => {
			if uri.scheme() != "file" || uri.query().is_some() || uri.fragment().is_some() {
				return Err("document URI must be a query-free file URI inside the workspace".into());
			}
			normalize_absolute(
				&uri
					.to_file_path()
					.map_err(|()| "document URI is not a local file URI".to_owned())?,
			)?
		},
		None => root_path.join(normalize_relative(Path::new(input))?),
	};
	if candidate == root_path || !candidate.starts_with(&root_path) {
		return Err("document path escapes or names the workspace root".into());
	}
	let canonical_root = std_fs::canonicalize(&root_path)
		.map_err(|error| format!("cannot canonicalize document workspace root: {error}"))?;
	let parent = candidate
		.parent()
		.ok_or_else(|| "move destination has no parent directory".to_owned())?;
	let canonical_parent = std_fs::canonicalize(parent)
		.map_err(|error| format!("cannot canonicalize move destination parent: {error}"))?;
	if !canonical_parent.starts_with(&canonical_root) {
		return Err("move destination escapes the canonical workspace root".into());
	}
	if candidate.exists() {
		return Err(format!("MV destination already exists: {input}"));
	}
	let uri = Url::from_file_path(&candidate)
		.map_err(|()| "move destination cannot be represented as a file URI".to_owned())?;
	let path = candidate
		.to_str()
		.map(Str::new)
		.ok_or_else(|| "move destination path is not valid UTF-8".to_owned())?;
	Ok(ResolvedDestination { uri: uri.as_str().into(), path })
}
fn ensure_canonical_containment(
	root: &Path,
	candidate: &Path,
	allow_missing: bool,
) -> Result<(), String> {
	let canonical_root = std_fs::canonicalize(root)
		.map_err(|error| format!("cannot canonicalize document workspace root: {error}"))?;
	let canonical_candidate = match std_fs::canonicalize(candidate) {
		Ok(candidate) => candidate,
		Err(error) if allow_missing && error.kind() == io::ErrorKind::NotFound => {
			let parent = candidate
				.parent()
				.ok_or_else(|| "document create target has no parent directory".to_owned())?;
			let parent = std_fs::canonicalize(parent)
				.map_err(|error| format!("cannot canonicalize document create parent: {error}"))?;
			if !parent.starts_with(&canonical_root) {
				return Err("document create target escapes the canonical workspace root".into());
			}
			return Ok(());
		},
		Err(error) => return Err(format!("cannot canonicalize document path: {error}")),
	};
	if canonical_candidate == canonical_root || !canonical_candidate.starts_with(&canonical_root) {
		return Err("document path escapes the canonical workspace root".into());
	}
	Ok(())
}

fn normalize_relative(path: &Path) -> Result<PathBuf, String> {
	let mut normalized = PathBuf::new();
	for component in path.components() {
		match component {
			Component::CurDir => {},
			Component::Normal(component) => normalized.push(component),
			Component::ParentDir => {
				if !normalized.pop() {
					return Err("document path lexically escapes the workspace root".into());
				}
			},
			Component::RootDir | Component::Prefix(_) => {
				return Err("document path must be workspace-relative".into());
			},
		}
	}
	if normalized.as_os_str().is_empty() {
		return Err("document path must name a file below the workspace root".into());
	}
	Ok(normalized)
}

fn normalize_absolute(path: &Path) -> Result<PathBuf, String> {
	if !path.is_absolute() {
		return Err("file URI did not resolve to an absolute path".into());
	}
	let mut normalized = PathBuf::new();
	for component in path.components() {
		match component {
			Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
			Component::RootDir => normalized.push(Path::new(path::MAIN_SEPARATOR_STR)),
			Component::CurDir => {},
			Component::Normal(component) => normalized.push(component),
			Component::ParentDir => {
				if !normalized.pop() {
					return Err("file URI lexically escapes its filesystem root".into());
				}
			},
		}
	}
	Ok(normalized)
}

fn revision_identity(head: &pb::DocumentHead) -> Result<Str, String> {
	let revision = head
		.revision
		.as_ref()
		.ok_or_else(|| "document head omitted its revision".to_owned())?;
	let hash: &[u8; 32] = revision
		.content_hash
		.as_ref()
		.try_into()
		.map_err(|_| "document revision hash is not 32 bytes".to_owned())?;
	Ok(sf!("{}:{}", revision.sequence, hex::encode_n(hash).as_str()))
}

fn committed_diagnostics(operation: &pb::OperationResult) -> (Vec<EditDiagnostic>, bool) {
	let Some(batch) = operation.diagnostics.as_ref() else {
		return (Vec::new(), false);
	};
	let diagnostics = batch
		.diagnostics
		.iter()
		.map(|diagnostic| EditDiagnostic {
			range:    diagnostic
				.range
				.as_ref()
				.map(|range| range.start..range.end),
			severity: match pb::DiagnosticSeverity::try_from(diagnostic.severity) {
				Ok(pb::DiagnosticSeverity::Error) => EditDiagnosticSeverity::Error,
				Ok(pb::DiagnosticSeverity::Warning) => EditDiagnosticSeverity::Warning,
				Ok(pb::DiagnosticSeverity::Hint) => EditDiagnosticSeverity::Hint,
				Ok(pb::DiagnosticSeverity::Information | pb::DiagnosticSeverity::Unspecified)
				| Err(_) => EditDiagnosticSeverity::Information,
			},
			code:     Str::from(diagnostic.code.as_str()),
			source:   Str::from(diagnostic.source.as_str()),
			message:  Str::from(diagnostic.message.as_str()),
		})
		.collect();
	(diagnostics, batch.complete)
}

fn validate_committed_metadata(
	operation: &pb::OperationResult,
	head: &pb::DocumentHead,
) -> Result<(), String> {
	let committed_revision = head
		.revision
		.as_ref()
		.ok_or_else(|| "committed document head omitted its revision".to_owned())?;
	let committed_document = head
		.document
		.as_ref()
		.ok_or_else(|| "committed document head omitted its document reference".to_owned())?;
	let diagnostics = operation.diagnostics.as_ref().ok_or_else(|| {
		"committed operation omitted its revision-bound diagnostic batch".to_owned()
	})?;
	if diagnostics.committed_revision.as_ref() != Some(committed_revision)
		|| diagnostics.document.as_ref() != Some(committed_document)
	{
		return Err("committed diagnostic batch names a different document revision".to_owned());
	}
	let drift = operation
		.format_drift
		.as_ref()
		.ok_or_else(|| "committed operation omitted client-format drift metadata".to_owned())?;
	if drift.submitted_revision.is_none()
		|| drift.committed_revision.as_ref() != Some(committed_revision)
		|| drift.committed_content_hash != committed_revision.content_hash
	{
		return Err("client-format drift metadata does not name the committed revision".to_owned());
	}
	Ok(())
}

fn document_path(head: &pb::DocumentHead) -> Result<Str, String> {
	let uri = head
		.document
		.as_ref()
		.ok_or_else(|| "document head omitted its canonical document reference".to_owned())?
		.uri
		.as_str();
	let uri = Url::parse(uri)
		.map_err(|error| format!("document head returned an invalid canonical URI: {error}"))?;
	if uri.scheme() != "file" {
		return Err("document head canonical URI is not a file URI".into());
	}
	let path = uri
		.to_file_path()
		.map_err(|()| "document head canonical URI is not a local file URI".to_owned())?;
	path
		.to_str()
		.map(Str::new)
		.ok_or_else(|| "document canonical path is not valid UTF-8".to_owned())
}

pub(super) fn resolve_read_document(
	host: &DocumentHost,
	input: &str,
) -> Result<ResolvedDocument, String> {
	resolve_document(host, input)
}

pub(super) fn read_document_metadata(head: &pb::DocumentHead) -> Result<(Str, Str), String> {
	Ok((revision_identity(head)?, document_path(head)?))
}

const fn proposed_text_mutation(
	content: Bytes,
	base_revision: pb::Revision,
	stale_policy: StalePolicy,
	format_policy: FormatPolicy,
) -> pb::TextMutation {
	pb::TextMutation {
		base_revision: Some(base_revision),
		change:        Some(text_mutation::Change::ProposedContent(content)),
		stale_policy:  match stale_policy {
			StalePolicy::RebaseNonOverlapping => pb::StalePolicy::RebaseNonOverlapping as i32,
		},
		format_policy: protocol_format_policy(format_policy),
	}
}

const fn protocol_format_policy(format_policy: FormatPolicy) -> i32 {
	match format_policy {
		FormatPolicy::Disabled => pb::FormatPolicy::Disabled as i32,
		FormatPolicy::BestEffort => pb::FormatPolicy::BestEffort as i32,
		FormatPolicy::Required => pb::FormatPolicy::Required as i32,
	}
}

fn proposed_move_mutation(
	content: Bytes,
	base_content: &[u8],
	base_revision: pb::Revision,
	destination_uri: String,
	format_policy: FormatPolicy,
) -> document_mutation::Operation {
	if content.as_ref() == base_content {
		use omp_proto::document::v1::move_mutation::DestinationPrecondition;
		document_mutation::Operation::Move(pb::MoveMutation {
			base_revision: Some(base_revision),
			destination_uri,
			destination_precondition: Some(DestinationPrecondition::DestinationMustNotExist(true)),
		})
	} else {
		use omp_proto::document::v1::move_with_content_mutation::DestinationPrecondition;
		document_mutation::Operation::MoveWithContent(pb::MoveWithContentMutation {
			base_revision: Some(base_revision),
			destination_uri,
			destination_precondition: Some(DestinationPrecondition::DestinationMustNotExist(true)),
			content,
			format_policy: protocol_format_policy(format_policy),
		})
	}
}

fn persisted_edit_bytes(
	prepared: &PreparedDocument,
	content: &Bytes,
) -> Result<Bytes, EditCommitError> {
	if prepared.notebook {
		serialize_notebook_edit(&prepared.raw_base_bytes, content, &prepared.path)
			.map_err(edit_invalid_commit)
	} else {
		Ok(content.clone())
	}
}

fn serialize_notebook_edit(
	original: &[u8],
	editable: &[u8],
	display_path: &str,
) -> Result<Bytes, String> {
	let editable = str::from_utf8(editable).map_err(|_| {
		format!("Invalid notebook editable representation for {display_path}: text is not UTF-8")
	})?;
	notebook::round_trip(original, editable)
		.map(Bytes::from)
		.map_err(|error| format!("Invalid notebook edit for {display_path}: {error}"))
}

/// Decodes exact document bytes and returns BOM-stripped, LF-normalized text.
pub(crate) fn snapshot_text(bytes: &[u8]) -> Option<Cow<'_, str>> {
	let text = str::from_utf8(bytes).ok()?;
	let (_, rest) = strip_bom(text);
	Some(normalize_to_lf(rest))
}

fn record_committed_snapshot(
	store: &EditStore,
	path: Str,
	bytes: Bytes,
) -> Result<(), EditCommitError> {
	let path = Path::new(path.as_str());
	if bytes.len() > SNAPSHOT_MAX_BYTES {
		store.invalidate(path);
		return Ok(());
	}
	let text = snapshot_text(&bytes)
		.ok_or_else(|| edit_invalid_commit("committed document content is not UTF-8"))?;
	let line_count = bytecount::count(text.as_bytes(), b'\n').saturating_add(1);
	let seen_lines = (1..=line_count)
		.filter_map(|line| u32::try_from(line).ok())
		.collect::<Vec<_>>();
	store.record(path, &text, Some(&seen_lines));
	Ok(())
}

fn validate_seen_lines(
	store: &EditStore,
	snapshot: &Snapshot,
	display_path: &str,
	tag: &str,
	anchor_lines: &[usize],
) -> Result<(), EditFault> {
	let Some(seen_lines) = snapshot.seen_lines.as_ref() else {
		return Ok(());
	};
	if seen_lines.is_empty() {
		return Ok(());
	}
	let mut unseen = anchor_lines
		.iter()
		.copied()
		.filter(|line| u32::try_from(*line).map_or(true, |line| !seen_lines.contains(&line)))
		.collect::<Vec<_>>();
	unseen.sort_unstable();
	unseen.dedup();
	if unseen.is_empty() {
		return Ok(());
	}
	let ranges = format_line_ranges(&unseen);
	let selector = ranges.replace(", ", ",");
	let header = format!(
		"This edit anchors to lines {ranges} of {display_path} that [{display_path}#{tag}] never \
		 displayed (it showed a partial range, a search hit, or a folded summary)."
	);
	let source_lines = snapshot.text.split('\n').collect::<Vec<_>>();
	let mut revealed = Vec::with_capacity(unseen.len().min(40));
	let mut truncated = unseen.len() > 40;
	for &line in unseen.iter().take(40) {
		let Some(source) = line
			.checked_sub(1)
			.and_then(|index| source_lines.get(index))
		else {
			truncated = true;
			continue;
		};
		let columns = source.chars().count();
		let shown = if columns > 512 {
			truncated = true;
			let mut clipped = source.chars().take(512).collect::<String>();
			clipped.push('…');
			clipped
		} else {
			(*source).to_owned()
		};
		revealed.push((line, shown));
	}
	let message = if revealed.is_empty() {
		format!(
			"{header} Re-read them in full first with a ranged read like `{display_path}:{selector}` \
			 — it skips summarization and mints a fresh tag (a plain re-read just re-folds them) — \
			 then re-issue the edit."
		)
	} else {
		let preview = revealed
			.iter()
			.map(|(line, text)| format!("  {line}:{text}"))
			.collect::<Vec<_>>()
			.join("\n");
		if truncated {
			format!(
				"{header} Preview of the actual file content at the first {} unseen \
				 line(s):\n{preview}\nThe range exceeds the inline preview cap — re-read the \
				 remainder with `{display_path}:{selector}` before re-issuing the edit.",
				revealed.len()
			)
		} else {
			let revealed_lines = revealed
				.iter()
				.filter_map(|(line, _)| u32::try_from(*line).ok())
				.collect::<Vec<_>>();
			store.record_seen_lines(&snapshot.path, &snapshot.hash, &revealed_lines);
			format!(
				"{header} Actual file content at those lines:\n{preview}\nVerify the content matches \
				 what you intend to touch, then re-issue the edit with the same [path#tag] header — a \
				 straight retry now succeeds without a re-read. If the content does NOT match, fix \
				 your line numbers."
			)
		}
	};
	Err(edit_invalid(message))
}

fn format_line_ranges(lines: &[usize]) -> String {
	let mut output = Vec::new();
	let mut index = 0;
	while index < lines.len() {
		let start = lines[index];
		let mut end = start;
		while index + 1 < lines.len() && lines[index + 1] == end.saturating_add(1) {
			index += 1;
			end = lines[index];
		}
		if start == end {
			output.push(start.to_string());
		} else {
			output.push(format!("{start}-{end}"));
		}
		index += 1;
	}
	output.join(", ")
}

pub(super) fn transaction_id(server_epoch: &[u8]) -> Bytes {
	let sequence = NEXT_TRANSACTION.fetch_add(1, Ordering::Relaxed);
	let now = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_nanos();
	let mut hasher = Hash32::hasher();
	hasher.update(server_epoch);
	hasher.update(process::id().to_le_bytes());
	hasher.update(sequence.to_le_bytes());
	hasher.update(now.to_le_bytes());
	Bytes::copy_from_slice(&hasher.finalize().as_bytes()[..16])
}

fn map_rejection(rejected: &pb::TransactionRejected, base: &[u8]) -> EditFault {
	let reason = match pb::TransactionRejectReason::try_from(rejected.reason) {
		Ok(pb::TransactionRejectReason::OverlappingChange) => RejectionReason::Conflict,
		Ok(
			pb::TransactionRejectReason::StaleBase
			| pb::TransactionRejectReason::ExternalModification
			| pb::TransactionRejectReason::RevisionExpired,
		) => RejectionReason::StaleUnrecoverable { message: Str::from(rejected.message.as_str()) },
		Ok(pb::TransactionRejectReason::FormatFailed) => {
			RejectionReason::Format { message: Str::from(rejected.message.as_str()) }
		},
		Ok(pb::TransactionRejectReason::InvalidContent) => {
			RejectionReason::InvalidPatch { message: Str::from(rejected.message.as_str()) }
		},
		Ok(pb::TransactionRejectReason::PersistFailed) => RejectionReason::InvalidPatch {
			message: sf!("document persistence failed: {}", rejected.message),
		},
		Ok(pb::TransactionRejectReason::PreconditionFailed) => RejectionReason::InvalidPatch {
			message: sf!("document precondition failed: {}", rejected.message),
		},
		Ok(pb::TransactionRejectReason::Cancelled) => RejectionReason::InvalidPatch {
			message: sf!("document transaction was cancelled: {}", rejected.message),
		},
		Ok(pb::TransactionRejectReason::Unspecified) | Err(_) => RejectionReason::InvalidPatch {
			message: sf!("document transaction returned an unknown rejection: {}", rejected.message),
		},
	};
	let conflicts = rejected
		.conflicts
		.iter()
		.flat_map(|conflict| conflict.conflicting_ranges.iter())
		.map(|range| Conflict {
			start_line: line_at_offset(base, range.start),
			end_line:   line_at_offset(base, range.end.saturating_sub(1).max(range.start)),
			message:    Str::from(rejected.message.as_str()),
		})
		.collect();
	EditFault { reason, conflicts }
}

fn line_at_offset(bytes: &[u8], offset: u64) -> usize {
	let offset = usize::try_from(offset)
		.unwrap_or(usize::MAX)
		.min(bytes.len());
	bytecount::count(&bytes[..offset], b'\n').saturating_add(1)
}

fn edit_invalid(message: impl Into<String>) -> EditFault {
	EditFault {
		reason:    RejectionReason::InvalidPatch { message: Str::from(message.into()) },
		conflicts: Vec::new(),
	}
}

fn edit_stale(message: impl Into<Str>) -> EditFault {
	EditFault {
		reason:    RejectionReason::StaleUnrecoverable { message: message.into() },
		conflicts: Vec::new(),
	}
}

fn edit_invalid_commit(message: impl Into<String>) -> EditCommitError {
	EditCommitError::Rejected(edit_invalid(message))
}

fn edit_unknown(reason: impl Into<Str>) -> EditCommitError {
	EditCommitError::EffectsUnknown { reason: reason.into() }
}

#[derive(Debug)]
struct ResolvedPlainWrite {
	uri:               Str,
	path:              PathBuf,
	display_path:      Str,
	use_document_host: bool,
}
struct CancelSpecialWriteOnDrop(Option<SpecialWriteControl>);

impl CancelSpecialWriteOnDrop {
	fn disarm(&mut self) {
		self.0 = None;
	}
}

impl Drop for CancelSpecialWriteOnDrop {
	fn drop(&mut self) {
		if let Some(control) = self.0.take() {
			control.cancel();
		}
	}
}

#[derive(Default)]
struct SqliteWriteInterrupt {
	interrupted: AtomicBool,
	handle:      Mutex<Option<rusqlite::InterruptHandle>>,
}

impl SqliteWriteInterrupt {
	fn install(&self, connection: &rusqlite::Connection) {
		let handle = connection.get_interrupt_handle();
		let mut published = self.handle.lock();
		if self.interrupted.load(Ordering::Acquire) {
			handle.interrupt();
		}
		*published = Some(handle);
	}

	fn interrupt(&self) {
		self.interrupted.store(true, Ordering::Release);
		if let Some(handle) = self.handle.lock().as_ref() {
			handle.interrupt();
		}
	}
}

async fn run_special_write_blocking<T, F>(
	control: SpecialWriteControl,
	task_name: &'static str,
	worker: F,
) -> Result<T, backends::Fault>
where
	T: Send + 'static,
	F: FnOnce(&SpecialWriteControl) -> Result<T, backends::Fault> + Send + 'static,
{
	let task_control = control.clone();
	let mut cancel_on_drop = CancelSpecialWriteOnDrop(Some(control));
	let result = task::spawn_blocking(move || worker(&task_control)).await;
	cancel_on_drop.disarm();
	result.map_err(|error| special_fault(format!("{task_name} write task failed: {error}")))?
}

impl WriteDocuments for DocumentHost {
	async fn write_resource(
		&self,
		request: ResourceMutationRequest,
	) -> Result<Option<ResourceMutationReceipt>, WriteCommitError> {
		use super::{
			tool_url::{
				host::write,
				vault::{parse_resource, vault_fault, vault_url_fault},
			},
			vault::ObsidianOperation,
		};
		let Some(services) = self.resource_mutations() else {
			return Ok(None);
		};
		let byte_len = request.content.len() as u64;
		let revision = match request.capability {
			MutationCapability::Ssh => {
				let Some(resource) = request.uri.strip_prefix("ssh://") else {
					return Err(write_rejected("invalid SSH mutation URI"));
				};
				let (alias, path) = ssh::parse_resource(resource.as_str())
					.map_err(|fault| write_rejected(fault.message().clone()))?;
				services
					.ssh
					.write(&alias, &path, request.content.as_bytes())
					.await
					.map_err(|error| write_rejected(Str::new(error.to_string())))?;
				NEXT_TRANSACTION.fetch_add(1, Ordering::Relaxed)
			},
			MutationCapability::Vault => {
				let Some(resource) = request.uri.strip_prefix("vault://") else {
					return Err(write_rejected("invalid vault mutation URI"));
				};
				let (resource, query) = resource
					.split_once('?')
					.map_or((resource.as_str(), None), |(resource, query)| (resource, Some(query)));
				let parsed = parse_resource(resource)
					.map_err(|error| write_rejected(vault_url_fault(error).message().clone()))?;
				if parsed.directory {
					return Err(write_rejected(
						"vault:// writes require a file path without a trailing slash",
					));
				}
				let operation = query
					.map(|query| {
						let params = url::form_urlencoded::parse(query.as_bytes())
							.into_owned()
							.collect::<BTreeMap<_, _>>();
						let operation = params
							.get("op")
							.filter(|operation| !operation.is_empty())
							.ok_or_else(|| {
								write_rejected("vault:// query writes require an 'op' parameter")
							})?
							.parse::<ObsidianOperation>()
							.map_err(|_| write_rejected("unsupported vault:// write operation"))?;
						Ok::<_, WriteCommitError>((operation, params))
					})
					.transpose()?;
				match operation {
					None => services
						.vault
						.write(&parsed.vault, &parsed.path, request.content.as_bytes(), 8 * 1024 * 1024)
						.await
						.map_err(|error| write_rejected(vault_fault(error).message().clone()))?,
					Some((ObsidianOperation::Create, params)) => services
						.vault
						.obsidian_create(
							&parsed.vault,
							&parsed.path,
							&request.content,
							params.contains_key("overwrite"),
						)
						.await
						.map_err(|error| write_rejected(vault_fault(error).message().clone()))?,
					Some((ObsidianOperation::Move, params)) => {
						if !request.content.is_empty() {
							return Err(write_rejected("vault://?op=move requires empty write content"));
						}
						let destination = params
							.get("to")
							.filter(|value| !value.is_empty())
							.ok_or_else(|| {
								write_rejected("vault://?op=move requires a non-empty 'to' parameter")
							})?;
						services
							.vault
							.obsidian_move(&parsed.vault, &parsed.path, destination)
							.await
							.map_err(|error| write_rejected(vault_fault(error).message().clone()))?
					},
					Some((ObsidianOperation::Delete, params)) => {
						if !request.content.is_empty() {
							return Err(write_rejected("vault://?op=delete requires empty write content"));
						}
						services
							.vault
							.obsidian_delete(&parsed.vault, &parsed.path, params.contains_key("permanent"))
							.await
							.map_err(|error| write_rejected(vault_fault(error).message().clone()))?
					},
					Some((ObsidianOperation::Open, params)) => {
						if !request.content.is_empty() {
							return Err(write_rejected("vault://?op=open requires empty write content"));
						}
						services
							.vault
							.obsidian_open(&parsed.vault, &parsed.path, params.contains_key("newtab"))
							.await
							.map_err(|error| write_rejected(vault_fault(error).message().clone()))?
					},
					Some((ObsidianOperation::Read | ObsidianOperation::Search, _)) => {
						return Err(write_rejected("read-only Obsidian operations use Read, not Write"));
					},
					Some((ObsidianOperation::Discover, _)) => {
						return Err(write_rejected("unsupported vault:// write operation"));
					},
				}
			},
			MutationCapability::Attachment => return Ok(None),
			MutationCapability::Host => {
				write(&request.uri, request.content.to_string())
					.await
					.map_err(|error| write_rejected(Str::new(error.to_string())))?;
				NEXT_TRANSACTION.fetch_add(1, Ordering::Relaxed)
			},
		};
		Ok(Some(ResourceMutationReceipt { canonical_uri: request.uri, byte_len, revision }))
	}

	fn probe_literal(
		&self,
		path: Str,
	) -> impl Future<Output = Result<selector::LiteralPathProbe, WriteFault>> + Send + '_ {
		ready(
			resolve_plain_write(self, &path)
				.map_err(|message| WriteFault::Document { message: Str::from(message) })
				.map(|resolved| match std_fs::symlink_metadata(resolved.path) {
					Ok(_) => selector::LiteralPathProbe::Exists,
					Err(error)
						if matches!(
							error.kind(),
							io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
						) =>
					{
						selector::LiteralPathProbe::Missing
					},
					Err(_) => selector::LiteralPathProbe::Unknown,
				}),
		)
	}

	async fn write_plain(
		&self,
		request: PlainWriteRequest,
	) -> Result<PlainWriteResult, WriteCommitError> {
		let resolved = resolve_plain_write(self, &request.path).map_err(write_rejected)?;
		let existed = match std_fs::symlink_metadata(&resolved.path) {
			Ok(_) => true,
			Err(error)
				if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) =>
			{
				false
			},
			Err(error) => return Err(write_rejected(error.to_string())),
		};
		if existed {
			let prefix = read_file_prefix(&resolved.path, 16 * 1024).map_err(write_rejected)?;
			if request.guard_generated && auto_generated_file(&resolved.path, &prefix) {
				return Err(write_rejected(format!(
					"Refusing to overwrite auto-generated file {}; change its generator input instead",
					request.path
				)));
			}
		}
		let parent = resolved
			.path
			.parent()
			.ok_or_else(|| write_rejected("document path has no parent directory"))?;
		tokio::fs::create_dir_all(parent)
			.await
			.map_err(|error| write_rejected(error.to_string()))?;

		let content = Bytes::copy_from_slice(request.content.as_bytes());
		let absolute_path = Str::from(resolved.path.to_string_lossy().into_owned());
		self.invalidate_late_diagnostics_path(&absolute_path);
		if let Some(result) = self
			.write_acp_text(absolute_path.clone(), request.content.clone())
			.await
		{
			let formatted = result
				.map_err(|error| write_rejected(format!("ACP document write failed: {error}")))?;
			let content = Bytes::copy_from_slice(formatted.as_bytes());
			omp_walker::invalidate_path(&resolved.path);
			let snapshot_tag = record_write_snapshot(self, absolute_path.clone(), content.clone());
			return Ok(PlainWriteResult {
				resolved_path: absolute_path,
				display_path: resolved.display_path,
				byte_len: u64::try_from(content.len()).unwrap_or(u64::MAX),
				disposition: if existed {
					WriteDisposition::Overwrote
				} else {
					WriteDisposition::Created
				},
				made_executable: false,
				snapshot_tag,
			});
		}
		if !resolved.use_document_host {
			atomic_write_plain(&resolved.path, &content).map_err(write_rejected)?;
			let resolved_path = Str::from(resolved.path.to_string_lossy().into_owned());
			let made_executable =
				mark_executable_for_shebang(&resolved.path, request.content.as_bytes());
			let snapshot_tag = record_write_snapshot(self, resolved_path.clone(), content.clone());
			return Ok(PlainWriteResult {
				resolved_path,
				display_path: resolved.display_path,
				byte_len: u64::try_from(content.len()).unwrap_or(u64::MAX),
				disposition: if existed {
					WriteDisposition::Overwrote
				} else {
					WriteDisposition::Created
				},
				made_executable,
				snapshot_tag,
			});
		}
		let _late_diagnostics = self.begin_late_diagnostics_uri(resolved.uri.clone());
		let transaction_id = transaction_id(self.hello().server_epoch.as_ref());
		let response = self
			.commit_transaction(
				transaction_id.clone(),
				vec![pb::DocumentMutation {
					document:  Some(pb::DocumentTarget {
						target: Some(document_target::Target::Uri(resolved.uri.clone().into())),
					}),
					operation: Some(document_mutation::Operation::Create(pb::CreateMutation {
						content:           content.clone(),
						existing_document: pb::ExistingDocumentPolicy::ReplaceExisting as i32,
						format_policy:     protocol_format_policy(request.format_policy),
					})),
				}],
				&CancellationToken::new(),
			)
			.await
			.map_err(|error| WriteCommitError::EffectsUnknown {
				reason: Str::from(error.to_string()),
			})?;
		let committed = match response.outcome {
			Some(commit_transaction_response::Outcome::Committed(committed))
				if committed.transaction_id == transaction_id =>
			{
				committed
			},
			Some(commit_transaction_response::Outcome::Rejected(rejected))
				if rejected.transaction_id == transaction_id =>
			{
				return Err(write_rejected(rejected.message));
			},
			Some(commit_transaction_response::Outcome::PartiallyCommitted(partial))
				if partial.transaction_id == transaction_id =>
			{
				return Err(WriteCommitError::EffectsUnknown {
					reason: sf!(
						"document transaction partially committed before operation {}: {}",
						partial.failed_operation_index,
						partial.message
					),
				});
			},
			Some(_) => {
				return Err(WriteCommitError::EffectsUnknown {
					reason: "document transaction identity did not match".into(),
				});
			},
			None => {
				return Err(WriteCommitError::EffectsUnknown {
					reason: "document transaction omitted its outcome".into(),
				});
			},
		};
		let operation = committed
			.operations
			.first()
			.filter(|operation| committed.operations.len() == 1 && operation.operation_index == 0)
			.ok_or_else(|| WriteCommitError::EffectsUnknown {
				reason: "document transaction did not return exactly operation 0".into(),
			})?;
		let head = operation
			.head
			.as_ref()
			.ok_or_else(|| WriteCommitError::EffectsUnknown {
				reason: "committed operation omitted its document head".into(),
			})?;
		validate_committed_metadata(operation, head)
			.map_err(|message| WriteCommitError::EffectsUnknown { reason: Str::from(message) })?;
		let (_, diagnostics_complete) = committed_diagnostics(operation);
		self.expect_late_diagnostics(head, diagnostics_complete);
		let resolved_path = document_path(head)
			.map_err(|message| WriteCommitError::EffectsUnknown { reason: Str::from(message) })?;
		let made_executable =
			mark_executable_for_shebang(Path::new(resolved_path.as_str()), request.content.as_bytes());
		let snapshot_tag = record_write_snapshot(self, resolved_path.clone(), content.clone());
		Ok(PlainWriteResult {
			resolved_path,
			display_path: resolved.display_path,
			byte_len: u64::try_from(content.len()).unwrap_or(u64::MAX),
			disposition: if existed {
				WriteDisposition::Overwrote
			} else {
				WriteDisposition::Created
			},
			made_executable,
			snapshot_tag,
		})
	}

	async fn splice_conflict(
		&self,
		request: ConflictSpliceRequest,
	) -> Result<Option<ConflictSpliceResult>, WriteCommitError> {
		splice_conflict_document(self, request).await.map(Some)
	}

	async fn splice_conflict_file(
		&self,
		request: ConflictBulkFileRequest,
	) -> Result<Option<ConflictBulkFileResult>, WriteCommitError> {
		splice_conflict_file_document(self, request).await.map(Some)
	}

	async fn write_archive_member(
		&self,
		display_path: Str,
		content: Bytes,
		control: SpecialWriteControl,
	) -> Result<Option<backends::ResultPayload>, backends::Fault> {
		let host = self.clone();
		run_special_write_blocking(control, "archive", move |task_control| {
			write_archive_member_blocking(&host, &display_path, content, task_control)
		})
		.await
	}

	async fn write_sqlite_row(
		&self,
		display_path: Str,
		content: Str,
		control: SpecialWriteControl,
	) -> Result<Option<backends::ResultPayload>, backends::Fault> {
		let host = self.clone();
		let interrupt = Arc::new(SqliteWriteInterrupt::default());
		let task_interrupt = Arc::clone(&interrupt);
		let wait_control = control.clone();
		let interrupt_waiter = tokio::spawn(async move {
			wait_control.cancelled().await;
			interrupt.interrupt();
		});
		let result = run_special_write_blocking(control, "SQLite", move |task_control| {
			write_sqlite_row_blocking(&host, &display_path, &content, task_control, &task_interrupt)
		})
		.await;
		interrupt_waiter.abort();
		result
	}
}

fn resolve_plain_write(host: &DocumentHost, input: &str) -> Result<ResolvedPlainWrite, String> {
	let root_uri = Url::parse(host.hello().root_uri.as_str())
		.map_err(|error| format!("document workspace root is not a valid URI: {error}"))?;
	if root_uri.scheme() != "file" || root_uri.query().is_some() || root_uri.fragment().is_some() {
		return Err("document workspace root is not a query-free file URI".into());
	}
	let root = normalize_absolute(
		&root_uri
			.to_file_path()
			.map_err(|()| "document workspace root is not a local file URI".to_owned())?,
	)?;
	resolve_plain_write_from_root(&root, input)
}

fn resolve_plain_write_from_root(root: &Path, input: &str) -> Result<ResolvedPlainWrite, String> {
	let authored = selector::expand_tilde(input, None);
	let candidate = if authored.is_absolute() {
		normalize_absolute(&authored)?
	} else {
		normalize_absolute(&root.join(authored))?
	};
	if candidate == root {
		return Err("document path must name a file".into());
	}
	let canonical_root = std_fs::canonicalize(root)
		.map_err(|error| format!("cannot canonicalize document workspace root: {error}"))?;
	let mut ancestor = candidate.as_path();
	let canonical_ancestor = loop {
		match std_fs::canonicalize(ancestor) {
			Ok(canonical) => break canonical,
			Err(error)
				if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) =>
			{
				ancestor = ancestor
					.parent()
					.ok_or_else(|| "document path has no existing ancestor".to_owned())?;
			},
			Err(error) => {
				return Err(format!("cannot canonicalize document path ancestor: {error}"));
			},
		}
	};
	let suffix = candidate
		.strip_prefix(ancestor)
		.map_err(|_| "document path could not be resolved from its existing ancestor")?;
	let path = join_nonempty_suffix(canonical_ancestor, suffix);
	let use_document_host = path != canonical_root && path.starts_with(&canonical_root);
	let uri = Url::from_file_path(&path)
		.map_err(|()| "document path cannot be represented as a file URI".to_owned())?;
	let display_path = display_write_path(&path, &canonical_root);
	Ok(ResolvedPlainWrite { uri: Str::from(uri.as_str()), path, display_path, use_document_host })
}

fn join_nonempty_suffix(mut base: PathBuf, suffix: &Path) -> PathBuf {
	if !suffix.as_os_str().is_empty() {
		base.push(suffix);
	}
	base
}

fn display_write_path(path: &Path, workspace_root: &Path) -> Str {
	if let Ok(relative) = path.strip_prefix(workspace_root) {
		return Str::from(relative.to_string_lossy().replace('\\', "/"));
	}
	if let Some(home) = home_dir()
		&& let Some(shortened) =
			shorten_home_path(path.to_string_lossy().as_ref(), home.to_string_lossy().as_ref())
	{
		return Str::from(shortened);
	}
	Str::from(path.to_string_lossy().replace('\\', "/"))
}

fn read_file_prefix(path: &Path, limit: u64) -> Result<Bytes, String> {
	use io::Read as _;

	let file = std_fs::File::open(path).map_err(|error| error.to_string())?;
	let mut prefix = Vec::with_capacity(usize::try_from(limit).unwrap_or(16 * 1024));
	file
		.take(limit)
		.read_to_end(&mut prefix)
		.map_err(|error| error.to_string())?;
	Ok(Bytes::from(prefix))
}

fn auto_generated_file(path: &Path, prefix: &[u8]) -> bool {
	let path = path.to_string_lossy().to_ascii_lowercase();
	if path.ends_with(".pb.go")
		|| path.ends_with(".pb.rs")
		|| path.ends_with(".g.dart")
		|| path.ends_with(".generated.ts")
	{
		return true;
	}
	let prefix = String::from_utf8_lossy(prefix).to_ascii_lowercase();
	[
		"@generated",
		"code generated",
		"do not edit",
		"generated by protoc",
		"generated by sqlc",
		"generated by buf",
		"swagger codegen",
		"openapi-generator",
	]
	.iter()
	.any(|marker| prefix.contains(marker))
}

fn atomic_write_plain(path: &Path, content: &Bytes) -> Result<(), String> {
	use io::Write as _;

	let existing_permissions = match std_fs::metadata(path) {
		Ok(metadata) => Some(metadata.permissions()),
		Err(error) if error.kind() == io::ErrorKind::NotFound => None,
		Err(error) => return Err(error.to_string()),
	};
	let temporary = unique_temp_path(path);
	let mut output = OpenOptions::new()
		.write(true)
		.create_new(true)
		.open(&temporary)
		.map_err(|error| error.to_string())?;
	let prepared = (|| -> Result<(), String> {
		output
			.write_all(content)
			.map_err(|error| error.to_string())?;
		if let Some(permissions) = existing_permissions {
			output
				.set_permissions(permissions)
				.map_err(|error| error.to_string())?;
		}
		output.flush().map_err(|error| error.to_string())?;
		output.sync_all().map_err(|error| error.to_string())
	})();
	if let Err(error) = prepared {
		let _ = std_fs::remove_file(&temporary);
		return Err(error);
	}
	if let Err(error) = replace_file_atomically(&temporary, path) {
		let _ = std_fs::remove_file(&temporary);
		return Err(error.to_string());
	}
	if let Some(parent) = path.parent()
		&& let Ok(directory) = std_fs::File::open(parent)
	{
		let _ = directory.sync_all();
	}
	Ok(())
}

fn record_write_snapshot(host: &DocumentHost, path: Str, content: Bytes) -> Option<Str> {
	let store = host.snapshot_store();
	let path = Path::new(path.as_str());
	if content.len() > SNAPSHOT_MAX_BYTES {
		store.invalidate(path);
		return None;
	}
	let Some(text) = snapshot_text(&content) else {
		store.invalidate(path);
		return None;
	};
	let line_count = if text.is_empty() {
		0
	} else {
		bytecount::count(text.as_bytes(), b'\n') + 1
	};
	let seen_lines = (1..=line_count)
		.filter_map(|line| u32::try_from(line).ok())
		.collect::<Vec<_>>();
	Some(store.record(path, &text, Some(&seen_lines)).into())
}

async fn splice_conflict_document(
	host: &DocumentHost,
	request: ConflictSpliceRequest,
) -> Result<ConflictSpliceResult, WriteCommitError> {
	let (lease, current) = open_conflict_document(host, &request.entry.display_path).await?;
	let splice = splice_registered(&current, &request.entry, &request.replacement)
		.map_err(|fault| write_rejected(fault.message().to_string()))?;
	let content = Bytes::copy_from_slice(splice.text.as_bytes());
	let write = commit_conflict_content(host, &lease, request.entry.display_path, content).await?;
	Ok(ConflictSpliceResult {
		write,
		range: splice.range,
		echo_trimmed: splice.trimmed_leading + splice.trimmed_trailing,
	})
}

async fn splice_conflict_file_document(
	host: &DocumentHost,
	request: ConflictBulkFileRequest,
) -> Result<ConflictBulkFileResult, WriteCommitError> {
	if request.entries.is_empty()
		|| request
			.entries
			.iter()
			.any(|(entry, _)| entry.display_path != request.display_path)
	{
		return Err(write_rejected(
			"bulk conflict file request must contain one path's registered entries",
		));
	}
	let (lease, current) = open_conflict_document(host, &request.display_path).await?;
	let splice = splice_registered_bulk(&current, &request.entries)
		.map_err(|fault| write_rejected(fault.message().to_string()))?;
	let content = Bytes::copy_from_slice(splice.text.as_bytes());
	let write = commit_conflict_content(host, &lease, request.display_path, content).await?;
	Ok(ConflictBulkFileResult {
		write,
		resolved_ids: splice.resolved_ids,
		echo_trimmed: splice.echo_trimmed,
	})
}

async fn open_conflict_document(
	host: &DocumentHost,
	display_path: &str,
) -> Result<(DocumentLease, String), WriteCommitError> {
	let resolved = resolve_document(host, display_path).map_err(write_rejected)?;
	let lease = DocumentHost::open(host, resolved.uri, None, &CancellationToken::new())
		.await
		.map_err(|error| write_rejected(error.to_string()))?;
	if pb::DocumentKind::try_from(lease.head().kind) != Ok(pb::DocumentKind::Text) {
		return Err(write_rejected("conflict splices require a UTF-8 text document"));
	}
	let current = read_whole(host, &lease)
		.await
		.map_err(|error| write_rejected(error.to_string()))?;
	let current = str::from_utf8(&current)
		.map_err(|_| write_rejected("conflict splices require a UTF-8 text document"))?
		.to_owned();
	Ok((lease, current))
}

async fn commit_conflict_content(
	host: &DocumentHost,
	lease: &DocumentLease,
	display_path: Str,
	content: Bytes,
) -> Result<PlainWriteResult, WriteCommitError> {
	let revision = lease
		.head()
		.revision
		.clone()
		.ok_or_else(|| write_rejected("document head omitted its revision"))?;
	let transaction_id = transaction_id(host.hello().server_epoch.as_ref());
	let response = host
		.commit_transaction(
			transaction_id.clone(),
			vec![pb::DocumentMutation {
				document:  Some(lease_target(lease)),
				operation: Some(document_mutation::Operation::Text(pb::TextMutation {
					base_revision: Some(revision),
					change:        Some(text_mutation::Change::ProposedContent(content.clone())),
					stale_policy:  pb::StalePolicy::Fail as i32,
					format_policy: pb::FormatPolicy::Disabled as i32,
				})),
			}],
			&CancellationToken::new(),
		)
		.await
		.map_err(|error| WriteCommitError::EffectsUnknown { reason: Str::from(error.to_string()) })?;
	let committed = match response.outcome {
		Some(commit_transaction_response::Outcome::Committed(committed))
			if committed.transaction_id == transaction_id =>
		{
			committed
		},
		Some(commit_transaction_response::Outcome::Rejected(rejected))
			if rejected.transaction_id == transaction_id =>
		{
			return Err(write_rejected(rejected.message));
		},
		Some(commit_transaction_response::Outcome::PartiallyCommitted(partial))
			if partial.transaction_id == transaction_id =>
		{
			return Err(WriteCommitError::EffectsUnknown {
				reason: sf!(
					"conflict splice partially committed before operation {}: {}",
					partial.failed_operation_index,
					partial.message
				),
			});
		},
		Some(_) => {
			return Err(WriteCommitError::EffectsUnknown {
				reason: "conflict splice transaction identity did not match".into(),
			});
		},
		None => {
			return Err(WriteCommitError::EffectsUnknown {
				reason: "conflict splice transaction omitted its outcome".into(),
			});
		},
	};
	let operation = committed
		.operations
		.first()
		.filter(|operation| committed.operations.len() == 1 && operation.operation_index == 0)
		.ok_or_else(|| WriteCommitError::EffectsUnknown {
			reason: "conflict splice did not return exactly operation 0".into(),
		})?;
	let head = operation
		.head
		.as_ref()
		.ok_or_else(|| WriteCommitError::EffectsUnknown {
			reason: "conflict splice omitted its committed document head".into(),
		})?;
	validate_committed_metadata(operation, head)
		.map_err(|message| WriteCommitError::EffectsUnknown { reason: Str::from(message) })?;
	let resolved_path = document_path(head)
		.map_err(|message| WriteCommitError::EffectsUnknown { reason: Str::from(message) })?;
	let snapshot_tag = record_write_snapshot(host, resolved_path.clone(), content.clone());
	Ok(PlainWriteResult {
		resolved_path,
		display_path,
		byte_len: u64::try_from(content.len()).unwrap_or(u64::MAX),
		disposition: WriteDisposition::Overwrote,
		made_executable: false,
		snapshot_tag,
	})
}

fn write_rejected(message: impl Into<Str>) -> WriteCommitError {
	WriteCommitError::Rejected(WriteFault::Document { message: message.into() })
}

#[cfg(unix)]
fn mark_executable_for_shebang(path: &Path, content: &[u8]) -> bool {
	use std::os::unix::fs::PermissionsExt as _;

	if !content.starts_with(b"#!") {
		return false;
	}
	let Ok(metadata) = std_fs::metadata(path) else {
		return false;
	};
	let current = metadata.permissions().mode();
	let next = current | 0o111;
	if next == current {
		return false;
	}
	let mut permissions = metadata.permissions();
	permissions.set_mode(next);
	std_fs::set_permissions(path, permissions).is_ok()
}

#[cfg(not(unix))]
fn mark_executable_for_shebang(_path: &Path, _content: &[u8]) -> bool {
	false
}

#[cfg(test)]
mod tests {
	use std::fmt::Write as _;

	use omp_proto::document::v1::{
		client_frame, move_with_content_mutation::DestinationPrecondition, server_frame,
	};

	use super::*;

	#[test]
	fn privileged_permission_errnos_remain_distinct() {
		for (errno, expected) in
			[(libc::EPERM, "EPERM"), (libc::EACCES, "EACCES"), (libc::EROFS, "EROFS")]
		{
			let error = crate::docserver::Error::Persistence {
				path:   PathBuf::from("/target"),
				source: io::Error::from_raw_os_error(errno),
			};
			let classified = classify_privileged(error);
			let actual = match classified {
				PrivilegedMutationFault::OperationNotPermitted { .. } => "EPERM",
				PrivilegedMutationFault::PermissionDenied { .. } => "EACCES",
				PrivilegedMutationFault::ReadOnlyFilesystem { .. } => "EROFS",
				PrivilegedMutationFault::Other { .. } | PrivilegedMutationFault::StaleRevision => {
					"other"
				},
			};
			assert_eq!(actual, expected);
		}
	}

	#[test]
	fn recovers_unique_workspace_suffix_for_missing_edit_path() {
		let workspace = tempfile::tempdir().expect("workspace");
		let nested = workspace.path().join("src").join("replace.txt");
		std_fs::create_dir_all(nested.parent().expect("nested parent")).expect("create nested");
		std_fs::write(&nested, b"alpha\nbeta\n").expect("write nested file");

		assert_eq!(
			find_unique_workspace_suffix(workspace.path(), Path::new("replace.txt"))
				.expect("scan workspace"),
			Some(nested)
		);
		assert_eq!(
			find_unique_workspace_suffix(workspace.path(), Path::new("missing.txt"))
				.expect("scan workspace"),
			None
		);
	}

	#[test]
	fn rejects_lexical_parent_escape() {
		assert!(normalize_relative(Path::new("../outside.rs")).is_err());
		assert_eq!(
			normalize_relative(Path::new("src/../inside.rs")).expect("contained parent"),
			PathBuf::from("inside.rs")
		);
	}
	#[cfg(unix)]
	#[test]
	fn rejects_symlink_escape_after_canonicalization() {
		use std::os::unix::fs::symlink;

		let sandbox = tempfile::tempdir().expect("sandbox");
		let root = sandbox.path().join("root");
		let outside = sandbox.path().join("outside");
		std_fs::create_dir_all(&root).expect("root");
		std_fs::create_dir_all(&outside).expect("outside");
		std_fs::write(outside.join("secret"), b"secret").expect("outside file");
		symlink(&outside, root.join("link")).expect("symlink");
		assert!(ensure_canonical_containment(&root, &root.join("link/secret"), false).is_err());
	}

	#[test]
	fn revision_identity_includes_sequence_and_exact_hash() {
		let head = pb::DocumentHead {
			revision: Some(pb::Revision {
				sequence:     7,
				content_hash: Bytes::from_static(&[0xab; 32]),
			}),
			..Default::default()
		};
		assert_eq!(
			revision_identity(&head).expect("valid revision"),
			"7:abababababababababababababababababababababababababababababababab"
		);
	}

	#[test]
	fn builds_revision_bound_proposed_content_mutation() {
		let payload = Bytes::from_static(b"new");
		let revision =
			pb::Revision { sequence: 7, content_hash: Bytes::from_static(&[0xab; 32]) };
		let mutation = proposed_text_mutation(
			payload.clone(),
			revision.clone(),
			StalePolicy::RebaseNonOverlapping,
			FormatPolicy::BestEffort,
		);
		let Some(text_mutation::Change::ProposedContent(content)) = mutation.change else {
			panic!("expected proposed content");
		};
		assert_eq!(content, payload);
		assert_eq!(mutation.base_revision, Some(revision));
		assert_eq!(mutation.format_policy, pb::FormatPolicy::BestEffort as i32);
	}

	#[test]
	fn changed_move_uses_one_revision_bound_move_with_content_mutation() {
		let content = Bytes::from_static(b"edited");
		let revision =
			pb::Revision { sequence: 9, content_hash: Bytes::from_static(&[0xcd; 32]) };
		let operation = proposed_move_mutation(
			content.clone(),
			b"original",
			revision.clone(),
			"file:///workspace/destination.txt".to_owned(),
			FormatPolicy::BestEffort,
		);
		let document_mutation::Operation::MoveWithContent(movement) = operation else {
			panic!("changed move must be one atomic move-with-content mutation");
		};
		assert_eq!(movement.base_revision, Some(revision));
		assert_eq!(movement.destination_uri, "file:///workspace/destination.txt");
		assert_eq!(movement.content, content);
		assert_eq!(movement.format_policy, pb::FormatPolicy::BestEffort as i32);
		assert!(matches!(
			movement.destination_precondition,
			Some(DestinationPrecondition::DestinationMustNotExist(true))
		));
	}

	#[test]
	fn maps_format_and_conflict_rejections_without_message_parsing() {
		let format = map_rejection(
			&pb::TransactionRejected {
				reason: pb::TransactionRejectReason::FormatFailed as i32,
				message: "opaque formatter diagnostic".into(),
				..Default::default()
			},
			b"one\ntwo\nthree\n",
		);
		assert_eq!(format.reason, RejectionReason::Format {
			message: "opaque formatter diagnostic".into(),
		});

		let conflict = map_rejection(
			&pb::TransactionRejected {
				reason: pb::TransactionRejectReason::OverlappingChange as i32,
				message: "opaque overlap".into(),
				conflicts: vec![pb::DocumentConflict {
					conflicting_ranges: vec![pb::ByteRange { start: 4, end: 7 }],
					..Default::default()
				}],
				..Default::default()
			},
			b"one\ntwo\nthree\n",
		);
		assert_eq!(conflict.reason, RejectionReason::Conflict);
		assert_eq!(conflict.conflicts[0].start_line, 2);
		assert_eq!(conflict.conflicts[0].end_line, 2);
	}

	#[test]
	fn plain_write_resolution_accepts_absolute_and_parent_relative_targets() {
		let sandbox = tempfile::tempdir().expect("sandbox");
		let root = sandbox.path().join("workspace");
		std_fs::create_dir_all(&root).expect("workspace");
		let existing = root.join("existing.txt");
		std_fs::write(&existing, "existing").expect("existing file");
		let resolved = resolve_plain_write_from_root(&root, "existing.txt").expect("existing target");
		assert_eq!(resolved.path, std_fs::canonicalize(&existing).expect("canonical existing file"));
		assert!(resolved.use_document_host);
		let absolute = sandbox.path().join("outside").join("file.txt");
		let canonical_sandbox = std_fs::canonicalize(sandbox.path()).expect("canonical sandbox");
		let resolved = resolve_plain_write_from_root(&root, absolute.to_str().expect("UTF-8 path"))
			.expect("absolute target");
		assert_eq!(resolved.path, canonical_sandbox.join("outside/file.txt"));
		assert!(!resolved.use_document_host);

		let relative = resolve_plain_write_from_root(&root, "../sibling/file.txt")
			.expect("parent-relative target");
		assert_eq!(relative.path, canonical_sandbox.join("sibling/file.txt"));
		assert!(!relative.use_document_host);
	}

	#[test]
	fn generated_file_markers_and_suffixes_are_blocked() {
		assert!(auto_generated_file(
			Path::new("api/client.rs"),
			b"// Code generated by protoc. DO NOT EDIT.\n"
		));
		assert!(auto_generated_file(Path::new("api/messages.pb.go"), b"package api\n"));
		assert!(!auto_generated_file(
			Path::new("src/generator.rs"),
			b"// Generates client code when explicitly run.\n"
		));
	}
	#[cfg(unix)]
	#[test]
	fn atomic_plain_write_preserves_mode_and_shebang_adds_execute_bits() {
		use std::os::unix::fs::PermissionsExt as _;

		let sandbox = tempfile::tempdir().expect("sandbox");
		let path = sandbox.path().join("script.sh");
		std_fs::write(&path, b"old").expect("seed file");
		std_fs::set_permissions(&path, std_fs::Permissions::from_mode(0o640)).expect("seed mode");
		atomic_write_plain(&path, &Bytes::from_static(b"#!/bin/sh\nexit 0\n"))
			.expect("atomic overwrite");
		assert_eq!(
			std_fs::metadata(&path)
				.expect("metadata")
				.permissions()
				.mode() & 0o777,
			0o640
		);
		assert!(mark_executable_for_shebang(&path, b"#!/bin/sh\nexit 0\n"));
		assert_eq!(
			std_fs::metadata(&path)
				.expect("metadata")
				.permissions()
				.mode() & 0o777,
			0o751
		);
		assert_eq!(std_fs::read(&path).expect("written bytes"), b"#!/bin/sh\nexit 0\n");

		let created = sandbox.path().join("created.sh");
		atomic_write_plain(&created, &Bytes::from_static(b"#!/bin/sh\n")).expect("atomic create");
		assert!(mark_executable_for_shebang(&created, b"#!/bin/sh\n"));
		assert_eq!(
			std_fs::metadata(&created)
				.expect("created metadata")
				.permissions()
				.mode() & 0o111,
			0o111
		);
	}

	#[tokio::test]
	async fn production_host_rolls_back_landed_prefix_and_keeps_registers_unpublished() {
		use bytes::BytesMut;

		use crate::docserver::wire::{FrameConfig, read_client_frame, write_server_frame};

		let root = tempfile::tempdir().expect("workspace");
		let root_uri = Url::from_directory_path(root.path())
			.expect("root URI")
			.to_string();
		let a_path = root.path().join("a.txt");
		let b_path = root.path().join("b.txt");
		let a_uri = Url::from_file_path(&a_path).expect("a URI").to_string();
		let b_uri = Url::from_file_path(&b_path).expect("b URI").to_string();
		use tokio::{io, sync::oneshot};

		let (client, server) = io::duplex(64 * 1024);
		let (server_release, server_hold) = oneshot::channel();
		let server_task = tokio::spawn({
			let root_uri = root_uri.clone();
			let a_uri = a_uri.clone();
			let b_uri = b_uri.clone();
			async move {
				let (mut reader, mut writer) = io::split(server);
				let config = FrameConfig::default();
				let mut read_scratch = BytesMut::new();
				let mut write_scratch = BytesMut::new();
				let hello = read_client_frame(&mut reader, config, &mut read_scratch)
					.await
					.expect("read hello")
					.expect("hello frame");
				assert_eq!(hello.request_id, 0);
				write_server_frame(
					&mut writer,
					&pb::ServerFrame {
						request_id: 0,
						body:       Some(server_frame::Body::Hello(pb::ServerHello {
							protocol_major: crate::docserver::connection::PROTOCOL_MAJOR,
							protocol_minor: crate::docserver::connection::PROTOCOL_MINOR,
							workspace_id: Bytes::from_static(b"workspace"),
							root_uri,
							server_epoch: Bytes::from_static(b"rollback-epoch"),
							server_build: String::new(),
						})),
					},
					config,
					&mut write_scratch,
				)
				.await
				.expect("write hello");

				for (index, uri) in [a_uri.clone(), b_uri.clone()].into_iter().enumerate() {
					let open = read_client_frame(&mut reader, config, &mut read_scratch)
						.await
						.expect("read open")
						.expect("open frame");
					write_server_frame(
						&mut writer,
						&pb::ServerFrame {
							request_id: open.request_id,
							body:       Some(server_frame::Body::DocumentOpened(
								pb::OpenDocumentResponse {
									lease_id: Bytes::from(vec![index as u8 + 1; 16]),
									head:     Some(test_document_head(
										uri,
										index as u8 + 1,
										1,
										index as u8 + 10,
										b"old\n".len(),
									)),
								},
							)),
						},
						config,
						&mut write_scratch,
					)
					.await
					.expect("write open");
				}

				let first = read_client_frame(&mut reader, config, &mut read_scratch)
					.await
					.expect("read edit transaction")
					.expect("edit transaction");
				let Some(client_frame::Body::CommitTransaction(first_request)) = first.body else {
					panic!("expected edit transaction");
				};
				assert_eq!(first_request.operations.len(), 2);
				write_server_frame(
					&mut writer,
					&pb::ServerFrame {
						request_id: first.request_id,
						body:       Some(server_frame::Body::TransactionResult(
							pb::CommitTransactionResponse {
								outcome: Some(commit_transaction_response::Outcome::PartiallyCommitted(
									pb::TransactionPartiallyCommitted {
										transaction_id:         first_request.transaction_id,
										committed_operations:   vec![pb::OperationResult {
											operation_index: 0,
											head: Some(test_document_head(
												a_uri.clone(),
												1,
												2,
												30,
												b"new-a\n".len(),
											)),
											..Default::default()
										}],
										failed_operation_index: 1,
										reason:
											pb::TransactionRejectReason::PreconditionFailed as i32,
										message:                "late rejection".into(),
									},
								)),
							},
						)),
					},
					config,
					&mut write_scratch,
				)
				.await
				.expect("write partial outcome");

				let rollback = read_client_frame(&mut reader, config, &mut read_scratch)
					.await
					.expect("read rollback")
					.expect("rollback frame");
				let Some(client_frame::Body::CommitTransaction(rollback_request)) = rollback.body
				else {
					panic!("expected rollback transaction");
				};
				assert_eq!(rollback_request.operations.len(), 1);
				let Some(document_mutation::Operation::Text(text)) =
					rollback_request.operations[0].operation.as_ref()
				else {
					panic!("rollback must restore original text");
				};
				assert_eq!(
					text.change,
					Some(text_mutation::Change::ProposedContent(Bytes::from_static(b"old\n")))
				);
				write_server_frame(
					&mut writer,
					&pb::ServerFrame {
						request_id: rollback.request_id,
						body:       Some(server_frame::Body::TransactionResult(
							pb::CommitTransactionResponse {
								outcome: Some(commit_transaction_response::Outcome::Committed(
									pb::TransactionCommitted {
										transaction_id: rollback_request.transaction_id,
										operations:     vec![pb::OperationResult {
											operation_index: 0,
											head: Some(test_document_head(a_uri, 1, 3, 10, b"old\n".len())),
											..Default::default()
										}],
									},
								)),
							},
						)),
					},
					config,
					&mut write_scratch,
				)
				.await
				.expect("write rollback outcome");
				server_hold.await.expect("test releases fake server");
			}
		});

		let host = DocumentHost::connect(client).await.expect("document host");
		let cancel = CancellationToken::new();
		let a_lease = host
			.open(a_uri.clone().into(), None, &cancel)
			.await
			.expect("a lease");
		let b_lease = host
			.open(b_uri.clone().into(), None, &cancel)
			.await
			.expect("b lease");
		assert_eq!(a_lease.id().as_ref(), &[1; 16]);
		assert_eq!(b_lease.id().as_ref(), &[2; 16]);
		assert_eq!(
			a_lease.head().revision.as_ref(),
			Some(&pb::Revision { sequence: 1, content_hash: Bytes::from(vec![10; 32]) })
		);
		assert_eq!(
			b_lease.head().revision.as_ref(),
			Some(&pb::Revision { sequence: 1, content_hash: Bytes::from(vec![11; 32]) })
		);
		let mut a = prepared_for_test(a_lease, &a_path);
		let mut b = prepared_for_test(b_lease, &b_path);
		let proposals = [&a, &b]
			.into_iter()
			.enumerate()
			.map(|(index, prepared)| EditProposal {
				action:        EditAction::Write {
					content: Bytes::from(format!("new-{}\n", if index == 0 { "a" } else { "b" })),
				},
				base_revision: prepared.base_revision.clone(),
				stale_policy:  StalePolicy::RebaseNonOverlapping,
				format_policy: FormatPolicy::BestEffort,
			})
			.collect();
		let mut batch = host.start_clipboard_batch();
		let cut =
			omp_edit::modes::hashline::parser::parse_patch("CUT 1.=1 @carry").expect("cut patch");
		omp_edit::modes::hashline::apply::apply_edits(
			"carry\n",
			&cut.edits,
			omp_edit::modes::hashline::apply::ApplyOptions {
				clipboard:      Some(&mut batch),
				path:           Some("a.txt"),
				on_empty_paste: omp_edit::modes::hashline::apply::EmptyPaste::Throw,
			},
		)
		.expect("populate batch register");
		assert!(
			batch
				.named
				.as_ref()
				.is_some_and(|named| named.contains_key("carry"))
		);
		let result = EditDocuments::commit(&host, vec![&mut a, &mut b], proposals, batch).await;
		assert!(
			matches!(result, Err(EditCommitError::Rejected(_))),
			"unexpected partial-commit result: {result:?}"
		);
		assert!(
			host
				.start_clipboard_batch()
				.named
				.as_ref()
				.is_none_or(|named| !named.contains_key("carry"))
		);
		server_release
			.send(())
			.expect("release fake document server");
		server_task.await.expect("fake document server");
	}

	fn test_document_head(
		uri: String,
		id: u8,
		sequence: u64,
		hash: u8,
		byte_length: usize,
	) -> pb::DocumentHead {
		pb::DocumentHead {
			document:    Some(pb::DocumentRef { id: Bytes::from(vec![id; 16]), uri }),
			revision:    Some(pb::Revision { sequence, content_hash: Bytes::from(vec![hash; 32]) }),
			presence:    pb::DocumentPresence::Present as i32,
			kind:        pb::DocumentKind::Text as i32,
			byte_length: byte_length as u64,
			language_id: String::new(),
		}
	}

	fn prepared_for_test(lease: DocumentLease, path: &Path) -> PreparedDocument {
		let base_revision = revision_identity(lease.head()).expect("revision identity");
		PreparedDocument {
			lease,
			path: path.to_string_lossy().into_owned().into(),
			display_path: path.to_string_lossy().into_owned().into(),
			base_revision,
			base_bytes: Bytes::from_static(b"old\n"),
			authored_bytes: Bytes::from_static(b"old\n"),
			raw_base_bytes: Bytes::from_static(b"old\n"),
			exists: true,
			notebook: false,
			path_recoveries: Vec::new(),
		}
	}

	// Seen-line guard contracts: rejections resend the full patch, full inline
	// reveals unblock a straight same-tag retry, and truncated reveals keep the
	// merge gate closed.
	const GUARD_PATH: &str = "notes.txt";
	const GUARD_CONTENT: &str = "l1\nl2\nl3\nl4\nl5\n";

	fn guard_store(content: &str, seen: Vec<usize>) -> (EditStore, Str) {
		let store = EditStore::default();
		let seen = seen
			.into_iter()
			.filter_map(|line| u32::try_from(line).ok())
			.collect::<Vec<_>>();
		let tag = store.record(Path::new(GUARD_PATH), content, Some(&seen));
		(store, tag.into())
	}

	fn guard_check(store: &EditStore, tag: &str, anchors: &[usize]) -> Result<(), EditFault> {
		let snapshot = store
			.by_hash(Path::new(GUARD_PATH), tag)
			.expect("retained guard snapshot");
		validate_seen_lines(store, &snapshot, GUARD_PATH, tag, anchors)
	}

	fn guard_message(result: Result<(), EditFault>) -> Str {
		match result.expect_err("seen-line guard must reject").reason {
			RejectionReason::InvalidPatch { message } => message,
			other => panic!("unexpected rejection reason: {other:?}"),
		}
	}

	#[test]
	fn seen_line_guard_skips_when_no_lines_were_recorded() {
		// Absent provenance (externally minted or aged-out tag) → allow.
		let (store, tag) = guard_store(GUARD_CONTENT, vec![]);
		assert!(guard_check(&store, &tag, &[4]).is_ok());
	}

	#[test]
	fn seen_line_guard_accepts_displayed_anchors() {
		let (store, tag) = guard_store(GUARD_CONTENT, vec![1, 2]);
		assert!(guard_check(&store, &tag, &[1, 2]).is_ok());
	}

	#[test]
	fn seen_line_guard_rejects_an_anchor_the_read_never_displayed() {
		let (store, tag) = guard_store(GUARD_CONTENT, vec![1, 2]);
		let message = guard_message(guard_check(&store, &tag, &[4]));
		assert!(message.contains("never displayed"));
		assert!(message.contains("lines 4 of notes.txt"));
	}

	#[test]
	fn seen_line_guard_widens_coverage_on_reread_fusion() {
		// A second read of identical content displaying lines 4-5 unions into
		// the same revision's seen set.
		let (store, tag) = guard_store(GUARD_CONTENT, vec![1, 2]);
		store.record(Path::new(GUARD_PATH), GUARD_CONTENT, Some(&[4, 5]));
		assert!(guard_check(&store, &tag, &[4]).is_ok());
	}

	#[test]
	fn seen_line_guard_reveals_content_and_unblocks_a_straight_retry() {
		let (store, tag) = guard_store(GUARD_CONTENT, vec![1, 2]);
		let message = guard_message(guard_check(&store, &tag, &[4]));
		// The rejection surfaces the ACTUAL file content at the unseen anchor.
		assert!(message.contains("Actual file content at those lines:"));
		assert!(message.contains("  4:l4"));
		assert!(message.contains("straight retry now succeeds"));
		// The revealed line joined the snapshot's seen set: a straight retry
		// with the same [path#tag] header passes without a re-read.
		assert!(guard_check(&store, &tag, &[4]).is_ok());
	}

	#[test]
	fn seen_line_guard_caps_the_reveal_and_keeps_retries_rejected() {
		let content = (1..=200).fold(String::new(), |mut text, line| {
			writeln!(text, "l{line}").expect("writing to String cannot fail");
			text
		});
		let (store, tag) = guard_store(&content, vec![1]);
		// Anchor 60 unseen lines — over the 40-line inline reveal cap.
		let anchors = (100..=159).collect::<Vec<usize>>();
		let message = guard_message(guard_check(&store, &tag, &anchors));
		assert!(message.contains("first 40 unseen line(s)"));
		assert!(message.contains("  100:l100"));
		assert!(message.contains("  139:l139"));
		assert!(!message.contains("140:l140"));
		// Guidance directs at a range re-read of the FULL anchor range.
		assert!(message.contains("notes.txt:100-159"));
		// A straight retry STILL rejects: a truncated reveal must not merge
		// its prefix into the seen set, or the model could split a blind
		// over-cap edit into <=cap-line retries and slip past the re-read
		// gate. The reveal window stays anchored at the head.
		let retry = guard_message(guard_check(&store, &tag, &anchors));
		assert!(retry.contains("first 40 unseen line(s)"));
		assert!(retry.contains("  100:l100"));
		assert!(!retry.contains("140:l140"));
	}

	#[test]
	fn seen_line_guard_clips_wide_lines_and_keeps_the_merge_gate_closed() {
		// Minified-bundle-style single wide line at anchor 2; anchor 3 stays
		// short so the width clip applies only where needed.
		let wide = "a".repeat(4096);
		let content = format!("l1\n{wide}\nl3\nl4\n");
		let (store, tag) = guard_store(&content, vec![1]);
		let message = guard_message(guard_check(&store, &tag, &[2, 3]));
		assert!(message.contains("first 2 unseen line(s)"));
		// Line 2 is clipped at 512 chars + ellipsis; the full 4KB never leaks
		// into the error preview.
		assert!(message.contains(&format!("2:{}…", "a".repeat(512))));
		assert!(!message.contains(&"a".repeat(513)));
		// The short line surfaces verbatim.
		assert!(message.contains("  3:l3"));
		assert!(message.contains("notes.txt:2-3"));
		// A straight retry STILL rejects: column-truncated reveals must not
		// merge, otherwise the model would land the edit having seen only the
		// first 512 chars of a >4KB line.
		let retry = guard_message(guard_check(&store, &tag, &[2, 3]));
		assert!(retry.contains(&format!("2:{}…", "a".repeat(512))));
	}

	#[test]
	fn seen_line_guard_out_of_range_anchors_keep_the_reread_fallback() {
		let (store, tag) = guard_store("l1\nl2\nl3\n", vec![1]);
		let message = guard_message(guard_check(&store, &tag, &[9]));
		// Nothing to reveal — the message keeps the range re-read guidance
		// and the anchor never joins the seen set.
		assert!(message.contains("Re-read them in full first"));
		assert!(guard_check(&store, &tag, &[9]).is_err());
	}

	#[test]
	fn committed_snapshot_marks_every_line_seen() {
		// A committed write is full-file provenance: the guard must not force
		// a re-read before the next edit against the freshly minted tag.
		let store = EditStore::default();
		record_committed_snapshot(&store, Str::from(GUARD_PATH), Bytes::from_static(b"l1\nl2\nl3\n"))
			.expect("record committed snapshot");
		let snapshot = store
			.by_content(Path::new(GUARD_PATH), "l1\nl2\nl3\n")
			.expect("retained committed snapshot");
		let seen_lines = snapshot.seen_lines.as_ref().expect("full-file provenance");
		assert!(seen_lines.contains(&1));
		assert!(seen_lines.contains(&4));
		assert!(!seen_lines.contains(&5));
		assert!(
			validate_seen_lines(&store, &snapshot, GUARD_PATH, &snapshot.hash, &[1, 2, 3, 4]).is_ok()
		);
	}

	#[test]
	fn oversized_committed_snapshot_invalidates_retained_history() {
		let store = EditStore::default();
		store.record(Path::new(GUARD_PATH), "l1\n", Some(&[1]));
		record_committed_snapshot(
			&store,
			Str::from(GUARD_PATH),
			Bytes::from(vec![b'a'; SNAPSHOT_MAX_BYTES + 1]),
		)
		.expect("oversized commit invalidates instead of failing");
		assert!(store.head(Path::new(GUARD_PATH)).is_none());
	}
}

fn write_archive_member_blocking(
	host: &DocumentHost,
	display_path: &str,
	content: Bytes,
	control: &SpecialWriteControl,
) -> Result<Option<backends::ResultPayload>, backends::Fault> {
	use omp_tools::write::backends::{
		ResultPayload, archive_targets, create_tar_member, create_zip_member,
		empty_archive_selector_misfire, format_for_path, rewrite_tar_member, rewrite_zip_member,
	};

	let candidates = archive_targets(display_path)?;
	if candidates.is_empty() {
		return Ok(None);
	}
	let mut resolved = Vec::with_capacity(candidates.len());
	for candidate in candidates {
		let absolute = resolve_special_write_path(host, &candidate.archive_path)?;
		match std_fs::metadata(&absolute) {
			Ok(metadata) if metadata.is_file() => {
				resolved.push((candidate, absolute, true));
				break;
			},
			Ok(_) => resolved.push((candidate, absolute, false)),
			Err(error) if error.kind() == io::ErrorKind::NotFound => {
				resolved.push((candidate, absolute, false));
			},
			Err(error) => return Err(special_fault(error.to_string())),
		}
	}
	let (target, authored_path, exists) = resolved
		.iter()
		.find(|(_, _, exists)| *exists)
		.cloned()
		.or_else(|| resolved.last().cloned())
		.expect("archive candidates are non-empty");
	let final_path = if exists {
		std_fs::canonicalize(&authored_path).unwrap_or_else(|_| authored_path.clone())
	} else {
		authored_path
	};
	if format_for_path(&final_path) == archive::ArchiveFormat::Asar {
		return Err(special_fault("ASAR archives are read-only"));
	}
	let member_existed = if exists {
		archive_member_exists(&final_path, format_for_path(&final_path), &target.member_path)?
	} else {
		false
	};
	if let Some(fault) =
		empty_archive_selector_misfire(display_path, content.is_empty(), member_existed)
	{
		return Err(fault);
	}
	if !control.begin_effects() {
		return Err(special_write_cancelled());
	}
	if let Some(parent) = final_path.parent() {
		std_fs::create_dir_all(parent).map_err(|error| special_fault(error.to_string()))?;
	}
	atomic_replace(&final_path, |output| match (format_for_path(&final_path), exists) {
		(archive::ArchiveFormat::Zip, true) => {
			let input =
				std_fs::File::open(&final_path).map_err(|error| special_fault(error.to_string()))?;
			rewrite_zip_member(input, output, &target.member_path, &content)
		},
		(archive::ArchiveFormat::Zip, false) => {
			create_zip_member(output, &target.member_path, &content)
		},
		(archive::ArchiveFormat::Tar, true) => {
			let input =
				std_fs::File::open(&final_path).map_err(|error| special_fault(error.to_string()))?;
			rewrite_tar_member(input, output, &target.member_path, &content)
		},
		(archive::ArchiveFormat::Tar, false) => {
			create_tar_member(output, &target.member_path, &content)
		},
		(archive::ArchiveFormat::TarGz, true) => {
			let input =
				std_fs::File::open(&final_path).map_err(|error| special_fault(error.to_string()))?;
			let mut decoder = GzDecoder::new(input);
			let limit = archive::MAX_TAR_ARCHIVE_BYTES;
			let mut decoded = Vec::new();
			let mut bounded = io::Read::take(&mut decoder, limit.saturating_add(1));
			io::Read::read_to_end(&mut bounded, &mut decoded)
				.map_err(|error| special_fault(error.to_string()))?;
			if decoded.len() as u64 > limit {
				return Err(special_fault(
					omp_ar::Error::ArchiveTooLarge { actual: decoded.len() as u64, limit }.to_string(),
				));
			}
			let mut encoder = GzEncoder::new(output, flate2::Compression::default());
			rewrite_tar_member(io::Cursor::new(decoded), &mut encoder, &target.member_path, &content)?;
			encoder
				.finish()
				.map_err(|error| special_fault(error.to_string()))?;
			Ok(())
		},
		(archive::ArchiveFormat::TarGz, false) => {
			let mut encoder = GzEncoder::new(output, flate2::Compression::default());
			create_tar_member(&mut encoder, &target.member_path, &content)?;
			encoder
				.finish()
				.map_err(|error| special_fault(error.to_string()))?;
			Ok(())
		},
		(archive::ArchiveFormat::TarZst, true) => {
			let input =
				std_fs::File::open(&final_path).map_err(|error| special_fault(error.to_string()))?;
			let mut decoder = zstd::stream::read::Decoder::new(input)
				.map_err(|error| special_fault(error.to_string()))?;
			let limit = archive::MAX_TAR_ARCHIVE_BYTES;
			let mut decoded = Vec::new();
			let mut bounded = io::Read::take(&mut decoder, limit.saturating_add(1));
			io::Read::read_to_end(&mut bounded, &mut decoded)
				.map_err(|error| special_fault(error.to_string()))?;
			if decoded.len() as u64 > limit {
				return Err(special_fault(
					omp_ar::Error::ArchiveTooLarge { actual: decoded.len() as u64, limit }.to_string(),
				));
			}
			let mut encoder = zstd::stream::write::Encoder::new(output, 0)
				.map_err(|error| special_fault(error.to_string()))?;
			rewrite_tar_member(io::Cursor::new(decoded), &mut encoder, &target.member_path, &content)?;
			encoder
				.finish()
				.map_err(|error| special_fault(error.to_string()))?;
			Ok(())
		},
		(archive::ArchiveFormat::TarZst, false) => {
			let mut encoder = zstd::stream::write::Encoder::new(output, 0)
				.map_err(|error| special_fault(error.to_string()))?;
			create_tar_member(&mut encoder, &target.member_path, &content)?;
			encoder
				.finish()
				.map_err(|error| special_fault(error.to_string()))?;
			Ok(())
		},
		(other, _) => {
			Err(special_fault(format!("{} archives are read-only", <&'static str>::from(other))))
		},
	})?;

	let canonical = std_fs::canonicalize(&final_path).unwrap_or(final_path);
	let canonical_key = canonical.to_string_lossy().into_owned();
	let member_key = format!("{canonical_key}:{}", target.member_path);
	let _snapshot_tag = {
		let snapshots = host.snapshot_store();
		snapshots.invalidate(Path::new(&canonical_key));
		snapshots.invalidate(Path::new(&member_key));
		if content.len() <= SNAPSHOT_MAX_BYTES {
			snapshot_text(&content)
				.map(|text| Str::from(snapshots.record(Path::new(&member_key), &text, Some(&[]))))
		} else {
			None
		}
	};
	let output_path = format!("{}:{}", target.archive_path, target.member_path);
	Ok(Some(ResultPayload {
		resolved_path: canonical_key.into(),
		display_path:  output_path.into(),
		byte_len:      u64::try_from(content.len()).unwrap_or(u64::MAX),
		disposition:   if member_existed {
			WriteDisposition::Overwrote
		} else {
			WriteDisposition::Created
		},
		operation:     WriteOperation::ArchiveMember,
		snapshot_tag:  None,
	}))
}

fn archive_member_exists(
	path: &Path,
	format: archive::ArchiveFormat,
	member: &str,
) -> Result<bool, backends::Fault> {
	if !matches!(
		format,
		omp_ar::Format::Zip | omp_ar::Format::Tar | omp_ar::Format::TarGz | omp_ar::Format::TarZst
	) {
		return Err(special_fault(format!(
			"{} archives are read-only",
			<&'static str>::from(format)
		)));
	}
	let file = std_fs::File::open(path).map_err(|error| special_fault(error.to_string()))?;
	let archive = omp_ar::Archive::with_format(file, format)
		.map_err(|error| special_fault(error.to_string()))?;
	Ok(archive
		.entry(member)
		.is_some_and(|entry| !entry.is_directory()))
}

fn write_sqlite_row_blocking(
	host: &DocumentHost,
	display_path: &str,
	content: &str,
	control: &SpecialWriteControl,
	interrupt: &SqliteWriteInterrupt,
) -> Result<Option<backends::ResultPayload>, backends::Fault> {
	use omp_tools::{
		read::looks_like_sqlite,
		write::backends::{ResultPayload, mutate_sqlite_row, sqlite_targets},
	};
	use rusqlite::OpenFlags;

	let candidates = sqlite_targets(display_path)?;
	if candidates.is_empty() {
		return Ok(None);
	}
	let mut fallback = None;
	let mut selected = None;
	let mut saw_existing_non_sqlite = false;
	for candidate in candidates {
		let absolute = resolve_special_write_path(host, &candidate.sqlite_path)?;
		fallback = Some((candidate.clone(), absolute.clone()));
		match std_fs::metadata(&absolute) {
			Ok(metadata) if metadata.is_file() => {
				let mut prefix = [0_u8; 16];
				let sqlite = std_fs::File::open(&absolute)
					.and_then(|mut file| io::Read::read_exact(&mut file, &mut prefix))
					.is_ok() && looks_like_sqlite(&prefix);
				if sqlite {
					selected = Some((candidate, absolute));
					break;
				}
				saw_existing_non_sqlite = true;
			},
			Ok(_) => {},
			Err(error) if error.kind() == io::ErrorKind::NotFound => {},
			Err(error) => return Err(special_fault(error.to_string())),
		}
	}
	if selected.is_none() && saw_existing_non_sqlite {
		return Ok(None);
	}
	let Some((target, absolute)) = selected else {
		let _ = fallback;
		return Err(special_fault(format!("SQLite database '{display_path}' not found")));
	};
	if !control.begin_effects() {
		return Err(special_write_cancelled());
	}
	let mut connection = rusqlite::Connection::open_with_flags(
		&absolute,
		OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI,
	)
	.map_err(|error| special_fault(error.to_string()))?;
	let progress = control.clone();
	connection
		.progress_handler(1_000, Some(move || progress.is_cancelled()))
		.map_err(|error| special_fault(error.to_string()))?;
	interrupt.install(&connection);
	if control.is_cancelled() {
		interrupt.interrupt();
	}
	let mutation = mutate_sqlite_row(&mut connection, &target, content)?;
	drop(connection);
	let canonical = std_fs::canonicalize(&absolute).unwrap_or(absolute);
	let canonical_key = canonical.to_string_lossy().into_owned();
	host.snapshot_store().invalidate(Path::new(&canonical_key));
	Ok(Some(ResultPayload {
		resolved_path: canonical_key.into(),
		display_path:  display_path.into(),
		byte_len:      u64::try_from(content.len()).unwrap_or(u64::MAX),
		disposition:   mutation.disposition,
		operation:     mutation.operation,
		snapshot_tag:  None,
	}))
}

fn resolve_special_write_path(
	host: &DocumentHost,
	input: &str,
) -> Result<PathBuf, backends::Fault> {
	let root_url = Url::parse(host.hello().root_uri.as_str()).map_err(|error| {
		special_fault(format!("document workspace root is not a valid URI: {error}"))
	})?;
	let root = normalize_absolute(
		&root_url
			.to_file_path()
			.map_err(|()| special_fault("document workspace root is not a local file URI"))?,
	)
	.map_err(special_fault)?;
	let authored = selector::expand_tilde(input, None);
	let candidate = if authored.is_absolute() {
		normalize_absolute(&authored)
	} else {
		normalize_absolute(&root.join(authored))
	}
	.map_err(special_fault)?;
	let mut ancestor = candidate.as_path();
	let canonical_ancestor = loop {
		match std_fs::canonicalize(ancestor) {
			Ok(canonical) => break canonical,
			Err(error)
				if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) =>
			{
				ancestor = ancestor
					.parent()
					.ok_or_else(|| special_fault("write path has no existing ancestor"))?;
			},
			Err(error) => return Err(special_fault(error.to_string())),
		}
	};
	let suffix = candidate
		.strip_prefix(ancestor)
		.map_err(|_| special_fault("write path could not be resolved from its existing ancestor"))?;
	Ok(join_nonempty_suffix(canonical_ancestor, suffix))
}

fn atomic_replace(
	path: &Path,
	write: impl FnOnce(std_fs::File) -> Result<(), backends::Fault>,
) -> Result<(), backends::Fault> {
	let tmp_path = unique_temp_path(path);
	let output = OpenOptions::new()
		.write(true)
		.create_new(true)
		.open(&tmp_path)
		.map_err(|error| special_fault(error.to_string()))?;
	if let Err(error) = write(output) {
		let _ = std_fs::remove_file(&tmp_path);
		return Err(error);
	}
	if let Err(error) = replace_file_atomically(&tmp_path, path) {
		let _ = std_fs::remove_file(&tmp_path);
		return Err(special_fault(error.to_string()));
	}
	Ok(())
}

fn unique_temp_path(path: &Path) -> PathBuf {
	static NEXT_SPECIAL_WRITE: AtomicU64 = AtomicU64::new(1);
	let sequence = NEXT_SPECIAL_WRITE.fetch_add(1, Ordering::Relaxed);
	let name = path
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or("archive");
	path.with_file_name(format!(".{name}.tmp-{}-{sequence}", std::process::id()))
}

fn special_write_cancelled() -> backends::Fault {
	special_fault("special write cancelled before mutation began")
}

fn special_fault(message: impl Into<Str>) -> backends::Fault {
	backends::Fault { message: message.into() }
}

#[cfg(test)]
mod special_write_tests {
	use std::{
		fs as std_fs,
		io::Write as _,
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
		},
		time::Duration,
	};

	use omp_tools::write::{SpecialWriteCancellation, SpecialWriteControl};
	use tokio::{task, time};

	use super::{
		SqliteWriteInterrupt, atomic_replace, run_special_write_blocking, special_fault,
		special_write_cancelled,
	};

	#[tokio::test(flavor = "current_thread")]
	async fn stalled_blocking_write_keeps_runtime_responsive_and_cancels_before_effects() {
		let (started_tx, started_rx) = flume::bounded(1);
		let (release_tx, release_rx) = flume::bounded(1);
		let mutated = Arc::new(AtomicBool::new(false));
		let worker_mutated = Arc::clone(&mutated);
		let control = SpecialWriteControl::new();
		let task_control = control.clone();
		let task = tokio::spawn(async move {
			run_special_write_blocking(task_control, "injected", move |control| {
				started_tx.send(()).expect("test receives worker start");
				release_rx.recv().expect("test releases stalled worker");
				if !control.begin_effects() {
					return Err(special_write_cancelled());
				}
				worker_mutated.store(true, Ordering::Release);
				Ok(())
			})
			.await
		});
		time::timeout(Duration::from_secs(1), started_rx.recv_async())
			.await
			.expect("blocking worker starts without pinning the runtime")
			.expect("worker start channel remains live");
		let heartbeat = tokio::spawn(async {
			task::yield_now().await;
		});
		time::timeout(Duration::from_secs(1), heartbeat)
			.await
			.expect("runtime remains responsive while worker is stalled")
			.expect("heartbeat joins");
		assert_eq!(control.cancel(), SpecialWriteCancellation::BeforeEffects);
		release_tx.send(()).expect("release worker");
		let result = time::timeout(Duration::from_secs(1), task)
			.await
			.expect("cancelled worker finishes")
			.expect("worker task joins");
		assert_eq!(
			result
				.expect_err("pre-effect cancellation rejects")
				.message
				.as_str(),
			"special write cancelled before mutation began"
		);
		assert!(!mutated.load(Ordering::Acquire));
	}

	#[tokio::test(flavor = "current_thread")]
	async fn cancellation_after_blocking_worker_starts_effects_is_unknown() {
		let (started_tx, started_rx) = flume::bounded(1);
		let (release_tx, release_rx) = flume::bounded(1);
		let control = SpecialWriteControl::new();
		let task_control = control.clone();
		let task = tokio::spawn(async move {
			run_special_write_blocking(task_control, "injected", move |control| {
				assert!(control.begin_effects());
				started_tx.send(()).expect("test receives effect boundary");
				release_rx.recv().expect("test releases stalled worker");
				Ok(())
			})
			.await
		});

		time::timeout(Duration::from_secs(1), started_rx.recv_async())
			.await
			.expect("worker reaches effect boundary")
			.expect("effect boundary channel remains live");
		assert_eq!(control.cancel(), SpecialWriteCancellation::EffectsUnknown);
		release_tx.send(()).expect("release worker");
		time::timeout(Duration::from_secs(1), task)
			.await
			.expect("worker finishes")
			.expect("worker task joins")
			.expect("injected worker succeeds");
	}

	#[tokio::test(flavor = "current_thread")]
	async fn sqlite_interrupt_handle_stops_an_active_operation() {
		let (started_tx, started_rx) = flume::bounded(1);
		let control = SpecialWriteControl::new();
		let interrupt = Arc::new(SqliteWriteInterrupt::default());
		let task_control = control.clone();
		let task_interrupt = Arc::clone(&interrupt);
		let worker = task::spawn_blocking(move || {
			let connection = rusqlite::Connection::open_in_memory().expect("open SQLite fixture");
			let progress = task_control.clone();
			connection
				.progress_handler(1_000, Some(move || progress.is_cancelled()))
				.expect("install SQLite progress handler");
			task_interrupt.install(&connection);
			assert!(task_control.begin_effects());
			started_tx
				.send(())
				.expect("test observes active SQLite operation");
			connection
				.query_row(
					"WITH RECURSIVE count(x) AS (VALUES(0) UNION ALL SELECT x + 1 FROM count) SELECT \
					 sum(x) FROM count",
					[],
					|row| row.get::<_, i64>(0),
				)
				.expect_err("active SQLite operation is interrupted")
		});
		let waiter_control = control.clone();
		let waiter_interrupt = Arc::clone(&interrupt);
		let waiter = tokio::spawn(async move {
			waiter_control.cancelled().await;
			waiter_interrupt.interrupt();
		});

		time::timeout(Duration::from_secs(1), started_rx.recv_async())
			.await
			.expect("SQLite worker starts")
			.expect("SQLite start channel remains live");
		assert_eq!(control.cancel(), SpecialWriteCancellation::EffectsUnknown);
		let error = time::timeout(Duration::from_secs(1), worker)
			.await
			.expect("SQLite interrupt stops active operation promptly")
			.expect("SQLite worker joins");
		waiter.await.expect("interrupt waiter joins");
		assert!(
			matches!(
				&error,
				rusqlite::Error::SqliteFailure(failure, _)
					if failure.code == rusqlite::ErrorCode::OperationInterrupted
			),
			"unexpected SQLite interruption error: {error}"
		);
	}

	#[test]
	fn atomic_archive_swap_commits_complete_output() {
		let directory = tempfile::tempdir().unwrap();
		let archive = directory.path().join("fixture.zip");
		std_fs::write(&archive, b"old archive").unwrap();
		atomic_replace(&archive, |mut output| {
			output
				.write_all(b"complete new archive")
				.map_err(|error| special_fault(error.to_string()))
		})
		.unwrap();
		assert_eq!(std_fs::read(&archive).unwrap(), b"complete new archive");
	}

	#[test]
	fn atomic_archive_swap_rolls_back_partial_output() {
		let directory = tempfile::tempdir().unwrap();
		let archive = directory.path().join("fixture.zip");
		std_fs::write(&archive, b"old archive").unwrap();
		let result = atomic_replace(&archive, |mut output| {
			output
				.write_all(b"partial")
				.map_err(|error| special_fault(error.to_string()))?;
			Err(special_fault("injected archive encoder failure"))
		});
		assert_eq!(result.unwrap_err().to_string(), "injected archive encoder failure");
		assert_eq!(std_fs::read(&archive).unwrap(), b"old archive");
		assert_eq!(std_fs::read_dir(directory.path()).unwrap().count(), 1);
	}
}
