//! Deterministic canonical inference used by joined spine proofs.

use std::{
	collections::VecDeque,
	future::{Future, ready},
	sync::Arc,
	time::SystemTime,
};

use omp_agent::Inference;
use omp_ai::{ChatEvent, ChatRequest, ChatStream, RequestId, ResponseMeta};
use parking_lot::Mutex;

/// Captured canonical inference requests.
pub type CapturedRequests = Arc<Mutex<Vec<ChatRequest>>>;

/// A finite sequence of canonical provider event scripts.
pub struct ScriptedInference {
	scripts:  VecDeque<Vec<ChatEvent>>,
	requests: CapturedRequests,
}

impl ScriptedInference {
	/// Creates a scripted inference source and its request recorder.
	pub fn new(scripts: impl IntoIterator<Item = Vec<ChatEvent>>) -> (Self, CapturedRequests) {
		let requests = Arc::new(Mutex::new(Vec::new()));
		(Self { scripts: scripts.into_iter().collect(), requests: Arc::clone(&requests) }, requests)
	}
}

impl Inference for ScriptedInference {
	fn chat(
		&mut self,
		request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		self.requests.lock().push(request);
		let events = self
			.scripts
			.pop_front()
			.expect("one script per inference request");
		ready(Ok(scripted_stream(events)))
	}
}

/// Wraps canonical events in the production stream handshake.
pub fn scripted_stream(events: Vec<ChatEvent>) -> ChatStream {
	let events = std::iter::once(ChatEvent::Started(ResponseMeta {
		request_id:          RequestId::from("e2e-scripted-request"),
		provider:            "scripted".into(),
		route:               "scripted/e2e".into(),
		model:               Some("e2e".into()),
		provider_request_id: None,
		created_at:          SystemTime::UNIX_EPOCH,
	}))
	.chain(events)
	.map(Ok);
	ChatStream::ordinary(Box::pin(futures::stream::iter(events)))
}
