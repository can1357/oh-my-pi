//! Audited provider credential projection for `omp token`.

use std::{
	process,
	time::{SystemTime, UNIX_EPOCH},
};

use miette::{Context as _, IntoDiagnostic as _, miette};
use omp_ai::{
	answer::{AccountState, AuthAnswer},
	auth::AuditedCredentialReveal,
	call::AuthRequest,
};
use omp_catalog::ProviderId;
use omp_core::Str;
use serde_json::Value;

use crate::cli::TokenArgs;

/// Lists or prints one provider credential after durable reveal auditing.
pub(crate) async fn run(args: TokenArgs) -> miette::Result<()> {
	let data = omp_core::dirs::data_dir(None).into_diagnostic()?;
	let store = omp_driver::registry::open_credential_store(data.join("credentials.db"))
		.into_diagnostic()
		.wrap_err(
			"credential storage could not be unlocked; unattended callers may set \
			 OMP_LLM_KEY_SOURCE=local-file for the owner-only local encrypted store",
		)?;
	let (_registry, auth) = omp_driver::registry::production_rpc_registry(&data, store.clone())
		.await
		.into_diagnostic()
		.wrap_err(
			"credential storage could not be unlocked; unattended callers may set \
			 OMP_LLM_KEY_SOURCE=local-file for the owner-only local encrypted store",
		)?;
	let provider = ProviderId::from(args.provider.clone());
	let accounts = match auth
		.execute(AuthRequest::ListAccounts { provider: Some(provider.clone()) })
		.await
		.into_diagnostic()?
	{
		AuthAnswer::Accounts(accounts) => accounts
			.into_iter()
			.filter(|account| account.state == AccountState::Active)
			.collect::<Vec<_>>(),
		_ => return Err(miette!("provider account listing returned an unexpected response")),
	};
	if args.list {
		for (index, account) in accounts.iter().enumerate() {
			println!("{}. {}", index + 1, account.account);
		}
		return Ok(());
	}
	if accounts.is_empty() {
		return Err(miette!("no active credential found for provider `{}`", args.provider));
	}
	let selected = args.account.unwrap_or(1);
	if selected == 0 || selected > accounts.len() {
		return Err(miette!(
			"invalid --account {selected}; provider has {} active account(s)",
			accounts.len()
		));
	}
	let account = &accounts[selected - 1];
	if args.force_refresh {
		let _ = auth
			.execute(AuthRequest::Refresh { account: account.account.clone() })
			.await
			.into_diagnostic()?;
	}
	let request_id = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_nanos() as u64;
	let audit = AuditedCredentialReveal {
		extension: Str::new_static("omp.cli.token"),
		caller_principal: Str::from(format!("pid:{}", process::id())),
		provider: Str::new(provider.as_str()),
		host_generation: 1,
		session_generation: 1,
		request_id,
		reason: Str::new_static("explicit operator token command"),
	};
	let rendered = store
		.with_audited_secret(&account.account, &audit, |secret| {
			secret.expose(|bytes| {
				let raw = std::str::from_utf8(bytes)
					.map_err(|_| miette!("stored credential is not valid UTF-8"))?;
				Ok::<_, miette::Report>(render_token(raw, args.raw))
			})
		})
		.into_diagnostic()??;
	println!("{rendered}");
	Ok(())
}
fn render_token(raw: &str, unparsed: bool) -> String {
	if unparsed {
		return raw.to_owned();
	}
	serde_json::from_str::<Value>(raw)
		.ok()
		.and_then(|value| {
			["token", "access_token", "accessToken", "api_key", "apiKey"]
				.into_iter()
				.find_map(|key| value.get(key).and_then(Value::as_str).map(str::to_owned))
		})
		.unwrap_or_else(|| raw.to_owned())
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn nested_token_projection_and_raw_mode_are_distinct() {
		let raw = r#"{"access_token":"secret","refresh_token":"hidden"}"#;
		assert_eq!(render_token(raw, false), "secret");
		assert_eq!(render_token(raw, true), raw);
	}
}
