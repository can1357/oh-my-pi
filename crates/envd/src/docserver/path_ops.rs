//! Actor-aware Environment path operations.

use std::{
	fmt, io,
	path::{Path, PathBuf},
	result,
	sync::Arc,
};

use bytes::Bytes;
use omp_core::{Str, sf};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::docserver::{
	DocumentHead, DocumentId, DocumentPresence, DocumentStore, Error, ReadBody, ReadSelection,
	Result, Revision, TransactionId,
	environment::WorkspaceMutationGuard,
	fs::{
		CopyOutcome, DestinationOverwritePolicy, DirectoryEntry, DiskState, ExistingDirectoryPolicy,
		FileKind, FollowSymlinks, PathMetadata, PortablePermissions, SymlinkTarget,
		SymlinkTargetKind,
	},
	lsp_registry::LspRegistry,
	transaction::{
		DeleteMutation, DocumentMutation, DocumentTarget, FormatPolicy, MoveDestinationPrecondition,
		MoveMutation, MutationOperation, StalePolicy, TextMutation, TextProposal,
		TransactionCoordinator, TransactionOutcome, TransactionRequest,
	},
};

/// Result of a path mutation which may have used the document transaction
/// pipeline.
#[derive(Clone, Debug)]
pub enum PathMutationResult<T> {
	/// The requested path mutation completed.
	Completed(T),
	/// The document transaction rejected the mutation without hiding its stable
	/// rejection classification or conflicts.
	TransactionRejected(Arc<TransactionOutcome>),
}

impl<T> PathMutationResult<T> {
	/// Returns the completed value, or the exact rejected transaction outcome.
	pub fn into_result(self) -> result::Result<T, Arc<TransactionOutcome>> {
		match self {
			Self::Completed(value) => Ok(value),
			Self::TransactionRejected(outcome) => Err(outcome),
		}
	}

	fn map<U>(self, map: impl FnOnce(T) -> U) -> PathMutationResult<U> {
		match self {
			Self::Completed(value) => PathMutationResult::Completed(map(value)),
			Self::TransactionRejected(outcome) => PathMutationResult::TransactionRejected(outcome),
		}
	}
}

/// Capability-confined path operations coordinated with active document
/// actors.
#[derive(Clone)]
pub struct PathService {
	store:        DocumentStore,
	transactions: TransactionCoordinator<LspRegistry>,
}

impl fmt::Debug for PathService {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("PathService")
			.finish_non_exhaustive()
	}
}

impl PathService {
	/// Creates a path service sharing the supplied store and transaction
	/// coordinator.
	pub const fn new(
		store: DocumentStore,
		transactions: TransactionCoordinator<LspRegistry>,
	) -> Self {
		Self { store, transactions }
	}

	/// Reserves mutation targets against concurrent workspace lease acquisition.
	pub(crate) fn begin_workspace_mutation(
		&self,
		owner: [u8; 16],
		paths: Vec<PathBuf>,
	) -> Result<WorkspaceMutationGuard> {
		self.store.workspace_leases().begin_mutation(owner, paths)
	}

	/// Canonicalizes an existing confined file URI.
	pub fn canonicalize(&self, uri: &Url) -> Result<Url> {
		let path = self.store.resolve_entry_path(uri)?;
		let canonical = self.store.local_fs().canonicalize(path)?;
		self.store.file_uri(&canonical)
	}

	/// Returns stat or lstat metadata for a confined file URI.
	pub fn stat(&self, uri: &Url, follow: FollowSymlinks) -> Result<PathMetadata> {
		let path = self.store.resolve_entry_path(uri)?;
		self.store.local_fs().stat(path, follow)
	}

	/// Lists the immediate children of a confined directory.
	pub fn list_directory(&self, uri: &Url, follow: FollowSymlinks) -> Result<Vec<DirectoryEntry>> {
		let path = self.store.resolve_entry_path(uri)?;
		self.store.local_fs().list_directory(path, follow)
	}

	/// Creates one directory or a missing parent chain while excluding active
	/// actor bindings.
	pub async fn create_directory(
		&self,
		uri: &Url,
		recursive: bool,
		existing: ExistingDirectoryPolicy,
		cancellation: &CancellationToken,
	) -> Result<PathMutationResult<PathMetadata>> {
		let path = self.store.resolve_entry_path(uri)?;
		ensure_not_cancelled(cancellation, &path, "create directory")?;
		let gate = self.store.mutation_gate();
		let _authority = tokio::select! {
			biased;
			() = cancellation.cancelled() => {
				return Err(cancelled_path_operation(&path, "create directory"));
			},
			authority = gate.lock() => authority,
		};
		self.store.check_workspace_paths(None, [path.clone()])?;
		ensure_not_cancelled(cancellation, &path, "create directory")?;
		self.reject_active_at_or_below(&path, cancellation).await?;
		ensure_not_cancelled(cancellation, &path, "create directory")?;
		let metadata = self
			.store
			.local_fs()
			.create_directory(path, recursive, existing)?;
		Ok(PathMutationResult::Completed(metadata))
	}

