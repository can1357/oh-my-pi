//! Project-declared workflow files and the execution detail they carry.
//!
//! `omp-adw` owns what a workflow *means* and deliberately carries no
//! execution detail: a phase declaration says nothing about which prompt or
//! which command produces its result. That detail is what a project declares,
//! so it lives here, beside the loader that reads it, and is handed back to
//! the host at dispatch keyed by phase name.

use std::{
	fs, io,
	path::{Path, PathBuf},
};

use omp_adw::{
	OnReject, Phase, PhaseKind, PhaseName, Requirement, Workflow, WorkflowError, WorkflowName,
};
use omp_core::{FastHashMap, Hash32, Str};
use omp_ext::workspace_trust::inventory::{WORKFLOW_EXTENSION, WORKFLOWS_DIR};
use serde::Deserialize;

use crate::verification::{NativeVerificationError, NativeVerificationSpec};

/// How one phase produces its result.
///
/// Agent and review phases carry a prompt; code phases carry an argv or an
/// explicit native verification inventory. The variant is resolved at load, so
/// a dispatch never discovers a phase is missing its instructions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PhaseSpec {
	/// A model turn driven by this prompt.
	Prompt {
		/// Instruction text installed as the child's turn input.
		text:            Str,
		/// A delegated executor that runs the turn instead of a native OMP kernel
		/// (ADR 0052 D1, D6). `None` runs natively.
		executor:        Option<Str>,
		/// Accept the phase on its completion claim without verification
		/// evidence. When `false` (default), the phase requires verification
		/// evidence to pass (ADR 0053 O1 — unverified-by-default).
		accept_on_claim: bool,
	},
	/// A process whose exit status decides the outcome.
	Command {
		/// Executable name resolved against the project, never a path.
		binary: Str,
		/// Arguments excluding the executable.
		args:   Vec<Str>,
		/// Working directory relative to the project root.
		cwd:    Option<Str>,
	},
	/// Native deterministic checks whose retained evidence decides acceptance.
	Verification(NativeVerificationSpec),
}

/// A validated workflow and the execution detail for each of its phases.
#[derive(Debug)]
pub struct WorkflowDefinition {
	workflow: Workflow,
	specs:    FastHashMap<PhaseName, PhaseSpec>,
	digest:   Str,
}

impl WorkflowDefinition {
	/// The validated phase graph.
	#[inline]
	pub const fn workflow(&self) -> &Workflow {
		&self.workflow
	}

	/// Execution detail for one phase.
	///
	/// Total for every phase the workflow declares: [`load`] rejects a
	/// definition whose phase lacks instructions, so a dispatch never has to
	/// handle a missing spec.
	pub fn spec(&self, phase: &PhaseName<str>) -> Option<&PhaseSpec> {
		self.specs.get(phase)
	}

	/// SHA-256 digest of the workflow definition content.
	#[inline]
	pub fn digest(&self) -> &str {
		&self.digest
	}
}

