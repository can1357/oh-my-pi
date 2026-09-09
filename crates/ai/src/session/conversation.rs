//! Append-only conversation DAG and rollback-on-drop turn drafts.

use std::{
	collections::{HashMap, HashSet},
	fmt,
	hash::{DefaultHasher, Hash, Hasher},
	sync::Arc,
};

use bytes::Bytes;
use omp_core::Str;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use super::{
	binding::{PendingServerStateBinding, ServerStateBinding},
	revision::{CommittedRevision, HistoryDelta},
};
use crate::{
	answer::ArtifactRef,
	body::BodySource,
	call::{
		CacheRetention, ContentPart, MediaInput, Message, OpaqueJson, ProviderProof, Role,
		ToolResultContent,
	},
	catalog::{CodecId, ProviderId},
	id::{ConversationId, Revision, ToolCallId, TurnId},
};

/// Structured conversation-store failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ConversationError {
	/// The conversation does not exist.
	#[error("unknown conversation {0}")]
	UnknownConversation(ConversationId),
	/// The supplied revision does not exist as a committed node.
	#[error("unknown committed revision {0}")]
	UnknownRevision(Revision),
	/// A draft or fork did not use the branch's current committed head.
	#[error("revision conflict: expected {expected}, got {actual}")]
	RevisionConflict {
		/// Revision that was current when the operation began.
		expected: Revision,
		/// Revision that was current when the operation committed.
		actual:   Revision,
	},
	/// A turn identity was reused with different atomic commit content.
	#[error("turn identity {0} was reused with different content")]
	TurnConflict(TurnId),
	/// Stored history is corrupt or cannot be decoded.
	#[error("conversation store is corrupt")]
	CorruptStore,
	/// SQLite persistence failed without exposing statement or credential text.
	#[error("conversation persistence failed")]
	Persistence,
}

/// Why a canonical message cannot be durably committed without implicit
/// buffering.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum MessagePersistenceError {
	/// A live or factory-backed media body was not explicitly staged.
	#[error("session media must be immutable bytes or an explicitly staged artifact")]
	UnstagedBody,
	/// Opaque JSON could not be encoded or decoded losslessly.
	#[error("session opaque JSON could not be persisted losslessly")]
	InvalidOpaqueJson,
}

/// Postcard-safe canonical message persisted by durable conversation stores.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct StoredMessage {
	/// Semantic author role.
	pub role:    StoredRole,
	/// Ordered lossless content.
	pub content: Arc<[StoredContent]>,
	/// Optional caller-facing author label.
	pub name:    Option<Str>,
}

/// Durable semantic author role.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum StoredRole {
	/// System-level instruction.
	System,
	/// Developer-level instruction.
	Developer,
	/// User-authored input.
	User,
	/// Assistant-authored output.
	Assistant,
	/// Tool-authored result.
	Tool,
}

/// Durable immutable media representation.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub enum StoredMedia {
	/// Inline immutable bytes.
	Bytes {
		/// MIME type of the inline media.
		media_type: Str,
		/// Immutable media bytes.
		data:       Bytes,
	},
	/// Immutable artifact-store identity and revision.
	Artifact {
		/// Artifact-store namespace.
		store:    Str,
		/// Artifact identifier.
		id:       Str,
		/// Immutable artifact revision.
		revision: Str,
	},
	/// Remote immutable resource metadata.
	Remote {
		/// Resource URI.
		uri:        Str,
		/// Optional MIME type.
		media_type: Option<Str>,
		/// Optional display name.
		name:       Option<Str>,
	},
}