	/// Removes a path, routing active regular files through a revisioned delete.
	pub async fn remove(
		&self,
		uri: &Url,
		recursive: bool,
		revision: Option<Revision>,
		cancellation: &CancellationToken,
	) -> Result<PathMutationResult<()>> {
		let path = self.store.resolve_entry_path(uri)?;
		ensure_not_cancelled(cancellation, &path, "remove path")?;
		let metadata = self.store.local_fs().stat(&path, FollowSymlinks::No)?;
		if metadata.kind == FileKind::RegularFile
			&& let Some((document_id, _)) = self.active_regular(&metadata.path, cancellation).await?
		{
			let revision = require_revision(revision, &metadata.path, "active removal")?;
			ensure_not_cancelled(cancellation, &metadata.path, "remove path")?;
			return Ok(self
				.commit_one(
					document_id,
					MutationOperation::Delete(DeleteMutation::new(revision)),
					cancellation,
				)
				.await
				.map(|_| ()));
		}
		let gate = self.store.mutation_gate();
		let _authority = tokio::select! {
			biased;
			() = cancellation.cancelled() => {
				return Err(cancelled_path_operation(&metadata.path, "remove path"));
			},
			authority = gate.lock() => authority,
		};
		self
			.store
			.check_workspace_paths(None, [metadata.path.clone()])?;
		ensure_not_cancelled(cancellation, &metadata.path, "remove path")?;
		if metadata.kind == FileKind::Directory {
			self
				.reject_active_at_or_below(&metadata.path, cancellation)
				.await?;
		} else {
			self.reject_active_exact(&metadata.path, cancellation)?;
		}
		ensure_not_cancelled(cancellation, &metadata.path, "remove path")?;
		self.store.local_fs().remove(path, recursive)?;
		Ok(PathMutationResult::Completed(()))
	}

	/// Renames an entry, preserving the stable identity of an active regular
	/// source and refusing to displace any active destination.
	pub async fn rename(
		&self,
		source_uri: &Url,
		destination_uri: &Url,
		overwrite: DestinationOverwritePolicy,
		source_revision: Option<Revision>,
		destination_revision: Option<Revision>,
		cancellation: &CancellationToken,
	) -> Result<PathMutationResult<PathMetadata>> {
		let source = self.store.resolve_entry_path(source_uri)?;
		let destination = self.store.resolve_entry_path(destination_uri)?;
		ensure_not_cancelled(cancellation, &source, "rename path")?;
		let source_metadata = self.store.local_fs().stat(&source, FollowSymlinks::No)?;
		if source_metadata.kind == FileKind::RegularFile
			&& let Some((document_id, _)) = self
				.active_regular(&source_metadata.path, cancellation)
				.await?
		{
			self
				.reject_active_destination(&destination, destination_revision, cancellation)
				.await?;
			let revision =
				require_revision(source_revision, &source_metadata.path, "active rename source")?;
			let destination_precondition = self
				.move_destination_precondition(&destination, overwrite, cancellation)
				.await?;
			ensure_not_cancelled(cancellation, &source_metadata.path, "rename path")?;
			let outcome = self
				.commit_one(
					document_id,
					MutationOperation::Move(MoveMutation::new(
						revision,
						destination_uri.clone(),
						destination_precondition,
					)),
					cancellation,
				)
				.await;
			return match outcome {
				PathMutationResult::Completed(head) => Ok(PathMutationResult::Completed(
					committed_file_metadata(source_metadata, &destination, &head),
				)),
				PathMutationResult::TransactionRejected(outcome) => {
					Ok(PathMutationResult::TransactionRejected(outcome))
				},
			};
		}
		let gate = self.store.mutation_gate();
		let _authority = tokio::select! {
			biased;
			() = cancellation.cancelled() => {
				return Err(cancelled_path_operation(&source_metadata.path, "rename path"));
			},
			authority = gate.lock() => authority,
		};
		self
			.store
			.check_workspace_paths(None, [source_metadata.path.clone(), destination.clone()])?;
		ensure_not_cancelled(cancellation, &source_metadata.path, "rename path")?;
		if source_metadata.kind == FileKind::Directory {
			self
				.reject_active_at_or_below(&source_metadata.path, cancellation)
				.await?;
		} else {
			self.reject_active_exact(&source_metadata.path, cancellation)?;
		}
		self
			.reject_active_at_or_below(&destination, cancellation)
			.await?;
		ensure_not_cancelled(cancellation, &source_metadata.path, "rename path")?;
		let metadata = self
			.store
			.local_fs()
			.rename(source, destination, overwrite)?;
		Ok(PathMutationResult::Completed(metadata))
	}

