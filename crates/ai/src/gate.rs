//! Transactional visibility gate for semantic postconditions.

use std::{collections::VecDeque, io, mem::size_of};

use omp_core::{Str, sf};

use crate::{
	answer::{Artifact, ArtifactBody, ArtifactRef, ResponseMeta},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	event::{ChatEvent, ToolCall},
	receipt::{
		Adjustment, AttemptReceipt, ExecutionReceipt, PlanSummary, ReasonId, RecoveryRecord,
		StagingReceipt,
	},
};

/// A semantic condition that must hold before provisional events become public.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GateCondition {
	/// Commit on the first ordinary canonical event.
	FirstValidEvent,
	/// Commit only on a schema-validated ready call to the named tool.
	ToolCallReady {
		/// Name of the tool whose ready call commits output.
		tool: Str,
	},
	/// Commit only after the structured-output validator explicitly reports
	/// success.
	ValidStructuredOutput,
	/// Commit only after the entire upstream attempt finishes successfully.
	WholeAttempt,
}

/// Observable lifecycle of a transactional output gate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GatePhase {
	/// Events are private and may still be discarded.
	Provisional,
	/// At least one condition was accepted and output may pass through.
	Committed,
	/// The attempt ended without satisfying its condition.
	Discarded,
	/// The upstream stream or provisional store failed.
	Failed,
	/// The caller cancelled the stream.
	Cancelled,
}

/// Result of accepting one canonical event.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GateProgress {
	/// The event remains private.
	Provisional,
	/// The condition committed and this many events were flushed in order.
	Committed {
		/// Number of provisional events flushed in order.
		flushed: usize,
	},
	/// The already-committed event was forwarded directly.
	PassThrough,
	/// A schema-valid ready call named a different tool, so the attempt was
	/// discarded.
	Rejected,
}

/// Result of a successful upstream end-of-stream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GateFinish {
	/// The gate had already committed before end-of-stream.
	AlreadyCommitted,
	/// Whole-attempt validation committed and flushed the buffered events.
	Committed {
		/// Number of provisional events flushed in order.
		flushed: usize,
	},
	/// The condition remained unsatisfied and every provisional event was
	/// discarded.
	Unsatisfied(GateCondition),
}

/// Secret-free failure returned by an explicit secure provisional spool.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GateSpoolError {
	/// The spool's explicit byte capacity was exceeded.
	Capacity {
		/// Spool byte capacity.
		limit:    u64,
		/// Bytes observed before rejecting the append.
		observed: u64,
	},
	/// The encrypted store was unavailable.
	Unavailable {
		/// Secret-free unavailability reason.
		reason: ReasonId,
	},
	/// Authenticated spool contents failed validation while being read.
	Corrupt {
		/// Secret-free corruption reason.
		reason: ReasonId,
	},
}

/// Explicit secure storage for provisional canonical events.
///
/// Implementations must encrypt and authenticate persistent contents, must
/// preserve insertion order, and must securely erase all remaining contents
/// from `discard` and `Drop`. Supplying this trait object is the caller's
/// explicit opt-in to spill model output; the gate never creates one itself.
pub trait SecureGateSpool: Send {
	/// Returns the hard bound on bytes accepted by this spool.
	fn capacity_bytes(&self) -> u64;

	/// Appends one owned event and its deterministic gate size.
	fn push(&mut self, event: ChatEvent, event_bytes: u64) -> Result<(), GateSpoolError>;

	/// Removes the oldest event, preserving insertion order.
	fn pop_front(&mut self) -> Result<Option<(ChatEvent, u64)>, GateSpoolError>;

	/// Securely erases every remaining event and any persistent backing state.
	fn discard(&mut self) -> Result<(), GateSpoolError>;
}

/// Transactional owner of all output from one semantic attempt.
///
/// `push` is the only event ingress. It never invokes `emit` while the gate is
/// provisional. Once the selected condition holds, buffered events are emitted
/// in original order and later events pass through. Errors, cancellation, and
/// unsatisfied completion erase private events without exposing rollback or
/// restart markers.
pub struct OutputGate {
	condition:         GateCondition,
	phase:             GatePhase,
	committed:         bool,
	memory_limit:      u64,
	memory_bytes:      u64,
	provisional_bytes: u64,
	memory:            VecDeque<(ChatEvent, u64)>,
	spool:             Option<Box<dyn SecureGateSpool>>,
	spooling:          bool,
	receipt:           ExecutionReceipt,
}

impl OutputGate {
	/// Creates a memory-only gate with empty accounting.
	pub fn new(condition: GateCondition, max_memory_bytes: u64) -> Self {
		Self::with_receipt(condition, max_memory_bytes, ExecutionReceipt::default())
	}

