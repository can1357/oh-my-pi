//! Production persistent child-kernel runtime for workpool workers.

use std::{collections::BTreeMap, future::Future, path::PathBuf, pin::Pin, sync::Arc};

use async_trait::async_trait;
use omp_agent::{JobBoard, JobSettlement, RunControl, TurnInput, TurnStop};
use omp_core::{Str, sf};
use omp_dom::{Op, PropKey, Txn, Value};
use omp_session::components::jobs;
use omp_tool::{
	HostToolExecutor, HostToolInvocation, HostToolResult, HostToolSpec, HostToolUpdateSink,
	Registry, Rev,
};
use omp_tools::eval::{EvalSessionControl, EvalToolRegistration, EvalToolRoster};
use serde_json::Value as Json;
use tokio_util::sync::CancellationToken;

use super::{
	settings::{SV_TASK_RECURSION_DEPTH, TaskSettings, child_ctx},
	spawn::{
		SpawnError, child_session_path, configure_child_route, create_isolation, discard_isolation,
		engage_workpool_yield_ladder, finish_isolation,
	},
	workpool_scheduler::{
		SessionMutator, WorkerBatch, WorkerEvent, WorkerHandle, WorkerSpawn, WorkpoolLauncher,
		WorkpoolSchedulerError, job_handle, now_ms,
	},
	yield_assembly,
};

/// Driver-owned launcher that keeps one composed child kernel and isolated
/// workspace alive across every batch assigned to that worker.
pub struct KernelWorkpoolLauncher {
	data_dir:     PathBuf,
	sessions_dir: PathBuf,
	sessions:     Arc<crate::sessions::SessionRegistry>,
	parent:       SessionMutator,
	jobs:         Arc<JobBoard>,
	env:          omp_env::EnvClient,
	ctx:          Arc<omp_con::Ctx>,
	cfg:          Arc<dyn omp_con::CfgLoader>,
	model:        Str,
	eval:         EvalSessionControl,
	registry:     Arc<Registry>,
}

impl KernelWorkpoolLauncher {
	/// Captures the same production composition inputs as `task@1`.
	#[must_use]
	pub fn new(
		data_dir: PathBuf,
		sessions_dir: PathBuf,
		sessions: Arc<crate::sessions::SessionRegistry>,
		parent: SessionMutator,
		jobs: Arc<JobBoard>,
		env: omp_env::EnvClient,
		ctx: Arc<omp_con::Ctx>,
		cfg: Arc<dyn omp_con::CfgLoader>,
		model: Str,
		registry: Arc<Registry>,
		eval: EvalSessionControl,
	) -> Self {
		Self { data_dir, sessions_dir, sessions, parent, jobs, env, ctx, cfg, model, eval, registry }
	}

	fn forwarded_registry(
		&self,
		request: &WorkerSpawn,
		roster: &EvalToolRoster,
	) -> Result<Arc<Registry>, WorkpoolSchedulerError> {
		let base = &self.registry;
		let control = self.eval.clone();
		let names = base.live_names();
		let child = base.restrict(names.iter().map(Str::as_str));
		let registrations = roster
			.tools
			.iter()
			.cloned()
			.map(|registration| (registration.name.clone(), registration))
			.collect::<BTreeMap<_, _>>();
		let executor: Arc<dyn HostToolExecutor> = Arc::new(EvalForwardExecutor {
			owner: request.owner.clone(),
			control,
			registrations: Arc::new(registrations),
		});
		for registration in &roster.tools {
			let claimant = sf!(
				"eval/{}/{}/{}/{}/{}",
				request.owner,
				registration.generation,
				registration.name,
				registration.rev,
				registration.handler
			);
			child
				.replace_host_tools(
					claimant,
					1,
					vec![HostToolSpec {
						name:        registration.name.clone(),
						description: registration.description.clone(),
						parameters:  registration.parameters.clone(),
						rev:         Some(Rev {
							family: sf!("eval-{}-{}", registration.generation, registration.handler),
							n:      registration.rev,
						}),
					}],
					Arc::clone(&executor),
				)
				.map_err(|source| WorkpoolSchedulerError::EvalRegistry {
					id: request.id.clone(),
					source,
				})?;
		}
		Ok(Arc::new(child))
	}
}

#[derive(Clone)]
struct EvalForwardExecutor {
	owner:         Str,
	control:       EvalSessionControl,
	registrations: Arc<BTreeMap<Str, EvalToolRegistration>>,
}