/// A workflow definition that could not be loaded.
#[derive(Debug, thiserror::Error)]
pub enum DefinitionError {
	/// No definition file exists for the requested name.
	#[error("no workflow named `{name}` exists under `{WORKFLOWS_DIR}`")]
	Unknown {
		/// The requested workflow name.
		name: Str,
	},
	/// The definition file could not be read.
	#[error("workflow definition could not be read")]
	Read {
		/// The definition file.
		path:   PathBuf,
		/// The underlying filesystem failure.
		#[source]
		source: io::Error,
	},
	/// The definition file is not valid TOML, or does not match the schema.
	#[error("workflow definition is not valid")]
	Parse {
		/// The definition file.
		path:   PathBuf,
		/// The underlying deserialization failure.
		#[source]
		source: toml::de::Error,
	},
	/// The declared phase graph is invalid.
	#[error("workflow phase graph is invalid")]
	Graph(#[from] WorkflowError),
	/// A model phase declared no prompt.
	#[error("phase `{phase}` is a model phase but declares no prompt")]
	MissingPrompt {
		/// The phase missing its instruction.
		phase: PhaseName,
	},
	/// A phase named an executor that is empty, or that cannot apply to it.
	#[error("phase `{phase}` names an executor but is not a model phase, or names an empty one")]
	BadExecutor {
		/// The phase carrying the rejected executor.
		phase: PhaseName,
	},
	/// A phase named a delegated executor and also declared a posture
	/// requirement.
	#[error(
		"phase `{phase}` names an executor and declares a requirement, which a delegated executor \
		 cannot meet"
	)]
	ExecutorWithRequirement {
		/// The phase carrying both.
		phase: PhaseName,
	},
	/// A code phase declared no command.
	#[error("phase `{phase}` is a code phase but declares no command")]
	MissingCommand {
		/// The phase missing its instruction.
		phase: PhaseName,
	},
	/// A code phase named an executable by path rather than by name.
	#[error("phase `{phase}` names its executable by path, which escapes project authority")]
	CommandPath {
		/// The phase carrying the rejected executable.
		phase: PhaseName,
	},
	/// A code phase declared a working directory outside the project.
	#[error("phase `{phase}` declares a working directory outside the project")]
	CommandCwd {
		/// The phase carrying the rejected directory.
		phase: PhaseName,
	},
	/// Verification was combined with another provider or declared on a model
	/// phase.
	#[error("phase `{phase}` must declare native verification alone on a code phase")]
	VerificationConflict {
		/// The phase with incompatible execution declarations.
		phase: PhaseName,
	},
	/// The explicit native verification inventory or budgets are invalid.
	#[error("phase `{phase}` declares invalid native verification")]
	Verification {
		/// The phase with the rejected inventory.
		phase:  PhaseName,
		/// Typed native verification validation failure.
		#[source]
		source: NativeVerificationError,
	},
}

/// Loads `<project>/.omp/workflows/<name>.toml`.
///
/// # Errors
///
/// Returns [`DefinitionError`] when the file is absent, unreadable, malformed,
/// declares an invalid phase graph, or declares a phase without the execution
/// detail its kind requires.
pub fn load(project_root: &Path, name: &str) -> Result<WorkflowDefinition, DefinitionError> {
	let path = project_root
		.join(WORKFLOWS_DIR)
		.join(format!("{name}.{WORKFLOW_EXTENSION}"));
	if !path.is_file() {
		return Err(DefinitionError::Unknown { name: Str::new(name) });
	}
	let text = fs::read_to_string(&path)
		.map_err(|source| DefinitionError::Read { path: path.clone(), source })?;
	let file: FileWorkflow =
		toml::from_str(&text).map_err(|source| DefinitionError::Parse { path, source })?;
	let digest = Str::from(Hash32::sum(&text).to_hex().as_str());
	lower(file, name, digest)
}

/// Every workflow name declared by the project, sorted.
pub fn available(project_root: &Path) -> Vec<Str> {
	let Ok(entries) = fs::read_dir(project_root.join(WORKFLOWS_DIR)) else {
		return Vec::new();
	};
	let mut names: Vec<Str> = entries
		.flatten()
		.filter(|entry| {
			entry
				.path()
				.extension()
				.is_some_and(|value| value == WORKFLOW_EXTENSION)
		})
		.filter_map(|entry| {
			entry
				.path()
				.file_stem()
				.and_then(|stem| stem.to_str().map(Str::new))
		})
		.collect();
	names.sort_unstable();
	names
}