	/// Creates a memory-only gate owning the supplied execution receipt.
	pub fn with_receipt(
		condition: GateCondition,
		max_memory_bytes: u64,
		receipt: ExecutionReceipt,
	) -> Self {
		Self {
			condition,
			phase: GatePhase::Provisional,
			committed: false,
			memory_limit: max_memory_bytes,
			memory_bytes: 0,
			provisional_bytes: 0,
			memory: VecDeque::new(),
			spool: None,
			spooling: false,
			receipt,
		}
	}

	/// Creates a gate that may explicitly spill beyond its memory bound into
	/// secure storage.
	pub fn with_secure_spool(
		condition: GateCondition,
		max_memory_bytes: u64,
		spool: Box<dyn SecureGateSpool>,
		receipt: ExecutionReceipt,
	) -> Self {
		let mut gate = Self::with_receipt(condition, max_memory_bytes, receipt);
		gate.spool = Some(spool);
		gate
	}

	/// Returns the selected semantic condition.
	pub const fn condition(&self) -> &GateCondition {
		&self.condition
	}

	/// Returns the gate lifecycle.
	pub const fn phase(&self) -> GatePhase {
		self.phase
	}

	/// Returns whether output has committed to the consumer.
	pub const fn is_committed(&self) -> bool {
		self.committed
	}

	/// Returns bytes currently owned provisionally across memory and secure
	/// spool.
	pub const fn provisional_bytes(&self) -> u64 {
		self.provisional_bytes
	}

	/// Borrows accumulated execution accounting.
	pub const fn receipt(&self) -> &ExecutionReceipt {
		&self.receipt
	}

	/// Mutably borrows accumulated execution accounting.
	pub const fn receipt_mut(&mut self) -> &mut ExecutionReceipt {
		&mut self.receipt
	}

	/// Records one attempt as hidden and charges its usage and cost to the final
	/// receipt.
	pub fn record_attempt(&mut self, mut attempt: AttemptReceipt) {
		attempt.hidden = true;
		self.receipt.record_attempt(attempt);
	}

	/// Consumes the gate and returns its lossless accounting.
	pub fn into_receipt(self) -> ExecutionReceipt {
		self.receipt
	}

	/// Accepts one canonical event, withholding it until the condition commits.
	pub fn push(
		&mut self,
		event: ChatEvent,
		emit: &mut impl FnMut(ChatEvent),
	) -> Result<GateProgress, Error> {
		match self.phase {
			GatePhase::Committed => {
				emit(event);
				return Ok(GateProgress::PassThrough);
			},
			GatePhase::Provisional => {},
			GatePhase::Discarded | GatePhase::Failed | GatePhase::Cancelled => {
				return Err(self.inactive_error());
			},
		}
		if event.is_workflow_control() {
			emit(event);
			return Ok(GateProgress::PassThrough);
		}

		if self.event_satisfies(&event) {
			let flushed = self.commit(Some(event), emit)?;
			return Ok(GateProgress::Committed { flushed });
		}
		if self.event_rejects(&event) {
			self.discard_or_fail()?;
			self.phase = GatePhase::Discarded;
			return Ok(GateProgress::Rejected);
		}

		self.buffer(event)?;
		Ok(GateProgress::Provisional)
	}

	/// Accepts explicit success evidence from the structured-output validator.
	///
	/// This signal is deliberately separate from text events: the gate never
	/// attempts to infer schema validity by traversing an opaque JSON value.
	pub fn mark_structured_output_valid(
		&mut self,
		emit: &mut impl FnMut(ChatEvent),
	) -> Result<GateProgress, Error> {
		if self.phase != GatePhase::Provisional {
			return Err(self.inactive_error());
		}
		if !matches!(&self.condition, GateCondition::ValidStructuredOutput) {
			return Err(self.condition_evidence_error());
		}
		let flushed = self.commit(None, emit)?;
		Ok(GateProgress::Committed { flushed })
	}

	/// Handles a clean upstream end-of-stream.
	///
	/// `WholeAttempt` commits only here. Every other unsatisfied condition
	/// discards its attempt.
	pub fn finish(&mut self, emit: &mut impl FnMut(ChatEvent)) -> Result<GateFinish, Error> {
		match self.phase {
			GatePhase::Committed => Ok(GateFinish::AlreadyCommitted),
			GatePhase::Provisional if matches!(&self.condition, GateCondition::WholeAttempt) => {
				let flushed = self.commit(None, emit)?;
				Ok(GateFinish::Committed { flushed })
			},
			GatePhase::Provisional => {
				let condition = self.condition.clone();
				self.discard_or_fail()?;
				self.phase = GatePhase::Discarded;
				Ok(GateFinish::Unsatisfied(condition))
			},
			GatePhase::Discarded | GatePhase::Failed | GatePhase::Cancelled => {
				Err(self.inactive_error())
			},
		}
	}

	/// Handles an upstream failure, discarding private output and setting exact
	/// commit evidence.
	pub fn fail(&mut self, error: Error) -> Error {
		let committed = self.is_committed();
		if !committed && let Err(spool_error) = self.discard_private() {
			self.phase = GatePhase::Failed;
			return self.spool_error(spool_error);
		}
		self.phase = GatePhase::Failed;
		let mut error = error.committed(committed);
		error.replace_receipt(self.receipt.clone());
		error
	}

