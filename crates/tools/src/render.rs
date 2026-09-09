use std::fmt;

use omp_core::Str;
use omp_tool::{
	Part, PromptCaps, Registry, ToolIdentity,
	render::{RenderRegistry, RenderRegistryError},
};

use self::{
	agentic::GoalRenderer,
	ast::{AstEditRenderer, AstGrepRenderer},
	codeintel::{DebugRenderer, LspRenderer},
	edit::EditRenderer,
	exec::{EvalRenderer, ShellRenderer},
	fs::{ReadRenderer, WriteRenderer},
	hub::HubRenderer,
	interaction::{AskRenderer, ThinkRenderer, TodoRenderer},
	misc::{BrowserRenderer, ComputerRenderer, GithubRenderer},
	search::{GlobRenderer, GrepRenderer},
	web::WebSearchRenderer,
};

/// Native goal renderer views.
pub mod agentic;
/// Native structural search and rewrite renderer views.
pub mod ast;
/// Native LSP and debugger renderer views.
pub mod codeintel;
/// Native ask, todo, and think renderer views.
pub mod interaction;
/// Native GitHub, browser, and computer renderer views.
pub mod misc;

/// Native edit renderer views.
pub mod edit;
/// Native shell and eval renderer views.
pub mod exec;
/// Native read and write renderer views.
pub mod fs;
/// Native hub renderer views.
pub mod hub;
/// Grouped path and directory-tree rendering.
pub mod paths;
/// Native grep and glob renderer views.
pub mod search;
/// Shared line, byte, and column truncation.
pub mod truncate;
/// Typed renderer view construction and canonical serialization.
pub mod view;
/// Native web search renderer views.
pub mod web;

/// Exact production identities associated with enabled native renderer
/// implementations.
///
/// Composition supplies identities only for tools that were actually
/// registered. Renderers therefore auto-follow tool inclusion independently:
/// disabling one tool cannot suppress every unrelated renderer.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct BuiltinRendererIdentities {
	/// Identity of the native edit dialect, when enabled.
	pub edit:       Option<ToolIdentity>,
	/// Identity of the native regex search tool, when enabled.
	pub grep:       Option<ToolIdentity>,
	/// Identity of canonical web search, when enabled.
	pub web_search: Option<ToolIdentity>,
	/// Identity of the native path matching tool, when enabled.
	pub glob:       Option<ToolIdentity>,
	/// Identity of the native persistent shell, when enabled.
	pub shell:      Option<ToolIdentity>,
	/// Identity of the native coordination hub, when enabled.
	pub hub:        Option<ToolIdentity>,
	/// Identity of the native whole-file writer, when enabled.
	pub write:      Option<ToolIdentity>,
	/// Identity of the native resource reader, when enabled.
	pub read:       Option<ToolIdentity>,
	/// Identity of the native persistent evaluator, when enabled.
	pub eval:       Option<ToolIdentity>,
	/// Identity of the native structural search tool, when enabled.
	pub ast_grep:   Option<ToolIdentity>,
	/// Identity of the native structural rewrite tool, when enabled.
	pub ast_edit:   Option<ToolIdentity>,
	/// Identity of the native question picker, when enabled.
	pub ask:        Option<ToolIdentity>,
	/// Identity of the native task checklist, when enabled.
	pub todo:       Option<ToolIdentity>,
	/// Identity of the native scratchpad note, when enabled.
	pub think:      Option<ToolIdentity>,
	/// Identity of the native language-server bridge, when enabled.
	pub lsp:        Option<ToolIdentity>,
	/// Identity of the native debugger bridge, when enabled.
	pub debug:      Option<ToolIdentity>,
	/// Identity of the native durable goal regime, when enabled.
	pub goal:       Option<ToolIdentity>,
	/// Identity of the native GitHub device, when enabled.
	pub github:     Option<ToolIdentity>,
	/// Identity of the native browser device, when enabled.
	pub browser:    Option<ToolIdentity>,
	/// Identity of the native computer device, when enabled.
	pub computer:   Option<ToolIdentity>,
}

