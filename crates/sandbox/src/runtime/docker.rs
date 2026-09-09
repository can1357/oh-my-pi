use std::{ffi::OsString, process::Command};

use omp_core::{CowBytes, Str};
use tempfile::{NamedTempFile, TempDir};
use tokio::process::Child;

use crate::{Backend, CleanupFailure, CleanupFailures, SandboxError, SandboxOperation};

/// Explicitly owned Docker preparation artifacts, released in reverse order.
pub enum DockerArtifact {
	File(Option<NamedTempFile>),
	Directory(Option<TempDir>),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ContainerState {
	Prepared,
	Active,
	Finished,
}

/// Runtime state which keeps Docker secrets and masks alive for the container.
pub struct DockerPrepared {
	backend:   Backend,
	docker:    OsString,
	name:      Str,
	artifacts: Vec<DockerArtifact>,
	state:     ContainerState,
}

impl DockerPrepared {
	pub(crate) fn new(
		backend: Backend,
		docker: OsString,
		name: OsString,
		artifacts: Vec<DockerArtifact>,
	) -> Self {
		Self {
			backend,
			docker,
			name: Str::from(name.to_string_lossy().into_owned()),
			artifacts,
			state: ContainerState::Prepared,
		}
	}

	/// Marks the interval after `docker run` starts and before it is reaped.
	pub(crate) fn mark_active(&mut self) {
		debug_assert_eq!(self.state, ContainerState::Prepared);
		self.state = ContainerState::Active;
	}

	/// Records a naturally reaped `docker run`; `--rm` owns container removal.
	pub(crate) fn mark_finished(&mut self) {
		debug_assert_eq!(self.state, ContainerState::Active);
		self.state = ContainerState::Finished;
	}

	/// Stops the Docker client from creating further state, force-removes the
	/// complete named container, and then reaps the client. Every step is
	/// attempted even when an earlier step fails.
	pub(crate) async fn terminate_and_reap(
		&mut self,
		child: &mut Child,
	) -> Result<(), SandboxError> {
		debug_assert_eq!(self.state, ContainerState::Active);
		let backend = self.backend;
		let kill = child
			.start_kill()
			.map_err(|source| SandboxError::BackendIo {
				backend,
				operation: SandboxOperation::Cleanup,
				source,
			});
		let removal = self.remove_container(backend).await;
		let reap = child
			.wait()
			.await
			.map_err(|source| SandboxError::Wait { backend, source });
		if removal.is_ok() {
			self.state = ContainerState::Finished;
		}
		kill?;
		removal?;
		reap.map(|_| ())
	}

	async fn remove_container(&self, backend: Backend) -> Result<(), SandboxError> {
		let output = tokio::process::Command::new(&self.docker)
			.args(["rm", "-f", self.name.as_str()])
			.output()
			.await
			.map_err(|source| SandboxError::BackendIo {
				backend,
				operation: SandboxOperation::Cleanup,
				source,
			})?;
		if output.status.success() {
			Ok(())
		} else {
			let mut diagnostic = output.stderr;
			diagnostic.truncate(4096);
			Err(SandboxError::BackendCommand {
				backend,
				operation: SandboxOperation::Cleanup,
				status: output.status.code(),
				diagnostic: CowBytes::from(diagnostic),
			})
		}
	}

	/// Releases any active container and every prepared artifact in LIFO order.
	pub(crate) async fn cleanup(&mut self) -> Result<(), CleanupFailures> {
		let backend = self.backend;
		let mut failures = Vec::new();
		if self.state == ContainerState::Active {
			match tokio::process::Command::new(&self.docker)
				.args(["rm", "-f", self.name.as_str()])
				.output()
				.await
			{
				Ok(output) if output.status.success() => {},
				Ok(output) => {
					let mut diagnostic = output.stderr;
					diagnostic.truncate(4096);
					failures.push(CleanupFailure::BackendCommand {
						backend,
						operation: SandboxOperation::Cleanup,
						status: output.status.code(),
						diagnostic: diagnostic.into(),
					});
				},
				Err(source) => failures.push(CleanupFailure::BackendIo {
					backend,
					operation: SandboxOperation::Cleanup,
					source,
				}),
			}
			self.state = ContainerState::Finished;
		}
		self.cleanup_artifacts(backend, &mut failures);
		if failures.is_empty() {
			Ok(())
		} else {
			Err(CleanupFailures::new(failures))
		}
	}

	fn cleanup_artifacts(&mut self, backend: Backend, failures: &mut Vec<CleanupFailure>) {
		while let Some(artifact) = self.artifacts.pop() {
			match artifact {
				DockerArtifact::File(mut file) => {
					if let Some(file) = file.take() {
						let path = file.path().to_path_buf();
						if let Err(source) = file.close() {
							failures.push(CleanupFailure::BackendPath {
								backend,
								operation: SandboxOperation::Cleanup,
								path,
								source,
							});
						}
					}
				},
				DockerArtifact::Directory(mut directory) => {
					if let Some(directory) = directory.take() {
						let path = directory.path().to_path_buf();
						if let Err(source) = directory.close() {
							failures.push(CleanupFailure::BackendPath {
								backend,
								operation: SandboxOperation::Cleanup,
								path,
								source,
							});
						}
					}
				},
			}
		}
	}
}

impl Drop for DockerPrepared {
	fn drop(&mut self) {
		if self.state == ContainerState::Active {
			let _ = Command::new(&self.docker)
				.args(["rm", "-f", self.name.as_str()])
				.status();
			self.state = ContainerState::Finished;
		}
		let mut ignored = Vec::new();
		self.cleanup_artifacts(self.backend, &mut ignored);
	}
}