	/// Cancels the attempt, discarding private output and retaining hidden
	/// accounting.
	pub fn cancel(&mut self) -> Error {
		let committed = self.is_committed();
		if !committed && let Err(spool_error) = self.discard_private() {
			self.phase = GatePhase::Failed;
			return self.spool_error(spool_error);
		}
		self.phase = GatePhase::Cancelled;
		Error::new(
			ErrorKind::Cancelled,
			ErrorPhase::Streaming,
			RetryAction::Never,
			self.receipt.clone(),
		)
		.committed(committed)
	}

	fn event_satisfies(&self, event: &ChatEvent) -> bool {
		match (&self.condition, event) {
			(GateCondition::FirstValidEvent, event) => event.commits_output(),
			(GateCondition::ToolCallReady { tool }, ChatEvent::ToolCallReady { call, .. }) => {
				tool == &call.name
			},
			(
				GateCondition::ToolCallReady { .. }
				| GateCondition::ValidStructuredOutput
				| GateCondition::WholeAttempt,
				_,
			) => false,
		}
	}

	fn event_rejects(&self, event: &ChatEvent) -> bool {
		matches!(
			(&self.condition, event),
			(GateCondition::ToolCallReady { tool }, ChatEvent::ToolCallReady { call, .. }) if tool != &call.name
		)
	}

	fn buffer(&mut self, event: ChatEvent) -> Result<(), Error> {
		let event_bytes = event_size(&event);
		let observed = self.provisional_bytes.saturating_add(event_bytes);
		if !self.spooling && self.memory_bytes.saturating_add(event_bytes) <= self.memory_limit {
			self.memory.push_back((event, event_bytes));
			self.memory_bytes = self.memory_bytes.saturating_add(event_bytes);
			self.provisional_bytes = observed;
			return Ok(());
		}

		let Some(spool_limit) = self.spool.as_ref().map(|spool| spool.capacity_bytes()) else {
			return Err(self.buffer_limit_error(self.memory_limit, observed));
		};
		if observed > spool_limit {
			return Err(self.abort_spool(GateSpoolError::Capacity { limit: spool_limit, observed }));
		}

		if !self.spooling {
			self.spooling = true;
			while let Some((buffered, bytes)) = self.memory.pop_front() {
				let result = match self.spool.as_mut() {
					Some(spool) => spool.push(buffered, bytes),
					None => Err(missing_spool()),
				};
				if let Err(error) = result {
					return Err(self.abort_spool(error));
				}
			}
			self.memory_bytes = 0;
		}
		let result = match self.spool.as_mut() {
			Some(spool) => spool.push(event, event_bytes),
			None => Err(missing_spool()),
		};
		if let Err(error) = result {
			return Err(self.abort_spool(error));
		}
		self.provisional_bytes = observed;
		Ok(())
	}

	fn commit(
		&mut self,
		tail: Option<ChatEvent>,
		emit: &mut impl FnMut(ChatEvent),
	) -> Result<usize, Error> {
		let mut flushed = 0usize;
		if self.spooling {
			loop {
				let result = match self.spool.as_mut() {
					Some(spool) => spool.pop_front(),
					None => Err(missing_spool()),
				};
				let event = match result {
					Ok(event) => event,
					Err(error) => {
						let cleanup = self.discard_private();
						let failure = match cleanup {
							Ok(()) => self.spool_error(error),
							Err(cleanup_error) => self.spool_error(cleanup_error),
						};
						self.phase = GatePhase::Failed;
						return Err(failure);
					},
				};
				let Some((event, event_bytes)) = event else {
					break;
				};
				self.provisional_bytes = self.provisional_bytes.saturating_sub(event_bytes);
				self.phase = GatePhase::Committed;
				self.committed = true;
				emit(event);
				flushed = flushed.saturating_add(1);
			}
			let result = match self.spool.as_mut() {
				Some(spool) => spool.discard(),
				None => Err(missing_spool()),
			};
			if let Err(error) = result {
				let failure = self.spool_error(error);
				self.phase = GatePhase::Failed;
				return Err(failure);
			}
			self.spooling = false;
		} else {
			while let Some((event, event_bytes)) = self.memory.pop_front() {
				self.memory_bytes = self.memory_bytes.saturating_sub(event_bytes);
				self.provisional_bytes = self.provisional_bytes.saturating_sub(event_bytes);
				self.phase = GatePhase::Committed;
				self.committed = true;
				emit(event);
				flushed = flushed.saturating_add(1);
			}
		}
		if let Some(event) = tail {
			self.phase = GatePhase::Committed;
			self.committed = true;
			emit(event);
			flushed = flushed.saturating_add(1);
		}
		self.phase = GatePhase::Committed;
		self.committed = true;
		self.memory_bytes = 0;
		self.provisional_bytes = 0;
		Ok(flushed)
	}

