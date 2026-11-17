//! Python `agent_settled` hooks answer through the environment authority's hook
//! gate.

#![cfg(unix)]

use omp_agent::{AgentSettled, LifecycleHooks};
use omp_e2e::{
	Result,
	support::{InProcessEnvHarness, PythonExtension, Scratch},
};
use serde_json::json;

const SOURCE: &str = r#"
import omp

_calls = 0


@omp.hook("agent_settled")
async def settled(event, ctx):
    global _calls
    _calls += 1
    if _calls == 1:
        return omp.agents.Continue(prompt="one more")
    return omp.agents.Settle()
"#;

const VETO_SOURCE: &str = r#"
import omp


# Domain hooks cannot set order; envd sorts by name within an extension.
@omp.hook("agent_settled", name="a_propose")
async def propose(event, ctx):
    return omp.agents.Continue(prompt="keep going", label="goal")


@omp.hook("agent_settled", name="b_guard")
async def guard(event, ctx):
    assert ctx.pending_continuation is not None
    assert ctx.pending_continuation.prompt == "keep going"
    assert ctx.pending_continuation.label == "goal"
    return omp.agents.Settle()
"#;

static EXTENSION: PythonExtension =
	PythonExtension::new("p9_settled_extension", SOURCE, &[]).trusting();

static VETO_EXTENSION: PythonExtension =
	PythonExtension::new("p9_settled_veto_extension", VETO_SOURCE, &[]).trusting();

fn payload() -> serde_json::Value {
	json!({
		"submission_id": "s1",
		"reason": "stop",
		"committed_turns": 1,
		"last_stop": "stop",
		"pending_jobs": [],
		"continuations_used": 0,
		"incomplete_todos": [],
	})
}

#[tokio::test]
async fn python_agent_settled_continue_runs_one_more_turn() -> Result<()> {
	let scratch = Scratch::new()?;
	let harness = InProcessEnvHarness::spawn_with_extension(scratch, &EXTENSION).await?;
	let hooks = LifecycleHooks::new(harness.server().admission_gate());

	let first = hooks.agent_settled(payload()).await;
	assert_eq!(first.decision, AgentSettled::Continue, "the extension asked for one more turn");
	assert!(
		format!("{:?}", first.context).contains("one more"),
		"the prompt is the continuation context: {:?}",
		first.context
	);

	let second = hooks.agent_settled(payload()).await;
	assert_eq!(second.decision, AgentSettled::Settle);

	harness.shutdown().await;
	Ok(())
}

#[tokio::test]
async fn python_agent_settled_later_settle_vetoes_continue() -> Result<()> {
	let scratch = Scratch::new()?;
	let harness = InProcessEnvHarness::spawn_with_extension(scratch, &VETO_EXTENSION).await?;
	let hooks = LifecycleHooks::new(harness.server().admission_gate());

	let settled = hooks.agent_settled(payload()).await;
	assert_eq!(settled.decision, AgentSettled::Settle, "the guard vetoed the pending Continue");
	assert!(settled.context.is_empty());

	harness.shutdown().await;
	Ok(())
}

#[tokio::test]
async fn python_agent_settled_continue_through_open_project() -> Result<()> {
	let scratch = Scratch::new()?;
	let harness = InProcessEnvHarness::spawn_project_with_extension(scratch, &EXTENSION).await?;
	let hooks = LifecycleHooks::new(harness.server().admission_gate());

	let first = hooks.agent_settled(payload()).await;
	assert_eq!(first.decision, AgentSettled::Continue, "open_project attach must dispatch Continue");
	assert!(
		format!("{:?}", first.context).contains("one more"),
		"the prompt is the continuation context: {:?}",
		first.context
	);

	let second = hooks.agent_settled(payload()).await;
	assert_eq!(second.decision, AgentSettled::Settle);

	harness.shutdown().await;
	Ok(())
}

#[tokio::test]
async fn python_agent_settled_continue_through_open_session_host() -> Result<()> {
	let scratch = Scratch::new()?;
	let harness =
		InProcessEnvHarness::spawn_session_host_with_extension(scratch, &EXTENSION).await?;
	let hooks = LifecycleHooks::new(harness.server().admission_gate());

	let first = hooks.agent_settled(payload()).await;
	assert_eq!(
		first.decision,
		AgentSettled::Continue,
		"open_session_host attach must dispatch Continue"
	);
	assert!(
		format!("{:?}", first.context).contains("one more"),
		"the prompt is the continuation context: {:?}",
		first.context
	);

	let second = hooks.agent_settled(payload()).await;
	assert_eq!(second.decision, AgentSettled::Settle);

	harness.shutdown().await;
	Ok(())
}
