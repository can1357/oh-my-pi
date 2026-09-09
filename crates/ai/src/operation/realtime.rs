//! Bounded owned realtime session construction and typed control receipts.

use std::{
	fmt,
	future::Future,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	task::{Context, Poll},
	time::SystemTime,
};

use flume::Receiver;
use tower::Service;

use crate::{
	answer::{Answer, AnswerBody, RealtimeEvent, RealtimeInput, RealtimeSession},
	call::{Call, OperationCall, RealtimeModality, RealtimeRequest},
	catalog::OperationKind,
	error::Error,
	operation::{
		MediaOperationError, OperationRequest, OperationResponse, media_validation_error,
		wrong_operation,
	},
};

/// Realtime channel construction failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum RealtimeSessionError {
	/// Capacity must be non-zero.
	#[error("realtime channel capacity is zero")]
	ZeroCapacity,
	/// The bounded outbound queue is full.
	#[error("realtime outbound queue is full")]
	Backpressure,
	/// Provider input is disconnected.
	#[error("realtime provider input is disconnected")]
	OutboundClosed,
	/// Provider output is disconnected.
	#[error("realtime provider output is disconnected")]
	InboundClosed,
	/// Session was already closed.
	#[error("realtime session is already closed")]
	AlreadyClosed,
	/// No realtime modality was requested.
	#[error("realtime request has no modality")]
	MissingModality,
	/// A modality was requested more than once.
	#[error("realtime request contains a duplicate modality")]
	DuplicateModality,
	/// Tool count exceeds the negotiated bound.
	#[error("realtime tool count exceeds the negotiated bound")]
	TooManyTools,
	/// Initial instructions exceed the negotiated bound.
	#[error("realtime instructions exceed the negotiated bound")]
	InstructionsTooLarge,
	/// A voice was selected without audio output.
	#[error("realtime voice requires audio output")]
	VoiceWithoutAudio,
}

/// Kind of caller message accepted into the bounded queue.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RealtimeInputKind {
	/// Encoded input audio.
	Audio,
	/// User text.
	Text,
	/// Result of one authorized tool call.
	ToolResult,
	/// Provider-neutral session or delegation context.
	AppendContext,
	/// Caller microphone mute state.
	SetMuted,
	/// Cancellation of one delegated agent turn.
	CancelDelegation,
	/// Terminal settlement of one delegated agent turn.
	SettleDelegation,
	/// Commit current input.
	Commit,
	/// Cancel only the active response.
	CancelResponse,
	/// Close the entire session.
	Close,
}

impl RealtimeInputKind {
	const fn of(input: &RealtimeInput) -> Self {
		match input {
			RealtimeInput::Audio(_) => Self::Audio,
			RealtimeInput::Text(_) => Self::Text,
			RealtimeInput::ToolResult { .. } => Self::ToolResult,
			RealtimeInput::AppendContext(_) => Self::AppendContext,
			RealtimeInput::SetMuted(_) => Self::SetMuted,
			RealtimeInput::CancelDelegation { .. } => Self::CancelDelegation,
			RealtimeInput::SettleDelegation(_) => Self::SettleDelegation,
			RealtimeInput::Commit => Self::Commit,
			RealtimeInput::CancelResponse => Self::CancelResponse,
			RealtimeInput::Close => Self::Close,
		}
	}
}

/// Evidence that a realtime input or control message entered the bounded queue.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RealtimeSendReceipt {
	/// Accepted message kind.
	pub kind:        RealtimeInputKind,
	/// Time at which the queue accepted it.
	pub accepted_at: SystemTime,
}

/// Provider-side endpoint paired with an owned caller session.
pub struct RealtimeProviderEndpoint {
	input:         Receiver<RealtimeInput>,
	output:        flume::Sender<Result<RealtimeEvent, Error>>,
	closed:        Arc<AtomicBool>,
	terminal_sent: bool,
}

impl fmt::Debug for RealtimeProviderEndpoint {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("RealtimeProviderEndpoint")
			.field("closed", &self.closed.load(Ordering::Acquire))
			.field("terminal_sent", &self.terminal_sent)
			.finish_non_exhaustive()
	}
}

