use std::{
	fs,
	path::{Path, PathBuf},
	sync::LazyLock,
	time::Duration,
};

use ashpd::desktop::remote_desktop::RemoteDesktop;
use tokio::runtime::{Builder, Runtime};

use crate::desktop::{
	control,
	error::{CoreResult, DesktopError},
};

/// How long the input probe waits for the portal frontend to answer.
const INPUT_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
/// How long before the run's end an unanswered permission prompt is given up:
/// the bounded portal-session close (`CLOSE_TIMEOUT`) plus time to answer the
/// caller, so the prompt's own error still beats the run's timeout.
const CONSENT_MARGIN: Duration =
	crate::desktop::CLOSE_TIMEOUT.saturating_add(Duration::from_millis(500));

/// Process-wide Tokio runtime shared by every xdg-desktop-portal call.
///
/// `ashpd` caches a process-global D-Bus connection whose I/O tasks are bound
/// to the runtime that first creates it. A long-lived multi-thread runtime
/// keeps that connection alive and drives it while portal callers block.
static PORTAL_RUNTIME: LazyLock<Result<Runtime, String>> = LazyLock::new(|| {
	Builder::new_multi_thread()
		.worker_threads(1)
		.enable_all()
		.build()
		.map_err(|err| err.to_string())
});

/// Borrow the shared portal runtime, surfacing a one-time build failure.
pub(super) fn portal_runtime() -> CoreResult<&'static Runtime> {
	PORTAL_RUNTIME
		.as_ref()
		.map_err(|err| DesktopError::internal(format!("xdg-desktop-portal runtime: {err}")))
}

/// Bounds a wait on a portal prompt the user answers (the `RemoteDesktop`
/// permission dialog, the `ScreenCast` share picker) by the current
/// operation's deadline (the run's end or the caller's reply timeout), and
/// fails with `Timeout` and `unanswered` once it passes. GNOME can open the
/// prompt behind other windows; unbounded, only the run's own timeout ends the
/// wait, and the run fails without saying why.
pub(super) async fn until_deadline<T>(
	future: impl Future<Output = T>,
	unanswered: &'static str,
) -> CoreResult<T> {
	let Some(deadline) = control::current_token().and_then(|token| token.deadline()) else {
		return Ok(future.await);
	};
	let give_up = deadline.checked_sub(CONSENT_MARGIN).unwrap_or(deadline);
	tokio::time::timeout_at(give_up.into(), future)
		.await
		.map_err(|_| DesktopError::timeout(unanswered))
}

/// File name of the `RemoteDesktop` restore token that pre-#7884 builds wrote
/// (world-readable) during read-only `computer` calls. Nothing reads it after
/// #7884 dropped the restore-token path.
const ORPHANED_REMOTE_DESKTOP_TOKEN: &str = "remote-desktop-token";

/// Resolves the `omp` state directory (`$XDG_STATE_HOME/omp` or
/// `~/.local/state/omp`) that holds portal tokens.
fn omp_state_dir() -> Option<PathBuf> {
	let base = std::env::var_os("XDG_STATE_HOME")
		.map(PathBuf::from)
		.or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))?;
	Some(base.join("omp"))
}

fn remove_token_in(dir: &Path) {
	let _ = fs::remove_file(dir.join(ORPHANED_REMOTE_DESKTOP_TOKEN));
}

/// Best-effort removal of the orphaned `RemoteDesktop` restore token left
/// behind by pre-#7884 builds. Runs on Wayland backend construction; a missing
/// file is success, so it is safe to call on every session.
pub(super) fn remove_orphaned_remote_desktop_token() {
	if let Some(dir) = omp_state_dir() {
		remove_token_in(&dir);
	}
}

fn token_path(name: &str) -> Option<PathBuf> {
	Some(omp_state_dir()?.join(name))
}

pub(super) fn read_token(name: &str) -> Option<String> {
	fs::read_to_string(token_path(name)?)
		.ok()
		.map(|token| token.trim().to_string())
		.filter(|token| !token.is_empty())
}

pub(super) fn store_token(name: &str, token: Option<&str>) {
	let (Some(path), Some(token)) = (token_path(name), token) else {
		return;
	};
	let Some(parent) = path.parent() else {
		return;
	};
	if fs::create_dir_all(parent).is_ok() {
		let _ = fs::write(path, token);
	}
}

/// Why native input can never reach this desktop, or `None` when it may.
/// `LIBEI_SOCKET` reaches an EIS server directly; otherwise input needs a
/// `RemoteDesktop` portal backend, which wlroots compositors such as sway lack.
/// Only builds the frontend proxy, which reads its properties: no session, no
/// prompt. A frontend that fails to answer counts as reachable, so only a
/// definite absence turns input off.
pub(super) fn input_unavailable_reason() -> Option<String> {
	let direct_eis = std::env::var_os("LIBEI_SOCKET").is_some();
	unavailable_reason(direct_eis, portal_runtime().ok()?, RemoteDesktop::new)
}

