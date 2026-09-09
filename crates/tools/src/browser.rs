//! Stateful browser automation over a harness-owned supervised daemon.

use std::sync::{
	Arc,
	atomic::{AtomicU64, Ordering},
};

use async_stream::stream;
use async_trait::async_trait;
use bytes::Bytes;
use futures::Stream;
use omp_core::{Str, sf};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CallOutcome, CommitError, Constraint, Effects, Ev, ExecEffects,
	IncomingParams, LiftedCall, ParamError, Part, PromptCaps, RecordedCall, Rev, Tool, ToolSpec,
	ToolTerminal,
};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

static NEXT_OWNER: AtomicU64 = AtomicU64::new(1);

/// Browser lifecycle operation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, strum::Display)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Action {
	/// Create or replace a named tab.
	Open,
	/// Execute one automation operation in a named tab.
	Run,
	/// Close one named tab or every tab.
	Close,
}

/// Browser application attachment or launch configuration.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct App {
	/// Binary path to spawn.
	pub path:    Option<Str>,
	/// Existing Chrome `DevTools` Protocol endpoint.
	pub cdp_url: Option<Str>,
	/// Drive the user's own browser through the relay.
	pub relay:   Option<bool>,
	/// Extra application arguments.
	pub args:    Option<Vec<Str>>,
	/// Window title or URL substring used to select a target.
	pub target:  Option<Str>,
}

/// Browser viewport configuration.
#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
	/// Width in CSS pixels.
	pub width:  u32,
	/// Height in CSS pixels.
	pub height: u32,
	/// Device scale factor.
	pub scale:  Option<f64>,
}

/// Navigation completion condition.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, strum::Display)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
pub enum WaitUntil {
	/// Window load event.
	Load,
	/// DOM content loaded event.
	Domcontentloaded,
	/// No active network requests.
	Networkidle0,
	/// At most two active network requests.
	Networkidle2,
}

/// JavaScript dialog handling policy.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, strum::Display)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Dialogs {
	/// Accept dialogs.
	Accept,
	/// Dismiss dialogs.
	Dismiss,
}

/// Browser tool arguments.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Lifecycle action.
	pub action:                  Action,
	/// Stable tab name; defaults to `main`.
	pub name:                    Option<Str>,
	/// Initial or navigated URL.
	pub url:                     Option<Str>,
	/// Browser process, CDP, or relay configuration for `open`.
	pub app:                     Option<App>,
	/// Viewport dimensions for `open`.
	pub viewport:                Option<Viewport>,
	/// Navigation completion condition.
	pub wait_until:              Option<WaitUntil>,
	/// Automatic JavaScript dialog handling.
	pub dialogs:                 Option<Dialogs>,
	/// JavaScript body evaluated by `run` against the persistent named tab.
	pub code:                    Option<Str>,
	/// Bounded operation timeout in seconds.
	pub timeout:                 Option<f64>,
	/// Close every managed tab.
	#[serde(default)]
	pub all:                     bool,
	/// Also terminate spawned browser processes while closing.
	#[serde(default)]
	pub kill:                    bool,
	/// Private host-control signal used by `/browser` after persisting a mode
	/// change. This is intentionally absent from the model-facing schema.
	#[serde(default)]
	#[schemars(skip)]
	#[doc(hidden)]
	pub restart_for_mode_change: Option<bool>,
}

/// Retained browser binary output.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Artifact {
	/// Content-addressed artifact URI.
	pub uri:      Str,
	/// Media type.
	pub mime:     Str,
	/// Stable origin (`screenshot` or `download`).
	pub kind:     Str,
	/// Whether transcript actors should reveal the artifact inline.
	pub visible:  bool,
	/// Exact retained byte count.
	pub byte_len: u64,
}

impl<'de> Deserialize<'de> for Artifact {
	fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		#[derive(Deserialize)]
		#[serde(untagged)]
		enum Wire {
			Legacy(Str),
			Current {
				uri:      Str,
				mime:     Str,
				kind:     Str,
				#[serde(default = "visible")]
				visible:  bool,
				#[serde(default)]
				byte_len: u64,
			},
		}
		Ok(match Wire::deserialize(deserializer)? {
			Wire::Legacy(uri) => Self {
				uri,
				mime: sf!("image/png"),
				kind: sf!("screenshot"),
				visible: true,
				byte_len: 0,
			},
			Wire::Current { uri, mime, kind, visible, byte_len } => {
				Self { uri, mime, kind, visible, byte_len }
			},
		})
	}
}

