//! Direct GitHub API device with isolated worktree mutation operations.

use std::sync::Arc;

use async_stream::stream;
use async_trait::async_trait;
use futures::Stream;
use omp_core::{Str, sf};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CommitError, Constraint, Effects, Ev, ExecEffects,
	IncomingParams, LiftedCall, ParamError, Part, PromptCaps, RecordedCall, Rev, Tool, ToolSpec,
	ToolTerminal,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// GitHub operation.
///
/// The `message` is the human title a transcript card paints after the shared
/// `GitHub` prefix.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	JsonSchema,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumMessage,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Operation {
	/// Read repository metadata.
	#[strum(message = "Repo")]
	RepoView,
	/// Read a repository file.
	#[strum(message = "File")]
	FileRead,
	/// Create a pull request.
	#[strum(message = "PR Create")]
	PrCreate,
	/// Check out pull request heads into isolated worktrees.
	#[strum(message = "PR Checkout")]
	PrCheckout,
	/// Push a previously checked-out pull request branch.
	#[strum(message = "PR Push")]
	PrPush,
	/// Search issues.
	#[strum(message = "Search Issues")]
	SearchIssues,
	/// Search pull requests.
	#[strum(message = "Search PRs")]
	SearchPrs,
	/// Search code.
	#[strum(message = "Search Code")]
	SearchCode,
	/// Search commits.
	#[strum(message = "Search Commits")]
	SearchCommits,
	/// Search repositories.
	#[strum(message = "Search Repos")]
	SearchRepos,
	/// Watch Actions runs and jobs.
	#[strum(message = "Run Watch")]
	RunWatch,
}
/// Pull request selector accepted as either one value or a batch.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(untagged)]
pub enum PrSelector {
	/// One pull request number, URL, or branch name.
	One(Str),
	/// Multiple pull request numbers, URLs, or branch names.
	Many(Vec<Str>),
}

impl PrSelector {
	/// Returns the selectors as a borrowed slice.
	pub fn as_slice(&self) -> &[Str] {
		match self {
			Self::One(value) => std::slice::from_ref(value),
			Self::Many(values) => values,
		}
	}
}

/// Date field supported by GitHub issue, pull-request, and repository search.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DateField {
	/// Resource creation time.
	Created,
	/// Resource update time; repository search maps this to push time.
	Updated,
}

/// Flat GitHub operation arguments.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Params {
	/// Operation selector.
	pub op:               Operation,
	/// `[host/]owner/repo`; omitted operations resolve the current checkout.
	pub repo:             Option<Str>,
	/// Repository-relative file path.
	pub path:             Option<Str>,
	/// Branch, ref, or watched commit.
	pub branch:           Option<Str>,
	/// Pull request number, URL, or branch; arrays batch checkout.
	pub pr:               Option<PrSelector>,
	/// Search query.
	pub query:            Option<Str>,
	/// Lower date bound.
	pub since:            Option<Str>,
	/// Upper date bound.
	pub until:            Option<Str>,
	/// Search date field.
	pub date_field:       Option<DateField>,
	/// Maximum returned rows.
	pub limit:            Option<u32>,
	/// Pull request title.
	pub title:            Option<Str>,
	/// Pull request body.
	pub body:             Option<Str>,
	/// Pull request base branch.
	pub base:             Option<Str>,
	/// Pull request head branch.
	pub head:             Option<Str>,
	/// Actions run id or URL.
	pub run:              Option<Str>,
	/// Open a draft pull request.
	#[serde(default)]
	pub draft:            bool,
	/// Reset an existing local pull-request branch to the remote head.
	#[serde(default)]
	pub force:            bool,
	/// Force-with-lease a PR push.
	#[serde(default)]
	pub force_with_lease: bool,
	/// Derive the pull request title and body from the head commits; mutually
	/// exclusive with `title` and `body`.
	#[serde(default)]
	pub fill:             bool,
	/// Reviewers to request on the created pull request; `org/team` requests a
	/// team review.
	#[serde(default)]
	pub reviewer:         Vec<Str>,
	/// Users to assign to the created pull request.
	#[serde(default)]
	pub assignee:         Vec<Str>,
	/// Labels to apply to the created pull request.
	#[serde(default)]
	pub label:            Vec<Str>,
	/// Log lines retained per failed Actions job; defaults to 15, capped at 200.
	pub tail:             Option<u32>,
}

impl Params {
	/// Whether this operation mutates GitHub or local worktree state.
	pub const fn mutates(&self) -> bool {
		matches!(self.op, Operation::PrCreate | Operation::PrCheckout | Operation::PrPush)
	}
}

/// Durable reference to complete output retained outside the inline projection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Artifact {
	/// Canonical content-addressed URI.
	pub uri:        Str,
	/// Exact retained byte count.
	pub size:       u64,
	/// Media type of the retained bytes.
	pub media_type: Str,
}