	/// Copies a regular file or symbolic-link entry, committing bytes through
	/// the destination actor when the destination is an active regular file.
	pub async fn copy(
		&self,
		source_uri: &Url,
		destination_uri: &Url,
		follow_source: FollowSymlinks,
		overwrite: DestinationOverwritePolicy,
		destination_revision: Option<Revision>,
		cancellation: &CancellationToken,
	) -> Result<PathMutationResult<CopyOutcome>> {
		let source = self.store.resolve_entry_path(source_uri)?;
		let destination = self.store.resolve_entry_path(destination_uri)?;
		ensure_not_cancelled(cancellation, &source, "copy path")?;
		if overwrite == DestinationOverwritePolicy::ReplaceEmptyDirectory {
			return Err(invalid_target(
				&destination,
				"copy cannot use the replace-empty-directory policy",
			));
		}
		if let Ok(destination_metadata) = self.store.local_fs().stat(&destination, FollowSymlinks::No)
		{
			if overwrite == DestinationOverwritePolicy::FailIfExists {
				return Err(path_io_error(
					&destination,
					"copy path",
					io::ErrorKind::AlreadyExists,
					"copy destination already exists",
				));
			}
			if destination_metadata.kind == FileKind::RegularFile
				&& let Some((document_id, _)) = self
					.active_regular(&destination_metadata.path, cancellation)
					.await?
			{
				if follow_source == FollowSymlinks::No
					&& self
						.store
						.local_fs()
						.stat(&source, FollowSymlinks::No)?
						.kind == FileKind::SymbolicLink
				{
					return Err(precondition_failed(
						&destination,
						"a symbolic-link entry cannot replace an active regular document",
					));
				}
				let revision = require_revision(
					destination_revision,
					&destination_metadata.path,
					"active copy destination",
				)?;
				let bytes = self
					.copy_source_bytes(&source, follow_source, cancellation)
					.await?;
				let bytes_copied = u64::try_from(bytes.len()).map_err(|_| Error::InvalidContent {
					reason: sf!("copy source length exceeds the protocol limit"),
				})?;
				ensure_not_cancelled(cancellation, &destination_metadata.path, "copy path")?;
				let outcome = self
					.commit_one(
						document_id,
						MutationOperation::Text(TextMutation::new(
							revision,
							TextProposal::Content(bytes),
							StalePolicy::Fail,
							FormatPolicy::Disabled,
						)),
						cancellation,
					)
					.await;
				return match outcome {
					PathMutationResult::Completed(head) => {
						Ok(PathMutationResult::Completed(CopyOutcome {
							metadata: committed_file_metadata(destination_metadata, &destination, &head),
							bytes_copied,
						}))
					},
					PathMutationResult::TransactionRejected(outcome) => {
						Ok(PathMutationResult::TransactionRejected(outcome))
					},
				};
			}
		}
		let gate = self.store.mutation_gate();
		let _authority = tokio::select! {
			biased;
			() = cancellation.cancelled() => {
				return Err(cancelled_path_operation(&destination, "copy path"));
			},
			authority = gate.lock() => authority,
		};
		self
			.store
			.check_workspace_paths(None, [destination.clone()])?;
		ensure_not_cancelled(cancellation, &destination, "copy path")?;
		self
			.reject_active_at_or_below(&destination, cancellation)
			.await?;
		ensure_not_cancelled(cancellation, &destination, "copy path")?;
		let outcome = self
			.store
			.local_fs()
			.copy(source, destination, follow_source, overwrite)?;
		Ok(PathMutationResult::Completed(outcome))
	}

	/// Reads a symbolic link without dereferencing its final component.
	pub fn read_link(&self, uri: &Url) -> Result<SymlinkTarget> {
		let path = self.store.resolve_entry_path(uri)?;
		self.store.local_fs().read_link(path)
	}

	/// Creates a symbolic link while refusing to replace an active entry.
	pub async fn create_symlink(
		&self,
		target: &SymlinkTarget,
		link_uri: &Url,
		target_kind: SymlinkTargetKind,
		overwrite: DestinationOverwritePolicy,
		cancellation: &CancellationToken,
	) -> Result<PathMutationResult<PathMetadata>> {
		let link = self.store.resolve_entry_path(link_uri)?;
		ensure_not_cancelled(cancellation, &link, "create symlink")?;
		let gate = self.store.mutation_gate();
		let _authority = tokio::select! {
			biased;
			() = cancellation.cancelled() => {
				return Err(cancelled_path_operation(&link, "create symlink"));
			},
			authority = gate.lock() => authority,
		};
		self.store.check_workspace_paths(None, [link.clone()])?;
		ensure_not_cancelled(cancellation, &link, "create symlink")?;
		self.reject_active_at_or_below(&link, cancellation).await?;
		ensure_not_cancelled(cancellation, &link, "create symlink")?;
		let metadata = self
			.store
			.local_fs()
			.create_symlink(target, link, target_kind, overwrite)?;
		Ok(PathMutationResult::Completed(metadata))
	}