	fn discard_private(&mut self) -> Result<(), GateSpoolError> {
		self.memory.clear();
		self.memory_bytes = 0;
		self.provisional_bytes = 0;
		if self.spooling {
			if let Some(spool) = self.spool.as_mut() {
				spool.discard()?;
			}
			self.spooling = false;
		}
		Ok(())
	}

	fn discard_or_fail(&mut self) -> Result<(), Error> {
		if let Err(error) = self.discard_private() {
			let failure = self.spool_error(error);
			self.phase = GatePhase::Failed;
			return Err(failure);
		}
		Ok(())
	}

	fn buffer_limit_error(&mut self, limit: u64, observed: u64) -> Error {
		let cleanup = self.discard_private();
		self.phase = GatePhase::Failed;
		if let Err(error) = cleanup {
			return self.spool_error(error);
		}
		Error::new(
			ErrorKind::PolicyBufferExceeded,
			ErrorPhase::Streaming,
			RetryAction::Never,
			self.receipt.clone(),
		)
		.detail(ErrorDetail::budget(
			sf!("provisional_bytes"),
			u128::from(limit),
			u128::from(observed),
		))
	}

	fn abort_spool(&mut self, cause: GateSpoolError) -> Error {
		let cleanup = self.discard_private();
		self.phase = GatePhase::Failed;
		match cleanup {
			Ok(()) => self.spool_error(cause),
			Err(cleanup_error) => self.spool_error(cleanup_error),
		}
	}

	fn spool_error(&self, error: GateSpoolError) -> Error {
		match error {
			GateSpoolError::Capacity { limit, observed } => Error::new(
				ErrorKind::PolicyBufferExceeded,
				ErrorPhase::Streaming,
				RetryAction::Never,
				self.receipt.clone(),
			)
			.committed(self.is_committed())
			.detail(ErrorDetail::budget(
				sf!("provisional_spool_bytes"),
				u128::from(limit),
				u128::from(observed),
			)),
			GateSpoolError::Unavailable { reason } => {
				self.spool_protocol_error(ErrorKind::ResourceExhausted, reason)
			},
			GateSpoolError::Corrupt { reason } => {
				self.spool_protocol_error(ErrorKind::StreamCorruption, reason)
			},
		}
	}

	fn spool_protocol_error(&self, kind: ErrorKind, reason: ReasonId) -> Error {
		Error::new(kind, ErrorPhase::Streaming, RetryAction::Never, self.receipt.clone())
			.committed(self.is_committed())
			.detail(ErrorDetail::protocol(reason))
	}

	fn inactive_error(&self) -> Error {
		Error::new(
			ErrorKind::InternalInvariant,
			ErrorPhase::Internal,
			RetryAction::Never,
			self.receipt.clone(),
		)
		.committed(self.is_committed())
		.detail(ErrorDetail::protocol(ReasonId(sf!("output_gate_not_active"))))
	}

	fn condition_evidence_error(&self) -> Error {
		Error::new(
			ErrorKind::InternalInvariant,
			ErrorPhase::Recovery,
			RetryAction::Never,
			self.receipt.clone(),
		)
		.detail(ErrorDetail::protocol(ReasonId(sf!("gate_evidence_condition_mismatch"))))
	}
}

fn missing_spool() -> GateSpoolError {
	GateSpoolError::Unavailable { reason: ReasonId(sf!("secure_spool_missing")) }
}

/// Returns the conservative number of bytes charged while an event is
/// provisional.
///
/// The fixed buffered representation is charged for every event, then logical
/// variable payload bytes are added. A streamed artifact charges only its owned
/// stream handle; streamed media bytes are budgeted by the artifact pipeline
/// when polled after commit.
pub fn event_size(event: &ChatEvent) -> u64 {
	let payload = match event {
		ChatEvent::Started(meta) => response_meta_size(meta),
		ChatEvent::BlockStarted { .. } | ChatEvent::Usage(_) => 0,
		ChatEvent::TextDelta { text, .. } | ChatEvent::ThinkingDelta { text, .. } => {
			usize_to_u64(text.len())
		},
		ChatEvent::ToolCallStarted { id, name, .. } => {
			usize_to_u64(id.as_str().len()).saturating_add(usize_to_u64(name.len()))
		},
		ChatEvent::ToolArgumentsDelta { bytes, .. } => usize_to_u64(bytes.len()),
		ChatEvent::ToolCallReady { call, .. } => tool_call_size(call),
		ChatEvent::Artifact { artifact, .. } => artifact_size(artifact),
		ChatEvent::WorkflowAction(action) => usize_to_u64(action.invocation.len())
			.saturating_add(usize_to_u64(action.name.len()))
			.saturating_add(usize_to_u64(action.arguments.len())),
		ChatEvent::WorkflowResume(resume) => usize_to_u64(resume.workflow_id.len())
			.saturating_add(usize_to_u64(resume.session_id.len()))
			.saturating_add(usize_to_u64(resume.last_event_id.as_ref().map_or(0, Str::len))),
		ChatEvent::WorkflowCancelled { invocation } => usize_to_u64(invocation.len()),
		ChatEvent::Completed(completion) => receipt_heap_size(&completion.receipt),
	};
	usize_to_u64(size_of::<(ChatEvent, u64)>()).saturating_add(payload)
}

