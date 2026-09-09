//! Ordered tool output frames stream onto the call's `<result>` text (ADR
//! 0008): a running card reads the accumulated output, the journal never
//! carries the bytes twice, and replay reproduces the DOM byte for byte.

use std::{sync::Arc, time::Duration};

use async_stream::stream;
use futures::Stream;
use omp_agent::{CancelTree, DispatchPolicy, Dispatcher, ToolCancellation};
use omp_core::Str;
use omp_dom::{KnownTag, PropId, Tag};
use omp_journal::blob::BlobStore;
use omp_session::{ComponentRegistry, Session};
use omp_tool::{
	Claims, Ev, IncomingParams, Part, Precedence, Presentation, PromptCaps, Registry, Tool,
	ToolTerminal,
};

mod support;
use support::{Fault, Payload, call, request, session, tool_spec};

/// Emits ordered output frames shaped like `omp_tools::shell::Update` — a
/// byte-array `data` chunk per frame — then settles.
struct Frames {
	spec:   omp_tool::ToolSpec,
	chunks: Vec<&'static [u8]>,
	pause:  Duration,
}

impl Tool for Frames {
	type Fault = Fault;
	type Params = serde_json::Value;
	type Payload = Payload;
	type Update = serde_json::Value;

	fn spec(&self) -> &omp_tool::ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
		stream! {
			let _ = params.committed().await;
			yield Ev::Update(serde_json::json!({
				"channel": "stdout", "data": [], "sequence": 0, "started": true,
			}));
			for (index, chunk) in self.chunks.iter().enumerate() {
				yield Ev::Update(serde_json::json!({
					"channel": "stdout", "data": chunk, "sequence": index + 1,
				}));
				// A stale duplicate of the same frame must not append twice.
				yield Ev::Update(serde_json::json!({
					"channel": "stdout", "data": chunk, "sequence": index + 1,
				}));
			}
			if !self.pause.is_zero() {
				tokio::time::sleep(self.pause).await;
			}
			yield Ev::Done(ToolTerminal::Done {
				result: Ok(Payload { text: Str::new_static("exit 0") }),
				useless: false,
			});
		}
	}

	fn prompt(&self, view: Result<&Self::Payload, &Self::Fault>, _caps: &PromptCaps) -> Vec<Part> {
		let text = match view {
			Ok(payload) => payload.text.clone(),
			Err(fault) => fault.message.clone(),
		};
		vec![Part::Text { text }]
	}
}

fn frames_registry(chunks: Vec<&'static [u8]>, pause: Duration) -> Arc<Registry> {
	let mut registry = Registry::new();
	registry
		.register(
			Frames { spec: tool_spec("frames", 1), chunks, pause },
			Presentation::Slot,
			Claims {
				precedence: Precedence::CORE,
				claimant:   Str::new_static("omp-agent/tests"),
				replaces:   None,
			},
		)
		.expect("tool registers");
	Arc::new(registry)
}

fn result_handle(session: &Session, call_id: &str) -> omp_dom::Handle {
	let dom = session.dom();
	let call = dom
		.handles()
		.find(|handle| {
			dom.get(*handle).is_some_and(|node| {
				node.tag == Tag::Custom(Str::new_static("frames"))
					&& node
						.prop(&PropId::Id.into())
						.and_then(omp_dom::Value::as_str)
						== Some(call_id)
			})
		})
		.expect("call element");
	dom.children(call)
		.iter()
		.copied()
		.find(|child| {
			dom.get(*child)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Result))
		})
		.expect("result element")
}

fn result_text(session: &Session, call_id: &str) -> String {
	let result = result_handle(session, call_id);
	let dom = session.dom();
	dom.stream_text(result, &PropId::Text.into())
		.map(str::to_owned)
		.or_else(|| {
			dom.get(result)?
				.prop(&PropId::Text.into())
				.and_then(omp_dom::Value::as_str)
				.map(str::to_owned)
		})
		.unwrap_or_default()
}

#[tokio::test]
async fn output_frames_stream_onto_the_result_text_and_replay_byte_identical() {
	let directory = tempfile::tempdir().expect("temporary directory");
	// The second chunk splits a multibyte character ("é" = C3 A9) across
	// frames; the stream must carry the lead byte instead of mangling it.
	let tools = frames_registry(
		vec![&b"line 1\nca"[..], &b"f\xC3"[..], &b"\xA9 au lait\nline 3\n"[..]],
		Duration::from_millis(400),
	);
	let identity = tools.resolved_identity("frames").expect("identity");
	let dispatcher = Dispatcher::new(
		Arc::clone(&tools),
		DispatchPolicy::new(BlobStore::open(directory.path()).expect("blob store")),
	);
	let path = directory.path().join("frames.oms");
	let mut session = session(&path);
	let (entry, args) = call(&mut session, &identity, "frames");
	let cancellation = CancelTree::new().begin_turn();
	let dispatch = dispatcher.dispatch(
		&mut session,
		request(
			entry,
			identity,
			args,
			ToolCancellation::ReadOnly(cancellation.read_only_tool()),
			false,
		),
	);
	let report = dispatch.await.expect("frames dispatch settles");
	assert!(!report.is_error);
	// The stream closed before the terminal; the settled result now owns
	// the text, and the journal carries the output exactly once — in the
	// stream frames, never duplicated into the typed updates.
	assert_eq!(result_text(&session, "frames"), "line 1\ncafé au lait\nline 3\n");
	let journal = std::fs::read_to_string(&path).expect("journal reads");
	assert_eq!(journal.matches("au lait").count(), 1, "{journal}");
	assert!(!journal.contains("[108,105,110,101"), "typed updates drop the bytes: {journal}");
	let live = session.dom().snapshot();
	drop(session);
	let restored = Session::open(&path, ComponentRegistry::default()).expect("journal replays");
	assert_eq!(restored.dom().snapshot().as_bytes(), live.as_bytes());
}

#[tokio::test]
async fn output_stream_is_readable_mid_call_and_dedupes_stale_frames() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let tools = frames_registry(vec![&b"one\n"[..], &b"two\n"[..]], Duration::from_secs(60));
	let identity = tools.resolved_identity("frames").expect("identity");
	let dispatcher = Dispatcher::new(
		Arc::clone(&tools),
		DispatchPolicy::new(BlobStore::open(directory.path()).expect("blob store")),
	);
	let mut session = session(&directory.path().join("live.oms"));
	let (entry, args) = call(&mut session, &identity, "live");
	let cancellation = CancelTree::new().begin_turn().read_only_tool();
	let report = {
		let dispatch = dispatcher.dispatch(
			&mut session,
			request(entry, identity, args, ToolCancellation::ReadOnly(cancellation.clone()), false),
		);
		tokio::pin!(dispatch);
		tokio::select! {
			result = &mut dispatch => panic!("dispatch settled early: {result:?}"),
			() = tokio::time::sleep(Duration::from_millis(150)) => {},
		}
		// `dispatch` borrows the session mutably; cancel to release it, then
		// inspect what the stream held when the call was torn down.
		cancellation.cancel_tool();
		dispatch
			.await
			.expect("cancelled dispatch journals a terminal")
	};
	assert!(report.is_error);
	// The close materialized the concatenation (each chunk once despite
	// the duplicate frames); the abort's diag, not the result, carries the
	// error, so the streamed text survives on the result element.
	assert_eq!(result_text(&session, "live"), "one\ntwo\n");
}