const fn visible() -> bool {
	true
}

/// Browser operation result.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Payload {
	/// Completed lifecycle action.
	pub action:    Action,
	/// Stable tab name.
	pub name:      Str,
	/// Current committed URL, when a tab remains open.
	pub url:       Option<Str>,
	/// Current document title, when available.
	pub title:     Option<Str>,
	/// Values explicitly emitted through the run scope's `display(value)`.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub display:   Vec<Value>,
	/// JSON value returned by the run scope.
	pub result:    Option<Value>,
	/// Content-addressed artifacts created by the operation.
	pub artifacts: Vec<Artifact>,
	/// Backend mode the tab runs under (`headless` or `window`). Absent on
	/// payloads journaled before it existed.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub browser:   Option<Str>,
}

/// Human name of a backend mode for [`Payload::browser`].
#[must_use]
pub const fn mode_name(headless: bool) -> Str {
	if headless {
		Str::new_static("headless")
	} else {
		Str::new_static("window")
	}
}

/// Browser daemon failure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct Fault {
	/// Stable failure category.
	pub code:      Str,
	/// Secret-free diagnostic.
	pub message:   Str,
	/// Stable tab name when failure happened after tab lookup.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub name:      Option<Str>,
	/// Current committed URL when available.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub url:       Option<Str>,
	/// Current document title when available.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub title:     Option<Str>,
	/// Backend mode when known.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub browser:   Option<Str>,
	/// Helper or lifecycle phase that failed.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub operation: Option<Str>,
}

/// Typed browser progress streamed into the call element.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Update {
	/// Lifecycle work began.
	Started {
		/// Stable tab name.
		name:    Str,
		/// Lifecycle action.
		action:  Action,
		/// Selected backend mode.
		browser: Str,
	},
	/// One lifted JavaScript helper is running.
	Helper {
		/// Stable helper name such as `tab.click`.
		operation: Str,
	},
	/// A screenshot or download was retained.
	Artifact {
		/// Content-addressed artifact URI.
		uri:  Str,
		/// Media type.
		mime: Str,
	},
}

/// Harness-owned browser daemon contract.
#[async_trait]
pub trait BrowserHost: Send + Sync + 'static {
	/// Execute one lifecycle operation.
	async fn execute(
		&self,
		owner: Str,
		params: Params,
		cancellation: CancellationToken,
		updates: flume::Sender<Update>,
	) -> Result<Payload, Fault>;
	/// Release every tab owned by one tool/session composition.
	fn release_owner(&self, owner: &str);
	/// Drop live browser surfaces and apply a new headless/windowed mode.
	async fn restart_for_mode_change(&self, headless: bool) -> Result<(), Fault>;
}

/// Browser tool routed to one supervised daemon.
pub struct Browser {
	host:  Arc<dyn BrowserHost>,
	owner: Str,
	spec:  ToolSpec,
}

/// Builds the host-free `browser@3` declaration.
pub fn spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("browser"),
		rev:             Rev { family: Str::default(), n: 3 },
		description:     sf!(
			"Drives persistent, session-owned browser tabs through a composable JavaScript surface. \
			 Call open before run and close when finished. run exposes page, browser, tab, display, \
			 assert, and wait. tab provides url/title/goto, observe/ariaSnapshot, \
			 click/type/fill/press/scroll/scrollIntoView/drag/select/uploadFile, evaluate/extract, \
			 screenshot/download, \
			 waitFor/waitForSelector/waitForUrl/waitForResponse/waitForNavigation, and id/ref \
			 element handles. app.path spawns an owned browser; app.cdp_url attaches without owning \
			 the page; app.relay uses the logged-in relay browser. Request interception is scoped to \
			 one run and is removed before settlement."
		),
		schema:          omp_tool::schema::<Params>(),
		constraint:      Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects:         Effects {
			documents: None,
			exec:      Some(ExecEffects { commands: Arc::default(), network: true }),
			inference: None,
			desktop:   None,
			subagents: 0,
		},
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("browser.rs"),
		)
		.into(),
	}
}

/// Creates `browser@3`.
pub fn tool(host: Arc<dyn BrowserHost>) -> Browser {
	let owner = sf!("browser-owner-{}", NEXT_OWNER.fetch_add(1, Ordering::Relaxed));
	Browser { host, owner, spec: spec() }
}