impl RealtimeSession {
	/// Creates bounded caller and provider endpoints; no hidden unbounded buffer
	/// exists.
	pub fn bounded(
		capacity: usize,
	) -> Result<(Self, RealtimeProviderEndpoint), RealtimeSessionError> {
		if capacity == 0 {
			return Err(RealtimeSessionError::ZeroCapacity);
		}
		let (outbound, input) = flume::bounded(capacity);
		let (output, inbound) = flume::bounded(capacity);
		let closed = Arc::new(AtomicBool::new(false));
		Ok((Self::from_channels(outbound, inbound, Arc::clone(&closed)), RealtimeProviderEndpoint {
			input,
			output,
			closed,
			terminal_sent: false,
		}))
	}

	/// Attempts to enqueue input immediately and reports bounded backpressure.
	pub fn try_send(
		&self,
		input: RealtimeInput,
	) -> Result<RealtimeSendReceipt, RealtimeSessionError> {
		if self.closed.load(Ordering::Acquire) {
			return Err(RealtimeSessionError::AlreadyClosed);
		}
		let kind = RealtimeInputKind::of(&input);
		if kind == RealtimeInputKind::Close && self.closed.swap(true, Ordering::AcqRel) {
			return Err(RealtimeSessionError::AlreadyClosed);
		}
		if let Err(error) = self.outbound.try_send(input) {
			if kind == RealtimeInputKind::Close {
				self.closed.store(false, Ordering::Release);
			}
			return Err(match error {
				flume::TrySendError::Full(_) => RealtimeSessionError::Backpressure,
				flume::TrySendError::Disconnected(_) => RealtimeSessionError::OutboundClosed,
			});
		}
		Ok(RealtimeSendReceipt { kind, accepted_at: SystemTime::now() })
	}

	/// Waits for bounded queue capacity and enqueues one message.
	pub async fn send(
		&self,
		input: RealtimeInput,
	) -> Result<RealtimeSendReceipt, RealtimeSessionError> {
		if self.closed.load(Ordering::Acquire) {
			return Err(RealtimeSessionError::AlreadyClosed);
		}
		let kind = RealtimeInputKind::of(&input);
		if kind == RealtimeInputKind::Close && self.closed.swap(true, Ordering::AcqRel) {
			return Err(RealtimeSessionError::AlreadyClosed);
		}
		if self.outbound.send_async(input).await.is_err() {
			if kind == RealtimeInputKind::Close {
				self.closed.store(false, Ordering::Release);
			}
			return Err(RealtimeSessionError::OutboundClosed);
		}
		Ok(RealtimeSendReceipt { kind, accepted_at: SystemTime::now() })
	}

	/// Enqueues cancellation of only the active response, leaving the session
	/// open.
	pub async fn cancel_response(&self) -> Result<RealtimeSendReceipt, RealtimeSessionError> {
		self.send(RealtimeInput::CancelResponse).await
	}

	/// Enqueues a clean session-close request exactly once.
	pub async fn close(&self) -> Result<RealtimeSendReceipt, RealtimeSessionError> {
		self.send(RealtimeInput::Close).await
	}

	/// Receives the next provider event without buffering it elsewhere.
	pub async fn recv(&self) -> Result<Result<RealtimeEvent, Error>, RealtimeSessionError> {
		let event = self
			.inbound
			.recv_async()
			.await
			.map_err(|_| RealtimeSessionError::InboundClosed)?;
		if matches!(&event, Ok(RealtimeEvent::CloseReceipt(_) | RealtimeEvent::Closed) | Err(_)) {
			self.closed.store(true, Ordering::Release);
		}
		Ok(event)
	}
}

impl RealtimeProviderEndpoint {
	/// Receives the next caller message under transport backpressure.
	pub async fn recv(&self) -> Result<RealtimeInput, RealtimeSessionError> {
		self
			.input
			.recv_async()
			.await
			.map_err(|_| RealtimeSessionError::OutboundClosed)
	}

