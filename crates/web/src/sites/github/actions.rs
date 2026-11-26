//! Workflow runs and jobs, including a job's plain-text log.

use std::{
	fmt::{self, Write as _},
	sync::LazyLock,
};

use jiff::Timestamp;
use regex::Regex;

use super::{
	Action, Context, Fetch, Repo, Value, api, api_done, arr_of, commit::short, fetch, str_of, u64_of,
};

pub(super) fn run(context: &Context, repo: Repo<'_>, id: u64) -> Option<Action> {
	let endpoint = repo.endpoint();
	fetch(api(context, format_args!("{endpoint}/actions/runs/{id}")), move |reply, context| {
		let run = reply.json_value()?;
		let number = u64_of(&run, "run_number")?;
		let mut md = String::new();
		if let Some(title) = str_of(&run, "display_title").or_else(|| str_of(&run, "name")) {
			let _ = write!(md, "# {title}\n\n");
		} else {
			let _ = write!(md, "# Run #{number}\n\n");
		}
		write_run_meta(&mut md, &run, number);
		md.push_str("\n---\n\n");
		fetch(
			api(context, format_args!("{endpoint}/actions/runs/{id}/jobs?per_page=100")),
			move |reply, _| {
				if let Some(data) = reply.json_value().filter(Value::is_object) {
					let jobs = arr_of(&data, "jobs");
					let _ = write!(md, "## Jobs ({})\n\n", jobs.len());
					for job in jobs {
						md.push_str("### ");
						write_cell(&mut md, str_of(job, "name").unwrap_or_default());
						md.push_str(" — ");
						write_status(&mut md, job);
						if let Some(duration) =
							duration(str_of(job, "started_at"), str_of(job, "completed_at"))
						{
							let _ = write!(md, " ({duration})");
						}
						md.push_str("\n\n");
						if job["conclusion"] != "success" {
							write_steps(&mut md, arr_of(job, "steps"));
						}
					}
				}
				api_done(md, "github-actions-run").finish()
			},
		)
	})
}

pub(super) fn job(context: &Context, repo: Repo<'_>, url_run: u64, id: u64) -> Option<Action> {
	let endpoint = repo.endpoint();
	fetch(api(context, format_args!("{endpoint}/actions/jobs/{id}")), move |reply, context| {
		let job = reply.json_value()?;
		let id = u64_of(&job, "id")?;
		let run_id = u64_of(&job, "run_id").unwrap_or(url_run);
		fetch(
			api(context, format_args!("{endpoint}/actions/runs/{run_id}")),
			move |reply, context| {
				let run = reply.json_value();
				let name = str_of(&job, "name")?;
				let mut md = String::from("# ");
				write_cell(&mut md, name);
				md.push_str("\n\n");
				if let Some(run) = run.as_ref()
					&& let Some(number) = u64_of(run, "run_number")
				{
					write_run_meta(&mut md, run, number);
				} else if let Some(workflow) = str_of(&job, "workflow_name") {
					let _ = writeln!(md, "**Workflow:** {workflow}");
					if let Some(branch) = str_of(&job, "head_branch") {
						let _ = writeln!(md, "**Branch:** {branch}");
					}
				}
				md.push_str("**Job:** ");
				write_cell(&mut md, name);
				md.push_str(" · ");
				write_status(&mut md, &job);
				if let Some(duration) =
					duration(str_of(&job, "started_at"), str_of(&job, "completed_at"))
				{
					let _ = write!(md, " · {duration}");
				}
				md.push('\n');
				if let Some(runner) = str_of(&job, "runner_name") {
					let _ = writeln!(md, "**Runner:** {runner}");
				}
				if let Some(link) = str_of(&job, "html_url") {
					let _ = writeln!(md, "URL: {link}");
				}
				md.push_str("\n---\n\n");
				let steps = arr_of(&job, "steps");
				if !steps.is_empty() {
					md.push_str("## Steps\n\n");
					write_steps(&mut md, steps);
				}
				// The caller strips Authorization when following the redirect to
				// the signed, cross-origin log URL.
				let request =
					Fetch::get(format!("https://api.github.com{endpoint}/actions/jobs/{id}/logs"))
						.header("Accept", "application/vnd.github+json")
						.header("X-GitHub-Api-Version", "2022-11-28")
						.bearer(context.credential("github"));
				fetch(request, move |reply, _| {
					md.push_str("## Logs\n\n");
					let truncated = if let Some(logs) = reply.body_text().filter(|text| !text.is_empty())
					{
						write_logs(&mut md, &logs);
						reply.truncated
					} else {
						md.push_str(
							"*Logs unavailable — requires a GITHUB_TOKEN/GH_TOKEN with read access, or \
							 the run's logs have expired.*\n",
						);
						false
					};
					let mut done = api_done(md, "github-actions-job");
					done.truncated = truncated;
					done.finish()
				})
			},
		)
	})
}