fn lower(
	file: FileWorkflow,
	fallback_name: &str,
	digest: Str,
) -> Result<WorkflowDefinition, DefinitionError> {
	let mut phases = Vec::with_capacity(file.phase.len());
	let mut specs = FastHashMap::default();
	for declared in file.phase {
		let name = PhaseName::new(declared.name);
		let spec = if let Some(verification) = declared.verification {
			if declared.kind != PhaseKind::Code
				|| declared.command.is_some()
				|| declared.cwd.is_some()
				|| declared.executor.is_some()
				|| declared.prompt.is_some()
			{
				return Err(DefinitionError::VerificationConflict { phase: name });
			}
			verification
				.validate()
				.map_err(|source| DefinitionError::Verification { phase: name.clone(), source })?;
			PhaseSpec::Verification(verification)
		} else {
			match declared.kind {
				PhaseKind::Agent | PhaseKind::Review => {
					let prompt = declared.prompt.unwrap_or_default();
					if prompt.trim().is_empty() {
						return Err(DefinitionError::MissingPrompt { phase: name });
					}
					if declared
						.executor
						.as_deref()
						.is_some_and(|id| id.trim().is_empty())
					{
						return Err(DefinitionError::BadExecutor { phase: name });
					}
					if declared.executor.is_some() && declared.requires != Requirement::default() {
						return Err(DefinitionError::ExecutorWithRequirement { phase: name });
					}
					PhaseSpec::Prompt {
						text:            prompt,
						executor:        declared.executor,
						accept_on_claim: declared.accept_on_claim,
					}
				},
				PhaseKind::Code => {
					if declared.executor.is_some() {
						return Err(DefinitionError::BadExecutor { phase: name });
					}
					let mut argv = declared.command.unwrap_or_default().into_iter();
					let Some(binary) = argv.next() else {
						return Err(DefinitionError::MissingCommand { phase: name });
					};
					if binary.bytes().any(|byte| matches!(byte, b'/' | b'\\')) {
						return Err(DefinitionError::CommandPath { phase: name });
					}
					if declared.cwd.as_deref().is_some_and(escapes_project) {
						return Err(DefinitionError::CommandCwd { phase: name });
					}
					PhaseSpec::Command { binary, args: argv.collect(), cwd: declared.cwd }
				},
			}
		};

		let mut phase = Phase::new(name.clone(), declared.kind)
			.consuming(declared.inputs.into_iter().map(PhaseName::new))
			.on_reject(declared.on_reject)
			.requiring(declared.requires);
		if let Some(names) = declared.depends_on {
			phase = phase.depending_on(names.into_iter().map(PhaseName::new));
		}
		phases.push(phase);
		specs.insert(name, spec);
	}

	let name = file
		.name
		.filter(|name| !name.is_empty())
		.unwrap_or_else(|| Str::new(fallback_name));
	Ok(WorkflowDefinition {
		workflow: Workflow::new(WorkflowName::new(name), phases)?,
		specs,
		digest,
	})
}