	/// Creates a hard link while refusing to replace an active entry.
	pub async fn create_hard_link(
		&self,
		source_uri: &Url,
		link_uri: &Url,
		follow_source: FollowSymlinks,
		overwrite: DestinationOverwritePolicy,
		cancellation: &CancellationToken,
	) -> Result<PathMutationResult<PathMetadata>> {
		let source = self.store.resolve_entry_path(source_uri)?;
		let link = self.store.resolve_entry_path(link_uri)?;
		ensure_not_cancelled(cancellation, &source, "create hard link")?;
		let gate = self.store.mutation_gate();
		let _authority = tokio::select! {
			biased;
			() = cancellation.cancelled() => {
				return Err(cancelled_path_operation(&source, "create hard link"));
			},
			authority = gate.lock() => authority,
		};
		ensure_not_cancelled(cancellation, &source, "create hard link")?;
		self
			.store
			.check_workspace_paths(None, [source.clone(), link.clone()])?;
		let selected_source = self.store.local_fs().stat(&source, follow_source)?;
		if selected_source.kind == FileKind::RegularFile
			&& self
				.store
				.actor_handle_for_path(&selected_source.path)
				.is_some()
		{
			return Err(precondition_failed(
				&selected_source.path,
				"hard links to active regular documents are not allowed",
			));
		}
		self.reject_active_at_or_below(&link, cancellation).await?;
		ensure_not_cancelled(cancellation, &link, "create hard link")?;
		let metadata =
			self
				.store
				.local_fs()
				.create_hard_link(source, link, follow_source, overwrite)?;
		Ok(PathMutationResult::Completed(metadata))
	}

	/// Changes portable permissions, requiring an exact revision for an active
	/// regular file selected by the request.
	pub async fn set_permissions(
		&self,
		uri: &Url,
		permissions: PortablePermissions,
		follow: FollowSymlinks,
		revision: Option<Revision>,
		cancellation: &CancellationToken,
	) -> Result<PathMutationResult<PathMetadata>> {
		let path = self.store.resolve_entry_path(uri)?;
		ensure_not_cancelled(cancellation, &path, "set path permissions")?;
		let selected = self.store.local_fs().stat(&path, follow)?;
		let gate = self.store.mutation_gate();
		let _authority = tokio::select! {
			biased;
			() = cancellation.cancelled() => {
				return Err(cancelled_path_operation(&selected.path, "set path permissions"));
			},
			authority = gate.lock() => authority,
		};
		ensure_not_cancelled(cancellation, &selected.path, "set path permissions")?;
		self
			.store
			.check_workspace_paths(None, [selected.path.clone()])?;
		if selected.kind == FileKind::RegularFile
			&& let Some(handle) = self.store.actor_handle_for_path(&selected.path)
		{
			let expected = require_revision(revision, &selected.path, "active permission target")?;
			ensure_not_cancelled(cancellation, &selected.path, "set path permissions")?;
			let metadata = handle
				.set_permissions(expected, permissions, follow)
				.await?;
			return Ok(PathMutationResult::Completed(metadata));
		}
		ensure_not_cancelled(cancellation, &path, "set path permissions")?;
		let metadata = self
			.store
			.local_fs()
			.set_permissions(path, permissions, follow)?;
		Ok(PathMutationResult::Completed(metadata))
	}

	async fn active_regular(
		&self,
		path: &Path,
		cancellation: &CancellationToken,
	) -> Result<Option<(DocumentId, DocumentHead)>> {
		ensure_not_cancelled(cancellation, path, "inspect active document")?;
		let Some(handle) = self.store.actor_handle_for_path(path) else {
			return Ok(None);
		};
		let state = tokio::select! {
			biased;
			() = cancellation.cancelled() => {
				return Err(cancelled_path_operation(path, "inspect active document"));
			},
			state = handle.state() => state?,
		};
		let Some(snapshot) = state.head else {
			return Err(precondition_failed(path, "active document is still initializing"));
		};
		if snapshot.head().presence() != DocumentPresence::Present {
			return Ok(None);
		}
		Ok(Some((state.document_id, snapshot.head().clone())))
	}

	async fn copy_source_bytes(
		&self,
		source: &Path,
		follow: FollowSymlinks,
		cancellation: &CancellationToken,
	) -> Result<Bytes> {
		ensure_not_cancelled(cancellation, source, "copy path")?;
		let metadata = self.store.local_fs().stat(source, follow)?;
		if metadata.kind == FileKind::RegularFile
			&& let Some(handle) = self.store.actor_handle_for_path(&metadata.path)
		{
			let read = tokio::select! {
				biased;
				() = cancellation.cancelled() => {
					return Err(cancelled_path_operation(source, "copy path"));
				},
				read = self.store.read(handle.document_id(), None, ReadSelection::Whole) => read?,
			};
			if read.head().presence() != DocumentPresence::Present {
				return Err(path_io_error(
					source,
					"copy path",
					io::ErrorKind::NotFound,
					"copy source is missing",
				));
			}
			let ReadBody::Whole(content) = read.body() else {
				unreachable!("whole-document reads return whole-document bodies");
			};
			return Ok(content.clone());
		}
		ensure_not_cancelled(cancellation, source, "copy path")?;
		match self.store.local_fs().stable_read(source)? {
			DiskState::Present { content, .. } => Ok(content),
			DiskState::Missing => Err(path_io_error(
				source,
				"copy path",
				io::ErrorKind::NotFound,
				"copy source is missing",
			)),
		}
	}