impl HostToolExecutor for EvalForwardExecutor {
	fn execute(
		&self,
		invocation: HostToolInvocation,
		_updates: HostToolUpdateSink,
		cancellation: CancellationToken,
	) -> Pin<Box<dyn Future<Output = Result<HostToolResult, Str>> + Send + 'static>> {
		let owner = self.owner.clone();
		let control = self.control.clone();
		let registration = self.registrations.get(&invocation.name).cloned();
		Box::pin(async move {
			let registration = registration
				.ok_or_else(|| sf!("eval-defined tool registration is no longer available"))?;
			let result = control
				.invoke_tool(
					owner.as_str(),
					&registration,
					Json::Object(invocation.arguments),
					cancellation,
				)
				.await
				.map_err(|error| Str::new(error.to_string()))?;
			Ok(HostToolResult { result: result.value, is_error: result.is_error })
		})
	}
}

#[async_trait]
impl WorkpoolLauncher for KernelWorkpoolLauncher {
	async fn spawn(
		&self,
		request: WorkerSpawn,
		events: flume::Sender<WorkerEvent>,
	) -> Result<WorkerHandle, WorkpoolSchedulerError> {
		let settings = TaskSettings::from_con(&self.ctx);
		let depth = SV_TASK_RECURSION_DEPTH.get(&self.ctx);
		if settings.at_recursion_limit(depth) {
			return Err(WorkpoolSchedulerError::WorkerSpawn {
				id:     request.id,
				source: Arc::new(SpawnError::RecursionDepth {
					depth,
					maximum: i32::from(settings.max_recursion_depth),
				}),
			});
		}
		if settings.disabled_agents.iter().any(|disabled| {
			disabled
				.as_str()
				.eq_ignore_ascii_case(request.agent.as_str())
		}) {
			return Err(WorkpoolSchedulerError::WorkerSpawn {
				id:     request.id.clone(),
				source: Arc::new(SpawnError::DisabledAgent { agent: request.agent }),
			});
		}
		let active = self
			.jobs
			.list()
			.into_iter()
			.filter(|job| {
				job.kind == omp_agent::JobKind::Subagent
					&& matches!(job.status.as_str(), "starting" | "running")
			})
			.count();
		if settings.max_concurrency != 0 && active >= settings.max_concurrency {
			return Err(WorkpoolSchedulerError::WorkerSpawn {
				id:     request.id,
				source: Arc::new(SpawnError::Concurrency { maximum: settings.max_concurrency }),
			});
		}
		let forwarded_registry = request
			.eval_tools
			.as_deref()
			.map(|roster| self.forwarded_registry(&request, roster))
			.transpose()?;
		let (batches, batch_rx) = flume::unbounded();
		let cancel = CancellationToken::new();
		let mut cancel_guard = SpawnCancelGuard(Some(cancel.clone()));
		let (ready_tx, ready_rx) = flume::bounded(1);
		let run = KernelWorkerRun {
			data_dir: self.data_dir.clone(),
			sessions_dir: self.sessions_dir.clone(),
			sessions: Arc::clone(&self.sessions),
			env: self.env.clone(),
			ctx: Arc::clone(&self.ctx),
			cfg: Arc::clone(&self.cfg),
			model: self.model.clone(),
			forwarded_registry,
			request: request.clone(),
			batches: batch_rx,
			events,
			cancel: cancel.clone(),
			ready: ready_tx,
		};
		let (finished_tx, finished) = flume::bounded(1);
		let task = tokio::spawn(async move {
			let settlement = run_kernel_worker(run).await;
			let _ = finished_tx.send(());
			settlement
		});
		let abort = task.abort_handle();
		let worker_id = request.id.clone();
		let mutation_id = request.id.clone();
		let owner = request.owner;
		let agent = request.agent;
		let jobs = Arc::clone(&self.jobs);
		let execution_cancel = cancel.clone();
		let request_cancel = cancel.clone();
		self
			.parent
			.mutate(&cancel, move |parent| {
				if request_cancel.is_cancelled() {
					return Err(WorkpoolSchedulerError::MutationCancelled);
				}
				if job_handle(parent, mutation_id.as_str()).is_some() {
					return Err(WorkpoolSchedulerError::JobCollision { id: mutation_id });
				}
				let cause = parent
					.head()
					.ok_or(WorkpoolSchedulerError::MissingParentHead)?;
				let txn = jobs::insert(parent.dom(), cause, jobs::JobSpec {
					id: mutation_id.clone(),
					kind: Str::new_static("subagent"),
					owner,
					started: Str::new(now_ms().to_string()),
					agent: Some(agent),
				})
				.ok_or(WorkpoolSchedulerError::MissingJobs)?;
				parent.patch(txn)?;
				let handle = job_handle(parent, mutation_id.as_str())
					.ok_or(WorkpoolSchedulerError::MissingJobs)?;
				let delivered_cause = parent
					.head()
					.ok_or(WorkpoolSchedulerError::MissingParentHead)?;
				parent.patch(Txn {
					cause: delivered_cause,
					label: Some(Str::new_static("workpool.worker.internal")),
					ops:   vec![Op::Set {
						h:     handle,
						prop:  PropKey::Custom(Str::new_static(omp_agent::jobs::DELIVERED)),
						value: Value::Bool(true),
					}],
				})?;
				if !jobs.attach_task(parent.dom(), handle, execution_cancel, task) {
					return Err(WorkpoolSchedulerError::MissingJobs);
				}
				Ok(())
			})
			.await?;
		match ready_rx.recv_async().await {
			Ok(Ok(())) => {
				cancel_guard.0 = None;
				Ok(WorkerHandle { id: worker_id, batches, cancel, finished, abort })
			},
			Ok(Err(source)) => Err(WorkpoolSchedulerError::WorkerSpawn { id: worker_id, source }),
			Err(_) => Err(WorkpoolSchedulerError::WorkerExited { id: worker_id }),
		}
	}
}