/// Postcard-safe canonical content preserving opaque JSON and provider proofs
/// exactly.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub enum StoredContent {
	/// Visible text and its optional provider proof.
	Text {
		/// Visible text.
		text:  Str,
		/// Optional provider continuation proof.
		proof: Option<StoredProof>,
	},
	/// Hidden reasoning text and its optional provider proof.
	Reasoning {
		/// Hidden reasoning text.
		text:  Str,
		/// Optional provider continuation proof.
		proof: Option<StoredProof>,
	},
	/// Image content.
	Image(StoredMedia),
	/// Audio content.
	Audio(StoredMedia),
	/// Document content.
	Document(StoredMedia),
	/// Validated tool invocation.
	ToolCall {
		/// Provider tool-call identity.
		call:      ToolCallId,
		/// Invoked tool name.
		name:      Str,
		/// Validated JSON argument bytes.
		arguments: Bytes,
		/// Optional provider continuation proof.
		proof:     Option<StoredProof>,
	},
	/// Tool result correlated to an invocation.
	ToolResult {
		/// Correlated provider tool-call identity.
		call:     ToolCallId,
		/// Optional tool name supplied by the provider.
		name:     Option<Str>,
		/// Ordered durable result content.
		content:  Arc<[StoredToolResult]>,
		/// Whether the tool reported an error.
		is_error: bool,
	},
	/// Prompt-cache boundary.
	CachePoint(StoredCacheRetention),
}

/// Durable tool-result content.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub enum StoredToolResult {
	/// Plain text result.
	Text(Str),
	/// Opaque JSON result.
	Json(Bytes),
	/// Image result.
	Image(StoredMedia),
	/// Document result.
	Document(StoredMedia),
}

/// Durable provider-scoped continuation proof.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredProof {
	/// Provider that issued the proof.
	pub provider: ProviderId,
	/// Codec that defines the proof representation.
	pub codec:    CodecId,
	/// Opaque proof bytes.
	pub value:    Bytes,
}

/// Durable prompt-cache retention vocabulary.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum StoredCacheRetention {
	/// One request only.
	Request,
	/// Current server-side session.
	Session,
	/// Short-lived cache.
	Short,
	/// Long-lived cache.
	Long,
}

impl TryFrom<&Message> for StoredMessage {
	type Error = MessagePersistenceError;

	fn try_from(message: &Message) -> Result<Self, Self::Error> {
		Ok(Self {
			role:    message.role.into(),
			content: message
				.content
				.iter()
				.map(StoredContent::try_from)
				.collect::<Result<Vec<_>, _>>()?
				.into(),
			name:    message.name.clone(),
		})
	}
}

impl TryFrom<StoredMessage> for Message {
	type Error = MessagePersistenceError;

	fn try_from(message: StoredMessage) -> Result<Self, Self::Error> {
		Ok(Self {
			role:    message.role.into(),
			content: message
				.content
				.iter()
				.cloned()
				.map(ContentPart::try_from)
				.collect::<Result<Vec<_>, _>>()?
				.into(),
			name:    message.name,
		})
	}
}

impl From<Role> for StoredRole {
	fn from(role: Role) -> Self {
		match role {
			Role::System => Self::System,
			Role::Developer => Self::Developer,
			Role::User => Self::User,
			Role::Assistant => Self::Assistant,
			Role::Tool => Self::Tool,
		}
	}
}

impl From<StoredRole> for Role {
	fn from(role: StoredRole) -> Self {
		match role {
			StoredRole::System => Self::System,
			StoredRole::Developer => Self::Developer,
			StoredRole::User => Self::User,
			StoredRole::Assistant => Self::Assistant,
			StoredRole::Tool => Self::Tool,
		}
	}
}

fn store_media(media: &MediaInput) -> Result<StoredMedia, MessagePersistenceError> {
	match media {
		MediaInput::Bytes { media_type, data } => {
			Ok(StoredMedia::Bytes { media_type: media_type.clone(), data: data.clone() })
		},
		MediaInput::Stored(artifact) => Ok(StoredMedia::Artifact {
			store:    artifact.store.clone(),
			id:       artifact.id.clone(),
			revision: artifact.revision.clone(),
		}),
		MediaInput::Remote { uri, media_type, name } => Ok(StoredMedia::Remote {
			uri:        uri.clone(),
			media_type: media_type.clone(),
			name:       name.clone(),
		}),
		MediaInput::Body { media_type, body: BodySource::Bytes(data), .. } => {
			Ok(StoredMedia::Bytes { media_type: media_type.clone(), data: data.clone() })
		},
		MediaInput::Body { body: BodySource::Stored(stored), .. } => {
			let artifact = stored.artifact();
			Ok(StoredMedia::Artifact {
				store:    artifact.store.clone(),
				id:       artifact.id.clone(),
				revision: artifact.revision.clone(),
			})
		},
		MediaInput::Body {
			body: BodySource::Factory(_) | BodySource::OneShot(_) | BodySource::Multipart(_),
			..
		} => Err(MessagePersistenceError::UnstagedBody),
	}
}