	fn reject_active_exact(&self, path: &Path, cancellation: &CancellationToken) -> Result<()> {
		ensure_not_cancelled(cancellation, path, "inspect active documents")?;
		if self.store.actor_handle_for_path(path).is_some() {
			return Err(precondition_failed(path, "path is owned by an active document"));
		}
		Ok(())
	}

	async fn reject_active_at_or_below(
		&self,
		path: &Path,
		cancellation: &CancellationToken,
	) -> Result<()> {
		ensure_not_cancelled(cancellation, path, "inspect active documents")?;
		let handles = self.store.actor_handles_under(path);
		for handle in handles {
			let state = tokio::select! {
				biased;
				() = cancellation.cancelled() => {
					return Err(cancelled_path_operation(path, "inspect active documents"));
				},
				state = handle.state() => state?,
			};
			if state.path.starts_with(path) {
				return Err(precondition_failed(path, "path operation overlaps an active document"));
			}
		}
		Ok(())
	}

	async fn reject_active_destination(
		&self,
		destination: &Path,
		destination_revision: Option<Revision>,
		cancellation: &CancellationToken,
	) -> Result<()> {
		ensure_not_cancelled(cancellation, destination, "inspect rename destination")?;
		if let Some(handle) = self.store.actor_handle_for_path(destination) {
			let state = tokio::select! {
				biased;
				() = cancellation.cancelled() => {
					return Err(cancelled_path_operation(
						destination,
						"inspect rename destination",
					));
				},
				state = handle.state() => state?,
			};
			if let Some(snapshot) = state.head
				&& snapshot.head().presence() == DocumentPresence::Present
			{
				let _ =
					require_revision(destination_revision, destination, "active rename destination")?;
			}
			return Err(precondition_failed(
				destination,
				"rename cannot displace an active destination",
			));
		}
		self
			.reject_active_at_or_below(destination, cancellation)
			.await?;
		Ok(())
	}

	async fn move_destination_precondition(
		&self,
		destination: &Path,
		overwrite: DestinationOverwritePolicy,
		cancellation: &CancellationToken,
	) -> Result<MoveDestinationPrecondition> {
		ensure_not_cancelled(cancellation, destination, "inspect rename destination")?;
		match self.store.local_fs().stat(destination, FollowSymlinks::No) {
			Err(Error::Io { source, .. }) if source.kind() == io::ErrorKind::NotFound => {
				Ok(MoveDestinationPrecondition::MustNotExist)
			},
			Err(error) => Err(error),
			Ok(_) if overwrite == DestinationOverwritePolicy::FailIfExists => Err(path_io_error(
				destination,
				"rename path",
				io::ErrorKind::AlreadyExists,
				"rename destination already exists",
			)),
			Ok(metadata) if metadata.kind == FileKind::RegularFile => {
				let opened = self.store.open(metadata.path.clone()).await?;
				let (lease_id, head, _) = opened.into_parts();
				let close_result = self.store.close(lease_id).await;
				ensure_not_cancelled(cancellation, destination, "inspect rename destination")?;
				close_result?;
				Ok(MoveDestinationPrecondition::Revision(head.revision()))
			},
			Ok(_) => Err(precondition_failed(
				destination,
				"active document moves can replace only inactive regular files",
			)),
		}
	}

	async fn commit_one(
		&self,
		document_id: DocumentId,
		operation: MutationOperation,
		cancellation: &CancellationToken,
	) -> PathMutationResult<DocumentHead> {
		let transaction_id = TransactionId::from_bytes(rand::random());
		let outcome = self
			.transactions
			.commit(
				TransactionRequest::new(transaction_id, vec![DocumentMutation::new(
					DocumentTarget::Document(document_id),
					operation,
				)]),
				cancellation.child_token(),
			)
			.await;
		match outcome.as_ref() {
			TransactionOutcome::Committed { operations, .. } => {
				PathMutationResult::Completed(operations[0].head().clone())
			},
			TransactionOutcome::Rejected { .. } | TransactionOutcome::PartiallyCommitted { .. } => {
				PathMutationResult::TransactionRejected(outcome)
			},
		}
	}
}

fn committed_file_metadata(
	mut captured: PathMetadata,
	destination: &Path,
	head: &DocumentHead,
) -> PathMetadata {
	captured.path = destination.to_path_buf();
	captured.kind = FileKind::RegularFile;
	captured.byte_length = head.byte_length();
	captured
}

fn require_revision(
	revision: Option<Revision>,
	path: &Path,
	operation: &'static str,
) -> Result<Revision> {
	revision
		.ok_or_else(|| invalid_target(path, &format!("{operation} requires a revision precondition")))
}

