//! Conventional commit command over the shared driver generation service.

use std::{env, fs};

use miette::{IntoDiagnostic as _, miette};
use omp_driver::commit::{CommitGenerator, CommitRequest};
use omp_envd::vcs::git::{
	diff::{DiffOptions, GitDiff},
	mutation::{CommitOptions, GitMutation, GitMutationConsumer, PushOptions},
	query::GitQuery,
	repo,
};
use tokio::io::{AsyncWriteExt as _, stdout};
use tokio_util::sync::CancellationToken;

use crate::cli::CommitCliArgs;

/// Generates one conventional message from the index, then commits it when not
/// running in preview mode.
pub(crate) async fn run(args: CommitCliArgs) -> miette::Result<()> {
	let cwd = fs::canonicalize(env::current_dir().into_diagnostic()?).into_diagnostic()?;
	let repository = repo::discover(&cwd)
		.await
		.into_diagnostic()?
		.ok_or_else(|| miette!("not a git repository"))?;
	let cwd = repository.worktree_root.clone();
	let cancel = CancellationToken::new();
	let diff = GitDiff::new();
	let mutation = GitMutation::new(repository, GitMutationConsumer::InteractiveGit);
	let mut staged = diff
		.raw(&cwd, DiffOptions { cached: true, ..Default::default() }, &[], &cancel)
		.await
		.into_diagnostic()?;
	if staged.is_empty() {
		if args.dry_run {
			return Err(miette!("no staged changes to analyze"));
		}
		mutation.stage_all(&cancel).await.into_diagnostic()?;
		staged = diff
			.raw(&cwd, DiffOptions { cached: true, ..Default::default() }, &[], &cancel)
			.await
			.into_diagnostic()?;
	}
	if staged.is_empty() {
		return Err(miette!("no staged changes to analyze"));
	}
	let staged = String::from_utf8_lossy(&staged);
	let recent_subjects = GitQuery::new()
		.log_subjects(&cwd, 10, &cancel)
		.await
		.unwrap_or_default();
	let data_dir = omp_core::dirs::data_dir(None).into_diagnostic()?;
	let generator = CommitGenerator::production(&data_dir, &cwd, args.model.as_deref())
		.await
		.into_diagnostic()?;
	let generated = generator
		.generate(CommitRequest {
			staged_diff:     staged.as_ref(),
			recent_subjects: &recent_subjects,
			amend_base:      None,
		})
		.await
		.into_diagnostic()?;
	let message = if generated.body.is_empty() {
		generated.summary.to_string()
	} else {
		format!("{}\n\n{}", generated.summary, generated.body)
	};

	if args.dry_run {
		let mut output = stdout();
		output
			.write_all(message.as_bytes())
			.await
			.into_diagnostic()?;
		output.write_all(b"\n").await.into_diagnostic()?;
		output.flush().await.into_diagnostic()?;
		return Ok(());
	}

	mutation
		.create_commit(message.as_bytes(), CommitOptions::default(), &cancel)
		.await
		.into_diagnostic()?;
	if args.push {
		mutation
			.push("origin", &["HEAD"], PushOptions::default(), &cancel)
			.await
			.into_diagnostic()?;
	}
	Ok(())
}