fn unavailable_reason<T, F: Future<Output = Result<T, ashpd::Error>>>(
	direct_eis: bool,
	runtime: &Runtime,
	probe: impl FnOnce() -> F,
) -> Option<String> {
	if direct_eis {
		return None;
	}
	// The timeout is built inside the runtime: its timer needs the reactor.
	let answer =
		runtime.block_on(async { tokio::time::timeout(INPUT_PROBE_TIMEOUT, probe()).await });
	answer.ok()?.err().as_ref().and_then(missing_remote_desktop)
}

fn missing_remote_desktop(error: &ashpd::Error) -> Option<String> {
	matches!(error, ashpd::Error::PortalNotFound(_)).then(|| {
		format!(
			"Wayland input is unavailable: no xdg-desktop-portal backend implements RemoteDesktop on \
			 this desktop ({error}), and LIBEI_SOCKET is unset; use AX actions instead"
		)
	})
}

#[cfg(test)]
mod tests {
	use futures::FutureExt;

	use super::*;

	const UNANSWERED: &str = "the prompt was not answered";

	#[test]
	fn an_unanswered_prompt_is_given_up_before_the_run_ends() {
		let runtime = tokio::runtime::Builder::new_current_thread()
			.enable_time()
			.build()
			.unwrap();
		// The run leaves only the session-close budget, so the prompt wait must
		// give up on its first poll; an unbounded wait would still be pending,
		// and a margin shorter than the close would wait for the run to end.
		let ending = control::CancellationSource::default();
		ending.set_deadline(Some(std::time::Instant::now() + crate::desktop::CLOSE_TIMEOUT));
		let error = control::with_token_for_test(&ending.token(), || {
			runtime.block_on(async {
				until_deadline(std::future::pending::<()>(), UNANSWERED).now_or_never()
			})
		})
		.expect("the wait must end at once")
		.unwrap_err();
		assert_eq!(error.code.as_str(), "Timeout");
		assert_eq!(error.message, UNANSWERED);

		// A run with time left lets a prompt answered later through.
		let running = control::CancellationSource::default();
		running.set_deadline(Some(std::time::Instant::now() + Duration::from_secs(3600)));
		let answered = control::with_token_for_test(&running.token(), || {
			runtime.block_on(until_deadline(
				async {
					tokio::task::yield_now().await;
					7
				},
				UNANSWERED,
			))
		});
		assert_eq!(answered.unwrap(), 7);
	}

	/// Every portal caller (libei input init and PipeWire capture) must borrow
	/// one persistent runtime; a regression to per-call runtimes would return
	/// distinct instances and re-open the orphaned-connection bug (#7886).
	#[test]
	fn portal_runtime_is_shared_across_calls() {
		let first = portal_runtime().expect("portal runtime builds");
		let second = portal_runtime().expect("portal runtime builds");
		assert!(
			std::ptr::eq(first, second),
			"portal_runtime must hand back one long-lived runtime, not a fresh per-call instance"
		);
	}

	/// The orphaned RemoteDesktop token written by pre-#7884 builds must be
	/// removed, and a second removal on the now-missing file must stay a no-op.
	#[test]
	fn removes_orphaned_remote_desktop_token() {
		let dir = std::env::temp_dir().join(format!("omp-token-test-{}", std::process::id()));
		fs::create_dir_all(&dir).expect("create token test dir");
		let token = dir.join(ORPHANED_REMOTE_DESKTOP_TOKEN);
		fs::write(&token, "cafef00d").expect("plant orphaned token");
		remove_token_in(&dir);
		assert!(!token.exists(), "orphaned token must be removed");
		remove_token_in(&dir);
		let _ = fs::remove_dir_all(&dir);
	}

	fn portal_not_found() -> ashpd::Error {
		ashpd::Error::PortalNotFound(
			zbus::names::OwnedInterfaceName::try_from("org.freedesktop.portal.RemoteDesktop").unwrap(),
		)
	}

	/// Only a portal frontend that reports the interface missing turns input
	/// off; any other answer leaves the lazy `RemoteDesktop` request to decide.
	/// The probe runs from the desktop session thread, outside any runtime,
	/// where a timer built outside `block_on` panics with "no reactor running".
	#[test]
	fn only_a_missing_remote_desktop_portal_makes_input_unavailable() {
		let runtime = portal_runtime().expect("portal runtime builds");
		let answers = std::thread::spawn(move || {
			(
				unavailable_reason(false, runtime, || {
					std::future::ready(Err::<(), _>(portal_not_found()))
				}),
				unavailable_reason(false, runtime, || {
					std::future::ready(Err::<(), _>(ashpd::Error::NoResponse))
				}),
				unavailable_reason(false, runtime, || std::future::ready(Ok(()))),
			)
		})
		.join()
		.expect("the input probe must not panic");
		let reason = answers.0.expect("a missing portal is reported");
		assert!(reason.contains("RemoteDesktop"), "{reason}");
		assert_eq!(answers.1, None);
		assert_eq!(answers.2, None);
	}

	/// `LIBEI_SOCKET` reaches EIS without the portal, so the portal is never
	/// asked.
	#[test]
	fn a_direct_eis_socket_skips_the_portal_probe() {
		let runtime = portal_runtime().expect("portal runtime builds");
		let reason =
			unavailable_reason(true, runtime, || -> std::future::Ready<Result<(), ashpd::Error>> {
				panic!("the portal must not be probed when LIBEI_SOCKET is set")
			});
		assert_eq!(reason, None);
	}
}