	/// Attempts to publish one provider event immediately.
	pub fn try_send(
		&mut self,
		event: Result<RealtimeEvent, Error>,
	) -> Result<(), RealtimeSessionError> {
		if self.terminal_sent {
			return Err(RealtimeSessionError::AlreadyClosed);
		}
		let terminal =
			matches!(&event, Ok(RealtimeEvent::CloseReceipt(_) | RealtimeEvent::Closed) | Err(_));
		if self.closed.load(Ordering::Acquire) && !terminal {
			return Err(RealtimeSessionError::AlreadyClosed);
		}
		self.output.try_send(event).map_err(|error| match error {
			flume::TrySendError::Full(_) => RealtimeSessionError::Backpressure,
			flume::TrySendError::Disconnected(_) => RealtimeSessionError::InboundClosed,
		})?;
		if terminal {
			self.closed.store(true, Ordering::Release);
			self.terminal_sent = true;
		}
		Ok(())
	}

	/// Publishes one provider event after bounded queue capacity becomes
	/// available.
	pub async fn send(
		&mut self,
		event: Result<RealtimeEvent, Error>,
	) -> Result<(), RealtimeSessionError> {
		if self.terminal_sent {
			return Err(RealtimeSessionError::AlreadyClosed);
		}
		let terminal =
			matches!(&event, Ok(RealtimeEvent::CloseReceipt(_) | RealtimeEvent::Closed) | Err(_));
		if self.closed.load(Ordering::Acquire) && !terminal {
			return Err(RealtimeSessionError::AlreadyClosed);
		}
		self
			.output
			.send_async(event)
			.await
			.map_err(|_| RealtimeSessionError::InboundClosed)?;
		if terminal {
			self.closed.store(true, Ordering::Release);
			self.terminal_sent = true;
		}
		Ok(())
	}

	/// Returns whether the session reached terminal closure.
	pub fn is_closed(&self) -> bool {
		self.closed.load(Ordering::Acquire)
	}
}
/// Realtime handshake limits enforced before opening a transport.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RealtimeLimits {
	/// Maximum number of callable tools.
	pub max_tools:             usize,
	/// Maximum UTF-8 instruction bytes.
	pub max_instruction_bytes: usize,
}

/// Validates session intent before a realtime connection is opened.
pub fn validate_request(
	request: &RealtimeRequest,
	limits: RealtimeLimits,
) -> Result<(), RealtimeSessionError> {
	if request.modalities.is_empty() {
		return Err(RealtimeSessionError::MissingModality);
	}
	if request
		.modalities
		.iter()
		.filter(|item| matches!(item, RealtimeModality::Text))
		.count()
		> 1 || request
		.modalities
		.iter()
		.filter(|item| matches!(item, RealtimeModality::Audio))
		.count()
		> 1
	{
		return Err(RealtimeSessionError::DuplicateModality);
	}
	if request.tools.len() > limits.max_tools {
		return Err(RealtimeSessionError::TooManyTools);
	}
	if request
		.instructions
		.as_ref()
		.is_some_and(|value| value.len() > limits.max_instruction_bytes)
	{
		return Err(RealtimeSessionError::InstructionsTooLarge);
	}
	if request.voice.is_some()
		&& !request
			.modalities
			.iter()
			.any(|item| matches!(item, RealtimeModality::Audio))
	{
		return Err(RealtimeSessionError::VoiceWithoutAudio);
	}
	Ok(())
}

/// Concrete realtime-session operation service over a constructed handshake
/// backend.
#[derive(Clone, Debug)]
pub struct RealtimeService<S> {
	inner:  S,
	limits: RealtimeLimits,
}

impl<S> RealtimeService<S> {
	/// Wraps a route backend with canonical realtime request validation.
	pub const fn new(inner: S, limits: RealtimeLimits) -> Self {
		Self { inner, limits }
	}
}