fn restore_media(media: StoredMedia) -> MediaInput {
	match media {
		StoredMedia::Bytes { media_type, data } => MediaInput::Bytes { media_type, data },
		StoredMedia::Artifact { store, id, revision } => {
			MediaInput::Stored(ArtifactRef { store, id, revision })
		},
		StoredMedia::Remote { uri, media_type, name } => MediaInput::Remote { uri, media_type, name },
	}
}

fn store_json(json: &OpaqueJson) -> Result<Bytes, MessagePersistenceError> {
	serde_json::to_vec(json.as_value())
		.map(Bytes::from)
		.map_err(|_| MessagePersistenceError::InvalidOpaqueJson)
}

fn restore_json(bytes: &Bytes) -> Result<OpaqueJson, MessagePersistenceError> {
	serde_json::from_slice(bytes)
		.map(OpaqueJson::new)
		.map_err(|_| MessagePersistenceError::InvalidOpaqueJson)
}

impl From<&ProviderProof> for StoredProof {
	fn from(proof: &ProviderProof) -> Self {
		Self {
			provider: proof.provider.clone(),
			codec:    proof.codec.clone(),
			value:    proof.value.clone(),
		}
	}
}

impl From<StoredProof> for ProviderProof {
	fn from(proof: StoredProof) -> Self {
		Self { provider: proof.provider, codec: proof.codec, value: proof.value }
	}
}

impl TryFrom<&ContentPart> for StoredContent {
	type Error = MessagePersistenceError;

	fn try_from(content: &ContentPart) -> Result<Self, Self::Error> {
		Ok(match content {
			ContentPart::Text { text, proof } => {
				Self::Text { text: text.clone(), proof: proof.as_ref().map(StoredProof::from) }
			},
			ContentPart::Reasoning { text, proof } => {
				Self::Reasoning { text: text.clone(), proof: proof.as_ref().map(StoredProof::from) }
			},
			ContentPart::Image(media) => Self::Image(store_media(media)?),
			ContentPart::Audio(media) => Self::Audio(store_media(media)?),
			ContentPart::Document(media) => Self::Document(store_media(media)?),
			ContentPart::ToolCall { call, name, arguments, proof } => Self::ToolCall {
				call:      call.clone(),
				name:      name.clone(),
				arguments: store_json(arguments)?,
				proof:     proof.as_ref().map(StoredProof::from),
			},
			ContentPart::ToolResult { call, name, content, is_error } => Self::ToolResult {
				call:     call.clone(),
				name:     name.clone(),
				content:  content
					.iter()
					.map(StoredToolResult::try_from)
					.collect::<Result<Vec<_>, _>>()?
					.into(),
				is_error: *is_error,
			},
			ContentPart::CachePoint(retention) => Self::CachePoint((*retention).into()),
		})
	}
}

impl TryFrom<StoredContent> for ContentPart {
	type Error = MessagePersistenceError;

	fn try_from(content: StoredContent) -> Result<Self, Self::Error> {
		Ok(match content {
			StoredContent::Text { text, proof } => Self::Text { text, proof: proof.map(Into::into) },
			StoredContent::Reasoning { text, proof } => {
				Self::Reasoning { text, proof: proof.map(Into::into) }
			},
			StoredContent::Image(media) => Self::Image(restore_media(media)),
			StoredContent::Audio(media) => Self::Audio(restore_media(media)),
			StoredContent::Document(media) => Self::Document(restore_media(media)),
			StoredContent::ToolCall { call, name, arguments, proof } => Self::ToolCall {
				call,
				name,
				arguments: restore_json(&arguments)?,
				proof: proof.map(Into::into),
			},
			StoredContent::ToolResult { call, name, content, is_error } => Self::ToolResult {
				call,
				name,
				content: content
					.iter()
					.cloned()
					.map(ToolResultContent::try_from)
					.collect::<Result<Vec<_>, _>>()?
					.into(),
				is_error,
			},
			StoredContent::CachePoint(retention) => Self::CachePoint(retention.into()),
		})
	}
}