fn write_status(md: &mut String, data: &Value) {
	md.push_str(str_of(data, "status").unwrap_or_default());
	if let Some(conclusion) = str_of(data, "conclusion") {
		let _ = write!(md, " ({conclusion})");
	}
}

fn write_run_meta(md: &mut String, run: &Value, number: u64) {
	let name = str_of(run, "name").unwrap_or("(unknown)");
	let _ = write!(md, "**Workflow:** {name}\n**Run:** #{number}");
	if let Some(attempt) = u64_of(run, "run_attempt").filter(|attempt| *attempt > 1) {
		let _ = write!(md, " (attempt {attempt})");
	}
	md.push_str(" · ");
	write_status(md, run);
	md.push('\n');
	if let Some(branch) = str_of(run, "head_branch") {
		let _ = write!(md, "**Branch:** {branch}");
		if let Some(sha) = str_of(run, "head_sha") {
			let _ = write!(md, " @ {}", short(sha, 7));
		}
		md.push('\n');
	}
	let event = str_of(run, "event").unwrap_or_default();
	let _ = write!(md, "**Event:** {event}");
	if let Some(actor) =
		str_of(&run["triggering_actor"], "login").or_else(|| str_of(&run["actor"], "login"))
	{
		let _ = write!(md, " · by @{actor}");
	}
	let started = str_of(run, "run_started_at").or_else(|| str_of(run, "created_at"));
	let _ = write!(md, "\nStarted: {}", started.unwrap_or_default());
	if let Some(duration) = duration(started, str_of(run, "updated_at")) {
		let _ = write!(md, " · Duration: {duration}");
	}
	let _ = write!(md, "\nURL: {}\n", str_of(run, "html_url").unwrap_or_default());
}

fn write_steps(md: &mut String, steps: &[Value]) {
	if steps.is_empty() {
		return;
	}
	md.push_str(
		"| # | Step | Status | Conclusion | Duration \
		 |\n|---|------|--------|------------|----------|\n",
	);
	for step in steps {
		let _ = write!(md, "| {} | ", u64_of(step, "number").unwrap_or(0));
		write_cell(md, str_of(step, "name").unwrap_or_default());
		let _ = write!(
			md,
			" | {} | {} | ",
			str_of(step, "status").unwrap_or_default(),
			str_of(step, "conclusion").unwrap_or("-"),
		);
		if let Some(duration) = duration(str_of(step, "started_at"), str_of(step, "completed_at")) {
			let _ = write!(md, "{duration}");
		} else {
			md.push('-');
		}
		md.push_str(" |\n");
	}
	md.push('\n');
}

fn write_cell(md: &mut String, text: &str) {
	for part in text.split_inclusive('|') {
		if let Some(part) = part.strip_suffix('|') {
			md.push_str(part);
			md.push_str("\\|");
		} else {
			md.push_str(part);
		}
	}
}

fn write_logs(md: &mut String, logs: &str) {
	static PREFIX: LazyLock<Regex> = LazyLock::new(|| {
		Regex::new(r"(?m)^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z ").expect("valid log timestamp regex")
	});
	let logs = logs.strip_prefix('\u{feff}').unwrap_or(logs);
	let mut start = 0;
	for hit in PREFIX.find_iter(logs) {
		md.push_str(&logs[start..hit.start()]);
		start = hit.end();
	}
	md.push_str(&logs[start..]);
}

struct Elapsed(u64);

impl fmt::Display for Elapsed {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let hours = self.0 / 3_600;
		let mins = self.0 / 60 % 60;
		let secs = self.0 % 60;
		if hours == 0 {
			write!(f, "{mins:02}:{secs:02}")
		} else {
			write!(f, "{hours}:{mins:02}:{secs:02}")
		}
	}
}

fn duration(start: Option<&str>, end: Option<&str>) -> Option<Elapsed> {
	let start: Timestamp = start?.parse().ok()?;
	let end: Timestamp = end?.parse().ok()?;
	let millis = u64::try_from(end.as_millisecond() - start.as_millisecond()).ok()?;
	Some(Elapsed((millis + 500) / 1_000))
}