struct SpawnCancelGuard(Option<CancellationToken>);

impl Drop for SpawnCancelGuard {
	fn drop(&mut self) {
		if let Some(cancel) = self.0.take() {
			cancel.cancel();
		}
	}
}

struct KernelWorkerRun {
	data_dir:           PathBuf,
	sessions_dir:       PathBuf,
	sessions:           Arc<crate::sessions::SessionRegistry>,
	env:                omp_env::EnvClient,
	ctx:                Arc<omp_con::Ctx>,
	cfg:                Arc<dyn omp_con::CfgLoader>,
	model:              Str,
	forwarded_registry: Option<Arc<Registry>>,
	request:            WorkerSpawn,
	batches:            flume::Receiver<WorkerBatch>,
	events:             flume::Sender<WorkerEvent>,
	cancel:             CancellationToken,
	ready:              flume::Sender<Result<(), Arc<SpawnError>>>,
}

async fn run_kernel_worker(run: KernelWorkerRun) -> JobSettlement {
	match run_kernel_worker_inner(&run).await {
		Ok((text, tokens_in, tokens_out, workspace, cancelled)) => {
			let cancellation_error =
				cancelled.then(|| Str::new_static("workpool worker was cancelled"));
			let output = omp_tools::task::ChildResult {
				id: run.request.id.clone(),
				agent: run.request.agent.clone(),
				text,
				description: None,
				assignment: None,
				stats: None,
				session_path: Str::new(
					child_session_path(&run.sessions_dir, &run.request.id).to_string_lossy(),
				),
				tokens_in,
				tokens_out,
				output: None,
				workspace,
				error: cancellation_error.clone(),
			};
			JobSettlement {
				status:     Str::new_static(if cancelled { "cancelled" } else { "completed" }),
				output:     serde_json::value::to_raw_value(&output).ok(),
				error:      cancellation_error,
				completion: None,
			}
		},
		Err(source) => {
			let source = Arc::new(source);
			let _ = run.ready.send(Err(Arc::clone(&source)));
			let _ = run
				.events
				.send_async(WorkerEvent::Dead {
					worker: run.request.id.clone(),
					error:  Str::new(source.to_string()),
				})
				.await;
			JobSettlement {
				status:     Str::new_static(if run.cancel.is_cancelled() {
					"cancelled"
				} else {
					"failed"
				}),
				output:     None,
				error:      Some(Str::new(source.to_string())),
				completion: None,
			}
		},
	}
}

