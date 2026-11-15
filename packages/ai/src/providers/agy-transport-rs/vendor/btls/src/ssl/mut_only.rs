pub(crate) struct MutOnly<T>(T);

impl<T> MutOnly<T> {
    pub(crate) fn new(value: T) -> Self {
        Self(value)
    }

    pub(crate) fn get_mut(&mut self) -> &mut T {
        &mut self.0
    }
}

/// SAFETY: The type does not let anyone get a &T so Sync is irrelevant.
unsafe impl<T> Sync for MutOnly<T> {}
