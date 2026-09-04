//! Golden and tree-projection regressions for canonical prompts.

use std::{fmt::Write as _, sync::Arc};

use omp_agent::prompt::{
	BandHash, CanonicalPromptSource, PromptError, PromptOut, PromptPatchSet, SlotAssembler,
	SlotClass, SlotDecl, SlotId, SlotPatch, SlotRegistration, SlotSource,
};
use omp_core::{Hash32, Str};
use omp_dom::{KnownTag, NodeSpec, Op, PropId, PropKey, Txn, Value as DomValue};
use omp_proto::thread::v1::{Item, item, part};
use omp_scribe::{Props, canon::canonicalize_prompt};
use omp_session::{ComponentRegistry, Session};
use serde_json::{Value, value::RawValue};

#[derive(Debug)]
#[allow(dead_code, reason = "fields are serialized through Debug by insta")]
struct GoldenItem {
	index: usize,
	band:  &'static str,
	text:  String,
}

fn item_text(item: &Item) -> &str {
	let Some(item::Kind::Message(message)) = item.kind.as_ref() else {
		panic!("prompt item must be a message");
	};
	let Some(part::Kind::Text(text)) = message.parts.first().and_then(|part| part.kind.as_ref())
	else {
		panic!("prompt message must contain text");
	};
	text
}

fn session_with_facts(facts: Value) -> (tempfile::TempDir, Session) {
	let directory = tempfile::tempdir().expect("temporary session directory");
	let mut session =
		Session::create(directory.path().join("prompt.oms"), ComponentRegistry::standard())
			.expect("session fixture");
	let encoded = serde_json::to_string(&facts).expect("prompt facts JSON");
	session
		.patch(Txn {
			cause: session.head().expect("genesis"),
			label: Some(Str::new_static("prompt.fixture")),
			ops:   vec![Op::Set {
				h:     session.dom().meta(),
				prop:  PropKey::Custom(Str::new_static("prompt-facts")),
				value: DomValue::Json(RawValue::from_string(encoded).expect("raw prompt facts")),
			}],
		})
		.expect("journal prompt fixture");
	(directory, session)
}

fn snapshot(session: &Session) -> Vec<GoldenItem> {
	CanonicalPromptSource
		.system_items(session.dom())
		.expect("canonical prompt renders")
		.iter()
		.enumerate()
		.map(|(index, item)| GoldenItem {
			index,
			band: match index {
				0 => "frozen+stable",
				1..=3 => "stable",
				4 | 5 => "epochal",
				_ => "volatile",
			},
			text: canonicalize_prompt(item_text(item)),
		})
		.collect()
}

const TOOL_NAMES: [&str; 8] = ["ast_edit", "bash", "edit", "glob", "grep", "read", "task", "write"];

fn inventory(full: bool) -> String {
	let mut out = String::new();
	if full {
		out.push_str("\n## functions\n\nnamespace functions {\n");
		for name in TOOL_NAMES {
			out.push_str("\n// Golden tool declaration.\n");
			out.push_str("// Golden long-form documentation.\n");
			out.push_str("// @example path lookup\n");
			let _ = writeln!(out, "// {name}({{\"path\":\"src/lib.rs\"}})");
			const SCHEMA: &str =
				r#"{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}"#;
			let _ = writeln!(out, "type {name} = (_: {SCHEMA});");
		}
		out.push_str("\n} // namespace functions\n");
	} else {
		out.push_str("\n# Tool Inventory\n");
		for name in TOOL_NAMES {
			let _ = writeln!(out, "- `{name}`");
		}
	}
	out
}