fn response_meta_size(meta: &ResponseMeta) -> u64 {
	[
		meta.request_id.as_str().len(),
		meta.provider.as_str().len(),
		meta.route.as_str().len(),
		meta.model.as_ref().map_or(0, |model| model.as_str().len()),
		meta
			.provider_request_id
			.as_ref()
			.map_or(0, |request_id| request_id.len()),
	]
	.into_iter()
	.fold(0u64, |total, bytes| total.saturating_add(usize_to_u64(bytes)))
}

fn receipt_heap_size(receipt: &ExecutionReceipt) -> u64 {
	let adjustment_bytes = receipt
		.adjustments
		.iter()
		.fold(0u64, |total, adjustment| total.saturating_add(adjustment_heap_size(adjustment)));
	let attempt_bytes = receipt
		.attempts
		.iter()
		.fold(0u64, |total, attempt| total.saturating_add(attempt_heap_size(attempt)));
	let recovery_bytes = receipt
		.recoveries
		.iter()
		.fold(0u64, |total, recovery| total.saturating_add(recovery_heap_size(recovery)));
	vector_allocation_size::<Adjustment>(receipt.adjustments.capacity())
		.saturating_add(vector_allocation_size::<AttemptReceipt>(receipt.attempts.capacity()))
		.saturating_add(vector_allocation_size::<RecoveryRecord>(receipt.recoveries.capacity()))
		.saturating_add(vector_allocation_size::<StagingReceipt>(receipt.staging.capacity()))
		.saturating_add(plan_heap_size(&receipt.plan))
		.saturating_add(adjustment_bytes)
		.saturating_add(attempt_bytes)
		.saturating_add(recovery_bytes)
}

fn plan_heap_size(plan: &PlanSummary) -> u64 {
	option_text_size(plan.catalog_revision.as_ref())
		.saturating_add(option_text_size(plan.model.as_ref()))
		.saturating_add(option_text_size(plan.provider.as_ref()))
		.saturating_add(option_text_size(plan.route.as_ref()))
		.saturating_add(option_text_size(plan.codec.as_ref()))
		.saturating_add(option_text_size(plan.wire_policy.as_ref()))
		.saturating_add(option_text_size(plan.thinking_policy.as_ref()))
}

fn adjustment_heap_size(adjustment: &Adjustment) -> u64 {
	match adjustment {
		Adjustment::Native { feature }
		| Adjustment::Emulated { feature, .. }
		| Adjustment::Escalated { feature, .. } => usize_to_u64(feature.0.len()),
		Adjustment::Dropped { feature, reason } => {
			usize_to_u64(feature.0.len()).saturating_add(usize_to_u64(reason.0.len()))
		},
		Adjustment::Substituted { feature, from, to } => usize_to_u64(feature.0.len())
			.saturating_add(usize_to_u64(from.len()))
			.saturating_add(usize_to_u64(to.len())),
	}
}

fn attempt_heap_size(attempt: &AttemptReceipt) -> u64 {
	option_text_size(attempt.provider.as_ref())
		.saturating_add(option_text_size(attempt.route.as_ref()))
		.saturating_add(option_text_size(attempt.account.as_ref()))
		.saturating_add(option_text_size(attempt.principal.as_ref()))
		.saturating_add(option_str_size(attempt.provider_evidence.request_id.as_ref()))
		.saturating_add(option_str_size(attempt.provider_evidence.code.as_ref()))
		.saturating_add(option_str_size(attempt.provider_evidence.summary.as_ref()))
}

fn recovery_heap_size(recovery: &RecoveryRecord) -> u64 {
	usize_to_u64(recovery.rule.0.len())
}

fn option_text_size<T: AsRef<str>>(value: Option<&T>) -> u64 {
	value.map_or(0, |text| usize_to_u64(text.as_ref().len()))
}

fn option_str_size(value: Option<&Str>) -> u64 {
	value.map_or(0, |text| usize_to_u64(text.len()))
}

fn vector_allocation_size<T>(capacity: usize) -> u64 {
	usize_to_u64(capacity).saturating_mul(usize_to_u64(size_of::<T>()))
}

fn tool_call_size(call: &ToolCall) -> u64 {
	usize_to_u64(call.id.as_str().len())
		.saturating_add(usize_to_u64(call.name.len()))
		.saturating_add(json_size(call.arguments.as_value()))
}

