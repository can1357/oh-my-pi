//! Native tool identities and versioned custom-tool registration.

use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use omp_core::Str;
use omp_inference::call::{
	OpaqueJson, ToolDefinition, ToolGrammar, ToolGrammarSyntax, ToolInputConstraint,
};
use omp_proto::thread::v1::{Item, item, part};
use omp_tool::{Claims, Constraint, GrammarSyntax, Presentation, Registry, RegistryError, Tool};
use thiserror::Error;
use tokio::{task, time};

/// Converts one native SDK tool into its provider-neutral inference
/// declaration.
///
/// Execution remains owned by the versioned [`Registry`]; this adapter exposes
/// only immutable model-facing metadata and never a provider or credential
/// handle.
pub fn custom_tool_to_definition<T: Tool>(
	tool: &T,
) -> Result<ToolDefinition, CustomToolDefinitionError> {
	let spec = tool.spec();
	let schema = serde_json::from_slice(&spec.schema)
		.map_err(|source| CustomToolDefinitionError::Schema { tool: spec.name.clone(), source })?;
	let input = match &spec.constraint {
		Constraint::None => {
			ToolInputConstraint::JsonSchema { parameters: OpaqueJson::new(schema), strict: false }
		},
		Constraint::Schema { .. } => {
			ToolInputConstraint::JsonSchema { parameters: OpaqueJson::new(schema), strict: true }
		},
		Constraint::Grammar { syntax, definition, .. } => {
			let syntax = match syntax {
				GrammarSyntax::Lark => ToolGrammarSyntax::Lark,
				GrammarSyntax::Regex => ToolGrammarSyntax::Regex,
				GrammarSyntax::Ebnf => ToolGrammarSyntax::Ebnf,
			};
			ToolInputConstraint::Grammar {
				grammar:  ToolGrammar { syntax, definition: definition.clone() },
				fallback: OpaqueJson::new(schema),
			}
		},
	};
	Ok(ToolDefinition {
		name: spec.name.clone(),
		description: Some(spec.description.clone()),
		input,
	})
}

/// A malformed model-facing declaration supplied by a custom SDK tool.
#[derive(Debug, Error)]
pub enum CustomToolDefinitionError {
	/// The tool's declared JSON Schema is not one complete JSON value.
	#[error("custom tool {tool} has an invalid JSON Schema")]
	Schema {
		/// Tool whose declaration was rejected.
		tool:   Str,
		/// Typed JSON parser failure.
		#[source]
		source: serde_json::Error,
	},
}

/// Credential-blind source state for one detached auto-learn capture.
#[derive(Clone, Debug)]
pub struct AutoLearnCaptureSnapshot {
	/// Stable model selector, never a live provider session.
	pub model: Str,
	/// Detached transcript copy with provider replay payloads removed.
	pub items: Arc<[Item]>,
}

impl AutoLearnCaptureSnapshot {
	/// Detaches transcript state and strips provider-owned replay metadata.
	pub fn detached(model: impl Into<Str>, items: impl IntoIterator<Item = Item>) -> Self {
		Self { model: model.into(), items: items.into_iter().map(strip_provider_state).collect() }
	}
}

/// One private auto-learn turn supplied to an SDK capture executor.
#[derive(Clone, Debug)]
pub struct AutoLearnCaptureRequest {
	/// Synthetic capture instruction, attributed to the agent rather than user.
	pub content:  Str,
	/// Credential-blind source snapshot.
	pub snapshot: AutoLearnCaptureSnapshot,
}

/// Failure reported by an embedding host's private capture executor.
#[derive(Clone, Debug, Error)]
#[error("detached auto-learn capture failed")]
pub struct AutoLearnCaptureError;

type AutoLearnCaptureFuture =
	Pin<Box<dyn Future<Output = Result<(), AutoLearnCaptureError>> + Send + 'static>>;

/// Cold callback boundary that creates and runs one private capture agent.
///
/// The callback receives no journal, credential authority, provider session,
/// or cache-key handle. Embedders resolve those at execution time and must keep
/// the private turn out of the source session's journal.
pub trait AutoLearnCaptureExecutor: Send + Sync + 'static {
	/// Runs one detached private capture turn.
	fn execute(&self, request: AutoLearnCaptureRequest) -> AutoLearnCaptureFuture;
}

impl<F, Fut> AutoLearnCaptureExecutor for F
where
	F: Fn(AutoLearnCaptureRequest) -> Fut + Send + Sync + 'static,
	Fut: Future<Output = Result<(), AutoLearnCaptureError>> + Send + 'static,
{
	fn execute(&self, request: AutoLearnCaptureRequest) -> AutoLearnCaptureFuture {
		Box::pin(self(request))
	}
}

