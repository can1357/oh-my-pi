//! Thin native embedding facade for the journal-first OMP kernel.

use std::path::Path;

use omp_agent::{Inference, Kernel, KernelError, RunControl, TurnInput, TurnOutcome, Up};
use omp_core::Str;
use omp_dom::{Event, Snapshot};
use omp_session::{ComponentRegistry, Session, SessionError};
use thiserror::Error;

/// SDK session construction or turn failure.
#[derive(Debug, Error)]
pub enum SdkError {
	/// Journal-backed session construction failed.
	#[error(transparent)]
	Session(#[from] SessionError),
	/// Kernel turn execution failed.
	#[error(transparent)]
	Kernel(#[from] KernelError),
}

/// One embedded journal-backed session and its owning agent kernel.
pub struct Sdk<C> {
	kernel:  Kernel<C>,
	session: Session,
}

impl<C> Sdk<C> {
	/// Creates a new `.oms` session around a caller-composed kernel.
	pub fn create(
		path: impl AsRef<Path>,
		kernel: Kernel<C>,
		components: ComponentRegistry,
	) -> Result<Self, SdkError> {
		Ok(Self { kernel, session: Session::create(path, components)? })
	}

	/// Opens an existing `.oms` session around a caller-composed kernel.
	pub fn open(
		path: impl AsRef<Path>,
		kernel: Kernel<C>,
		components: ComponentRegistry,
	) -> Result<Self, SdkError> {
		Ok(Self { kernel, session: Session::open(path, components)? })
	}

	/// Returns the kernel's upward command mailbox.
	#[must_use]
	pub fn mailbox(&self) -> flume::Sender<Up> {
		self.kernel.mailbox()
	}

	/// Subscribes an actor to a detached snapshot and subsequent DOM events.
	pub fn subscribe(&mut self) -> (Snapshot, flume::Receiver<Event>) {
		self.session.subscribe()
	}

	/// Borrows the authoritative session for explicit host-side inspection.
	#[must_use]
	pub const fn session(&self) -> &Session {
		&self.session
	}

	/// Mutably borrows the controller for host-owned lifecycle operations.
	pub const fn session_mut(&mut self) -> &mut Session {
		&mut self.session
	}
}

impl<C: Inference> Sdk<C> {
	/// Submits one user turn through the composed kernel.
	pub async fn submit(&mut self, text: impl Into<Str>) -> Result<TurnOutcome, SdkError> {
		Ok(self
			.kernel
			.run_turn(
				&mut self.session,
				TurnInput { text: text.into(), attachments: Vec::new() },
				RunControl::default(),
			)
			.await?)
	}
}

#[cfg(test)]
mod tests {
	use std::{future::ready, sync::Arc, time::SystemTime};

	use futures::stream;
	use omp_agent::StaticPrompt;
	use omp_ai::{
		BlockKind, ChatEvent, ChatRequest, ChatStream, Completion, ExecutionReceipt, FinishReason,
		RequestId, ResponseMeta, Usage,
	};
	use omp_catalog::{ProviderId, RouteId};
	use omp_tool::Registry;

	use super::*;

	struct OneTurn;

	impl Inference for OneTurn {
		fn chat(
			&mut self,
			_request: ChatRequest,
		) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
			let events = [
				ChatEvent::Started(ResponseMeta {
					request_id:          RequestId::from("sdk-test"),
					provider:            ProviderId::from("test"),
					route:               RouteId::from("test/route"),
					model:               None,
					provider_request_id: None,
					created_at:          SystemTime::UNIX_EPOCH,
				}),
				ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text },
				ChatEvent::TextDelta { index: 0, text: Str::new_static("hello") },
				ChatEvent::Completed(Completion {
					reason:  FinishReason::Stop,
					blocks:  1,
					usage:   Usage::default(),
					receipt: ExecutionReceipt::default().into(),
				}),
			]
			.into_iter()
			.map(Ok);
			ready(Ok(ChatStream::ordinary(Box::pin(stream::iter(events)))))
		}
	}

	fn kernel(root: &Path) -> Kernel<OneTurn> {
		let spill = omp_journal::blob::BlobStore::open(root.join("artifacts")).expect("blob store");
		Kernel::new(
			OneTurn,
			Arc::new(Registry::new()),
			omp_agent::DispatchPolicy::new(spill),
			StaticPrompt(Str::new_static("test")),
		)
	}

	#[tokio::test]
	async fn submit_is_durable_and_open_replays_the_same_dom() {
		let temp = tempfile::tempdir().expect("temporary directory");
		let path = temp.path().join("session.oms");
		let mut sdk = Sdk::create(&path, kernel(temp.path()), ComponentRegistry::standard())
			.expect("create SDK session");
		let outcome = sdk.submit("hi").await.expect("submit");
		assert_eq!(outcome.assistant_text, "hello");
		let live = sdk.session().dom().snapshot();
		drop(sdk);

		let reopened = Sdk::open(&path, kernel(temp.path()), ComponentRegistry::standard())
			.expect("reopen SDK session");
		assert_eq!(reopened.session().dom().snapshot(), live);
	}
}