/// Direct API response plus a bounded human projection and rate-limit receipt.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Payload {
	/// Completed operation.
	pub op:                   Operation,
	/// Structured operation result.
	pub result:               Value,
	/// Human-readable model and transcript projection.
	pub output:               Str,
	/// Complete output retained outside the inline projection, when applicable.
	pub artifact:             Option<Artifact>,
	/// Whether the operation produced no actionable result.
	pub useless:              bool,
	/// Remaining GitHub API requests, when reported.
	pub rate_limit_remaining: Option<u64>,
	/// Rate-limit reset Unix timestamp, when reported.
	pub rate_limit_reset:     Option<u64>,
}

/// GitHub service failure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct Fault {
	/// Stable failure category.
	pub code:                 Str,
	/// Secret-free diagnostic.
	pub message:              Str,
	/// HTTP status, when the failure came from GitHub.
	#[serde(default)]
	pub status:               Option<u16>,
	/// Remaining requests reported with an HTTP failure.
	#[serde(default)]
	pub rate_limit_remaining: Option<u64>,
	/// Rate-limit reset Unix timestamp reported with an HTTP failure.
	#[serde(default)]
	pub rate_limit_reset:     Option<u64>,
	/// Retry delay reported by GitHub, in seconds.
	#[serde(default)]
	pub retry_after_seconds:  Option<u64>,
}

impl Fault {
	/// Whether GitHub classified this failure as a primary or secondary rate
	/// limit.
	pub fn is_rate_limited(&self) -> bool {
		self.code == "github_rate_limited"
	}
}

/// Ephemeral Actions-watch state.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct Update {
	/// Operation producing the update.
	pub op:     Operation,
	/// Current normalized watch snapshot.
	pub result: Value,
	/// Human-readable current state.
	pub output: Str,
}

/// Harness-owned direct GitHub service.
#[async_trait]
pub trait GithubHost: Send + Sync + 'static {
	/// Execute one API/worktree operation.
	async fn execute(
		&self,
		params: Params,
		cancellation: CancellationToken,
		updates: flume::Sender<Update>,
	) -> Result<Payload, Fault>;
}

/// GitHub tool.
pub struct Github {
	host: Arc<dyn GithubHost>,
	spec: ToolSpec,
}

/// Creates `github@3`.
pub fn tool(host: Arc<dyn GithubHost>) -> Github {
	Github {
		host,
		spec: ToolSpec {
			name:            sf!("github"),
			rev:             Rev { family: Str::default(), n: 3 },
			description:     sf!(
				"Uses GitHub's direct API for repository, file, search, pull-request worktree, push, \
				 and Actions operations. Repository identities are [host/]owner/repo; name the host \
				 for GitHub Enterprise. `pr_create` accepts `fill`, `reviewer`, `assignee`, and \
				 `label`; `run_watch` returns the last `tail` log lines of each failed job. No gh \
				 process or commit automation is used."
			),
			schema:          omp_tool::schema::<Params>(),
			constraint:      Constraint::Schema {
				priority:       100,
				on_unsupported: omp_tool::Fallback::Unspecified,
			},
			effects:         Effects {
				documents: None,
				exec:      Some(ExecEffects { commands: Arc::from([sf!("git")]), network: true }),
				inference: None,
				desktop:   None,
				subagents: 0,
			},
			projection_code: omp_tool::native_projection_code(
				env!("CARGO_PKG_NAME"),
				env!("CARGO_PKG_VERSION"),
				include_bytes!("github.rs"),
			)
			.into(),
		},
	}
}

impl Tool for Github {
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
			let params = match incoming.whole::<Params>().await { Ok(params) => params, Err(error) => { yield param_event(error); return; } };
			if let Err(error) = incoming.interruptable().committed().await { yield commit_event(error); return; }
			let cancellation = CancellationToken::new();
			let (update_tx, update_rx) = flume::bounded(1);
			let execution = self.host.execute(params, cancellation.clone(), update_tx);
			tokio::pin!(execution);
			loop {
				tokio::select! {
					result = &mut execution => {
						let useless = result.as_ref().is_ok_and(|payload| payload.useless);
						yield Ev::Done(ToolTerminal::Done { result, useless });
						break;
					},
					update = update_rx.recv_async() => {
						if let Ok(update) = update {
							yield Ev::Update(update);
						}
					},
					interrupt = incoming.next_interrupt() => {
						cancellation.cancel();
						if let Ok(interrupt) = interrupt {
							yield Ev::Aborted(Abort::Interrupted { reason: interrupt.reason });
						} else {
							yield Ev::Aborted(Abort::InputDropped);
						}
						break;
					},
				}
			}
		}
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, _: &PromptCaps) -> Vec<Part> {
		match view {
			Ok(payload) => {
				let mut parts = vec![Part::Text { text: payload.output.clone() }];
				if let Some(artifact) = &payload.artifact
					&& artifact.media_type.starts_with("image/")
					&& let Some(hash) = artifact.uri.strip_prefix("artifact://sha256/")
				{
					parts.push(Part::Blob {
						blob: omp_tool::BlobRef {
							hash:       Str::new(hash),
							media_type: artifact.media_type.clone(),
							byte_len:   artifact.size,
						},
						alt:  payload
							.result
							.get("path")
							.and_then(Value::as_str)
							.map(Str::new),
					});
				}
				parts
			},
			Err(fault) => vec![Part::Text { text: fault.message.clone() }],
		}
	}

	fn lift(&self, _: &Rev, _: RecordedCall<'_>) -> Option<LiftedCall> {
		None
	}
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
		expected: sf!("one committed GitHub argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  None,
		found:    Some(message),
	}
}
#[cfg(test)]
mod tests {
	use omp_core::Str;
	use omp_tool::{Rev, Tool as _};
	use serde_json::json;

