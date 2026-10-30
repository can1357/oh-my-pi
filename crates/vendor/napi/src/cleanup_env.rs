pub(crate) struct CleanupEnvHookData<T: 'static> {
  pub(crate) data: T,
  pub(crate) hook: Box<dyn FnOnce(T)>,
}

/// Created by `Env::add_env_cleanup_hook`
/// And used by `Env::remove_env_cleanup_hook`
#[derive(Clone, Copy)]
pub struct CleanupEnvHook<T: 'static>(pub(crate) *mut CleanupEnvHookData<T>);