fn full_facts(personality: &str, full: bool, codex: bool) -> Value {
	serde_json::json!({
		"vcs": { "root": "/workspace/project", "head": "main@abc123" },
		"host": {
			"os": "darwin 25.6", "distro": "", "kernel": "Darwin 25.6", "arch": "arm64",
			"cpu": "Apple M4 Max", "terminal": "kitty", "gpus": ["Apple M4 Max"]
		},
		"model": { "identifier": "openai-codex/gpt-5.6-sol", "codex_task_policy": codex },
		"repositories": [
			{
				"root_uri": "file:///workspace/project",
				"worktree_root_uri": "file:///workspace/project",
				"primary_root_uri": "file:///workspace/project",
				"head": "abc123", "branch": "main", "staged": 1, "unstaged": 2,
				"untracked": 3, "revision": 9, "truncated": false
			},
			{
				"root_uri": "file:///workspace/shared",
				"worktree_root_uri": "file:///workspace/shared",
				"primary_root_uri": "file:///workspace/shared",
				"head": "def456", "branch": "feature", "staged": 0, "unstaged": 0,
				"untracked": 0, "revision": 0, "truncated": true
			}
		],
		"roots": {
			"revision": 17,
			"primary": { "canonical_uri": "file:///workspace/project", "grant_id": [112,114,105,109,97,114,121] },
			"roots": [
				{ "canonical_uri": "file:///workspace/project", "grant_id": [112,114,105,109,97,114,121] },
				{ "canonical_uri": "file:///workspace/shared", "grant_id": [115,104,97,114,101,100] }
			]
		},
		"additional_roots": [
			{ "canonical_uri": "file:///workspace/shared", "grant_id": [115,104,97,114,101,100] }
		],
		"active_repository": { "relative_root": "nested/repository" },
		"context_files": [
			{
				"path": "AGENTS.md", "origin": "discovery://agents",
				"content": "Unique context paragraph.\n\nShared duplicate paragraph."
			},
			{
				"path": "notes.txt", "origin": "user://context",
				"content": "Second context file."
			}
		],
		"directory_context": ["nested/AGENTS.md", "nested/deeper/RULES.md"],
		"workspace_trees": [
			{
				"root_uri": "file:///workspace/project",
				"rendered": "src/\n  lib.rs\ntests/", "truncated": false
			},
			{
				"root_uri": "file:///workspace/shared",
				"rendered": "fixtures/\n", "truncated": true
			}
		],
		"skills": [
			{ "name": "react", "description": "React implementation guidance." },
			{ "name": "tla", "description": "TLA specification guidance." }
		],
		"always_apply_rules": [
			{ "name": "RULES@project", "content": "Never force-push shared branches." }
		],
		"rules": [
			{ "name": "rust", "description": "Use typed errors.", "globs": ["*.rs"] },
			{ "name": "tests", "description": "Test observable behavior.", "globs": [] }
		],
		"personality": personality,
		"render_mermaid": true,
		"include_workstation": true,
		"include_model": true,
		"include_workspace_tree": true,
		"include_skills": true,
		"secrets_enabled": true,
		"intent_field": "intent",
		"tool_inventory": inventory(full),
		"tools": TOOL_NAMES,
		"schemes": [
			{
				"name": "artifact", "readable": true, "mintable": true,
				"selectors": true, "description": "durable artifacts"
			},
			{
				"name": "skill", "readable": true, "mintable": false,
				"selectors": false, "description": "installed skills"
			}
		],
		"scheme_selectors": true,
		"computer": true,
		"device_guidance": "Use mounted dynamic devices deliberately.",
		"auto_qa_guidance": "File inconsistent tool behavior through AutoQA.",
		"delegation": {
			"enabled": true, "eager": "always", "batch": true, "concurrency": 8,
			"queued": 2, "scout_available": true, "coordination": true
		},
		"mutations": {
			"format_on_write": true, "fetch": true, "editor": true, "escalation": true
		},
		"edit_hashline": true,
		"edit_apply_patch": false,
		"edit_sloppy": false,
		"memory": {
			"memory": "<memory>Remember architecture.</memory>",
			"standing": "<standing>Preserve behavior.</standing>",
			"recall": "<recall>Current target.</recall>"
		}
	})
}

#[test]
fn canonical_prompt_full_matrix() {
	let (_, default_session) = session_with_facts(serde_json::json!({}));
	insta::assert_debug_snapshot!("canonical_default", snapshot(&default_session));

	let personalities = [
		("default", include_str!("../prompts/personality/default.md")),
		("friendly", include_str!("../prompts/personality/friendly.md")),
		("pragmatic", include_str!("../prompts/personality/pragmatic.md")),
		("none", ""),
	];
	for (name, personality) in personalities {
		for full in [false, true] {
			for codex in [false, true] {
				let (_, session) = session_with_facts(full_facts(personality, full, codex));
				let snapshot_name = format!(
					"canonical_full_{name}_{}_codex_{codex}",
					if full { "full" } else { "compact" },
				);
				insta::assert_debug_snapshot!(snapshot_name, snapshot(&session));
			}
		}
	}

	let mut overridden =
		full_facts(include_str!("../prompts/personality/friendly.md"), false, false);
	overridden["personality"] = Value::String("Golden personality override.".into());
	let (_, overridden) = session_with_facts(overridden);
	insta::assert_debug_snapshot!("canonical_personality_override", snapshot(&overridden));

	let mut custom = full_facts(include_str!("../prompts/personality/pragmatic.md"), false, true);
	custom["custom_prompt"] =
		Value::String("Custom role paragraph.\n\nShared duplicate paragraph.".into());
	let (_, custom) = session_with_facts(custom);
	insta::assert_debug_snapshot!("canonical_custom_role", snapshot(&custom));

	let mut appended = full_facts(include_str!("../prompts/personality/default.md"), false, false);
	appended["append_prompt"] = Value::String("Appended golden guidance.".into());
	let (_, appended) = session_with_facts(appended);
	insta::assert_debug_snapshot!("canonical_append_guidance", snapshot(&appended));

	let mut null = full_facts(include_str!("../prompts/personality/default.md"), false, false);
	null["null_prompt"] = Value::Bool(true);
	let (_, null) = session_with_facts(null);
	insta::assert_debug_snapshot!("canonical_null_prompt", snapshot(&null));
}