	use super::{DateField, Params, Payload, PrSelector, tool};

	#[test]
	fn revision_three_schema_is_the_github_wire_contract() {
		let tool = tool(std::sync::Arc::new(PanicHost));
		assert_eq!(tool.spec().rev, Rev { family: Str::default(), n: 3 });
		let schema: serde_json::Value =
			serde_json::from_slice(&tool.spec().schema).expect("GitHub schema is JSON");
		let properties = schema["properties"].as_object().expect("object properties");
		let mut domain_properties = properties
			.keys()
			.filter(|name| !matches!(name.as_str(), "i" | "notrunc"))
			.map(String::as_str)
			.collect::<Vec<_>>();
		domain_properties.sort_unstable();
		assert_eq!(domain_properties, [
			"assignee",
			"base",
			"body",
			"branch",
			"dateField",
			"draft",
			"fill",
			"force",
			"forceWithLease",
			"head",
			"label",
			"limit",
			"op",
			"path",
			"pr",
			"query",
			"repo",
			"reviewer",
			"run",
			"since",
			"tail",
			"title",
			"until",
		]);
		assert_eq!(properties["fill"]["type"], "boolean");
		assert_eq!(properties["reviewer"]["type"], "array");
		assert_eq!(properties["assignee"]["type"], "array");
		assert_eq!(properties["label"]["type"], "array");
		assert_eq!(properties["tail"]["type"], json!(["integer", "null"]));
		let required = schema["required"].as_array().expect("required fields");
		assert!(required.iter().any(|value| value == "i"));
		assert!(required.iter().any(|value| value == "op"));
	}

	struct PanicHost;

	#[async_trait::async_trait]
	impl super::GithubHost for PanicHost {
		async fn execute(
			&self,
			_: Params,
			_: tokio_util::sync::CancellationToken,
			_: flume::Sender<super::Update>,
		) -> Result<Payload, super::Fault> {
			panic!("schema test never executes the host")
		}
	}

	#[test]
	fn pr_selector_accepts_scalar_and_list_forms() {
		let scalar: Params =
			serde_json::from_value(serde_json::json!({ "op": "pr_checkout", "pr": "feature/foo" }))
				.expect("scalar selector");
		assert!(
			matches!(scalar.pr, Some(PrSelector::One(value)) if value == "feature/foo"),
			"scalar branch selector must survive schema decoding",
		);

		let list: Params = serde_json::from_value(
			serde_json::json!({ "op": "pr_checkout", "pr": ["17", "feature/foo"] }),
		)
		.expect("selector list");
		assert!(
			matches!(list.pr, Some(PrSelector::Many(values)) if values.len() == 2),
			"selector arrays must remain batch inputs",
		);
	}

	#[test]
	fn pr_metadata_and_tail_fields_deserialize() {
		let create: Params = serde_json::from_value(serde_json::json!({
			"op": "pr_create",
			"head": "feature/foo",
			"fill": true,
			"reviewer": ["alice", "org/team"],
			"assignee": ["bob"],
			"label": ["bug", "p1"],
		}))
		.expect("pr metadata fields");
		assert!(create.fill);
		assert_eq!(create.reviewer, ["alice", "org/team"]);
		assert_eq!(create.assignee, ["bob"]);
		assert_eq!(create.label, ["bug", "p1"]);
		assert_eq!(create.tail, None);

		let watch: Params =
			serde_json::from_value(serde_json::json!({ "op": "run_watch", "run": "42", "tail": 40 }))
				.expect("tail field");
		assert_eq!(watch.tail, Some(40));
		assert!(!watch.fill);
		assert!(watch.reviewer.is_empty() && watch.assignee.is_empty() && watch.label.is_empty());
	}

	#[test]
	fn older_revisions_do_not_lift_across_the_projection_change() {
		let tool = tool(std::sync::Arc::new(PanicHost));
		assert!(
			tool
				.lift(&Rev { family: Str::default(), n: 2 }, omp_tool::RecordedCall {
					raw_args: br#"{"op":"repo_view","repo":"owner/repo"}"#,
					verdict:  br#"{"kind":"ok","value":{"op":"repo_view","result":{}}}"#,
				},)
				.is_none()
		);
	}

	#[test]
	fn date_field_is_a_closed_enum() {
		let updated: Params = serde_json::from_value(
			serde_json::json!({ "op": "search_repos", "dateField": "updated" }),
		)
		.expect("updated date field");
		assert_eq!(updated.date_field, Some(DateField::Updated));
		assert!(
			serde_json::from_value::<Params>(
				serde_json::json!({ "op": "search_repos", "dateField": "pushed" }),
			)
			.is_err(),
			"undeclared date fields must fail before dispatch",
		);
	}
}