impl TryFrom<&ToolResultContent> for StoredToolResult {
	type Error = MessagePersistenceError;

	fn try_from(content: &ToolResultContent) -> Result<Self, Self::Error> {
		Ok(match content {
			ToolResultContent::Text(text) => Self::Text(text.clone()),
			ToolResultContent::Json(json) => Self::Json(store_json(json)?),
			ToolResultContent::Image(media) => Self::Image(store_media(media)?),
			ToolResultContent::Document(media) => Self::Document(store_media(media)?),
		})
	}
}

impl TryFrom<StoredToolResult> for ToolResultContent {
	type Error = MessagePersistenceError;

	fn try_from(content: StoredToolResult) -> Result<Self, Self::Error> {
		Ok(match content {
			StoredToolResult::Text(text) => Self::Text(text),
			StoredToolResult::Json(json) => Self::Json(restore_json(&json)?),
			StoredToolResult::Image(media) => Self::Image(restore_media(media)),
			StoredToolResult::Document(media) => Self::Document(restore_media(media)),
		})
	}
}

impl From<CacheRetention> for StoredCacheRetention {
	fn from(value: CacheRetention) -> Self {
		match value {
			CacheRetention::Request => Self::Request,
			CacheRetention::Session => Self::Session,
			CacheRetention::Short => Self::Short,
			CacheRetention::Long => Self::Long,
		}
	}
}

impl From<StoredCacheRetention> for CacheRetention {
	fn from(value: StoredCacheRetention) -> Self {
		match value {
			StoredCacheRetention::Request => Self::Request,
			StoredCacheRetention::Session => Self::Session,
			StoredCacheRetention::Short => Self::Short,
			StoredCacheRetention::Long => Self::Long,
		}
	}
}

#[derive(Clone)]
pub(crate) struct RevisionNode<I> {
	pub conversation: ConversationId,
	pub parent:       Option<Revision>,
	pub turn:         Option<TurnId>,
	pub items:        Arc<[I]>,
}

pub(crate) struct ConversationState<I> {
	pub next_conversation: u64,
	pub next_draft:        u64,
	pub heads:             HashMap<ConversationId, Revision>,
	pub revisions:         HashMap<Revision, RevisionNode<I>>,
	pub turns:             HashMap<(ConversationId, TurnId), Revision>,
	pub drafts:            HashSet<u64>,
	pub bindings:          HashMap<ConversationId, ServerStateBinding>,
}

impl<I> Default for ConversationState<I> {
	fn default() -> Self {
		Self {
			next_conversation: 1,
			next_draft:        1,
			heads:             HashMap::new(),
			revisions:         HashMap::new(),
			turns:             HashMap::new(),
			drafts:            HashSet::new(),
			bindings:          HashMap::new(),
		}
	}
}

impl<I> ConversationState<I> {
	pub fn allocate_conversation(&mut self) -> ConversationId {
		let id = ConversationId::new(format!("conversation-{}", self.next_conversation));
		self.next_conversation += 1;
		id
	}

	pub fn revision_for(
		conversation: &ConversationId<str>,
		parent: Option<&Revision<str>>,
		turn: Option<&TurnId<str>>,
	) -> Revision {
		let mut hasher = DefaultHasher::new();
		conversation.hash(&mut hasher);
		parent.hash(&mut hasher);
		turn.hash(&mut hasher);
		Revision::new(format!("revision-{:016x}", hasher.finish()))
	}
}

pub(crate) type SharedState<I> = Arc<Mutex<ConversationState<I>>>;

/// A private staged append whose drop structurally aborts the draft.
#[must_use]
pub struct TurnDraft<I> {
	pub(crate) state:        SharedState<I>,
	pub(crate) draft:        u64,
	pub(crate) conversation: ConversationId,
	pub(crate) base:         Revision,
	pub(crate) turn:         TurnId,
	pub(crate) items:        Option<Arc<[I]>>,
	pub(crate) binding:      Option<PendingServerStateBinding>,
}

