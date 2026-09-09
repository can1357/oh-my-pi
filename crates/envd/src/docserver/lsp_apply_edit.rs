//! Transactional lowering for server-initiated `workspace/applyEdit` requests.

use std::{collections::BTreeMap, num, str};

use bytes::Bytes;
use omp_core::Str;
use serde::Deserialize;
use serde_json::{Map, Value};
use thiserror::Error;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::docserver::{
	ByteEdit, ByteRange, DocumentHead, DocumentKind, DocumentLocator, DocumentPresence, Environment,
	Error as DocserverError, ReadBody, ReadSelection, Revision, TransactionId,
	lsp_process::InboundDispatch,
	lsp_registry::{LspBindingHandle, LspRegistryError},
	position::{PositionError, TextEdit, range_to_offsets},
	transaction::{
		CreateMutation, DeleteMutation, DocumentMutation, DocumentTarget, ExistingDocumentPolicy,
		FormatPolicy, MoveDestinationPrecondition, MoveMutation, MutationOperation, StalePolicy,
		TextMutation, TextProposal, TransactionOutcome, TransactionRequest,
	},
	validate_edits,
};
/// Failures that can occur when lowering server-initiated `workspace/applyEdit`
/// requests.
#[derive(Debug, Error)]
pub enum ApplyWorkspaceEditError {
	/// The incoming workspace edit parameters could not be parsed.
	#[error("invalid workspace edit: {0}")]
	InvalidWorkspaceEdit(#[source] serde_json::Error),

	/// Workspace edits cannot mix `changes` and `documentChanges` without a
	/// declared order.
	#[error("workspace edits cannot mix changes and documentChanges without a declared order")]
	MixedChangesAndDocumentChanges,

	/// The edit requires interactive confirmation.
	#[error("workspace edit requires interactive confirmation")]
	InteractiveConfirmationRequired,

	/// A `textDocument` edit entry could not be parsed.
	#[error("invalid text document edit: {0}")]
	InvalidTextDocumentEdit(#[source] serde_json::Error),

	/// A `documentChanges` entry lacked both `textDocument` and `kind`.
	#[error("documentChanges entry requires textDocument or kind")]
	MissingDocumentChangesKind,

	/// A `documentChanges` resource operation kind is unsupported.
	#[error("unsupported workspace resource operation {kind}")]
	UnsupportedResourceOperation {
		/// The unsupported operation kind name.
		kind: Str,
	},

	/// A workspace edit URI is invalid.
	#[error("invalid workspace edit URI {uri:?}: {source}")]
	InvalidUri {
		/// The URI string.
		uri:    Str,
		/// The URL parse error.
		#[source]
		source: url::ParseError,
	},

	/// A required field was missing from a resource operation.
	#[error("workspace resource operation requires {field}")]
	MissingResourceField {
		/// The required field name.
		field: Str,
	},

	/// No admitted revision was found for an LSP version.
	#[error("LSP version {version} has no admitted daemon revision for {uri}")]
	NoAdmittedRevision {
		/// Target document URI.
		uri:     Url,
		/// LSP version number.
		version: i32,
	},

	/// A target text document was missing.
	#[error("text document {uri} is missing")]
	TextDocumentMissing {
		/// Target document URI.
		uri: Url,
	},

	/// Text edits attempted to target a binary document.
	#[error("text edits cannot target binary document {uri}")]
	BinaryDocumentTarget {
		/// Target document URI.
		uri: Url,
	},

	/// A document's content is not valid UTF-8.
	#[error("text document {uri} does not contain UTF-8")]
	NonUtf8Document {
		/// Target document URI.
		uri: Url,
	},

	/// Edit start coordinate exceeded u64 limits.
	#[error("edit start exceeds u64: {source}")]
	EditStartOverflow {
		/// Numeric conversion error.
		#[source]
		source: num::TryFromIntError,
	},

	/// Edit end coordinate exceeded u64 limits.
	#[error("edit end exceeds u64: {source}")]
	EditEndOverflow {
		/// Numeric conversion error.
		#[source]
		source: num::TryFromIntError,
	},

	/// Document length exceeded u64 limits.
	#[error("document length exceeds u64: {source}")]
	DocumentLengthOverflow {
		/// Numeric conversion error.
		#[source]
		source: num::TryFromIntError,
	},

	/// Recursive workspace deletes are not supported.
	#[error("recursive workspace deletes are not supported transactionally")]
	RecursiveDeleteUnsupported,

	/// A delete target was missing.
	#[error("delete target {uri} is missing")]
	DeleteTargetMissing {
		/// Target document URI.
		uri: Url,
	},

	/// A rename source was missing.
	#[error("rename source {old_uri} is missing")]
	RenameSourceMissing {
		/// Source document URI.
		old_uri: Url,
	},

	/// A rename destination already exists.
	#[error("rename destination {new_uri} already exists")]
	RenameDestinationExists {
		/// Destination document URI.
		new_uri: Url,
	},
	/// The workspace edit was cancelled.
	#[error("workspace edit was cancelled")]
	Cancelled,

	/// Underlying document store error.
	#[error(transparent)]
	Store(#[from] DocserverError),

	/// LSP registry error.
	#[error(transparent)]
	LspRegistry(#[from] LspRegistryError),

	/// Position conversion error.
	#[error(transparent)]
	Position(#[from] PositionError),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyEditParams {
	edit: WorkspaceEdit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEdit {
	changes:            Option<BTreeMap<String, Vec<TextEdit>>>,
	document_changes:   Option<Vec<Value>>,
	#[serde(default)]
	change_annotations: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextDocumentEdit {
	text_document: OptionalVersionedDocument,
	edits:         Vec<TextEdit>,
}

#[derive(Deserialize)]
struct OptionalVersionedDocument {
	uri:     String,
	#[serde(default)]
	version: Option<i32>,
}

struct LoadedDocument {
	head:    DocumentHead,
	content: Bytes,
}

/// Applies one server-requested workspace edit through the document transaction
/// authority.
pub async fn apply_workspace_edit(
	environment: Environment,
	handle: LspBindingHandle,
	params: Bytes,
	cancellation: CancellationToken,
) -> InboundDispatch {
	let request = match lower_workspace_edit(&environment, handle, &params, &cancellation).await {
		Ok(request) => request,
		Err(error) => return apply_failure(&error, None),
	};
	let transaction_id = request.transaction_id();
	let barrier = environment
		.lsp()
		.defer_transaction_publication(transaction_id);
	let outcome = environment
		.transactions()
		.commit_deferred_publication(request, cancellation)
		.await;
	let response = outcome_response(outcome.as_ref());
	InboundDispatch::success_then(
		response,
		Box::pin(async move {
			barrier.release();
		}),
	)
}

async fn lower_workspace_edit(
	environment: &Environment,
	handle: LspBindingHandle,
	params: &[u8],
	cancellation: &CancellationToken,
) -> Result<TransactionRequest, ApplyWorkspaceEditError> {
	let params: ApplyEditParams =
		serde_json::from_slice(params).map_err(ApplyWorkspaceEditError::InvalidWorkspaceEdit)?;
	if params.edit.changes.is_some() && params.edit.document_changes.is_some() {
		return Err(ApplyWorkspaceEditError::MixedChangesAndDocumentChanges);
	}
	if params
		.edit
		.change_annotations
		.values()
		.any(|annotation| annotation.get("needsConfirmation").and_then(Value::as_bool) == Some(true))
	{
		return Err(ApplyWorkspaceEditError::InteractiveConfirmationRequired);
	}

	let mut operations = Vec::new();
	if let Some(changes) = params.edit.changes {
		for (uri, edits) in changes {
			operations
				.push(lower_text_edit(environment, handle, uri, None, edits, cancellation).await?);
		}
	}
	if let Some(document_changes) = params.edit.document_changes {
		for change in document_changes {
			if change.get("textDocument").is_some() {
				let edit: TextDocumentEdit = serde_json::from_value(change)
					.map_err(ApplyWorkspaceEditError::InvalidTextDocumentEdit)?;
				operations.push(
					lower_text_edit(
						environment,
						handle,
						edit.text_document.uri,
						edit.text_document.version,
						edit.edits,
						cancellation,
					)
					.await?,
				);
				continue;
			}
			let kind = change
				.get("kind")
				.and_then(Value::as_str)
				.ok_or(ApplyWorkspaceEditError::MissingDocumentChangesKind)?;
			match kind {
				"create" => lower_create(environment, &change, cancellation, &mut operations).await?,
				"rename" => lower_rename(environment, &change, cancellation, &mut operations).await?,
				"delete" => lower_delete(environment, &change, cancellation, &mut operations).await?,
				_ => {
					return Err(ApplyWorkspaceEditError::UnsupportedResourceOperation {
						kind: Str::new(kind),
					});
				},
			}
		}
	}
	Ok(TransactionRequest::new(TransactionId::from_bytes(rand::random()), operations))
}

async fn lower_text_edit(
	environment: &Environment,
	handle: LspBindingHandle,
	uri: String,
	version: Option<i32>,
	edits: Vec<TextEdit>,
	cancellation: &CancellationToken,
) -> Result<DocumentMutation, ApplyWorkspaceEditError> {
	let uri = parse_uri(&uri)?;
	let revision = match version {
		Some(version) => environment
			.lsp()
			.revision_for_version(handle, &uri, version)?
			.ok_or_else(|| ApplyWorkspaceEditError::NoAdmittedRevision {
				uri: uri.clone(),
				version,
			})?,
		None => load_document(environment, &uri, None, cancellation)
			.await?
			.head
			.revision(),
	};
	let loaded = load_document(environment, &uri, Some(revision), cancellation).await?;
	if loaded.head.presence() != DocumentPresence::Present {
		return Err(ApplyWorkspaceEditError::TextDocumentMissing { uri });
	}
	let language_id = match loaded.head.kind() {
		DocumentKind::Text(language_id) => language_id.as_ref(),
		DocumentKind::Binary => {
			return Err(ApplyWorkspaceEditError::BinaryDocumentTarget { uri });
		},
	};
	let policy = environment
		.lsp()
		.sync_policy_for_handle(handle, &uri, language_id)?;
	let text = str::from_utf8(&loaded.content)
		.map_err(|_| ApplyWorkspaceEditError::NonUtf8Document { uri: uri.clone() })?;
	let mut byte_edits = Vec::with_capacity(edits.len());
	for edit in edits {
		let (start, end) = range_to_offsets(policy.position_encoding, text, edit.range)?;
		let range = ByteRange::new(
			u64::try_from(start)
				.map_err(|source| ApplyWorkspaceEditError::EditStartOverflow { source })?,
			u64::try_from(end)
				.map_err(|source| ApplyWorkspaceEditError::EditEndOverflow { source })?,
		)?;
		byte_edits.push(ByteEdit::new(range, Bytes::from(edit.new_text)));
	}
	byte_edits.sort_by_key(|edit| edit.range().start());
	validate_edits(
		u64::try_from(loaded.content.len())
			.map_err(|source| ApplyWorkspaceEditError::DocumentLengthOverflow { source })?,
		&byte_edits,
	)?;
	Ok(DocumentMutation::new(
		DocumentTarget::Uri(uri),
		MutationOperation::Text(TextMutation::new(
			revision,
			TextProposal::Edits(byte_edits),
			StalePolicy::Fail,
			FormatPolicy::Disabled,
		)),
	))
}

async fn lower_create(
	environment: &Environment,
	change: &Value,
	cancellation: &CancellationToken,
	operations: &mut Vec<DocumentMutation>,
) -> Result<(), ApplyWorkspaceEditError> {
	let uri = parse_required_uri(change, "uri")?;
	let overwrite = option(change, "overwrite");
	let ignore = option(change, "ignoreIfExists");
	if ignore && !overwrite {
		let loaded = load_document(environment, &uri, None, cancellation).await?;
		if loaded.head.presence() == DocumentPresence::Present {
			return Ok(());
		}
	}
	let existing = if overwrite {
		ExistingDocumentPolicy::ReplaceExisting
	} else {
		ExistingDocumentPolicy::FailIfExists
	};
	operations.push(DocumentMutation::new(
		DocumentTarget::Uri(uri),
		MutationOperation::Create(CreateMutation::new(
			Bytes::new(),
			existing,
			FormatPolicy::Disabled,
		)),
	));
	Ok(())
}

async fn lower_delete(
	environment: &Environment,
	change: &Value,
	cancellation: &CancellationToken,
	operations: &mut Vec<DocumentMutation>,
) -> Result<(), ApplyWorkspaceEditError> {
	if option(change, "recursive") {
		return Err(ApplyWorkspaceEditError::RecursiveDeleteUnsupported);
	}
	let uri = parse_required_uri(change, "uri")?;
	let loaded = load_document(environment, &uri, None, cancellation).await?;
	if loaded.head.presence() == DocumentPresence::Missing && option(change, "ignoreIfNotExists") {
		return Ok(());
	}
	if loaded.head.presence() != DocumentPresence::Present {
		return Err(ApplyWorkspaceEditError::DeleteTargetMissing { uri });
	}
	operations.push(DocumentMutation::new(
		DocumentTarget::Uri(uri),
		MutationOperation::Delete(DeleteMutation::new(loaded.head.revision())),
	));
	Ok(())
}

async fn lower_rename(
	environment: &Environment,
	change: &Value,
	cancellation: &CancellationToken,
	operations: &mut Vec<DocumentMutation>,
) -> Result<(), ApplyWorkspaceEditError> {
	let old_uri = parse_required_uri(change, "oldUri")?;
	let new_uri = parse_required_uri(change, "newUri")?;
	let source = load_document(environment, &old_uri, None, cancellation).await?;
	if source.head.presence() != DocumentPresence::Present {
		return Err(ApplyWorkspaceEditError::RenameSourceMissing { old_uri });
	}
	let destination = load_document(environment, &new_uri, None, cancellation).await?;
	let overwrite = option(change, "overwrite");
	if destination.head.presence() == DocumentPresence::Present
		&& option(change, "ignoreIfExists")
		&& !overwrite
	{
		return Ok(());
	}
	let destination_precondition = if destination.head.presence() == DocumentPresence::Present {
		if !overwrite {
			return Err(ApplyWorkspaceEditError::RenameDestinationExists { new_uri });
		}
		MoveDestinationPrecondition::Revision(destination.head.revision())
	} else {
		MoveDestinationPrecondition::MustNotExist
	};
	operations.push(DocumentMutation::new(
		DocumentTarget::Uri(old_uri),
		MutationOperation::Move(MoveMutation::new(
			source.head.revision(),
			new_uri,
			destination_precondition,
		)),
	));
	Ok(())
}

async fn load_document(
	environment: &Environment,
	uri: &Url,
	revision: Option<Revision>,
	cancellation: &CancellationToken,
) -> Result<LoadedDocument, ApplyWorkspaceEditError> {
	if cancellation.is_cancelled() {
		return Err(ApplyWorkspaceEditError::Cancelled);
	}
	let path = environment.store().resolve_entry_path(uri)?;
	let opened = environment
		.store()
		.open(DocumentLocator::Path(path))
		.await?;
	let lease_id = opened.lease_id();
	let read = environment
		.store()
		.read(lease_id, revision, ReadSelection::Whole)
		.await;
	let close = environment.store().close(lease_id).await;
	let read = read?;
	close?;
	let content = match read.body() {
		ReadBody::Whole(content) => content.clone(),
		ReadBody::Slices(_) => unreachable!("whole read returns whole bytes"),
	};
	Ok(LoadedDocument { head: read.head().clone(), content })
}

fn parse_required_uri(value: &Value, field: &str) -> Result<Url, ApplyWorkspaceEditError> {
	let uri = value
		.get(field)
		.and_then(Value::as_str)
		.ok_or_else(|| ApplyWorkspaceEditError::MissingResourceField { field: Str::new(field) })?;
	parse_uri(uri)
}

fn parse_uri(uri: &str) -> Result<Url, ApplyWorkspaceEditError> {
	Url::parse(uri)
		.map_err(|error| ApplyWorkspaceEditError::InvalidUri { uri: Str::new(uri), source: error })
}
fn option(value: &Value, name: &str) -> bool {
	value
		.get("options")
		.and_then(|options| options.get(name))
		.and_then(Value::as_bool)
		.unwrap_or(false)
}

fn outcome_response(outcome: &TransactionOutcome) -> Bytes {
	match outcome {
		TransactionOutcome::Committed { .. } => apply_response(true, None, None),
		TransactionOutcome::Rejected { message, .. } => {
			apply_response(false, Some(message.as_str()), None)
		},
		TransactionOutcome::PartiallyCommitted { failed_operation_index, message, .. } => {
			apply_response(false, Some(message.as_str()), Some(*failed_operation_index))
		},
	}
}

fn apply_failure(reason: &ApplyWorkspaceEditError, failed_change: Option<u32>) -> InboundDispatch {
	InboundDispatch::success(apply_response(false, Some(&reason.to_string()), failed_change))
}

fn apply_response(applied: bool, reason: Option<&str>, failed_change: Option<u32>) -> Bytes {
	let mut response = Map::new();
	response.insert("applied".to_owned(), Value::Bool(applied));
	if let Some(reason) = reason {
		response.insert("failureReason".to_owned(), Value::String(reason.to_owned()));
	}
	if let Some(failed_change) = failed_change {
		response.insert("failedChange".to_owned(), Value::from(failed_change));
	}
	Bytes::from(serde_json::to_vec(&response).expect("workspace edit response is serializable"))
}
#[cfg(test)]
mod tests {
	use omp_core::sf;

	use super::*;

	#[test]
	fn formats_apply_workspace_edit_errors() {
		let err = ApplyWorkspaceEditError::MixedChangesAndDocumentChanges;
		assert_eq!(
			err.to_string(),
			"workspace edits cannot mix changes and documentChanges without a declared order"
		);

		let err = ApplyWorkspaceEditError::InteractiveConfirmationRequired;
		assert_eq!(err.to_string(), "workspace edit requires interactive confirmation");

		let err = ApplyWorkspaceEditError::UnsupportedResourceOperation { kind: sf!("unknown") };
		assert_eq!(err.to_string(), "unsupported workspace resource operation unknown");

		let err = ApplyWorkspaceEditError::RecursiveDeleteUnsupported;
		assert_eq!(err.to_string(), "recursive workspace deletes are not supported transactionally");
	}

	#[test]
	fn apply_response_produces_valid_json() {
		let err = ApplyWorkspaceEditError::InteractiveConfirmationRequired;
		let response_bytes = apply_response(false, Some(&err.to_string()), None);
		let json: Value = serde_json::from_slice(&response_bytes).unwrap();
		assert_eq!(json["applied"], false);
		assert_eq!(json["failureReason"], "workspace edit requires interactive confirmation");
	}
}