impl<S> Service<Call> for RealtimeService<S>
where
	S: Service<
			OperationRequest<RealtimeRequest>,
			Response = OperationResponse<RealtimeSession>,
			Error = Error,
		>,
	S::Future: Send + 'static,
{
	type Error = Error;
	type Response = Answer;

	type Future = impl Future<Output = Result<Answer, Error>> + Send;

	fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		self.inner.poll_ready(context)
	}

	fn call(&mut self, call: Call) -> Self::Future {
		let request = match &call.operation {
			OperationCall::Realtime(request) => Some(Arc::clone(request)),
			_ => None,
		};
		let validation = request
			.as_ref()
			.map(|request| validate_request(request, self.limits));
		let pending = request
			.as_ref()
			.filter(|_| validation.as_ref().is_some_and(Result::is_ok))
			.map(|request| {
				self
					.inner
					.call(OperationRequest::from_call(&call, Arc::clone(request)))
			});
		async move {
			if request.is_none() {
				return Err(wrong_operation(&call, OperationKind::Realtime));
			}
			if let Some(Err(error)) = validation {
				return Err(media_validation_error(OperationKind::Realtime, error));
			}
			let response = pending
				.ok_or_else(|| {
					media_validation_error(
						OperationKind::Realtime,
						MediaOperationError::RealtimeRequestNotDispatched,
					)
				})?
				.await?;
			Ok(response.into_answer(AnswerBody::Realtime))
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::answer::{RealtimeCloseOrigin, RealtimeCloseReason, RealtimeCloseReceipt};

	#[test]
	fn bounded_queue_reports_backpressure_and_close_receipt() {
		let (session, provider) = RealtimeSession::bounded(1).unwrap();
		assert!(session.try_send(RealtimeInput::Commit).is_ok());
		assert_eq!(session.try_send(RealtimeInput::Close), Err(RealtimeSessionError::Backpressure));
		drop(provider);
		assert_eq!(
			session.try_send(RealtimeInput::Commit),
			Err(RealtimeSessionError::OutboundClosed)
		);
	}

	#[test]
	fn explicit_close_is_terminal_and_exactly_once() {
		let (session, provider) = RealtimeSession::bounded(2).unwrap();
		let receipt = session.try_send(RealtimeInput::Close).unwrap();
		assert_eq!(receipt.kind, RealtimeInputKind::Close);
		assert!(session.is_closed());
		assert_eq!(session.try_send(RealtimeInput::Close), Err(RealtimeSessionError::AlreadyClosed));
		assert_eq!(session.try_send(RealtimeInput::Commit), Err(RealtimeSessionError::AlreadyClosed));
		assert!(matches!(provider.input.try_recv(), Ok(RealtimeInput::Close)));
		assert!(provider.input.try_recv().is_err());
	}

	#[test]
	fn provider_terminal_event_marks_session_closed() {
		let (session, mut provider) = RealtimeSession::bounded(1).unwrap();
		provider.try_send(Ok(RealtimeEvent::Closed)).unwrap();
		assert!(session.is_closed());
		let event = session.inbound.try_recv().unwrap().unwrap();
		assert!(matches!(event, RealtimeEvent::Closed));
		assert_eq!(
			provider.try_send(Ok(RealtimeEvent::Closed)),
			Err(RealtimeSessionError::AlreadyClosed)
		);
	}
	#[test]
	fn provider_close_receipt_is_terminal_and_exactly_once() {
		let (session, mut provider) = RealtimeSession::bounded(1).unwrap();
		let receipt = RealtimeCloseReceipt {
			origin:    RealtimeCloseOrigin::Provider,
			reason:    RealtimeCloseReason::Completed,
			closed_at: SystemTime::now(),
		};
		provider
			.try_send(Ok(RealtimeEvent::CloseReceipt(receipt)))
			.unwrap();
		assert!(session.is_closed());
		assert!(matches!(
			session.inbound.try_recv().unwrap().unwrap(),
			RealtimeEvent::CloseReceipt(received) if received == receipt
		));
		assert_eq!(
			provider.try_send(Ok(RealtimeEvent::CloseReceipt(receipt))),
			Err(RealtimeSessionError::AlreadyClosed)
		);
	}

	#[test]
	fn drop_enqueues_nonblocking_close_when_capacity_exists() {
		let (session, provider) = RealtimeSession::bounded(1).unwrap();
		drop(session);
		assert!(matches!(provider.input.try_recv(), Ok(RealtimeInput::Close)));
	}
}
