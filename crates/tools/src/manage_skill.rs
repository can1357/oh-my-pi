//! Revisioned create, update, and delete operations for isolated managed
//! skills.

use std::sync::Arc;

use async_stream::stream;
use futures::Stream;
use omp_core::{Str, StrMut, sf};
use omp_tool::{
	ArgIssue, ArgIssueKind, CommitError, Constraint, DocEffects, Effects, Ev, IncomingParams,
	ParamError, Part, PromptCaps, Rev, Tool, ToolSpec, ToolTerminal,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

const DESCRIPTION: &str = "Create, update, or delete a reusable generated skill in the isolated \
                           managed-skills root. Create and update require both description and \
                           body. Managed skills never override authored skills.";

/// Managed skill mutation action.
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
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Action {
	/// Exclusively create a new managed skill.
	Create,
	/// Atomically replace an existing managed skill.
	Update,
	/// Delete an existing managed skill directory.
	Delete,
}

/// Arguments accepted by `manage_skill@1`.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Mutation action.
	pub action:      Action,
	/// Kebab-case skill name.
	pub name:        Str,
	/// Prompt-safe one-line use-case description. Required for create/update.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description: Option<Str>,
	/// Markdown body without frontmatter. Required for create/update.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub body:        Option<Str>,
}

/// Borrowed request delivered to the Environment-owned managed-skill authority.
#[derive(Clone, Copy, Debug)]
pub struct MutationRequest<'a> {
	/// Mutation action.
	pub action:      Action,
	/// Raw model-supplied name; the authority normalizes and validates it.
	pub name:        &'a str,
	/// Description for create/update.
	pub description: Option<&'a str>,
	/// Markdown body for create/update.
	pub body:        Option<&'a str>,
}

/// Durable managed-skill mutation receipt.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct MutationOutcome {
	/// Completed action.
	pub action:   Action,
	/// Normalized managed-skill name.
	pub name:     Str,
	/// Path relative to the isolated managed root.
	pub path:     Str,
	/// Monotonic inventory revision after refresh.
	pub revision: u64,
}

/// Typed refusal from the Environment managed-skill authority.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthorityError {
	/// Name did not match the managed allowlist.
	#[error("managed skill name is invalid")]
	InvalidName,
	/// Description was empty or unsafe after sanitization.
	#[error("managed skill description is invalid")]
	InvalidDescription,
	/// Body was empty.
	#[error("managed skill body is empty")]
	EmptyBody,
	/// Complete UTF-8 file exceeded 64 KiB.
	#[error("managed skill exceeds the 64 KiB limit")]
	TooLarge,
	/// An authored skill already owns this name.
	#[error("an authored skill already owns this name")]
	AuthoredShadow,
	/// Exclusive create found an existing managed skill.
	#[error("managed skill already exists")]
	AlreadyExists,
	/// Update/delete could not find the named managed skill.
	#[error("managed skill does not exist")]
	NotFound,
	/// Root, directory, symlink, hardlink, or regular-file checks failed.
	#[error("managed skill path failed containment or link safety checks")]
	UnsafePath,
	/// Environment filesystem publication failed.
	#[error("managed skill filesystem mutation failed")]
	Io,
}

/// Narrow Environment authority used by both `manage_skill` and `learn`.
pub trait ManagedSkillAuthority: Send + Sync + 'static {
	/// Commits one serialized per-name mutation and refreshes the managed
	/// inventory.
	fn mutate(&self, request: MutationRequest<'_>) -> Result<MutationOutcome, AuthorityError>;
}

/// Managed skill operations do not stream progress.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Update {}

/// Typed tool failure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
	/// Environment authority rejected or failed the mutation.
	#[error("managed skill mutation failed")]
	Authority {
		/// Typed authority refusal.
		#[source]
		source: AuthorityError,
	},
}

/// Revisioned managed-skill executor.
pub struct ManageSkillTool<A> {
	authority: Arc<A>,
	spec:      ToolSpec,
}

/// Builds the host-free `manage_skill@1` declaration.
pub fn spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("manage_skill"),
		rev:             Rev { family: Str::default(), n: 1 },
		description:     sf!(DESCRIPTION),
		schema:          omp_tool::schema::<Params>(),
		constraint:      Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects:         Effects {
			documents: Some(DocEffects {
				read:        true,
				write_globs: [sf!("managed-skills/**")].into_iter().collect(),
			}),
			..Effects::empty()
		},
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("manage_skill.rs"),
		)
		.into(),
	}
}

/// Creates `manage_skill@1` over Environment-owned publication authority.
pub fn tool<A: ManagedSkillAuthority>(authority: Arc<A>) -> ManageSkillTool<A> {
	ManageSkillTool { authority, spec: spec() }
}

impl<A: ManagedSkillAuthority> Tool for ManageSkillTool<A> {
	type Fault = Fault;
	type Params = Params;
	type Payload = MutationOutcome;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Update, MutationOutcome, Fault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<Params>().await {
				Ok(value) => value,
				Err(error) => { yield param_event(error); return; },
			};
			let fields_valid = match params.action {
				Action::Create | Action::Update => params.description.is_some() && params.body.is_some(),
				Action::Delete => true,
			};
			if !fields_valid {
				yield Ev::Args(cross_field_issue());
				return;
			}
			if let Err(error) = incoming.interruptable().committed().await {
				yield commit_event(error);
				return;
			}
			let result = self.authority.mutate(MutationRequest {
				action: params.action,
				name: params.name.as_str(),
				description: params.description.as_deref(),
				body: params.body.as_deref(),
			}).map_err(|source| Fault::Authority { source });
			yield done(result);
		}
	}

	fn prompt(&self, view: Result<&MutationOutcome, &Fault>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Text {
			text: match view {
				Ok(outcome) => render_outcome(outcome),
				Err(fault) => Str::new(fault.to_string()),
			},
		}]
	}
}

fn render_outcome(outcome: &MutationOutcome) -> Str {
	let mut text = StrMut::new("");
	match outcome.action {
		Action::Create => text.push_str("Created managed skill \""),
		Action::Update => text.push_str("Updated managed skill \""),
		Action::Delete => text.push_str("Deleted managed skill \""),
	}
	text.push_str(outcome.name.as_str());
	text.push_str("\" (managed-skills/");
	text.push_str(outcome.path.as_str());
	text.push_str("). Registry refreshed.");
	text.freeze()
}

const fn done(result: Result<MutationOutcome, Fault>) -> Ev<Update, MutationOutcome, Fault> {
	Ev::Done(ToolTerminal::Done { result, useless: false })
}

fn param_event(error: ParamError) -> Ev<Update, MutationOutcome, Fault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(omp_tool::Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn commit_event(error: CommitError) -> Ev<Update, MutationOutcome, Fault> {
	match error {
		CommitError::Aborted => Ev::Aborted(omp_tool::Abort::InputDropped),
		CommitError::Interrupted(interrupt) => {
			Ev::Aborted(omp_tool::Abort::Interrupted { reason: interrupt.reason })
		},
		CommitError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed JSON argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  None,
		found:    Some(message),
	}
}
fn cross_field_issue() -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("description and body for create/update; name only for delete"),
		kind:     ArgIssueKind::Malformed,
		example:  None,
		found:    None,
	}
}