fn path_io_error(
	path: &Path,
	operation: &'static str,
	kind: io::ErrorKind,
	message: &'static str,
) -> Error {
	Error::Io {
		operation: sf!(operation),
		path:      path.to_path_buf(),
		source:    io::Error::new(kind, message),
	}
}

fn ensure_not_cancelled(
	cancellation: &CancellationToken,
	path: &Path,
	operation: &'static str,
) -> Result<()> {
	if cancellation.is_cancelled() {
		return Err(cancelled_path_operation(path, operation));
	}
	Ok(())
}

fn cancelled_path_operation(path: &Path, operation: &'static str) -> Error {
	path_io_error(path, operation, io::ErrorKind::Interrupted, "path operation was cancelled")
}

fn precondition_failed(path: &Path, reason: &str) -> Error {
	Error::PreconditionFailed { target: Str::new(path.to_string_lossy()), reason: Str::new(reason) }
}

fn invalid_target(path: &Path, reason: &str) -> Error {
	Error::InvalidTarget { target: Str::new(path.to_string_lossy()), reason: Str::new(reason) }
}

#[cfg(test)]
mod tests {
	use std::{fs, time::Duration};

	use bytes::Bytes;
	use tempfile::TempDir;
	use tokio::{task, time};

	use super::*;
	use crate::docserver::{DocumentEventKind, ServerConfig, fs::DiskExpectation};

	fn service(root: &TempDir) -> (DocumentStore, PathService) {
		let store = DocumentStore::new(ServerConfig::new(root.path()).expect("server config"))
			.expect("document store");
		let registry = LspRegistry::new(store.clone());
		let transactions = TransactionCoordinator::with_formatter(store.clone(), [7; 16], registry);
		(store.clone(), PathService::new(store, transactions))
	}

	fn create_file(store: &DocumentStore, path: &Path, content: &'static [u8]) {
		let filesystem = store.local_fs();
		let prepared = filesystem
			.prepare_write(path, Bytes::from_static(content), DiskExpectation::Missing)
			.expect("prepare file");
		filesystem.commit_prepared(prepared).expect("commit file");
	}

	#[tokio::test]
	async fn active_rename_preserves_document_id() {
		let root = tempfile::tempdir().expect("temporary root");
		let (store, service) = service(&root);
		let environment = store.local_fs().root_path().to_path_buf();
		let source = environment.join("source.txt");
		let destination = environment.join("renamed.txt");
		create_file(&store, &source, b"identity\n");
		let opened = store.open(source.clone()).await.expect("open source");
		let (lease, before, _) = opened.into_parts();
		let result = service
			.rename(
				&store.file_uri(&source).expect("source uri"),
				&store.file_uri(&destination).expect("destination uri"),
				DestinationOverwritePolicy::FailIfExists,
				Some(before.revision()),
				None,
				&CancellationToken::new(),
			)
			.await
			.expect("rename");
		assert!(matches!(result, PathMutationResult::Completed(_)));
		let after = store
			.read(lease, None, ReadSelection::Whole)
			.await
			.expect("read renamed actor");
		assert_eq!(after.head().document_id(), before.document_id());
		assert_eq!(after.body(), &ReadBody::Whole(Bytes::from_static(b"identity\n")));
	}

	#[tokio::test]
	async fn committed_active_rename_reports_committed_metadata_after_native_replacement() {
		let root = tempfile::tempdir().expect("temporary root");
		let (store, service) = service(&root);
		let source = store.local_fs().root_path().join("source.txt");
		let destination = store.local_fs().root_path().join("renamed.txt");
		create_file(&store, &source, b"committed rename\n");
		let opened = store.open(source.clone()).await.expect("open source");
		let (_, before, mut events) = opened.into_parts();
		let replaced_destination = destination.clone();
		let replace_after_commit = tokio::spawn(async move {
			loop {
				let event = events.recv().await.expect("source event stream");
				if event.kind() == DocumentEventKind::Committed {
					fs::remove_file(&replaced_destination).expect("remove committed rename destination");
					fs::write(&replaced_destination, b"native replacement")
						.expect("replace committed rename destination");
					break;
				}
			}
		});

		let result = service
			.rename(
				&store.file_uri(&source).expect("source uri"),
				&store.file_uri(&destination).expect("destination uri"),
				DestinationOverwritePolicy::FailIfExists,
				Some(before.revision()),
				None,
				&CancellationToken::new(),
			)
			.await
			.expect("committed rename remains successful");
		time::timeout(Duration::from_secs(5), replace_after_commit)
			.await
			.expect("committed rename event arrives")
			.expect("destination replacer");

		let PathMutationResult::Completed(metadata) = result else {
			panic!("rename should commit");
		};
		assert_eq!(metadata.path, destination);
		assert_eq!(metadata.byte_length, b"committed rename\n".len() as u64);
	}