impl<I> fmt::Debug for TurnDraft<I> {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("TurnDraft")
			.field("conversation", &self.conversation)
			.field("base", &self.base)
			.field("turn", &self.turn)
			.field("item_count", &self.items.as_ref().map_or(0, |items| items.len()))
			.finish_non_exhaustive()
	}
}

impl<I> TurnDraft<I> {
	/// Associates provider state captured by this successful turn with its
	/// atomic commit.
	pub fn capture_server_state(
		&mut self,
		binding: PendingServerStateBinding,
	) -> Result<(), ConversationError> {
		if binding.conversation != self.conversation {
			return Err(ConversationError::CorruptStore);
		}
		self.binding = Some(binding);
		Ok(())
	}

	/// Atomically commits a successful turn and its captured provider state.
	pub fn commit_successful_turn(
		mut self,
		binding: PendingServerStateBinding,
	) -> Result<CommittedRevision<I>, ConversationError>
	where
		I: PartialEq,
	{
		self.capture_server_state(binding)?;
		self.commit()
	}

	/// Appends additional private items before atomic commit.
	pub fn append(&mut self, items: Arc<[I]>)
	where
		I: Clone,
	{
		let current = self.items.take().unwrap_or_default();
		self.items = Some(
			current
				.iter()
				.cloned()
				.chain(items.iter().cloned())
				.collect::<Vec<_>>()
				.into(),
		);
	}

	/// Atomically commits the staged append, idempotently returning an earlier
	/// identical turn commit.
	pub fn commit(mut self) -> Result<CommittedRevision<I>, ConversationError>
	where
		I: PartialEq,
	{
		let mut state = self.state.lock();
		if let Some(revision) = state
			.turns
			.get(&(self.conversation.clone(), self.turn.clone()))
			.cloned()
		{
			let node = state
				.revisions
				.get(&revision)
				.ok_or(ConversationError::CorruptStore)?;
			let same = node.parent.as_ref() == Some(&self.base)
				&& self
					.items
					.as_deref()
					.is_some_and(|items| items == node.items.as_ref());
			if !same {
				return Err(ConversationError::TurnConflict(self.turn.clone()));
			}
			let committed = CommittedRevision::new(
				node.conversation.clone(),
				revision,
				node.parent.clone(),
				node.turn.clone(),
				Arc::clone(&node.items),
			);
			state.drafts.remove(&self.draft);
			self.items.take();
			return Ok(committed);
		}
		let head = state
			.heads
			.get(&self.conversation)
			.ok_or_else(|| ConversationError::UnknownConversation(self.conversation.clone()))?;
		if head != &self.base {
			return Err(ConversationError::RevisionConflict {
				expected: head.clone(),
				actual:   self.base.clone(),
			});
		}
		let revision = ConversationState::<I>::revision_for(
			&self.conversation,
			Some(&self.base),
			Some(&self.turn),
		);
		let items = self.items.take().ok_or(ConversationError::CorruptStore)?;
		let node = RevisionNode {
			conversation: self.conversation.clone(),
			parent:       Some(self.base.clone()),
			turn:         Some(self.turn.clone()),
			items:        Arc::clone(&items),
		};
		state.revisions.insert(revision.clone(), node);
		state
			.heads
			.insert(self.conversation.clone(), revision.clone());
		state
			.turns
			.insert((self.conversation.clone(), self.turn.clone()), revision.clone());
		if let Some(binding) = self.binding.take() {
			state
				.bindings
				.insert(self.conversation.clone(), binding.commit(revision.clone()));
		}
		state.drafts.remove(&self.draft);
		Ok(CommittedRevision::new(
			self.conversation.clone(),
			revision,
			Some(self.base.clone()),
			Some(self.turn.clone()),
			items,
		))
	}
}

impl<I> Drop for TurnDraft<I> {
	fn drop(&mut self) {
		if self.items.is_some() {
			self.state.lock().drafts.remove(&self.draft);
		}
	}
}

