//! Native renderer lifecycle fixtures used by the visual QA gallery.

use omp_core::Str;
use omp_tool::{Rev, ToolIdentity};

use crate::BuiltinRendererIdentities;

/// One native renderer's synthetic lifecycle inputs for visual QA.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RendererGalleryFixture {
	/// Exact production-compatible renderer identity.
	pub identity:        ToolIdentity,
	/// Partial argument JSON prefix folded for the streaming state, exactly as
	/// a provider would have emitted it mid-generation. Empty skips the fold.
	pub streaming_args:  &'static str,
	/// Committed argument JSON folded before updates and outcomes. Empty skips
	/// the fold.
	pub args:            &'static str,
	/// Serialized typed progress update, when this renderer streams updates.
	pub progress_update: Option<&'static [u8]>,
	/// Serialized typed successful tool outcome.
	pub success_outcome: &'static [u8],
	/// Serialized typed faulted tool outcome.
	pub error_outcome:   &'static [u8],
}

/// Complete native renderer gallery fixture set and its registration keys.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BuiltinRendererGallery {
	/// Exact identities passed through production renderer registration.
	pub identities: BuiltinRendererIdentities,
	/// One four-state fixture contract for each registered renderer.
	pub fixtures:   Vec<RendererGalleryFixture>,
}

/// Builds the complete native renderer fixture contract.
///
/// Serialized values use the production update and durable outcome wire
/// formats. Dispatching them through the native render registry validates every
/// fixture against its renderer's typed fold.
pub fn builtin_renderer_gallery() -> BuiltinRendererGallery {
	const fn identity(name: &'static str, family: &'static str) -> ToolIdentity {
		ToolIdentity {
			name: Str::new_static(name),
			rev:  Rev { family: Str::new_static(family), n: 1 },
		}
	}

	let edit = identity("edit", "hl");
	let grep = identity("grep", "");
	let web_search = identity("web_search", "");
	let glob = identity("glob", "");
	let shell = identity("bash", "");
	let hub = identity("hub", "");
	let write = identity("write", "");
	let read = identity("read", "");
	let eval = identity("eval", "");
	let ast_grep = identity("ast_grep", "");
	let ast_edit = identity("ast_edit", "");
	let ask = identity("ask", "");
	let todo = identity("todo", "");
	let think = identity("think", "");
	let lsp = identity("lsp", "");
	let debug = identity("debug", "");
	let goal = identity("goal", "");
	let github =
		ToolIdentity { name: Str::new_static("github"), rev: Rev { family: Str::default(), n: 3 } };
	let browser = identity("browser", "");
	let computer = identity("computer", "");
	let identities = BuiltinRendererIdentities {
		edit:       Some(edit.clone()),
		grep:       Some(grep.clone()),
		web_search: Some(web_search.clone()),
		glob:       Some(glob.clone()),
		shell:      Some(shell.clone()),
		hub:        Some(hub.clone()),
		write:      Some(write.clone()),
		read:       Some(read.clone()),
		eval:       Some(eval.clone()),
		ast_grep:   Some(ast_grep.clone()),
		ast_edit:   Some(ast_edit.clone()),
		ask:        Some(ask.clone()),
		todo:       Some(todo.clone()),
		think:      Some(think.clone()),
		lsp:        Some(lsp.clone()),
		debug:      Some(debug.clone()),
		goal:       Some(goal.clone()),
		github:     Some(github.clone()),
		browser:    Some(browser.clone()),
		computer:   Some(computer.clone()),
	};
	let fixtures = [
		crate::render::edit::gallery_fixtures(edit),
		crate::render::fs::gallery_fixtures(write, read),
		crate::render::search::gallery_fixtures(grep, glob),
		crate::render::exec::gallery_fixtures(shell, eval),
		crate::render::web::gallery_fixtures(web_search),
		crate::render::hub::gallery_fixtures(hub),
		crate::render::ast::gallery_fixtures(ast_grep, ast_edit),
		crate::render::interaction::gallery_fixtures(ask, todo, think),
		crate::render::codeintel::gallery_fixtures(lsp, debug),
		crate::render::agentic::gallery_fixtures(goal),
		crate::render::misc::gallery_fixtures(github, browser, computer),
	]
	.concat();
	BuiltinRendererGallery { identities, fixtures }
}
#[cfg(test)]
mod tests {
	use std::collections::BTreeSet;

	use bytes::Bytes;
	use omp_tool::render::{RenderRegistry, ViewState};

	use super::builtin_renderer_gallery;
	use crate::register_builtin_renderers;

	#[test]
	fn fixtures_cover_every_registered_renderer_and_decode_all_states() {
		let gallery = builtin_renderer_gallery();
		let fixture_identities = gallery
			.fixtures
			.iter()
			.map(|fixture| fixture.identity.clone())
			.collect::<BTreeSet<_>>();
		let mut registry = RenderRegistry::new();
		register_builtin_renderers(&mut registry, gallery.identities).unwrap();
		let registry_identities = registry.identities().cloned().collect::<BTreeSet<_>>();
		assert_eq!(fixture_identities, registry_identities);

		for fixture in &gallery.fixtures {
			let mut fold = ViewState::new();
			registry.view(&fixture.identity, &fold, None).unwrap();
			if let Some(update) = fixture.progress_update {
				registry
					.fold(&fixture.identity, &mut fold, Bytes::from_static(update))
					.unwrap();
			}
			registry.view(&fixture.identity, &fold, None).unwrap();
			registry
				.view(&fixture.identity, &fold, Some(fixture.success_outcome))
				.unwrap();
			registry
				.view(&fixture.identity, &fold, Some(fixture.error_outcome))
				.unwrap();
		}
	}
}