impl Drop for Browser {
	fn drop(&mut self) {
		self.host.release_owner(&self.owner);
	}
}

impl Tool for Browser {
	type Fault = Fault;
	type Params = Params;
	type Payload = Payload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Update, Payload, Fault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<Params>().await {
				Ok(params) => params,
				Err(error) => { yield param_event(error); return; },
			};
			if let Err(error) = incoming.interruptable().committed().await {
				yield commit_event(error);
				return;
			}
			if let Some(headless) = params.restart_for_mode_change {
				let name = params.name.clone().unwrap_or_else(|| sf!("main"));
				let result = self.host.restart_for_mode_change(headless).await.map(|()| Payload {
					action: Action::Close,
					name,
					url: None,
					title: None,
					display: Vec::new(),
					result: Some(json!({ "headless": headless })),
					artifacts: Vec::new(),
					browser: Some(mode_name(headless)),
				});
				yield Ev::Done(ToolTerminal::Done { result, useless: false });
				return;
			}
			let cancellation = CancellationToken::new();
			let (updates, progress) = flume::unbounded();
			let execution = self.host.execute(
				self.owner.clone(),
				params,
				cancellation.clone(),
				updates,
			);
			tokio::pin!(execution);
			loop {
				tokio::select! {
					biased;
					interrupt = incoming.next_interrupt() => {
						cancellation.cancel();
						let _ = execution.await;
						if let Ok(interrupt) = interrupt {
							yield Ev::Aborted(Abort::Interrupted { reason: interrupt.reason });
						} else {
							yield Ev::Aborted(Abort::InputDropped);
						}
						return;
					},
					result = &mut execution => {
						yield Ev::Done(ToolTerminal::Done { result, useless: false });
						return;
					},
					update = progress.recv_async() => match update {
						Ok(update) => yield Ev::Update(update),
						Err(_) => {},
					},
				}
			}
		}
	}

	fn lift(&self, from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
		lift_legacy_call(from, call)
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, caps: &PromptCaps) -> Vec<Part> {
		match view {
			Ok(payload) => {
				let mut parts = vec![Part::Text {
					text: Str::new(serde_json::to_string(payload).expect("browser payload serializes")),
				}];
				if caps.media {
					for artifact in payload.artifacts.iter().filter(|artifact| {
						artifact.visible && artifact.byte_len != 0 && artifact.mime.starts_with("image/")
					}) {
						if let Some(hash) = artifact.uri.strip_prefix("artifact://sha256/") {
							parts.push(Part::Blob {
								blob: omp_tool::BlobRef {
									hash:       Str::new(hash),
									media_type: artifact.mime.clone(),
									byte_len:   artifact.byte_len,
								},
								alt:  Some(sf!("Browser {}", artifact.kind)),
							});
						}
					}
				}
				parts
			},
			Err(fault) => vec![Part::Text { text: fault.message.clone() }],
		}
	}
}

fn lift_legacy_call(from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
	if !from.family.is_empty() || !matches!(from.n, 1 | 2) {
		return None;
	}
	let mut raw_args = serde_json::from_slice::<Value>(call.raw_args).ok()?;
	let object = raw_args.as_object_mut()?;
	let intent = object.remove("i");
	let notrunc = object.remove("notrunc");
	let params = serde_json::from_value::<Params>(raw_args.clone()).ok()?;
	match params.action {
		Action::Run if params.code.is_none() => return None,
		Action::Close if params.code.is_some() || params.url.is_some() || params.app.is_some() => {
			return None;
		},
		_ => {},
	}
	let verdict = serde_json::from_slice::<CallOutcome<Payload, Fault>>(call.verdict).ok()?;
	let object = raw_args.as_object_mut()?;
	if let Some(intent) = intent {
		object.insert("i".to_owned(), intent);
	}
	if let Some(notrunc) = notrunc {
		object.insert("notrunc".to_owned(), notrunc);
	}
	Some(LiftedCall {
		raw_args: Bytes::from(serde_json::to_vec(&raw_args).ok()?),
		verdict:  Bytes::from(serde_json::to_vec(&verdict).ok()?),
	})
}