/// Registers every native renderer under the exact identities supplied by
/// production composition.
///
/// # Errors
///
/// Returns the first duplicate-identity error reported by `registry`.
pub fn register_builtin_renderers(
	registry: &mut RenderRegistry,
	identities: BuiltinRendererIdentities,
) -> Result<(), RenderRegistryError> {
	if let Some(identity) = identities.edit {
		registry.register(identity, EditRenderer)?;
	}
	if let Some(identity) = identities.grep {
		registry.register(identity, GrepRenderer)?;
	}
	if let Some(identity) = identities.web_search {
		registry.register(identity, WebSearchRenderer)?;
	}
	if let Some(identity) = identities.glob {
		registry.register(identity, GlobRenderer)?;
	}
	if let Some(identity) = identities.shell {
		registry.register(identity, ShellRenderer)?;
	}
	if let Some(identity) = identities.hub {
		registry.register(identity, HubRenderer)?;
	}
	if let Some(identity) = identities.write {
		registry.register(identity, WriteRenderer)?;
	}
	if let Some(identity) = identities.read {
		registry.register(identity, ReadRenderer)?;
	}
	if let Some(identity) = identities.eval {
		registry.register(identity, EvalRenderer)?;
	}
	if let Some(identity) = identities.ast_grep {
		registry.register(identity, AstGrepRenderer)?;
	}
	if let Some(identity) = identities.ast_edit {
		registry.register(identity, AstEditRenderer)?;
	}
	if let Some(identity) = identities.ask {
		registry.register(identity, AskRenderer)?;
	}
	if let Some(identity) = identities.todo {
		registry.register(identity, TodoRenderer)?;
	}
	if let Some(identity) = identities.think {
		registry.register(identity, ThinkRenderer)?;
	}
	if let Some(identity) = identities.lsp {
		registry.register(identity, LspRenderer)?;
	}
	if let Some(identity) = identities.debug {
		registry.register(identity, DebugRenderer)?;
	}
	if let Some(identity) = identities.goal {
		registry.register(identity, GoalRenderer)?;
	}
	if let Some(identity) = identities.github {
		registry.register(identity, GithubRenderer)?;
	}
	if let Some(identity) = identities.browser {
		registry.register(identity, BrowserRenderer)?;
	}
	if let Some(identity) = identities.computer {
		registry.register(identity, ComputerRenderer)?;
	}
	Ok(())
}
/// Builds the app-owned renderer registry for every enabled native tool.
///
/// Identities resolve from the live tool registry, so renderers auto-follow
/// tool enablement and revision selection without environment-side wiring.
///
/// # Errors
///
/// Returns the first duplicate-identity error reported by the registry.
pub fn live_renderers(tools: &Registry) -> Result<RenderRegistry, RenderRegistryError> {
	let identity = |name: &str| tools.live_spec(name).ok().map(omp_tool::ToolSpec::identity);
	let mut renderers = RenderRegistry::new();
	register_builtin_renderers(&mut renderers, BuiltinRendererIdentities {
		edit:       identity("edit"),
		grep:       identity("grep"),
		web_search: identity("web_search"),
		glob:       identity("glob"),
		shell:      identity("bash"),
		hub:        identity("hub"),
		write:      identity("write"),
		read:       identity("read"),
		eval:       identity("eval"),
		ast_grep:   identity("ast_grep"),
		ast_edit:   identity("ast_edit"),
		ask:        identity("ask"),
		todo:       identity("todo"),
		think:      identity("think"),
		lsp:        identity("lsp"),
		debug:      identity("debug"),
		goal:       identity("goal"),
		github:     identity("github"),
		browser:    identity("browser"),
		computer:   identity("computer"),
	})?;
	Ok(renderers)
}

fn live_view(name: &str, status: &str) -> view::El {
	omp_macros::view! {
		<row gap=1>
			<text bold>{name}</text>
			<text fg=muted>{status}</text>
		</row>
	}
}

fn fault_view(name: &str, message: &str) -> view::El {
	omp_macros::view! {
		<row gap=1>
			<text bold fg=err>{name}</text>
			<text fg=err>{message}</text>
		</row>
	}
}

fn debug_label(value: impl fmt::Debug) -> String {
	format!("{value:?}").to_ascii_lowercase()
}

/// Accumulates complete UTF-8 fragments for the central dispatcher.
///
/// Tool implementations never apply byte limits or synthesize truncation
/// markers. The call-outcome path bounds the resulting parts once and retains
/// the complete projection in the artifact store (ADR 0009).
pub struct TextProjection {
	text: String,
}

impl TextProjection {
	pub(crate) fn new(caps: PromptCaps) -> Option<Self> {
		(caps.maximum_parts != 0 && caps.maximum_text_bytes != 0)
			.then(|| Self { text: String::new() })
	}

	pub(crate) fn push(&mut self, fragment: &str) -> bool {
		self.text.push_str(fragment);
		true
	}

	pub(crate) fn finish(self) -> Vec<Part> {
		if self.text.is_empty() {
			Vec::new()
		} else {
			vec![Part::Text { text: Str::new(self.text) }]
		}
	}
}

#[cfg(test)]
pub(crate) mod test_support {
	//! Shared registry construction helpers for renderer tests.

	use omp_core::{Str, sf};
	use omp_tool::{Rev, ToolIdentity, render::RenderRegistry};

	use super::{BuiltinRendererIdentities, register_builtin_renderers};

