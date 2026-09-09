use omp_dom::{Dom, Handle, NodeSpec, Op, PropKey, Value};
use omp_journal::{Entry, Kind};

use crate::components::{
	con::ConComponent,
	directors::DirectorsComponent,
	jobs::JobsComponent,
	lifecycle::{
		Checkpoint, DeferredActivation, PlanMode, SessionTransitions, ToolRoster, TurnCounter,
	},
	prompts::PromptsComponent,
	todo::TodoComponent,
};

/// A pure journal-to-DOM reducer for one durable session concern.
///
/// Implementations may inspect the current DOM and stage operations in
/// [`Draft`], but must not retain authoritative state outside the DOM.
pub trait Component: Send {
	/// Returns whether this component consumes `kind`.
	fn interested(&self, kind: &Kind) -> bool;

	/// Stages this entry's deterministic DOM changes.
	fn apply(&mut self, entry: &Entry, dom: &Dom, draft: &mut Draft);
}

/// Ordered set of component reducers applied after the built-in body fold.
pub struct ComponentRegistry {
	components: Vec<Box<dyn Component>>,
}

impl Default for ComponentRegistry {
	fn default() -> Self {
		Self::standard()
	}
}

impl ComponentRegistry {
	/// Creates an empty registry.
	#[must_use]
	pub const fn new() -> Self {
		Self { components: Vec::new() }
	}

	/// Creates a registry containing the standard session components.
	#[must_use]
	pub fn standard() -> Self {
		let mut registry = Self::new();
		registry.register(TodoComponent);
		registry.register(JobsComponent);
		registry.register(PromptsComponent);
		registry.register(DirectorsComponent);
		registry.register(ConComponent);
		registry.register(Checkpoint);
		registry.register(PlanMode);
		registry.register(ToolRoster);
		registry.register(DeferredActivation);
		registry.register(TurnCounter);
		registry.register(SessionTransitions);
		registry
	}

	/// Appends a component to the deterministic fold order.
	pub fn register<C>(&mut self, component: C)
	where
		C: Component + 'static,
	{
		self.components.push(Box::new(component));
	}

	/// Appends a type-erased extension component to the deterministic fold
	/// order.
	pub fn register_boxed(&mut self, component: Box<dyn Component>) {
		self.components.push(component);
	}

	pub(crate) fn iter_mut(&mut self) -> impl Iterator<Item = &mut Box<dyn Component>> {
		self.components.iter_mut()
	}
}

/// Operations staged by components for one atomic transaction.
#[derive(Default)]
pub struct Draft {
	ops: Vec<Op>,
}

impl Draft {
	/// Creates an empty component draft.
	#[must_use]
	pub const fn new() -> Self {
		Self { ops: Vec::new() }
	}

	/// Returns whether no operation has been staged.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.ops.is_empty()
	}

	/// Stages one raw DOM operation.
	pub fn push(&mut self, op: Op) {
		self.ops.push(op);
	}

	/// Stages insertion of one node.
	pub fn insert(&mut self, parent: Handle, after: Option<Handle>, node: NodeSpec) {
		self.push(Op::Ins { parent, after, node });
	}

	/// Stages removal of a node and its subtree.
	pub fn remove(&mut self, handle: Handle) {
		self.push(Op::Rm(handle));
	}

	/// Stages a property update.
	pub fn set(&mut self, handle: Handle, prop: PropKey, value: Value) {
		self.push(Op::Set { h: handle, prop, value });
	}

	/// Stages relocation of an existing subtree.
	pub fn move_after(&mut self, handle: Handle, parent: Handle, after: Option<Handle>) {
		self.push(Op::Mv { h: handle, parent, after });
	}

	/// Consumes the draft and returns its ordered operations.
	#[must_use]
	pub fn into_ops(self) -> Vec<Op> {
		self.ops
	}
}