fn escapes_project(cwd: &str) -> bool {
	let path = Path::new(cwd);
	path.is_absolute()
		|| path
			.components()
			.any(|component| matches!(component, std::path::Component::ParentDir))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileWorkflow {
	#[serde(default)]
	name:  Option<Str>,
	#[serde(default, rename = "phase")]
	phase: Vec<FilePhase>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FilePhase {
	name:            Str,
	kind:            PhaseKind,
	#[serde(default)]
	depends_on:      Option<Vec<Str>>,
	#[serde(default)]
	inputs:          Vec<Str>,
	#[serde(default = "retry")]
	on_reject:       OnReject,
	#[serde(default)]
	requires:        Requirement,
	#[serde(default)]
	prompt:          Option<Str>,
	#[serde(default)]
	executor:        Option<Str>,
	#[serde(default)]
	accept_on_claim: bool,
	#[serde(default)]
	command:         Option<Vec<Str>>,
	#[serde(default)]
	cwd:             Option<Str>,
	#[serde(default)]
	verification:    Option<NativeVerificationSpec>,
}

/// Matches `Phase::new`, whose undeclared rejection route is a retry.
const fn retry() -> OnReject {
	OnReject::Retry
}

#[cfg(test)]
mod tests {
	use super::*;

	fn write(root: &Path, name: &str, body: &str) {
		let directory = root.join(WORKFLOWS_DIR);
		std::fs::create_dir_all(&directory).expect("workflow directory");
		std::fs::write(directory.join(format!("{name}.toml")), body).expect("workflow file");
	}

	#[test]
	fn a_model_phase_may_name_a_delegated_executor() {
		let project = tempfile::tempdir().expect("project");
		write(
			project.path(),
			"ship",
			r#"
[[phase]]
name = "build"
kind = "agent"
executor = "codex"
prompt = "Implement it."
"#,
		);
		let definition = load(project.path(), "ship").expect("definition");
		assert_eq!(
			definition.spec(PhaseName::from_ref("build")),
			Some(&PhaseSpec::Prompt {
				text:            Str::new_static("Implement it."),
				executor:        Some(Str::new_static("codex")),
				accept_on_claim: false,
			})
		);
	}

	#[test]
	fn an_executor_together_with_a_requirement_is_refused_at_load_time() {
		let project = tempfile::tempdir().expect("project");
		write(
			project.path(),
			"both",
			r#"
[[phase]]
name = "build"
kind = "agent"
executor = "codex"
requires = { write = "read-only" }
prompt = "Implement it."
"#,
		);
		assert!(matches!(
			load(project.path(), "both"),
			Err(DefinitionError::ExecutorWithRequirement { .. })
		));
	}

	#[test]
	fn an_executor_on_a_code_phase_or_an_empty_executor_is_refused() {
		let project = tempfile::tempdir().expect("project");
		write(
			project.path(),
			"on-code",
			r#"
[[phase]]
name = "test"
kind = "code"
executor = "codex"
command = ["cargo", "test"]
"#,
		);
		write(
			project.path(),
			"empty",
			r#"
[[phase]]
name = "build"
kind = "agent"
executor = " "
prompt = "Implement it."
"#,
		);
		assert!(matches!(load(project.path(), "on-code"), Err(DefinitionError::BadExecutor { .. })));
		assert!(matches!(load(project.path(), "empty"), Err(DefinitionError::BadExecutor { .. })));
	}

	#[test]
	fn loads_phases_with_implicit_serial_order_and_execution_detail() {
		let project = tempfile::tempdir().expect("project");
		write(
			project.path(),
			"ship",
			r#"
name = "ship"

[[phase]]
name = "build"
kind = "agent"
prompt = "Implement it."

[[phase]]
name = "test"
kind = "code"
command = ["cargo", "test"]

[[phase]]
name = "review"
kind = "review"
inputs = ["build"]
on_reject = "correct"
prompt = "Judge it."
"#,
		);
		let definition = load(project.path(), "ship").expect("definition");
		assert_eq!(definition.workflow().name().as_str(), "ship");
		assert_eq!(definition.workflow().phases().len(), 3);
		assert_eq!(
			definition.spec(PhaseName::from_ref("build")),
			Some(&PhaseSpec::Prompt {
				text:            Str::new_static("Implement it."),
				executor:        None,
				accept_on_claim: false,
			})
		);
		assert_eq!(
			definition.spec(PhaseName::from_ref("test")),
			Some(&PhaseSpec::Command {
				binary: Str::new_static("cargo"),
				args:   vec![Str::new_static("test")],
				cwd:    None,
			})
		);
		assert_eq!(available(project.path()), vec![Str::new_static("ship")]);
	}

	#[test]
	fn rejects_missing_instructions_and_escaping_commands() {
		let project = tempfile::tempdir().expect("project");
		write(project.path(), "no-prompt", "[[phase]]\nname = \"a\"\nkind = \"agent\"\n");
		assert!(matches!(
			load(project.path(), "no-prompt"),
			Err(DefinitionError::MissingPrompt { .. })
		));

		write(project.path(), "no-command", "[[phase]]\nname = \"a\"\nkind = \"code\"\n");
		assert!(matches!(
			load(project.path(), "no-command"),
			Err(DefinitionError::MissingCommand { .. })
		));

		write(
			project.path(),
			"absolute",
			"[[phase]]\nname = \"a\"\nkind = \"code\"\ncommand = [\"/bin/sh\"]\n",
		);
		assert!(matches!(load(project.path(), "absolute"), Err(DefinitionError::CommandPath { .. })));

		write(
			project.path(),
			"escape",
			"[[phase]]\nname = \"a\"\nkind = \"code\"\ncommand = [\"cargo\"]\ncwd = \"../out\"\n",
		);
		assert!(matches!(load(project.path(), "escape"), Err(DefinitionError::CommandCwd { .. })));

		assert!(matches!(load(project.path(), "absent"), Err(DefinitionError::Unknown { .. })));
	}

	#[test]
	fn rejects_a_cyclic_graph_rather_than_reordering_it() {
		let project = tempfile::tempdir().expect("project");
		write(
			project.path(),
			"cycle",
			r#"
[[phase]]
name = "a"
kind = "agent"
prompt = "a"
depends_on = ["b"]

[[phase]]
name = "b"
kind = "agent"
prompt = "b"
depends_on = ["a"]
"#,
		);
		assert!(matches!(
			load(project.path(), "cycle"),
			Err(DefinitionError::Graph(WorkflowError::Cycle { .. }))
		));
	}

	#[test]
	fn computes_content_digest_on_load() {
		let project = tempfile::tempdir().expect("project");
		let content = "[[phase]]\nname = \"x\"\nkind = \"agent\"\nprompt = \"do it\"\n";
		write(project.path(), "flow", content);
		let def = load(project.path(), "flow").expect("load");
		let expected = Hash32::sum(content).to_hex().to_string();
		assert_eq!(def.digest(), expected);
	}

	#[test]
	fn native_verification_is_an_explicit_code_provider_with_bounded_defaults() {
		let project = tempfile::tempdir().unwrap();
		write(
			project.path(),
			"verify",
			r#"
[[phase]]
name = "implement"
kind = "agent"
prompt = "Implement the requested change."

[[phase]]
name = "verify"
kind = "code"
inputs = ["implement"]
on_reject = "correct"
verification = { packages = ["omp-core"] }
"#,
		);
		let definition = load(project.path(), "verify").unwrap();
		let Some(PhaseSpec::Verification(spec)) = definition.spec(PhaseName::from_ref("verify"))
		else {
			panic!("explicit verification provider must be retained");
		};
		assert_eq!(spec.packages, vec![Str::new_static("omp-core")]);
		assert_eq!(spec.timeout_seconds, 900);
		assert_eq!(spec.minimum_tests, 1);
		assert_eq!(spec.max_output_bytes, 4 * 1024 * 1024);
		let phase = definition
			.workflow()
			.phases()
			.iter()
			.find(|phase| phase.name.as_str() == "verify")
			.unwrap();
		assert_eq!(phase.kind, PhaseKind::Code);
		assert_eq!(phase.on_reject, OnReject::Correct);
		assert_eq!(&phase.inputs[..], &[PhaseName::new_static("implement")]);
	}

	#[test]
	fn native_verification_refuses_model_phases_and_ambiguous_execution_fields() {
		let project = tempfile::tempdir().unwrap();
		for kind in ["agent", "review"] {
			write(
				project.path(),
				"mixed",
				&format!(
					"[[phase]]\nname = \"verify\"\nkind = \"{kind}\"\nverification = {{ packages = \
					 [\"omp-core\"] }}\n"
				),
			);
			assert!(matches!(
				load(project.path(), "mixed"),
				Err(DefinitionError::VerificationConflict { .. })
			));
		}
		for field in [
			"command = [\"just\", \"check-pkg\", \"omp-core\"]",
			"command = []",
			"cwd = \"\"",
			"executor = \"\"",
			"prompt = \"\"",
		] {
			write(
				project.path(),
				"mixed",
				&format!(
					"[[phase]]\nname = \"verify\"\nkind = \"code\"\n{field}\nverification = {{ \
					 packages = [\"omp-core\"] }}\n"
				),
			);
			assert!(
				matches!(
					load(project.path(), "mixed"),
					Err(DefinitionError::VerificationConflict { .. })
				),
				"{field}"
			);
		}
	}

	#[test]
	fn native_verification_refuses_invalid_inventory_budgets_and_unknown_fields() {
		let project = tempfile::tempdir().unwrap();
		for fields in [
			"packages = []",
			"packages = [\"omp-core\", \"omp-core\"]",
			"packages = [\"../escape\"]",
			"packages = [\"omp-core\"], timeout_seconds = 0",
			"packages = [\"omp-core\"], timeout_seconds = 1801",
			"packages = [\"omp-core\"], minimum_tests = 0",
			"packages = [\"omp-core\"], max_output_bytes = 4194305",
		] {
			write(
				project.path(),
				"invalid",
				&format!(
					"[[phase]]\nname = \"verify\"\nkind = \"code\"\nverification = {{ {fields} }}\n"
				),
			);
			assert!(
				matches!(load(project.path(), "invalid"), Err(DefinitionError::Verification { .. })),
				"{fields}"
			);
		}
		write(
			project.path(),
			"unknown",
			"[[phase]]\nname = \"verify\"\nkind = \"code\"\nverification = { packages = \
			 [\"omp-core\"], invented = true }\n",
		);
		assert!(matches!(load(project.path(), "unknown"), Err(DefinitionError::Parse { .. })));
	}
}