#[derive(Clone)]
struct TextSource(&'static str);

impl SlotSource for TextSource {
	fn render(
		&self,
		_dom: &omp_dom::Dom,
		_props: &Props,
		out: &mut dyn PromptOut,
	) -> Result<(), PromptError> {
		out.write_str(self.0);
		Ok(())
	}
}

fn registration(
	slot: SlotId,
	class: SlotClass,
	owner: &'static str,
	text: &'static str,
) -> SlotRegistration {
	SlotRegistration {
		decl:   SlotDecl { slot, class, owner: Str::new_static(owner), priority: 0 },
		source: Arc::new(TextSource(text)),
	}
}

#[test]
fn slot_patch_matrix() {
	let patches = PromptPatchSet::new(
		vec![
			SlotPatch::Prepend {
				slot:     SlotId::Policy,
				content:  Str::new_static("pre-"),
				priority: 2,
			},
			SlotPatch::Append {
				slot:     SlotId::Policy,
				content:  Str::new_static("-post"),
				priority: 1,
			},
			SlotPatch::Override { slot: SlotId::Workflow, content: Str::new_static("replacement") },
			SlotPatch::Elide { slot: SlotId::Recall },
		],
		PromptPatchSet::DEFAULT_MAX_BYTE_EXPANSION,
	)
	.unwrap();
	let assembler = SlotAssembler::new(vec![
		registration(SlotId::Policy, SlotClass::Stable, "policy", "base"),
		registration(SlotId::Workflow, SlotClass::Stable, "workflow", "old"),
		registration(SlotId::Recall, SlotClass::Volatile, "recall", "elided"),
	])
	.with_patches(patches);
	let dom = omp_dom::Dom::new();
	let rendered = assembler.render_banded(&dom, &Props::new()).unwrap();
	let snapshot = rendered
		.items
		.iter()
		.enumerate()
		.map(|(index, item)| GoldenItem {
			index,
			band: match index {
				0 => "stable",
				1 => "dynamic",
				_ => "volatile",
			},
			text: canonicalize_prompt(item_text(item)),
		})
		.collect::<Vec<_>>();
	assert_ne!(rendered.bands[1].as_bytes(), &[0; 32]);
	insta::assert_debug_snapshot!("slot_patch_append_prepend_override_elide", snapshot);
}

#[test]
fn todo_and_director_status_are_selected_from_component_elements() {
	let (_, mut session) = session_with_facts(serde_json::json!({}));
	let todo = session
		.dom()
		.select("meta todo")
		.unwrap()
		.next()
		.expect("todo root");
	let directors = session
		.dom()
		.select("meta directors")
		.unwrap()
		.next()
		.expect("directors root");
	session
		.patch(Txn {
			cause: session.head().expect("head"),
			label: Some(Str::new_static("prompt.components")),
			ops:   vec![
				Op::Ins {
					parent: todo,
					after:  None,
					node:   NodeSpec::new(KnownTag::Item)
						.with_prop(PropId::Status, DomValue::Str(Str::new_static("in_progress")))
						.with_content("Verify prompt projection"),
				},
				Op::Ins { parent: directors, after: None, node: NodeSpec::new(KnownTag::Director) },
			],
		})
		.expect("component fixtures");
	let text = CanonicalPromptSource
		.system_items(session.dom())
		.expect("canonical prompt renders")
		.iter()
		.map(item_text)
		.collect::<String>();
	assert!(text.contains("- Verify prompt projection [in_progress]"));
	assert!(text.contains("active directors: 1"));
}

#[test]
fn attachment_blob_refs_are_resolved_only_at_thread_projection() {
	let (_, mut session) = session_with_facts(serde_json::json!({}));
	session.begin_turn().expect("turn");
	let attachment = session
		.store_attachment("image/png", b"image")
		.expect("attachment stores");
	let blob = attachment.blob;
	assert_eq!(blob.hash, Hash32::sum(b"image"));
	session
		.user("look", vec![attachment])
		.expect("user message");
	// The tree carries the reference only; bytes join at the projection.
	let tree_only = omp_session::project_thread(session.dom());
	assert!(tree_only.iter().all(|item| match item.kind.as_ref() {
		Some(item::Kind::Message(message)) => message.parts.iter().all(|part| {
			!matches!(part.kind.as_ref(), Some(part::Kind::Blob(blob)) if !blob.inline.is_empty())
		}),
		_ => true,
	}));
	let items = omp_agent::project_thread_with_attachments(session.dom(), session.blobs())
		.expect("stored attachment resolves");
	let projected = items
		.iter()
		.find_map(|item| match item.kind.as_ref() {
			Some(item::Kind::Message(message)) => message.parts.iter().find_map(|part| {
				if let Some(part::Kind::Blob(blob)) = part.kind.as_ref() {
					Some(blob)
				} else {
					None
				}
			}),
			_ => None,
		})
		.expect("projected blob");
	assert_eq!(projected.hash.as_ref(), blob.hash.as_bytes());
	assert_eq!(projected.size, blob.size);
	assert_eq!(projected.mime, "image/png");
	assert_eq!(projected.inline.as_ref(), b"image");
}

#[test]
fn retained_snapcompact_frame_is_inlined_after_the_summary() {
	let (_, mut session) = session_with_facts(serde_json::json!({}));
	session.begin_turn().expect("turn");
	let boundary = session.user("old context", Vec::new()).expect("user");
	let summary = session
		.blobs()
		.put(b"archive summary")
		.expect("summary stores");
	let frame = session
		.store_attachment("image/png", b"snapcompact png")
		.expect("frame stores");
	session
		.compaction(omp_journal::data::Compaction {
			summary,
			boundary,
			method: Some(Str::new_static("snapcompact")),
			tokens_before: Some(100_000),
			tokens_after: Some(8_000),
			warning: None,
			frames: vec![frame],
		})
		.expect("compaction");

	let items = omp_agent::project_thread_with_attachments(session.dom(), session.blobs())
		.expect("frame resolves");
	let message = items
		.first()
		.and_then(|item| match item.kind.as_ref()? {
			item::Kind::Message(message) => Some(message),
			_ => None,
		})
		.expect("summary message");
	assert_eq!(message.parts.len(), 2);
	let frame = message.parts[1]
		.kind
		.as_ref()
		.and_then(|part| match part {
			part::Kind::Blob(blob) => Some(blob),
			_ => None,
		})
		.expect("frame blob");
	assert_eq!(frame.mime, "image/png");
	assert_eq!(frame.inline.as_ref(), b"snapcompact png");
}

#[test]
fn missing_snapcompact_frame_drops_only_the_frame_and_keeps_summary_text() {
	let (directory, mut session) = session_with_facts(serde_json::json!({}));
	session.begin_turn().expect("turn");
	let boundary = session.user("old context", Vec::new()).expect("user");
	let summary = session
		.blobs()
		.put(b"archive summary")
		.expect("summary stores");
	let missing =
		omp_journal::blob::BlobRef { hash: Hash32::sum(b"missing snapcompact frame"), size: 25 };
	session
		.compaction(omp_journal::data::Compaction {
			summary,
			boundary,
			method: Some(Str::new_static("snapcompact")),
			tokens_before: Some(100_000),
			tokens_after: Some(8_000),
			warning: None,
			frames: vec![omp_journal::data::Attachment {
				blob: missing,
				mime: Str::new_static("image/png"),
			}],
		})
		.expect("missing frame references remain replayable");
	drop(session);
	let session = Session::open(directory.path().join("prompt.oms"), ComponentRegistry::standard())
		.expect("missing frame does not prevent replay");

	let items = omp_agent::project_thread_with_attachments(session.dom(), session.blobs())
		.expect("missing archive frame has a text fallback");
	let message = items
		.first()
		.and_then(|item| match item.kind.as_ref()? {
			item::Kind::Message(message) => Some(message),
			_ => None,
		})
		.expect("summary message");
	assert_eq!(message.parts.len(), 1, "only the unavailable frame is omitted");
	assert_eq!(
		message.parts[0].kind.as_ref(),
		Some(&part::Kind::Text("archive summary".to_owned()))
	);
}

#[test]
fn live_turn_facts_are_projected_from_session_dom_into_volatile_band() {
	let (_, baseline) = session_with_facts(serde_json::json!({}));
	let (_, mut session) = session_with_facts(serde_json::json!({
		"cwd": "/work/omp",
		"date": "2026-09-02",
		"mounts": ["/work"]
	}));
	let (_, baseline_bands) = CanonicalPromptSource.banded_render(baseline.dom()).unwrap();
	session.begin_turn().expect("turn");
	let (items, bands): (_, [BandHash; 4]) =
		CanonicalPromptSource.banded_render(session.dom()).unwrap();
	let text = items.iter().map(item_text).collect::<String>();
	assert!(text.contains("turn: 1"));
	assert!(text.contains("cwd: /work/omp"));
	assert!(text.contains("date: 2026-09-02"));
	assert!(text.contains("mounts:\n- /work"));
	assert_eq!(&bands[..SlotClass::Volatile as usize], &baseline_bands[..3]);
	assert_ne!(bands[SlotClass::Volatile as usize], baseline_bands[3]);
}