pub(crate) fn revision<I>(
	state: &ConversationState<I>,
	id: &Revision<str>,
) -> Result<CommittedRevision<I>, ConversationError> {
	let node = state
		.revisions
		.get(id)
		.ok_or_else(|| ConversationError::UnknownRevision(Revision::from(id)))?;
	Ok(CommittedRevision::new(
		node.conversation.clone(),
		Revision::from(id),
		node.parent.clone(),
		node.turn.clone(),
		Arc::clone(&node.items),
	))
}

pub(crate) fn is_ancestor<I>(
	state: &ConversationState<I>,
	ancestor: &Revision<str>,
	descendant: &Revision<str>,
) -> bool {
	let mut cursor: Option<&Revision<str>> = Some(descendant);
	while let Some(revision) = cursor {
		if revision.as_str() == ancestor.as_str() {
			return true;
		}
		cursor = state
			.revisions
			.get(revision)
			.and_then(|node| node.parent.as_deref());
	}
	false
}

pub(crate) fn delta<I>(
	state: &ConversationState<I>,
	base: Option<&Revision<str>>,
	head: &Revision<str>,
) -> Result<HistoryDelta<I>, ConversationError> {
	if !state.revisions.contains_key(head) {
		return Err(ConversationError::UnknownRevision(head.to_owned()));
	}
	if base.is_some_and(|base| !is_ancestor(state, base, head)) {
		return Err(ConversationError::RevisionConflict {
			expected: head.to_owned(),
			actual:   base.map(ToOwned::to_owned).expect("checked some"),
		});
	}
	let mut cursor: Option<&Revision<str>> = Some(head);
	let mut segments = Vec::new();
	while let Some(revision) = cursor {
		if base.is_some_and(|base| base == revision) {
			break;
		}
		let node = state
			.revisions
			.get(revision)
			.ok_or(ConversationError::CorruptStore)?;
		segments.push(Arc::clone(&node.items));
		cursor = node.parent.as_deref();
	}
	segments.reverse();
	Ok(HistoryDelta::new(base.map(ToOwned::to_owned), head.to_owned(), segments))
}
#[cfg(test)]
mod tests {
	use std::time::SystemTime;

	use omp_catalog::{
		id::{ModelKey, RouteId},
		provider::{RedirectTrust, TrustDomain},
	};

	use super::*;
	use crate::{
		id::PrincipalId,
		session::{BindingKey, CredentialGenerationPolicy},
	};

	#[test]
	fn rejected_throttled_turn_preserves_last_completed_server_binding() {
		let conversation = ConversationId::new("conversation");
		let revision = Revision::new("completed");
		let binding = ServerStateBinding {
			key:        BindingKey {
				conversation:          conversation.clone(),
				route:                 RouteId::new("openai-codex"),
				model:                 ModelKey::new("openai-codex/gpt"),
				principal:             PrincipalId::new("principal"),
				trust_domain:          TrustDomain {
					origin:          Str::new("https://chatgpt.com"),
					redirects:       RedirectTrust::SameOrigin,
					allow_plaintext: false,
				},
				base_revision:         revision.clone(),
				credential_generation: 1,
				credential_policy:     CredentialGenerationPolicy::PrincipalBound,
			},
			created_at: SystemTime::UNIX_EPOCH,
			expires_at: None,
			handle:     Bytes::from_static(b"resp_completed"),
		};
		let mut state = ConversationState::<Str>::default();
		state.heads.insert(conversation.clone(), revision.clone());
		state.bindings.insert(conversation.clone(), binding);
		let state = Arc::new(Mutex::new(state));
		for (draft, code) in [1_u64, 2]
			.into_iter()
			.zip(["rate_limit_exceeded", "slow_down"])
		{
			state.lock().drafts.insert(draft);
			drop(TurnDraft {
				state: Arc::clone(&state),
				draft,
				conversation: conversation.clone(),
				base: revision.clone(),
				turn: TurnId::new(code),
				items: Some(Arc::from([Str::new("partial")])),
				binding: None,
			});
		}

		let state = state.lock();
		assert_eq!(state.bindings[&conversation].handle, Bytes::from_static(b"resp_completed"));
		assert!(state.drafts.is_empty());
	}
}
