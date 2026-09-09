//! Conventional-commit generation over the production inference registry.

mod budget;
mod normalize;
mod parse;
mod scope;

use std::{
	env,
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use futures::StreamExt as _;
use omp_ai::{
	AnswerBody, Call, CallMeta, ChatEvent, ChatRequest, ContentPart, ExecutionBudget, Message,
	NegotiationPolicy, RequestId, Role, Sampling, Setting, Target,
};
use omp_catalog::ModelKey;
use omp_core::{FastHashMap, Hash32, Str, StrMut};
use parking_lot::Mutex;

use self::{budget::budget_diff, normalize::normalize_and_validate, parse::parse_completion};

const SYSTEM_PROMPT: &str =
	"You write conventional commit messages from staged Git diffs. Return one message in this \
	 exact form:\n<type>(<optional-scope>): <past-tense summary>\n\n- <past-tense detail>.\nUse \
	 only evidence in the diff. Allowed types: feat, fix, refactor, docs, test, chore, style, \
	 perf, build, ci, revert, deps, security, config, ux, release, hotfix, infra, init, merge, \
	 hack, wip. The summary must start with a past-tense verb, have no trailing period, and keep \
	 the complete first line at or below 128 bytes. Omit the scope for cross-cutting changes. Body \
	 details must be bullets and end with periods.";

/// Immutable inputs for one conventional-commit generation.
#[derive(Clone, Copy, Debug)]
pub struct CommitRequest<'a> {
	/// Complete staged diff used as the generation evidence.
	pub staged_diff:     &'a str,
	/// Newest-first commit subjects used only to adapt repository style.
	pub recent_subjects: &'a [Str],
	/// Existing first-parent message when generating an amend replacement.
	pub amend_base:      Option<&'a str>,
}

/// A normalized conventional commit ready for a commit form or `git commit`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConventionalCommit {
	/// Complete `type(scope): subject` first line.
	pub summary: Str,
	/// Zero or more normalized bullet lines separated by newlines.
	pub body:    Str,
}

/// Failure while generating or validating a conventional commit.
#[derive(Debug, thiserror::Error)]
pub enum CommitError {
	/// Production registry or credential state could not be composed.
	#[error("commit inference registry could not be composed at {data_dir:?}")]
	Registry {
		/// Durable inference state directory.
		data_dir: PathBuf,
		/// Typed production composition failure.
		#[source]
		source:   Box<crate::registry::RegistryError>,
	},
	/// The requested commit model selector could not be resolved.
	#[error("commit model selector {selector} could not be resolved")]
	ModelSelection {
		/// Exact requested selector.
		selector: Str,
		/// Typed catalog selection failure.
		#[source]
		source:   omp_catalog::SelectionError,
	},
	/// The inference registry rejected or failed the model call.
	#[error("commit inference failed for {model}")]
	Inference {
		/// Exact resolved model.
		model:  ModelKey,
		/// Typed inference failure.
		#[source]
		source: omp_ai::Error,
	},
	/// Inference completed without user-visible text.
	#[error("commit inference returned no visible text for {model}")]
	EmptyOutput {
		/// Exact resolved model.
		model: ModelKey,
	},
	/// The model output could not be repaired into a conventional commit.
	#[error("commit output is invalid: {issue}")]
	InvalidOutput {
		/// Stable validation failure category.
		issue: ValidationIssue,
	},
}

/// Stable conventional-message validation failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::AsRefStr, strum::Display)]
#[strum(serialize_all = "snake_case")]
pub enum ValidationIssue {
	/// No usable summary remained after parsing.
	EmptySummary,
	/// The summary could not be bounded without losing its verb phrase.
	SummaryTooLong,
}

/// Clone-cheap conventional-commit generator sharing one registry and cache.
#[derive(Clone)]
pub struct CommitGenerator {
	registry: omp_ai::Registry,
	model:    ModelKey,
	cache:    Arc<Mutex<FastHashMap<Hash32, ConventionalCommit>>>,
}

