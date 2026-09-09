//! Extension registration on the public Director, Component, and tool surfaces.
//!
//! Extensions never receive a second durable state channel. Behaviors that
//! keep control across turns register a [`Director`], journal-derived state
//! registers a [`Component`], and executable declarations continue through the
//! versioned tool-device path.

use omp_dom::{Dom, Op};
use omp_journal::{Entry, Kind};
use omp_session::{Component, ComponentRegistry};
use omp_tool::ToolSpec;
use thiserror::Error;

use crate::{Director, DirectorRegistry, Up};

/// Failure from a live extension Component reducer.
#[derive(Clone, Copy, Debug, Error)]
pub enum LiveComponentError {
	/// The external reducer failed, timed out, or returned malformed operations.
	#[error("live extension Component callback failed")]
	Callback,
}

/// Reducer invoked only for newly appended live entries.
///
/// Returned operations are journaled as `patch@1`; replay never invokes this
/// trait and applies the durable patch directly.
pub trait LiveComponent: Send + Sync {
	/// Stable component identity used in patch labels.
	fn id(&self) -> &str;
	/// Returns whether this reducer consumes `kind`.
	fn interested(&self, kind: &Kind) -> bool;
	/// Produces ordinary ADR 0003 DOM operations.
	fn reduce(&self, entry: &Entry, dom: &Dom) -> Result<Vec<Op>, LiveComponentError>;
}

/// Sending half of the kernel's single upward mailbox.
pub type KernelSender = flume::Sender<Up>;

/// Engine registrations installed for one extension generation.
pub struct InstalledExtensions {
	/// Director identities available for explicit lifecycle engagement.
	pub director_ids: Vec<omp_core::Str>,
	/// Declarations forwarded to the existing versioned device path.
	pub tool_specs:   Vec<ToolSpec>,
}

/// Registrations admitted for one authenticated extension generation.
///
/// The registrar is deliberately narrow: there is no custom journal kind,
/// restore callback, mutable session map, or extension-owned state store.
#[derive(Default)]
pub struct ExtensionRegistrar {
	directors:  Vec<Box<dyn Director>>,
	components: Vec<Box<dyn Component>>,
	tool_specs: Vec<ToolSpec>,
}

impl ExtensionRegistrar {
	/// Creates an empty registrar.
	#[must_use]
	pub const fn new() -> Self {
		Self { directors: Vec::new(), components: Vec::new(), tool_specs: Vec::new() }
	}

	/// Registers behavior that participates in inference and yield lifecycle.
	pub fn director(&mut self, director: Box<dyn Director>) {
		self.directors.push(director);
	}

	/// Registers a pure journal-to-DOM state reducer.
	pub fn component(&mut self, component: Box<dyn Component>) {
		self.components.push(component);
	}

	/// Registers a declaration for the existing versioned device path.
	pub fn tool_spec(&mut self, spec: ToolSpec) {
		self.tool_specs.push(spec);
	}

	/// Installs lifecycle and state registrations into the engine registries.
	pub fn install(
		self,
		directors: &mut DirectorRegistry,
		components: &mut ComponentRegistry,
	) -> InstalledExtensions {
		let director_ids = self
			.directors
			.iter()
			.map(|director| omp_core::Str::new(director.id()))
			.collect();
		for director in self.directors {
			directors.register_extension(director);
		}
		for component in self.components {
			components.register_boxed(component);
		}
		InstalledExtensions { director_ids, tool_specs: self.tool_specs }
	}

	/// Returns the number of registered lifecycle behaviors.
	#[must_use]
	pub fn director_count(&self) -> usize {
		self.directors.len()
	}

	/// Returns the number of registered state reducers.
	#[must_use]
	pub fn component_count(&self) -> usize {
		self.components.len()
	}

	/// Returns the registered tool declarations in deterministic declaration
	/// order.
	#[must_use]
	pub fn tool_specs(&self) -> &[ToolSpec] {
		&self.tool_specs
	}
}

#[cfg(test)]
mod tests {
	use omp_core::Str;
	use omp_dom::{NodeSpec, Tag};
	use omp_journal::{Entry, Kind};
	use omp_session::{Component, ComponentRegistry, Draft};

	use super::ExtensionRegistrar;
	use crate::{Director, DirectorRegistry, Verdict};

	struct ContinueDirector;

	impl Director for ContinueDirector {
		fn id(&self) -> &'static str {
			"extension-test"
		}

		fn on_yield(&self, _: &crate::DirectorCx<'_>, _: &crate::TurnView) -> Verdict {
			Verdict::Continue { reminder: None }
		}
	}

	struct ExtState;

	impl Component for ExtState {
		fn interested(&self, kind: &Kind) -> bool {
			kind.name.as_str() == "turn.start"
		}

		fn apply(&mut self, _: &Entry, dom: &omp_dom::Dom, draft: &mut Draft) {
			let meta = dom.meta();
			draft.insert(
				meta,
				dom.children(meta).last().copied(),
				NodeSpec::new(Tag::Custom(Str::new_static("ext-state"))),
			);
		}
	}

	#[test]
	fn extensions_register_only_directors_components_and_tools() {
		let mut registrar = ExtensionRegistrar::new();
		registrar.director(Box::new(ContinueDirector));
		registrar.component(Box::new(ExtState));
		assert_eq!(registrar.director_count(), 1);
		assert_eq!(registrar.component_count(), 1);
		assert!(registrar.tool_specs().is_empty());

		let mut directors = DirectorRegistry::standard();
		let mut components = ComponentRegistry::standard();
		let installed = registrar.install(&mut directors, &mut components);
		assert_eq!(installed.director_ids, ["extension-test"]);
		assert!(installed.tool_specs.is_empty());
	}
}
