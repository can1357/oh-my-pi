//! End-to-end contracts for the schema-derived `dyn` builtin.

use std::{collections::BTreeMap, fs, sync::Arc};

use omp_core::Str;
use omp_shell::{
	ProfileLoadBehavior, RcLoadBehavior, Shell, SourceInfo, builtins::default_builtins,
	extensions::DefaultShellExtensions,
};
use omp_shell_builtins::{
	DynCallOutput, DynDevice, DynFault, DynFuture, DynHost, DynOutput, DynSchema, dyn_builtin,
	extract_image_passthrough,
};
use omp_tool::{Diag, DiagKind};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture-pixels";

#[derive(Clone)]
struct FakeHost {
	devices: Arc<[DynDevice]>,
	schemas: Arc<BTreeMap<Str, DynSchema>>,
	calls:   Arc<Mutex<Vec<(Str, Value)>>>,
}

impl FakeHost {
	fn fixture() -> Self {
		let schema = json!({
			"type": "object",
			"properties": {
				"mode": {
					"type": "string",
					"enum": ["fast", "safe"],
					"description": "Execution mode."
				},
				"count": {
					"type": "integer",
					"description": "Number of passes."
				},
				"settings": {
					"type": "object",
					"properties": {
						"label": {
							"type": "string",
							"description": "Nested label."
						},
						"enabled": { "type": "boolean" }
					},
					"required": ["label"]
				}
			},
			"required": ["mode", "settings"]
		});
		let fixture = DynSchema {
			name: Str::new_static("fixture/run"),
			description: Some(Str::new_static("Run the fixture operation.")),
			schema,
		};
		let fault = DynSchema {
			name:        Str::new_static("fixture/fault"),
			description: Some(Str::new_static("Always fails.")),
			schema:      json!({ "type": "object", "properties": {} }),
		};
		let image = DynSchema {
			name:        Str::new_static("fixture/image"),
			description: Some(Str::new_static("Returns a caption and an image.")),
			schema:      json!({ "type": "object", "properties": {} }),
		};
		let schemas = BTreeMap::from([
			(fixture.name.clone(), fixture),
			(fault.name.clone(), fault),
			(image.name.clone(), image),
		]);
		Self {
			devices: Arc::from([
				DynDevice {
					name:        Str::new_static("github/list_issues"),
					description: Some(Str::new_static("List repository issues.")),
				},
				DynDevice {
					name:        Str::new_static("github/create_issue"),
					description: Some(Str::new_static("Create a repository issue.")),
				},
				DynDevice {
					name:        Str::new_static("fixture/run"),
					description: Some(Str::new_static("Run the fixture operation.")),
				},
			]),
			schemas: Arc::new(schemas),
			calls:   Arc::new(Mutex::new(Vec::new())),
		}
	}
}

impl DynHost for FakeHost {
	fn list(&self) -> DynFuture<'_, Vec<DynDevice>> {
		let devices = Vec::from(&*self.devices);
		Box::pin(async move { Ok(devices) })
	}

	fn schema(&self, name: &str) -> DynFuture<'_, DynSchema> {
		let schema = self.schemas.get(name).cloned();
		let name = Str::new(name);
		Box::pin(
			async move { schema.ok_or_else(|| DynFault::new(format!("unknown device `{name}`"))) },
		)
	}

	fn call(
		&self,
		name: &str,
		args: Value,
		_cancel: CancellationToken,
	) -> DynFuture<'_, DynCallOutput> {
		let name = Str::new(name);
		let calls = Arc::clone(&self.calls);
		Box::pin(async move {
			if name == "fixture/fault" {
				return Err(DynFault::new("fixture rejected the request"));
			}
			if name == "fixture/image" {
				return Ok(DynOutput::Parts(vec![
					DynOutput::Text(Str::new_static("rendered")),
					DynOutput::Blob { mime: Str::new_static("image/png"), bytes: PNG.into() },
				])
				.into());
			}
			calls.lock().push((name, args.clone()));
			Ok(DynCallOutput {
				output: DynOutput::Json(args),
				diags:  vec![Diag::info(DiagKind::Snapshot, "not stdout")],
			})
		})
	}
}

async fn run(host: FakeHost, root: &std::path::Path, command: &str) -> (u8, String, String) {
	let mut shell = Shell::<DefaultShellExtensions>::builder()
		.profile(ProfileLoadBehavior::Skip)
		.rc(RcLoadBehavior::Skip)
		.working_dir(root.to_path_buf())
		.builtins(default_builtins())
		.builtin("dyn", dyn_builtin(Arc::new(host)))
		.build()
		.await
		.expect("build shell");
	let params = shell.default_exec_params();
	let script = format!("{command} > stdout.txt 2> stderr.txt");
	let result = shell
		.run_string(script, &SourceInfo::from("<dyn-test>"), &params)
		.await
		.expect("run dyn command");
	let _ = shell.on_exit().await;
	let stdout = fs::read_to_string(root.join("stdout.txt")).unwrap_or_default();
	let stderr = fs::read_to_string(root.join("stderr.txt")).unwrap_or_default();
	(u8::from(result.exit_code), stdout, stderr)
}