fn artifact_size(artifact: &Artifact) -> u64 {
	let mut bytes = usize_to_u64(artifact.media_type.len());
	if let Some(digest) = &artifact.digest {
		bytes = bytes.saturating_add(usize_to_u64(digest.value.len()));
	}
	bytes.saturating_add(match &artifact.body {
		ArtifactBody::Bytes(body) => usize_to_u64(body.len()),
		ArtifactBody::Stream(_) => 0,
		ArtifactBody::Stored(reference) => artifact_ref_size(reference),
	})
}

fn artifact_ref_size(reference: &ArtifactRef) -> u64 {
	[reference.store.len(), reference.id.len(), reference.revision.len()]
		.into_iter()
		.fold(0u64, |total, bytes| total.saturating_add(usize_to_u64(bytes)))
}

fn json_size(value: &serde_json::Value) -> u64 {
	let mut writer = CountingWriter(0);
	if serde_json::to_writer(&mut writer, value).is_err() {
		u64::MAX
	} else {
		writer.0
	}
}

fn usize_to_u64(value: usize) -> u64 {
	u64::try_from(value).unwrap_or(u64::MAX)
}

struct CountingWriter(u64);

impl io::Write for CountingWriter {
	fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
		self.0 = self.0.saturating_add(usize_to_u64(buffer.len()));
		Ok(buffer.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use std::{collections::VecDeque, time::Duration};

	use bytes::Bytes;
	use serde_json::{Map, Value};

	use super::*;
	use crate::{
		body::{AttemptBodyEvidence, Replayability, RetryDecision, RetryDecisionReason},
		call::OpaqueJson,
		event::ToolCall,
		id::ToolCallId,
		receipt::{AttemptOutcome, Cost, ExecutionBudget, ProviderEvidence, Usage},
	};

	fn text(value: &str) -> ChatEvent {
		ChatEvent::TextDelta { index: 0, text: Str::new(value) }
	}

	fn partial_tool(name: &str) -> ChatEvent {
		ChatEvent::ToolCallStarted {
			index: 0,
			id:    ToolCallId::from("call-partial"),
			name:  Str::new(name),
		}
	}

	fn ready_tool(name: &str) -> ChatEvent {
		ChatEvent::ToolCallReady {
			index: 0,
			call:  ToolCall {
				id:        ToolCallId::from("call-ready"),
				name:      Str::new(name),
				arguments: OpaqueJson::new(Value::Object(Map::new())),
			},
		}
	}

	fn text_value(event: &ChatEvent) -> Option<&str> {
		match event {
			ChatEvent::TextDelta { text, .. } => Some(text.as_str()),
			_ => None,
		}
	}

	fn hidden_attempt(usage: Usage, cost: Cost) -> AttemptReceipt {
		AttemptReceipt {
			index: 0,
			hidden: false,
			provider: None,
			route: None,
			account: None,
			principal: None,
			body: AttemptBodyEvidence {
				replayability:  Replayability::Replayable,
				opened:         true,
				consumed:       true,
				retry_decision: RetryDecision::Allow,
				reason:         RetryDecisionReason::ReplayableSource,
			},
			outcome: AttemptOutcome::RejectedSemantic,
			usage,
			cost,
			provider_evidence: ProviderEvidence::default(),
			elapsed: Duration::ZERO,
		}
	}
	#[test]
	fn default_budget_buffers_first_block_marker_until_text_commits() {
		let mut gate = OutputGate::new(
			GateCondition::FirstValidEvent,
			ExecutionBudget::default().max_provisional_bytes,
		);
		let mut public = Vec::new();
		assert_eq!(
			gate
				.push(
					ChatEvent::BlockStarted { index: 0, kind: crate::event::BlockKind::Text },
					&mut |event| public.push(event),
				)
				.unwrap(),
			GateProgress::Provisional
		);
		assert!(public.is_empty());
		assert_eq!(
			gate
				.push(text("hello"), &mut |event| public.push(event))
				.unwrap(),
			GateProgress::Committed { flushed: 2 }
		);
		assert!(matches!(public.as_slice(), [
			ChatEvent::BlockStarted { .. },
			ChatEvent::TextDelta { .. }
		]));
	}

	#[test]
	fn provisional_events_do_not_leak_and_whole_attempt_flushes_without_control_events() {
		let first = text("one");
		let second = text("two");
		let bound = event_size(&first).saturating_add(event_size(&second));
		let mut gate = OutputGate::new(GateCondition::WholeAttempt, bound);
		let mut public = Vec::new();

		assert_eq!(
			gate.push(first, &mut |event| public.push(event)).unwrap(),
			GateProgress::Provisional
		);
		assert_eq!(
			gate.push(second, &mut |event| public.push(event)).unwrap(),
			GateProgress::Provisional
		);
		assert!(public.is_empty(), "callbacks must see no provisional events");
		assert_eq!(gate.finish(&mut |event| public.push(event)).unwrap(), GateFinish::Committed {
			flushed: 2,
		});

		let visible: Vec<_> = public.iter().filter_map(text_value).collect();
		assert_eq!(visible, ["one", "two"]);
		assert_eq!(public.len(), 2, "the gate must not inject restart or rollback events");
	}

	#[test]
	fn named_tool_gate_rejects_wrong_tool_without_exposing_authorization() {
		let mut gate =
			OutputGate::new(GateCondition::ToolCallReady { tool: sf!("required") }, u64::MAX);
		let mut public = Vec::new();

		assert_eq!(
			gate
				.push(ready_tool("wrong"), &mut |event| public.push(event))
				.unwrap(),
			GateProgress::Rejected
		);
		assert_eq!(gate.phase(), GatePhase::Discarded);
		assert!(public.is_empty());
	}

	#[test]
	fn partial_and_malformed_tool_output_is_noncompliant_at_completion() {
		let started = partial_tool("required");
		let malformed = ChatEvent::ToolArgumentsDelta {
			index: 0,
			bytes: Bytes::from_static(br#"{"unterminated":"#),
		};
		let bound = event_size(&started).saturating_add(event_size(&malformed));
		let condition = GateCondition::ToolCallReady { tool: sf!("required") };
		let mut gate = OutputGate::new(condition.clone(), bound);
		let mut public = Vec::new();

		gate.push(started, &mut |event| public.push(event)).unwrap();
		gate
			.push(malformed, &mut |event| public.push(event))
			.unwrap();
		assert_eq!(
			gate.finish(&mut |event| public.push(event)).unwrap(),
			GateFinish::Unsatisfied(condition)
		);
		assert!(public.is_empty());
		assert_eq!(gate.provisional_bytes(), 0);
	}

	#[test]
	fn matching_schema_valid_ready_call_flushes_in_order_then_passes_through() {
		let prefix = text("explanation");
		let bound = event_size(&prefix);
		let mut gate = OutputGate::new(GateCondition::ToolCallReady { tool: sf!("required") }, bound);
		let mut public = Vec::new();

		gate.push(prefix, &mut |event| public.push(event)).unwrap();
		assert!(public.is_empty());
		assert_eq!(
			gate
				.push(ready_tool("required"), &mut |event| public.push(event))
				.unwrap(),
			GateProgress::Committed { flushed: 2 }
		);
		assert_eq!(
			gate
				.push(text("after"), &mut |event| public.push(event))
				.unwrap(),
			GateProgress::PassThrough
		);

		assert_eq!(text_value(&public[0]), Some("explanation"));
		assert!(
			matches!(&public[1], ChatEvent::ToolCallReady { call, .. } if call.name.as_str() == "required")
		);
		assert_eq!(text_value(&public[2]), Some("after"));
	}

	#[test]
	fn structured_output_requires_explicit_validator_evidence() {
		let output = text(r#"{"ok":true}"#);
		let mut gate = OutputGate::new(GateCondition::ValidStructuredOutput, event_size(&output));
		let mut public = Vec::new();

		gate.push(output, &mut |event| public.push(event)).unwrap();
		assert!(public.is_empty());
		assert_eq!(
			gate
				.mark_structured_output_valid(&mut |event| public.push(event))
				.unwrap(),
			GateProgress::Committed { flushed: 1 }
		);
		assert_eq!(text_value(&public[0]), Some(r#"{"ok":true}"#));

		let invalid_output = text(r#"{"ok":"wrong shape"}"#);
		let mut invalid =
			OutputGate::new(GateCondition::ValidStructuredOutput, event_size(&invalid_output));
		let mut invalid_public = Vec::new();
		invalid
			.push(invalid_output, &mut |event| invalid_public.push(event))
			.unwrap();
		assert_eq!(
			invalid
				.finish(&mut |event| invalid_public.push(event))
				.unwrap(),
			GateFinish::Unsatisfied(GateCondition::ValidStructuredOutput)
		);
		assert!(invalid_public.is_empty());
	}

	#[test]
	fn memory_bound_failure_discards_everything_before_commit() {
		let event = text("too large");
		let limit = event_size(&event).saturating_sub(1);
		let mut gate = OutputGate::new(GateCondition::WholeAttempt, limit);
		let mut public = Vec::new();

		let error = gate
			.push(event, &mut |event| public.push(event))
			.unwrap_err();
		assert_eq!(error.kind, ErrorKind::PolicyBufferExceeded);
		assert!(!error.committed);
		assert!(public.is_empty());
		assert_eq!(gate.phase(), GatePhase::Failed);
		assert_eq!(gate.provisional_bytes(), 0);
	}

	#[test]
	fn hidden_attempt_usage_and_cost_survive_discard() {
		let mut gate =
			OutputGate::new(GateCondition::ToolCallReady { tool: sf!("required") }, u64::MAX);
		let usage = Usage { input_tokens: 11, output_tokens: 7, ..Usage::default() };
		let cost = Cost::from_micro_usd(29);
		gate.record_attempt(hidden_attempt(usage, cost));

		let mut public = Vec::new();
		assert!(matches!(
			gate.finish(&mut |event| public.push(event)).unwrap(),
			GateFinish::Unsatisfied(_)
		));
		assert!(public.is_empty());
		assert!(gate.receipt().attempts[0].hidden);
		assert_eq!(gate.receipt().usage.input_tokens, 11);
		assert_eq!(gate.receipt().usage.output_tokens, 7);
		assert_eq!(gate.receipt().cost, cost);
	}

	#[test]
	fn cancellation_and_errors_discard_precommit_but_mark_postcommit_failures() {
		let held = text("private");
		let mut cancelled = OutputGate::new(GateCondition::WholeAttempt, event_size(&held));
		let mut public = Vec::new();
		cancelled
			.push(held, &mut |event| public.push(event))
			.unwrap();
		let cancellation = cancelled.cancel();
		assert_eq!(cancellation.kind, ErrorKind::Cancelled);
		assert!(!cancellation.committed);
		assert!(public.is_empty());
		assert_eq!(cancelled.phase(), GatePhase::Cancelled);

		let failed_event = text("failed-private");
		let mut failed = OutputGate::new(GateCondition::WholeAttempt, event_size(&failed_event));
		failed
			.push(failed_event, &mut |event| public.push(event))
			.unwrap();
		let upstream = Error::new(
			ErrorKind::Connectivity,
			ErrorPhase::Streaming,
			RetryAction::Never,
			ExecutionReceipt::default(),
		);
		let precommit = failed.fail(upstream);
		assert!(!precommit.committed);
		assert!(public.is_empty());

		let mut committed = OutputGate::new(GateCondition::FirstValidEvent, 0);
		committed
			.push(text("visible"), &mut |event| public.push(event))
			.unwrap();
		let upstream = Error::new(
			ErrorKind::Connectivity,
			ErrorPhase::Streaming,
			RetryAction::Never,
			ExecutionReceipt::default(),
		);
		let surfaced = committed.fail(upstream);
		assert!(surfaced.committed);
		assert!(committed.is_committed());
		assert_eq!(public.len(), 1);
		assert_eq!(text_value(&public[0]), Some("visible"));
	}

	struct TestSecureSpool {
		capacity: u64,
		used:     u64,
		events:   VecDeque<(ChatEvent, u64)>,
	}

	impl SecureGateSpool for TestSecureSpool {
		fn capacity_bytes(&self) -> u64 {
			self.capacity
		}

		fn push(&mut self, event: ChatEvent, event_bytes: u64) -> Result<(), GateSpoolError> {
			let observed = self.used.saturating_add(event_bytes);
			if observed > self.capacity {
				return Err(GateSpoolError::Capacity { limit: self.capacity, observed });
			}
			self.used = observed;
			self.events.push_back((event, event_bytes));
			Ok(())
		}

		fn pop_front(&mut self) -> Result<Option<(ChatEvent, u64)>, GateSpoolError> {
			let Some((event, bytes)) = self.events.pop_front() else {
				return Ok(None);
			};
			self.used = self.used.saturating_sub(bytes);
			Ok(Some((event, bytes)))
		}

		fn discard(&mut self) -> Result<(), GateSpoolError> {
			self.events.clear();
			self.used = 0;
			Ok(())
		}
	}

	#[test]
	fn explicit_secure_spool_preserves_order_beyond_memory_bound() {
		let first = text("one");
		let second = text("two");
		let capacity = event_size(&first).saturating_add(event_size(&second));
		let spool = TestSecureSpool { capacity, used: 0, events: VecDeque::new() };
		let mut gate = OutputGate::with_secure_spool(
			GateCondition::WholeAttempt,
			0,
			Box::new(spool),
			ExecutionReceipt::default(),
		);
		let mut public = Vec::new();

		gate.push(first, &mut |event| public.push(event)).unwrap();
		gate.push(second, &mut |event| public.push(event)).unwrap();
		assert!(public.is_empty());
		assert_eq!(gate.finish(&mut |event| public.push(event)).unwrap(), GateFinish::Committed {
			flushed: 2,
		});
		assert_eq!(public.iter().filter_map(text_value).collect::<Vec<_>>(), ["one", "two"]);
	}

	#[test]
	fn explicit_secure_spool_capacity_is_a_hard_bound() {
		let event = text("spool overflow");
		let capacity = event_size(&event).saturating_sub(1);
		let spool = TestSecureSpool { capacity, used: 0, events: VecDeque::new() };
		let mut gate = OutputGate::with_secure_spool(
			GateCondition::WholeAttempt,
			0,
			Box::new(spool),
			ExecutionReceipt::default(),
		);
		let mut public = Vec::new();

		let error = gate
			.push(event, &mut |event| public.push(event))
			.unwrap_err();
		assert_eq!(error.kind, ErrorKind::PolicyBufferExceeded);
		assert!(!error.committed);
		assert!(public.is_empty());
		assert_eq!(gate.provisional_bytes(), 0);
	}
}