	#[tokio::test]
	async fn active_copy_preserves_destination_document_id() {
		let root = tempfile::tempdir().expect("temporary root");
		let (store, service) = service(&root);
		let environment = store.local_fs().root_path().to_path_buf();
		let source = environment.join("source.txt");
		let destination = environment.join("destination.txt");
		create_file(&store, &source, b"copied bytes\n");
		create_file(&store, &destination, b"old bytes\n");
		let _source_open = store.open(source.clone()).await.expect("open source");
		let opened = store
			.open(destination.clone())
			.await
			.expect("open destination");
		let (lease, before, _) = opened.into_parts();
		let fail_error = service
			.copy(
				&store.file_uri(&source).expect("source uri"),
				&store.file_uri(&destination).expect("destination uri"),
				FollowSymlinks::Yes,
				DestinationOverwritePolicy::FailIfExists,
				Some(before.revision()),
				&CancellationToken::new(),
			)
			.await
			.expect_err("fail-if-exists must reject an active destination");
		assert!(matches!(
			fail_error,
			Error::Io { source, .. } if source.kind() == std::io::ErrorKind::AlreadyExists
		));
		let unchanged = store
			.read(lease, None, ReadSelection::Whole)
			.await
			.expect("read unchanged destination");
		assert_eq!(unchanged.body(), &ReadBody::Whole(Bytes::from_static(b"old bytes\n")));
		let result = service
			.copy(
				&store.file_uri(&source).expect("source uri"),
				&store.file_uri(&destination).expect("destination uri"),
				FollowSymlinks::Yes,
				DestinationOverwritePolicy::ReplaceNonDirectory,
				Some(before.revision()),
				&CancellationToken::new(),
			)
			.await
			.expect("copy");
		assert!(matches!(result, PathMutationResult::Completed(_)));
		let after = store
			.read(lease, None, ReadSelection::Whole)
			.await
			.expect("read copied destination");
		assert_eq!(after.head().document_id(), before.document_id());
		assert_eq!(after.body(), &ReadBody::Whole(Bytes::from_static(b"copied bytes\n")));
	}

	#[tokio::test]
	async fn committed_active_copy_reports_committed_metadata_after_native_replacement() {
		let root = tempfile::tempdir().expect("temporary root");
		let (store, service) = service(&root);
		let source = store.local_fs().root_path().join("source.txt");
		let destination = store.local_fs().root_path().join("destination.txt");
		create_file(&store, &source, b"committed copy\n");
		create_file(&store, &destination, b"old\n");
		let opened = store
			.open(destination.clone())
			.await
			.expect("open destination");
		let (_, before, mut events) = opened.into_parts();
		let replaced_destination = destination.clone();
		let replace_after_commit = tokio::spawn(async move {
			loop {
				let event = events.recv().await.expect("destination event stream");
				if event.kind() == DocumentEventKind::Committed {
					fs::remove_file(&replaced_destination).expect("remove committed copy destination");
					fs::write(&replaced_destination, b"native replacement")
						.expect("replace committed copy destination");
					break;
				}
			}
		});

		let result = service
			.copy(
				&store.file_uri(&source).expect("source uri"),
				&store.file_uri(&destination).expect("destination uri"),
				FollowSymlinks::Yes,
				DestinationOverwritePolicy::ReplaceNonDirectory,
				Some(before.revision()),
				&CancellationToken::new(),
			)
			.await
			.expect("committed copy remains successful");
		time::timeout(Duration::from_secs(5), replace_after_commit)
			.await
			.expect("committed copy event arrives")
			.expect("destination replacer");

		let PathMutationResult::Completed(outcome) = result else {
			panic!("copy should commit");
		};
		assert_eq!(outcome.metadata.path, destination);
		assert_eq!(outcome.metadata.byte_length, b"committed copy\n".len() as u64);
		assert_eq!(outcome.bytes_copied, b"committed copy\n".len() as u64);
	}

	#[tokio::test]
	async fn active_copy_source_waits_for_watcher_reload() {
		let root = tempfile::tempdir().expect("temporary root");
		let (store, service) = service(&root);
		let source = store.local_fs().root_path().join("source.txt");
		let destination = store.local_fs().root_path().join("destination.txt");
		create_file(&store, &source, b"stale source\n");
		create_file(&store, &destination, b"old destination\n");
		let _source_lease = store.open(source.clone()).await.expect("open source");
		let destination_open = store
			.open(destination.clone())
			.await
			.expect("open destination");
		let (_, destination_head, _) = destination_open.into_parts();
		let post_reload = vec![b'r'; 4 * 1024 * 1024];
		fs::write(&source, &post_reload).expect("replace active source natively");
		let source_handle = store
			.actor_handle_for_path(&source)
			.expect("active source actor");
		time::timeout(Duration::from_secs(5), async {
			loop {
				if source_handle.state().await.expect("source state").reloading {
					break;
				}
				task::yield_now().await;
			}
		})
		.await
		.expect("watcher invalidates source before reload settles");

		let result = time::timeout(
			Duration::from_secs(5),
			service.copy(
				&store.file_uri(&source).expect("source uri"),
				&store.file_uri(&destination).expect("destination uri"),
				FollowSymlinks::Yes,
				DestinationOverwritePolicy::ReplaceNonDirectory,
				Some(destination_head.revision()),
				&CancellationToken::new(),
			),
		)
		.await
		.expect("copy completes after source reload")
		.expect("copy waits for source reload");
		assert!(matches!(result, PathMutationResult::Completed(_)));
		let copied =
			time::timeout(Duration::from_secs(5), store.read(destination, None, ReadSelection::Whole))
				.await
				.expect("destination read completes")
				.expect("read copied destination");
		let ReadBody::Whole(content) = copied.body() else {
			panic!("whole read should return whole body");
		};
		assert_eq!(content.as_ref(), post_reload.as_slice());
	}