#[tokio::test]
async fn dyn_help_is_synthesized_from_required_enum_and_nested_schema() {
	let root = tempfile::tempdir().expect("tempdir");
	let (exit, stdout, stderr) =
		run(FakeHost::fixture(), root.path(), "dyn fixture/run --help").await;
	assert_eq!(exit, 0);
	assert!(stderr.is_empty());
	assert_eq!(
		stdout,
		"fixture/run — Run the fixture operation.\n\nUsage:\n  dyn fixture/run <mode> [OPTIONS] \
		 [@FILE] [-]\n\nArguments:\n  <mode> {fast|safe}  Execution mode.\n\nOptions:\n  --mode \
		 {fast|safe}  Execution mode.  (required)\n  --count <INTEGER>  Number of passes.\n  \
		 --settings.label <STRING>  Nested label.  (required)\n  --settings.enabled / \
		 --no-settings.enabled\n  -j, --json <JSON>  Merge one raw JSON object.\n  @FILE          \
		 \x20  Merge a JSON object from FILE, or bind its text to the next argument.\n  -          \
		 \x20      Same as @FILE, read from stdin.\n  -h, --help        Show this help.\n"
	);
}

#[tokio::test]
async fn dyn_positional_literal_binds_the_first_required_scalar() {
	let root = tempfile::tempdir().expect("tempdir");
	let host = FakeHost::fixture();
	let calls = Arc::clone(&host.calls);
	let (exit, stdout, stderr) =
		run(host, root.path(), "dyn fixture/run safe --settings.label lit").await;
	assert_eq!(exit, 0);
	assert!(stderr.is_empty());
	assert_eq!(
		serde_json::from_str::<Value>(stdout.trim()).expect("JSON stdout"),
		json!({ "mode": "safe", "settings": { "label": "lit" } })
	);
	assert_eq!(calls.lock().len(), 1);

	let (exit, stdout, stderr) =
		run(FakeHost::fixture(), root.path(), "dyn fixture/run safe extra").await;
	assert_eq!(exit, 2);
	assert!(stdout.is_empty());
	assert!(stderr.starts_with("dyn: unexpected argument `extra`"));
}

#[tokio::test]
async fn dyn_image_output_is_graphics_passthrough_beside_text() {
	let root = tempfile::tempdir().expect("tempdir");
	let (exit, stdout, stderr) = run(FakeHost::fixture(), root.path(), "dyn fixture/image").await;
	assert_eq!(exit, 0);
	assert!(stderr.is_empty());
	let (text, images) = extract_image_passthrough(stdout.as_bytes());
	assert_eq!(text, b"rendered\n\n");
	assert_eq!(images.len(), 1);
	assert_eq!(images[0].mime.as_str(), "image/png");
	assert_eq!(&images[0].bytes[..], PNG);
}

#[tokio::test]
async fn dyn_at_file_and_stdin_merge_json_arguments_with_typed_flags() {
	let root = tempfile::tempdir().expect("tempdir");
	fs::write(
		root.path().join("args.json"),
		r#"{"mode":"safe","settings":{"label":"from-source"}}"#,
	)
	.expect("write args fixture");
	let host = FakeHost::fixture();
	let calls = Arc::clone(&host.calls);
	let (exit, stdout, stderr) =
		run(host, root.path(), "dyn fixture/run @args.json --count 3 --settings.enabled").await;
	assert_eq!(exit, 0);
	assert!(stderr.is_empty());
	assert_eq!(
		serde_json::from_str::<Value>(stdout.trim()).expect("JSON stdout"),
		json!({
			"mode": "safe",
			"count": 3,
			"settings": { "label": "from-source", "enabled": true }
		})
	);
	assert_eq!(calls.lock().len(), 1);

	let host = FakeHost::fixture();
	let (exit, stdout, stderr) = run(host, root.path(), "dyn fixture/run - < args.json").await;
	assert_eq!(exit, 0);
	assert!(stderr.is_empty());
	assert_eq!(
		serde_json::from_str::<Value>(stdout.trim()).expect("JSON stdout"),
		json!({ "mode": "safe", "settings": { "label": "from-source" } })
	);
}

#[tokio::test]
async fn dyn_search_ranks_exact_and_fuzzy_names_before_descriptions() {
	let root = tempfile::tempdir().expect("tempdir");
	let (exit, stdout, stderr) = run(FakeHost::fixture(), root.path(), "dyn --q list_issues").await;
	assert_eq!(exit, 0);
	assert!(stderr.is_empty());
	assert!(stdout.starts_with("github/list_issues — List repository issues.\n"));

	let (exit, stdout, stderr) = run(FakeHost::fixture(), root.path(), "dyn --q list_issus").await;
	assert_eq!(exit, 0);
	assert!(stderr.is_empty());
	assert!(stdout.starts_with("github/list_issues — List repository issues.\n"));
}

#[tokio::test]
async fn dyn_fault_writes_stderr_and_returns_nonzero() {
	let root = tempfile::tempdir().expect("tempdir");
	let (exit, stdout, stderr) = run(FakeHost::fixture(), root.path(), "dyn fixture/fault").await;
	assert_eq!(exit, 1);
	assert!(stdout.is_empty());
	assert_eq!(stderr, "dyn: fixture rejected the request\n");
}
