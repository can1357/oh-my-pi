//! Built-in custom OAuth exchange handlers selected by catalog discriminator.

use std::sync::Arc;

use super::{OAuthClock, OAuthCustomDispatchError, OAuthCustomDispatcher, OAuthHttpClient};

mod anthropic;
mod api_key;
mod cursor;
mod devin;
mod gitlab;
mod google_antigravity;
mod openrouter;
mod perplexity;
mod zai;

pub(super) fn register_all(
	dispatcher: &mut OAuthCustomDispatcher,
	http: Arc<dyn OAuthHttpClient>,
	clock: Arc<dyn OAuthClock>,
) -> Result<(), OAuthCustomDispatchError> {
	anthropic::register(dispatcher, http.clone(), clock.clone())?;
	api_key::register(dispatcher, http.clone(), clock.clone())?;
	cursor::register(dispatcher, http.clone(), clock.clone())?;
	devin::register(dispatcher, http.clone(), clock.clone())?;
	gitlab::register(dispatcher, http.clone(), clock.clone())?;
	google_antigravity::register(dispatcher, http.clone(), clock.clone())?;
	openrouter::register(dispatcher, http.clone(), clock.clone())?;
	perplexity::register(dispatcher, http.clone(), clock.clone())?;
	zai::register(dispatcher, http, clock)
}