	/// Mints a test identity under the shared `test` revision family.
	pub(crate) fn identity(name: &str, revision: u16) -> ToolIdentity {
		ToolIdentity { name: Str::new(name), rev: Rev { family: sf!("test"), n: revision } }
	}

	/// Full identity set covering every built-in renderer.
	pub(crate) fn identities() -> BuiltinRendererIdentities {
		BuiltinRendererIdentities {
			edit:       Some(identity("edit", 41)),
			grep:       Some(identity("grep", 42)),
			web_search: Some(identity("web_search", 48)),
			glob:       Some(identity("glob", 43)),
			shell:      Some(identity("bash", 44)),
			hub:        Some(identity("hub", 45)),
			write:      Some(identity("write", 45)),
			read:       Some(identity("read", 46)),
			eval:       Some(identity("eval", 47)),
			ast_grep:   Some(identity("ast_grep", 50)),
			ast_edit:   Some(identity("ast_edit", 51)),
			ask:        Some(identity("ask", 52)),
			todo:       Some(identity("todo", 53)),
			think:      Some(identity("think", 54)),
			lsp:        Some(identity("lsp", 55)),
			debug:      Some(identity("debug", 56)),
			goal:       Some(identity("goal", 57)),
			github:     Some(identity("github", 58)),
			browser:    Some(identity("browser", 59)),
			computer:   Some(identity("computer", 60)),
		}
	}

	/// Registers every built-in renderer and echoes the identity set.
	pub(crate) fn registry(
		identities: BuiltinRendererIdentities,
	) -> (RenderRegistry, BuiltinRendererIdentities) {
		let mut registry = RenderRegistry::new();
		register_builtin_renderers(&mut registry, identities.clone())
			.expect("unique built-in identities register");
		(registry, identities)
	}
}

#[cfg(test)]
mod tests {
	use omp_tool::{
		Claims, Precedence, Presentation, Registry,
		render::{RenderRegistry, ViewState},
	};

	use super::{
		BuiltinRendererIdentities, live_renderers, register_builtin_renderers,
		test_support::{identities, identity, registry},
	};

	#[test]
	fn registers_every_builtin_at_only_its_exact_revision() {
		let (registry, identities) = registry(identities());
		for identity in [
			identities.edit.as_ref().unwrap(),
			identities.grep.as_ref().unwrap(),
			identities.web_search.as_ref().unwrap(),
			identities.glob.as_ref().unwrap(),
			identities.shell.as_ref().unwrap(),
			identities.hub.as_ref().unwrap(),
			identities.write.as_ref().unwrap(),
			identities.read.as_ref().unwrap(),
			identities.eval.as_ref().unwrap(),
			identities.ast_grep.as_ref().unwrap(),
			identities.ast_edit.as_ref().unwrap(),
			identities.ask.as_ref().unwrap(),
			identities.todo.as_ref().unwrap(),
			identities.think.as_ref().unwrap(),
			identities.lsp.as_ref().unwrap(),
			identities.debug.as_ref().unwrap(),
			identities.goal.as_ref().unwrap(),
			identities.github.as_ref().unwrap(),
			identities.browser.as_ref().unwrap(),
			identities.computer.as_ref().unwrap(),
		] {
			assert!(
				registry
					.get(identity)
					.is_some_and(|entry| entry.identity() == identity)
			);
		}

		let wrong_revision = identity("edit", identities.edit.as_ref().unwrap().rev.n + 1);
		assert!(registry.get(&wrong_revision).is_none());
		let raw = br#"{"kind":"ok","value":{"foreign":true}}"#;
		assert_eq!(
			registry
				.view(&wrong_revision, &ViewState::new(), Some(raw))
				.expect("unknown exact revision uses generic facts")
				.as_str(),
			std::str::from_utf8(raw).expect("fixture is UTF-8"),
		);
	}

	#[test]
	fn disabled_tool_does_not_suppress_enabled_renderers() {
		let read = identity("read", 9);
		let mut registry = RenderRegistry::new();
		register_builtin_renderers(&mut registry, BuiltinRendererIdentities {
			read: Some(read.clone()),
			..Default::default()
		})
		.unwrap();
		assert!(registry.get(&read).is_some());
		assert!(registry.get(&identity("edit", 9)).is_none());
	}
	#[test]
	fn live_renderers_follow_live_tool_specs() {
		let mut tools = Registry::new();
		tools
			.register(crate::think::tool(), Presentation::Slot, Claims {
				precedence: Precedence::CORE,
				claimant:   "omp/test".into(),
				replaces:   None,
			})
			.expect("register think");

		let identity = tools.live_spec("think").expect("think is live").identity();
		let renderers = live_renderers(&tools).expect("build live renderer registry");
		assert_eq!(renderers.resolve_name("think"), Some(&identity));
		assert!(renderers.resolve_name("grep").is_none());
	}
}