	#[tokio::test]
	async fn recursive_remove_rejects_active_descendant() {
		let root = tempfile::tempdir().expect("temporary root");
		let (store, service) = service(&root);
		let directory = store.local_fs().root_path().join("tree");
		store
			.local_fs()
			.create_directory(&directory, false, ExistingDirectoryPolicy::FailIfExists)
			.expect("create directory");
		let child = directory.join("child.txt");
		create_file(&store, &child, b"active\n");
		let _opened = store.open(child).await.expect("open child");
		let error = service
			.remove(
				&store.file_uri(&directory).expect("directory uri"),
				true,
				None,
				&CancellationToken::new(),
			)
			.await
			.expect_err("active descendant must reject");
		assert!(matches!(error, Error::PreconditionFailed { .. }));
	}

	#[tokio::test]
	async fn rename_rejects_active_destination_displacement() {
		let root = tempfile::tempdir().expect("temporary root");
		let (store, service) = service(&root);
		let environment = store.local_fs().root_path().to_path_buf();
		let source = environment.join("source.txt");
		let destination = environment.join("destination.txt");
		create_file(&store, &source, b"source\n");
		create_file(&store, &destination, b"destination\n");
		let source_open = store.open(source.clone()).await.expect("open source");
		let destination_open = store
			.open(destination.clone())
			.await
			.expect("open destination");
		let (_, source_head, _) = source_open.into_parts();
		let (_, destination_head, _) = destination_open.into_parts();
		let error = service
			.rename(
				&store.file_uri(&source).expect("source uri"),
				&store.file_uri(&destination).expect("destination uri"),
				DestinationOverwritePolicy::ReplaceNonDirectory,
				Some(source_head.revision()),
				Some(destination_head.revision()),
				&CancellationToken::new(),
			)
			.await
			.expect_err("active destination must reject");
		assert!(matches!(error, Error::PreconditionFailed { .. }));
	}

	#[tokio::test]
	async fn hard_link_rejects_active_selected_source() {
		let root = tempfile::tempdir().expect("temporary root");
		let (store, service) = service(&root);
		let environment = store.local_fs().root_path().to_path_buf();
		let source = environment.join("source.txt");
		let link = environment.join("alias.txt");
		create_file(&store, &source, b"authoritative\n");
		let _opened = store.open(source.clone()).await.expect("open source");
		let error = service
			.create_hard_link(
				&store.file_uri(&source).expect("source uri"),
				&store.file_uri(&link).expect("link uri"),
				FollowSymlinks::Yes,
				DestinationOverwritePolicy::FailIfExists,
				&CancellationToken::new(),
			)
			.await
			.expect_err("active source must not be aliased");
		assert!(matches!(error, Error::PreconditionFailed { .. }));
		assert!(matches!(
			store.local_fs().stat(&link, FollowSymlinks::No),
			Err(Error::Io { source, .. }) if source.kind() == std::io::ErrorKind::NotFound
		));
	}

	#[tokio::test]
	async fn cancelled_copy_does_not_touch_the_destination() {
		let root = tempfile::tempdir().expect("temporary root");
		let (store, service) = service(&root);
		let source = store.local_fs().root_path().join("source.txt");
		let destination = store.local_fs().root_path().join("destination.txt");
		create_file(&store, &source, b"source\n");
		let cancellation = CancellationToken::new();
		cancellation.cancel();

		let error = service
			.copy(
				&store.file_uri(&source).expect("source uri"),
				&store.file_uri(&destination).expect("destination uri"),
				FollowSymlinks::Yes,
				DestinationOverwritePolicy::FailIfExists,
				None,
				&cancellation,
			)
			.await
			.expect_err("cancelled copy must fail");

		assert!(matches!(
			error,
			Error::Io { source, .. } if source.kind() == std::io::ErrorKind::Interrupted
		));
		assert!(matches!(
			store.local_fs().stat(&destination, FollowSymlinks::No),
			Err(Error::Io { source, .. }) if source.kind() == std::io::ErrorKind::NotFound
		));
	}
}