/// Factory for abortable detached auto-learn capture tasks.
#[derive(Clone)]
pub struct AutoLearnCaptureRunner {
	executor: Arc<dyn AutoLearnCaptureExecutor>,
}

impl AutoLearnCaptureRunner {
	/// Binds the process-local capture executor.
	pub fn new(executor: impl AutoLearnCaptureExecutor) -> Self {
		Self { executor: Arc::new(executor) }
	}

	/// Starts one detached private capture task.
	pub fn spawn(
		&self,
		snapshot: AutoLearnCaptureSnapshot,
		content: impl Into<Str>,
	) -> AutoLearnCaptureHandle {
		let executor = Arc::clone(&self.executor);
		let request = AutoLearnCaptureRequest { content: content.into(), snapshot };
		AutoLearnCaptureHandle { task: tokio::spawn(async move { executor.execute(request).await }) }
	}
}

/// Sole-owner handle for one detached auto-learn capture.
pub struct AutoLearnCaptureHandle {
	task: task::JoinHandle<Result<(), AutoLearnCaptureError>>,
}

impl AutoLearnCaptureHandle {
	/// Cancels the private capture without affecting the source agent.
	pub fn abort(&self) {
		self.task.abort();
	}

	/// Waits within `budget`, aborting work that does not settle in time.
	pub async fn drain(mut self, budget: Duration) -> Result<(), AutoLearnCaptureDrainError> {
		match time::timeout(budget, &mut self.task).await {
			Ok(Ok(result)) => result.map_err(AutoLearnCaptureDrainError::Capture),
			Ok(Err(source)) => Err(AutoLearnCaptureDrainError::Join { source }),
			Err(_) => {
				self.task.abort();
				let _ = self.task.await;
				Err(AutoLearnCaptureDrainError::Timeout)
			},
		}
	}
}

/// Terminal result of draining one private capture task.
#[derive(Debug, Error)]
pub enum AutoLearnCaptureDrainError {
	/// The capture executor reported failure.
	#[error(transparent)]
	Capture(#[from] AutoLearnCaptureError),
	/// The detached task failed before returning an executor result.
	#[error("detached auto-learn capture task failed")]
	Join {
		/// Typed Tokio task failure.
		#[source]
		source: task::JoinError,
	},
	/// The task exceeded its bounded drain window.
	#[error("detached auto-learn capture did not settle before its drain deadline")]
	Timeout,
}

fn strip_provider_state(mut item: Item) -> Item {
	item.props = None;
	match item.kind.as_mut() {
		Some(item::Kind::Message(message)) => {
			message.parts.retain_mut(|part| match part.kind.as_mut() {
				Some(part::Kind::Thinking(thinking)) => {
					thinking.signature.clear();
					!thinking.redacted
				},
				Some(part::Kind::ServerTool(_)) => false,
				_ => true,
			});
		},
		Some(item::Kind::ToolCall(call)) => {
			call.provider_metadata = None;
		},
		Some(item::Kind::ToolResult(result)) => {
			result.provider_metadata = None;
		},
		None => {},
	}
	item
}

/// SDK composition wrapper around the versioned native registry.
///
/// The production application supplies its authority-backed registry; SDK
/// embedders can then add native custom tools without converting them to an
/// untyped compatibility definition.
pub struct ToolRegistryBuilder {
	registry: Registry,
}

impl ToolRegistryBuilder {
	/// Starts from an authority-built production registry.
	pub const fn from_production(registry: Registry) -> Self {
		Self { registry }
	}

	/// Starts an empty registry for hosts that register every authority.
	pub fn empty() -> Self {
		Self { registry: Registry::new() }
	}

	/// Registers one versioned native custom tool.
	pub fn register<T: Tool>(
		&mut self,
		tool: T,
		presentation: Presentation,
		claims: Claims,
	) -> Result<&mut Self, RegistryError> {
		self.registry.register(tool, presentation, claims)?;
		Ok(self)
	}

	/// Protects essential harness-owned names from custom shadowing.
	pub fn protect_core<I, S>(&mut self, names: I) -> &mut Self
	where
		I: IntoIterator<Item = S>,
		S: Into<Str>,
	{
		self.registry.protect_core_claims(names);
		self
	}

	/// Returns the completed versioned registry.
	pub fn finish(self) -> Registry {
		self.registry
	}
}

impl Default for ToolRegistryBuilder {
	fn default() -> Self {
		Self::empty()
	}
}