fn param_event(error: ParamError) -> Ev<Update, Payload, Fault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn commit_event(error: CommitError) -> Ev<Update, Payload, Fault> {
	match error {
		CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		CommitError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed browser argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  None,
		found:    Some(message),
	}
}

#[cfg(test)]
mod tests {
	use omp_core::Str;
	use omp_tool::{CallOutcome, RecordedCall, Rev};
	use serde_json::{Value, json};

	use super::{Action, Artifact, Params, Payload, lift_legacy_call, spec};

	#[test]
	fn browser_schema_keeps_only_open_run_close_code_surface() {
		let schema: Value = serde_json::from_slice(&spec().schema).expect("browser schema");
		let properties = schema["properties"].as_object().expect("object properties");
		let mut domain = properties
			.keys()
			.filter(|name| !matches!(name.as_str(), "i" | "notrunc"))
			.map(String::as_str)
			.collect::<Vec<_>>();
		domain.sort_unstable();
		assert_eq!(domain, [
			"action",
			"all",
			"app",
			"code",
			"dialogs",
			"kill",
			"name",
			"timeout",
			"url",
			"viewport",
			"wait_until",
		]);
		assert!(!properties.contains_key("operation"));
		assert!(!properties.contains_key("selector"));
		assert!(!properties.contains_key("full_page"));
		assert!(properties["action"].is_object());
		for action in ["open", "run", "close"] {
			assert!(serde_json::from_value::<Action>(json!(action)).is_ok());
		}
	}

	#[test]
	fn browser_code_schema_accepts_reference_oracle_arguments() {
		let params: Params = serde_json::from_value(json!({
			"action": "open",
			"name": "main",
			"url": "https://example.test",
			"app": {
				"path": "/Applications/Browser.app/Contents/MacOS/Browser",
				"relay": false,
				"args": ["--incognito"],
				"target": "Example"
			},
			"viewport": { "width": 1280, "height": 800, "scale": 2.0 },
			"wait_until": "networkidle2",
			"dialogs": "dismiss",
			"timeout": 10.5,
			"all": false,
			"kill": false
		}))
		.expect("reference browser arguments");
		assert_eq!(params.action, Action::Open);
		assert_eq!(params.viewport.expect("viewport").width, 1280);
	}

	#[test]
	fn browser_contract_revision_covers_lifted_runtime_and_typed_artifacts() {
		assert_eq!(spec().rev.n, 3);
		let legacy: Artifact =
			serde_json::from_value(json!("artifact://sha256/abc")).expect("legacy artifact");
		assert_eq!(legacy.uri, "artifact://sha256/abc");
		assert_eq!(legacy.mime, "image/png");
		assert_eq!(legacy.kind, "screenshot");
		let current: Artifact = serde_json::from_value(json!({
			"uri": "artifact://sha256/def",
			"mime": "application/pdf",
			"kind": "download",
			"visible": false,
			"byte_len": 42
		}))
		.expect("typed artifact");
		assert_eq!(current.kind, "download");
		assert!(!current.visible);
	}

	#[test]
	fn revision_two_calls_lift_typed_artifact_metadata() {
		let args = br#"{"i":"Capturing page","action":"run","code":"return 1"}"#;
		let payload = Payload {
			action:    Action::Run,
			name:      "main".into(),
			url:       None,
			title:     None,
			display:   Vec::new(),
			result:    Some(json!(1)),
			artifacts: vec![Artifact {
				uri:      "artifact://sha256/abc".into(),
				mime:     "image/png".into(),
				kind:     "screenshot".into(),
				visible:  true,
				byte_len: 0,
			}],
			browser:   Some("headless".into()),
		};
		let mut verdict = serde_json::to_value(CallOutcome::<Payload, super::Fault>::Ok(payload))
			.expect("verdict value");
		verdict["value"]["artifacts"] = json!(["artifact://sha256/abc"]);
		let verdict = serde_json::to_vec(&verdict).expect("legacy verdict");
		let lifted = lift_legacy_call(&Rev { family: Str::default(), n: 2 }, RecordedCall {
			raw_args: args,
			verdict:  &verdict,
		})
		.expect("lift");
		let lifted: CallOutcome<Payload, super::Fault> =
			serde_json::from_slice(&lifted.verdict).expect("typed lifted verdict");
		let CallOutcome::Ok(payload) = lifted else {
			panic!("expected ok")
		};
		assert_eq!(payload.artifacts[0].kind, "screenshot");
	}
}