impl CommitGenerator {
	/// Uses one already-composed production registry and resolved model.
	pub fn new(registry: omp_ai::Registry, model: ModelKey) -> Self {
		Self { registry, model, cache: Arc::new(Mutex::new(FastHashMap::default())) }
	}

	/// Composes the ordinary production registry and resolves the commit role
	/// through exact project settings.
	pub async fn production(
		data_dir: &Path,
		project: &Path,
		model_override: Option<&str>,
	) -> Result<Self, CommitError> {
		Self::production_from_con(data_dir, project, model_override, Arc::new(omp_con::Ctx::new()))
			.await
	}

	/// Composes the production registry from an existing process console.
	pub async fn production_from_con(
		data_dir: &Path,
		project: &Path,
		model_override: Option<&str>,
		ctx: Arc<omp_con::Ctx>,
	) -> Result<Self, CommitError> {
		let home = env::var_os("HOME").map_or_else(|| project.to_owned(), Into::into);
		let model_settings = omp_catalog::settings::ModelSettings::from_con(ctx.as_ref())
			.resolve_path_scopes(project, &home);
		let catalog = crate::registry::production_catalog(data_dir).map_err(|source| {
			CommitError::Registry { data_dir: data_dir.to_owned(), source: Box::new(source) }
		})?;
		let selector = model_override.unwrap_or("@commit");
		let selected = crate::discovery::roles::resolve_role_selector(
			catalog.as_ref(),
			&model_settings,
			selector,
		)
		.map_err(|source| CommitError::ModelSelection { selector: Str::from(selector), source })?;
		let inference = crate::registry::production_inference_for_session(
			data_dir,
			Arc::new(omp_tool::Registry::new()),
			Some(project),
			crate::registry::InferenceSessionOverrides { con: Some(ctx), ..Default::default() },
		)
		.await
		.map_err(|source| CommitError::Registry {
			data_dir: data_dir.to_owned(),
			source:   Box::new(source),
		})?;
		Ok(Self::new(inference.registry, selected.model))
	}

	/// Generates, repairs, and validates one conventional commit with at most
	/// one model call.
	pub async fn generate(&self, req: CommitRequest<'_>) -> Result<ConventionalCommit, CommitError> {
		let digest = Hash32::sum(req.staged_diff.as_bytes());
		if let Some(cached) = self.cache.lock().get(&digest).cloned() {
			return Ok(cached);
		}

		let diff = budget_diff(req.staged_diff);
		let scope_hint = scope::infer_scope(req.staged_diff);
		let prompt =
			generation_prompt(&diff, req.recent_subjects, req.amend_base, scope_hint.as_deref());
		let raw = self
			.complete_auxiliary(SYSTEM_PROMPT, prompt.as_str())
			.await?;
		let parsed = parse_completion(raw.as_str());
		let commit = normalize_and_validate(parsed, req.staged_diff, scope_hint.as_deref())?;
		self.cache.lock().insert(digest, commit.clone());
		Ok(commit)
	}

