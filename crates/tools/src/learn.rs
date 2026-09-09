//! Durable lesson capture with optional managed-skill publication.

use std::sync::Arc;

use async_stream::stream;
use futures::Stream;
use omp_core::{Str, StrMut, sf};
use omp_memory::MemoryRuntime;
use omp_tool::{
	ArgIssue, ArgIssueKind, CommitError, Constraint, DocEffects, Effects, Ev, IncomingParams,
	ParamError, Part, PromptCaps, Rev, Tool, ToolSpec, ToolTerminal,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::manage_skill::{
	Action, AuthorityError, ManagedSkillAuthority, MutationOutcome, MutationRequest,
};

const DESCRIPTION: &str = "Capture one durable, self-contained lesson in active Mnemopi memory. \
                           Optionally create or update an isolated managed skill in the same \
                           call. The lesson remains stored when an authored skill shadows only \
                           the optional skill mutation.";

/// Optional managed-skill mutation bundled with a lesson.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SkillInput {
	/// Create or update. Delete is not accepted by `learn`.
	pub action:      LearnSkillAction,
	/// Kebab-case managed-skill name.
	pub name:        Str,
	/// Prompt-safe one-line use-case description.
	pub description: Str,
	/// Markdown body without frontmatter.
	pub body:        Str,
}

/// Skill actions accepted inside `learn`.
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
pub enum LearnSkillAction {
	/// Exclusively create a new managed skill.
	Create,
	/// Replace an existing managed skill.
	Update,
}

impl From<LearnSkillAction> for Action {
	fn from(action: LearnSkillAction) -> Self {
		match action {
			LearnSkillAction::Create => Self::Create,
			LearnSkillAction::Update => Self::Update,
		}
	}
}

/// Arguments accepted by `learn@1`.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Durable, self-contained lesson: what worked, when, and why.
	pub memory:  Str,
	/// Optional source context retained as lesson metadata.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub context: Option<Str>,
	/// Optional generated-skill create/update.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub skill:   Option<SkillInput>,
}

/// Result of the optional skill side of learning.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SkillOutcome {
	/// No skill mutation was requested.
	NotRequested,
	/// Managed skill was created or updated and the inventory refreshed.
	Published {
		/// Environment mutation receipt.
		mutation: MutationOutcome,
	},
	/// Lesson succeeded but an authored skill owns the requested name.
	AuthoredShadow {
		/// Normalized requested name when valid.
		name: Str,
	},
}

/// Durable learn receipt.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub struct LearnOutcome {
	/// Mnemopi memory identity.
	pub memory_id: Str,
	/// Optional skill-side outcome.
	pub skill:     SkillOutcome,
	/// Whether the lesson succeeded while only the optional skill was refused.
	pub partial:   bool,
}

/// Learn does not stream progress.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Update {}

/// Typed learn failure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
	/// Lesson was empty.
	#[error("lesson is empty")]
	InvalidInput,
	/// Active Mnemopi did not durably store the lesson.
	#[error("Mnemopi did not store the lesson")]
	Memory,
	/// Lesson was stored, but the optional skill mutation failed.
	#[error("lesson was stored, but managed skill publication failed")]
	SkillAfterMemory {
		/// Durable lesson identity proving partial success.
		memory_id: Str,
		/// Typed managed-skill failure.
		#[source]
		source:    AuthorityError,
	},
}

/// Revisioned learn executor.
pub struct LearnTool<A> {
	memory:    Arc<MemoryRuntime>,
	authority: Arc<A>,
	spec:      ToolSpec,
}

/// Builds the host-free `learn@1` declaration.
pub fn spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("learn"),
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
			include_bytes!("learn.rs"),
		)
		.into(),
	}
}

/// Creates `learn@1` over one active Mnemopi runtime and managed-skill
/// authority.
pub fn tool<A: ManagedSkillAuthority>(
	memory: Arc<MemoryRuntime>,
	authority: Arc<A>,
) -> LearnTool<A> {
	LearnTool { memory, authority, spec: spec() }
}

impl<A: ManagedSkillAuthority> Tool for LearnTool<A> {
	type Fault = Fault;
	type Params = Params;
	type Payload = LearnOutcome;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Update, LearnOutcome, Fault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<Params>().await {
				Ok(value) => value,
				Err(error) => { yield param_event(error); return; },
			};
			let lesson = params.memory.trim();
			if lesson.is_empty() {
				yield done(Err(Fault::InvalidInput));
				return;
			}
			if let Err(error) = incoming.interruptable().committed().await {
				yield commit_event(error);
				return;
			}
			let memory_id = if let Ok(outcome) = self.memory.save(
				lesson.as_str(),
				"coding-agent-learn",
				0.8,
				params.context.as_deref(),
			) { if let Some(id) = outcome.id { id } else { yield done(Err(Fault::Memory)); return; } } else { yield done(Err(Fault::Memory)); return; };
			let Some(skill) = params.skill else {
				yield done(Ok(LearnOutcome {
					memory_id,
					skill: SkillOutcome::NotRequested,
					partial: false,
				}));
				return;
			};
			let action = Action::from(skill.action);
			match self.authority.mutate(MutationRequest {
				action,
				name: skill.name.as_str(),
				description: Some(skill.description.as_str()),
				body: Some(skill.body.as_str()),
			}) {
				Ok(mutation) => yield done(Ok(LearnOutcome {
					memory_id,
					skill: SkillOutcome::Published { mutation },
					partial: false,
				})),
				Err(AuthorityError::AuthoredShadow) => yield done(Ok(LearnOutcome {
					memory_id,
					skill: SkillOutcome::AuthoredShadow { name: skill.name.trim().to_ascii_lowercase().into() },
					partial: true,
				})),
				Err(source) => yield done(Err(Fault::SkillAfterMemory { memory_id, source })),
			}
		}
	}

	fn prompt(&self, view: Result<&LearnOutcome, &Fault>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Text {
			text: match view {
				Ok(outcome) => render_outcome(outcome),
				Err(fault) => Str::new(fault.to_string()),
			},
		}]
	}
}

fn render_outcome(outcome: &LearnOutcome) -> Str {
	let mut text = StrMut::new("Lesson stored as memory://");
	text.push_str(outcome.memory_id.as_str());
	match &outcome.skill {
		SkillOutcome::NotRequested => text.push('.'),
		SkillOutcome::Published { mutation } => {
			text.push_str(". Managed skill \"");
			text.push_str(mutation.name.as_str());
			text.push_str("\" published and registry refreshed.");
		},
		SkillOutcome::AuthoredShadow { name } => {
			text.push_str(". Did not create managed skill \"");
			text.push_str(name.as_str());
			text.push_str("\": an authored skill owns that name.");
		},
	}
	text.freeze()
}

const fn done(result: Result<LearnOutcome, Fault>) -> Ev<Update, LearnOutcome, Fault> {
	Ev::Done(ToolTerminal::Done { result, useless: false })
}

fn param_event(error: ParamError) -> Ev<Update, LearnOutcome, Fault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(omp_tool::Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn commit_event(error: CommitError) -> Ev<Update, LearnOutcome, Fault> {
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
