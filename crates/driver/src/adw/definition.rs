//! Project-declared workflow files and the execution detail they carry.
//!
//! `omp-adw` owns what a workflow *means* and deliberately carries no
//! execution detail: a phase declaration says nothing about which prompt or
//! which command produces its result. That detail is what a project declares,
//! so it lives here, beside the loader that reads it, and is handed back to
//! the host at dispatch keyed by phase name.

use std::{
	io,
	path::{Path, PathBuf},
};

use omp_adw::{
	OnReject, Phase, PhaseKind, PhaseName, Requirement, Workflow, WorkflowError, WorkflowName,
};
use omp_core::{FastHashMap, Str};
use serde::Deserialize;

/// Project directory holding workflow definitions.
pub const WORKFLOW_DIR: &str = ".omp/workflows";

/// How one phase produces its result.
///
/// Parallel to [`PhaseKind`]: agent and review phases carry a prompt, code
/// phases carry an argv. The variant is resolved at load, so a dispatch never
/// discovers a phase is missing its instructions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PhaseSpec {
	/// A model turn driven by this prompt.
	Prompt {
		/// Instruction text installed as the child's turn input.
		text: Str,
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
}

/// A validated workflow and the execution detail for each of its phases.
#[derive(Debug)]
pub struct WorkflowDefinition {
	workflow: Workflow,
	specs:    FastHashMap<PhaseName, PhaseSpec>,
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
}

/// A workflow definition that could not be loaded.
#[derive(Debug, thiserror::Error)]
pub enum DefinitionError {
	/// No definition file exists for the requested name.
	#[error("no workflow named `{name}` exists under `{WORKFLOW_DIR}`")]
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
}

/// Loads `<project>/.omp/workflows/<name>.toml`.
///
/// # Errors
///
/// Returns [`DefinitionError`] when the file is absent, unreadable, malformed,
/// declares an invalid phase graph, or declares a phase without the execution
/// detail its kind requires.
pub fn load(project_root: &Path, name: &str) -> Result<WorkflowDefinition, DefinitionError> {
	let path = project_root.join(WORKFLOW_DIR).join(format!("{name}.toml"));
	if !path.is_file() {
		return Err(DefinitionError::Unknown { name: Str::new(name) });
	}
	let text = std::fs::read_to_string(&path)
		.map_err(|source| DefinitionError::Read { path: path.clone(), source })?;
	let file: FileWorkflow =
		toml::from_str(&text).map_err(|source| DefinitionError::Parse { path, source })?;
	lower(file, name)
}

/// Every workflow name declared by the project, sorted.
pub fn available(project_root: &Path) -> Vec<Str> {
	let Ok(entries) = std::fs::read_dir(project_root.join(WORKFLOW_DIR)) else {
		return Vec::new();
	};
	let mut names: Vec<Str> = entries
		.flatten()
		.filter(|entry| {
			entry
				.path()
				.extension()
				.is_some_and(|value| value == "toml")
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

fn lower(file: FileWorkflow, fallback_name: &str) -> Result<WorkflowDefinition, DefinitionError> {
	let mut phases = Vec::with_capacity(file.phase.len());
	let mut specs = FastHashMap::default();
	for declared in file.phase {
		let name = PhaseName::new(declared.name);
		let spec = match declared.kind {
			PhaseKind::Agent | PhaseKind::Review => {
				if declared.prompt.trim().is_empty() {
					return Err(DefinitionError::MissingPrompt { phase: name });
				}
				PhaseSpec::Prompt { text: declared.prompt }
			},
			PhaseKind::Code => {
				let mut argv = declared.command.into_iter();
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
	Ok(WorkflowDefinition { workflow: Workflow::new(WorkflowName::new(name), phases)?, specs })
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
	name:       Str,
	kind:       PhaseKind,
	#[serde(default)]
	depends_on: Option<Vec<Str>>,
	#[serde(default)]
	inputs:     Vec<Str>,
	#[serde(default = "retry")]
	on_reject:  OnReject,
	#[serde(default)]
	requires:   Requirement,
	#[serde(default)]
	prompt:     Str,
	#[serde(default)]
	command:    Vec<Str>,
	#[serde(default)]
	cwd:        Option<Str>,
}

/// Matches `Phase::new`, whose undeclared rejection route is a retry.
const fn retry() -> OnReject {
	OnReject::Retry
}

#[cfg(test)]
mod tests {
	use super::*;

	fn write(root: &Path, name: &str, body: &str) {
		let directory = root.join(WORKFLOW_DIR);
		std::fs::create_dir_all(&directory).expect("workflow directory");
		std::fs::write(directory.join(format!("{name}.toml")), body).expect("workflow file");
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
			Some(&PhaseSpec::Prompt { text: Str::new_static("Implement it.") })
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
}
