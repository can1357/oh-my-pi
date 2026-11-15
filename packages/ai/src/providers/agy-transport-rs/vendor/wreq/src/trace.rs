macro_rules! debug {
    ($($arg:tt)+) => {
        {
            #[cfg(feature = "tracing")]
            {
                ::tracing::debug!($($arg)+);
            }
        }
    }
}

macro_rules! trace {
    ($($arg:tt)*) => {
        {
            #[cfg(feature = "tracing")]
            {
                ::tracing::trace!($($arg)+);
            }
        }
    }
}

macro_rules! warn {
    ($($arg:tt)*) => {
        {
            #[cfg(feature = "tracing")]
            {
                ::tracing::warn!($($arg)+);
            }
        }
    }
}

macro_rules! error {
    ($($arg:tt)*) => {
        {
            #[cfg(feature = "tracing")]
            {
                ::tracing::error!($($arg)+);
            }
        }
    }
}