	/// Runs one text-only completion through the same registry and resolved
	/// model.
	pub async fn complete_auxiliary(&self, system: &str, input: &str) -> Result<Str, CommitError> {
		let request = ChatRequest {
			messages:          Arc::from([
				text_message(Role::System, system),
				text_message(Role::User, input),
			]),
			tools:             Arc::from([]),
			hosted_tools:      Arc::from([]),
			tool_choice:       Setting::Unset,
			output:            Setting::Unset,
			reasoning:         Setting::Unset,
			verbosity:         Setting::Unset,
			cache_retention:   Setting::Unset,
			service_tier:      Setting::Unset,
			sampling:          Sampling::default(),
			max_output_tokens: Some(512),
			top_logprobs:      None,
			safety:            Arc::from([]),
			negotiation:       NegotiationPolicy::default(),
			forced_call:       None,
		};
		let meta = CallMeta {
			id:             RequestId::from(format!("commit-{}", omp_core::Ulid::generate())),
			target:         Target::Model(self.model.clone()),
			deadline:       None,
			budget:         ExecutionBudget::default(),
			session:        None,
			debug_session:  None,
			response_hooks: Default::default(),
		};
		let answer = omp_ai::router::execute_registry_call(
			self.registry.clone(),
			Call::new(meta, omp_ai::OperationCall::Chat(Arc::new(request))),
			Duration::from_secs(30),
		)
		.await
		.map_err(|source| CommitError::Inference { model: self.model.clone(), source })?;
		let AnswerBody::Chat(mut stream) = answer.body else {
			return Err(CommitError::EmptyOutput { model: self.model.clone() });
		};
		let mut output = StrMut::new("");
		while let Some(event) = stream.next().await {
			match event
				.map_err(|source| CommitError::Inference { model: self.model.clone(), source })?
			{
				ChatEvent::TextDelta { text, .. } => output.push_str(text.as_str()),
				ChatEvent::Started(_)
				| ChatEvent::BlockStarted { .. }
				| ChatEvent::ThinkingDelta { .. }
				| ChatEvent::ToolCallStarted { .. }
				| ChatEvent::ToolArgumentsDelta { .. }
				| ChatEvent::ToolCallReady { .. }
				| ChatEvent::Artifact { .. }
				| ChatEvent::Usage(_)
				| ChatEvent::WorkflowAction(_)
				| ChatEvent::WorkflowResume(_)
				| ChatEvent::WorkflowCancelled { .. }
				| ChatEvent::Completed(_) => {},
			}
		}
		if output.is_empty() {
			Err(CommitError::EmptyOutput { model: self.model.clone() })
		} else {
			Ok(output.freeze())
		}
	}
}

fn text_message(role: Role, text: &str) -> Message {
	Message {
		role,
		content: Arc::from([ContentPart::Text { text: Str::from(text), proof: None }]),
		name: None,
	}
}

fn generation_prompt(
	diff: &str,
	recent_subjects: &[Str],
	amend_base: Option<&str>,
	scope_hint: Option<&str>,
) -> Str {
	let recent = recent_subjects
		.iter()
		.take(10)
		.map(Str::as_str)
		.collect::<Vec<_>>()
		.join("\n");
	let mut prompt =
		String::with_capacity(diff.len().saturating_add(recent.len()).saturating_add(512));
	prompt.push_str("Analyze the staged diff and return only the conventional commit message.\n");
	if let Some(scope) = scope_hint {
		prompt.push_str("Dominant path-derived scope candidate: ");
		prompt.push_str(scope);
		prompt.push_str(". Use it only when it names the changed component.\n");
	} else {
		prompt.push_str(
			"No dominant path-derived scope exists; omit scope unless the diff clearly proves one.\n",
		);
	}
	if !recent.is_empty() {
		prompt.push_str("\n<recent_subjects>\n");
		prompt.push_str(&recent);
		prompt.push_str(
			"\n</recent_subjects>\nAdapt scope vocabulary and detail density, not mistakes.\n",
		);
	}
	if let Some(base) = amend_base.filter(|base| !base.trim().is_empty()) {
		prompt.push_str("\n<amend_base>\n");
		prompt.push_str(base.trim());
		prompt.push_str(
			"\n</amend_base>\nReplace this message to describe the complete amended diff.\n",
		);
	}
	prompt.push_str("\n<staged_diff>\n");
	prompt.push_str(diff);
	prompt.push_str("\n</staged_diff>");
	Str::from(prompt)
}
#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn prompt_carries_style_and_amend_context() {
		let recent = [Str::new_static("fix(parser): corrected empty input")];
		let prompt = generation_prompt(
			"diff --git a/a.rs b/a.rs",
			&recent,
			Some("fix: corrected old behavior"),
			Some("parser"),
		);
		assert!(prompt.contains("<recent_subjects>"));
		assert!(prompt.contains("fix(parser): corrected empty input"));
		assert!(prompt.contains("<amend_base>"));
		assert!(prompt.contains("Dominant path-derived scope candidate: parser"));
	}
}