async fn run_kernel_worker_inner(
	run: &KernelWorkerRun,
) -> Result<(Str, u64, u64, Option<omp_tools::task::WorkspaceOutcome>, bool), SpawnError> {
	let ctx = Arc::new(child_ctx(&run.ctx, run.cfg.as_ref(), run.request.agent.as_str())?);
	let depth = SV_TASK_RECURSION_DEPTH.get(&run.ctx);
	SV_TASK_RECURSION_DEPTH.set(&ctx, depth.saturating_add(1))?;
	let settings = TaskSettings::from_con(&ctx);
	configure_child_route(&ctx, &settings, run.request.agent.as_str(), None)?;
	if omp_agent::AI_MODEL.get(&ctx).is_empty() {
		omp_agent::AI_MODEL.set(&ctx, run.model.clone())?;
	}
	let isolation = create_isolation(&run.env, &run.request.id).await?;
	let path = child_session_path(&run.sessions_dir, &run.request.id);
	let options = crate::headless::kernel::KernelOptions {
		session: Some(path),
		sessions_dir: Some(run.sessions_dir.clone()),
		sessions: Some(Arc::clone(&run.sessions)),
		session_name: Some(run.request.id.clone()),
		parent_session: Some(run.request.owner.clone()),
		model_override: true,
		tool_registry: run.forwarded_registry.clone(),
		..crate::headless::kernel::KernelOptions::default()
	};
	let composed = crate::headless::kernel::compose_kernel(
		&run.data_dir,
		&isolation.root,
		run.model.as_str(),
		ctx,
		options,
	)
	.await;
	let (mut kernel, mut session, _) = match composed {
		Ok(composed) => composed,
		Err(source) => {
			let _ = discard_isolation(&run.env, isolation).await;
			return Err(source.into());
		},
	};
	let _ = run.ready.send(Ok(()));
	let mut last = Str::default();
	let mut tokens_in = 0_u64;
	let mut tokens_out = 0_u64;
	let mut cancelled = false;
	loop {
		let batch = tokio::select! {
			() = run.cancel.cancelled() => {
				cancelled = true;
				break;
			},
			batch = run.batches.recv_async() => match batch {
				Ok(batch) => batch,
				Err(_) => break,
			},
		};
		let yield_items = batch
			.items
			.iter()
			.enumerate()
			.map(|(index, (id, _))| omp_tools::yield_tool::WorkpoolItem {
				id:    id.clone(),
				index: u32::try_from(index + 1).unwrap_or(u32::MAX),
			})
			.collect::<Vec<_>>();
		let registry = crate::headless::kernel::install_workpool_yield_contract(
			kernel.tool_registry().as_ref(),
			yield_items.clone(),
		)?;
		kernel.replace_tool_registry(registry);
		engage_workpool_yield_ladder(&mut session)?;
		let prompt = batch_prompt(&run.request.pool, &batch);
		let deadline = (settings.max_runtime_ms != 0).then(|| {
			std::time::Instant::now() + std::time::Duration::from_millis(settings.max_runtime_ms)
		});
		let outcome = kernel
			.run_turn(
				&mut session,
				TurnInput { text: Str::new(prompt), attachments: Vec::new() },
				RunControl::new(run.cancel.clone(), deadline)
					.with_request_budget(settings.soft_request_budget)
					.with_request_budget_notice(settings.soft_request_budget_notice),
			)
			.await;
		let outcome = match outcome {
			Ok(outcome) => outcome,
			Err(source) => {
				run.sessions
					.remove(crate::sessions::SessionId::from_ref(run.request.id.as_str()));
				let _ = discard_isolation(&run.env, isolation).await;
				return Err(source.into());
			},
		};
		last = outcome.assistant_text.clone();
		tokens_in = tokens_in.saturating_add(outcome.tokens_in);
		tokens_out = tokens_out.saturating_add(outcome.tokens_out);
		// Only a normally completed batch leaves a clean batch-local yield
		// Director/registry generation that may be reused. Steering and
		// cancellation retire this worker before another assignment.
		let alive = outcome.stop == TurnStop::Completed;
		let assembled = (outcome.stop == TurnStop::Completed)
			.then(|| yield_assembly::assemble_workpool_batch(&session, &yield_items))
			.transpose();
		let (output, success) = match assembled {
			Ok(Some(data)) => (Str::new(data.to_string()), true),
			Ok(None) if outcome.stop == TurnStop::Cancelled => {
				(sf!("workpool batch cancelled before completion"), false)
			},
			Ok(None) if outcome.stop == TurnStop::Steered => {
				(sf!("workpool batch was steered before completion"), false)
			},
			Ok(None) => (sf!("workpool batch failed before completion"), false),
			Err(error) => (Str::new(error.into_output().to_string()), false),
		};
		let event = WorkerEvent::Settled {
			worker: run.request.id.clone(),
			batch: batch.id,
			output,
			success,
			alive,
			context_tokens: Some(tokens_in.saturating_add(tokens_out)),
			context_window: None,
		};
		let _ = run.events.send_async(event).await;
		if !alive {
			cancelled = outcome.stop == TurnStop::Cancelled;
			break;
		}
	}
	run.sessions
		.remove(crate::sessions::SessionId::from_ref(run.request.id.as_str()));
	let workspace = if cancelled {
		discard_isolation(&run.env, isolation).await?
	} else {
		finish_isolation(&run.env, isolation, &settings).await?
	};
	Ok((last, tokens_in, tokens_out, Some(workspace), cancelled))
}

fn batch_prompt(pool: &str, batch: &WorkerBatch) -> String {
	let mut prompt = format!(
		"You are a persistent worker in pool `{pool}`. Complete every item in this batch. Submit \
		 each outcome separately with the batch-local `yield` tool, using its one-based `key`; do \
		 not combine items or invent ids. A successful item may submit partial structured fields in \
		 `data`. Submit `error` only when the active batch must fail."
	);
	if let Some(context) = &batch.context {
		prompt.push_str("\n\nShared context:\n");
		prompt.push_str(context);
	}
	prompt.push_str("\n\nBatch `");
	prompt.push_str(batch.id.as_str());
	prompt.push_str("`:\n");
	for (index, (id, text)) in batch.items.iter().enumerate() {
		prompt.push_str(&format!("{}. [{}] {}\n", index + 1, id, text));
	}
	prompt
}
