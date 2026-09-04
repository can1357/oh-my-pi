//! Encryption-key sources for persistent credentials.

use std::{
	fmt::{self, Display},
	fs::{self, File, OpenOptions},
	io::{self, Read as _, Write as _},
	path::{Path, PathBuf},
	str,
	sync::Arc,
};

use omp_core::{IntoStr, Str, hex};
use parking_lot::RwLock;
use ring::rand::{SecureRandom, SystemRandom};
use zeroize::Zeroizing;

const KEY_BYTES: usize = 32;
const FILE_KEY_BYTES: usize = 16 + KEY_BYTES;

/// Stable, non-secret identifier for an encryption key.
#[derive(Clone, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct KeyId(Str);

impl KeyId {
	/// Creates a key identifier from stored text.
	pub fn new(value: impl IntoStr) -> Self {
		Self(value.into_str())
	}

	/// Borrows the identifier as text.
	pub fn as_str(&self) -> &str {
		self.0.as_str()
	}
}

impl fmt::Debug for KeyId {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.debug_tuple("KeyId").field(&self.0).finish()
	}
}

impl Display for KeyId {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(self.as_str())
	}
}

/// A zeroizing 256-bit authenticated-encryption key.
pub struct EncryptionKey {
	id:    KeyId,
	bytes: Zeroizing<[u8; KEY_BYTES]>,
}

impl EncryptionKey {
	/// Constructs key material from an explicit 256-bit value.
	pub fn new(id: KeyId, bytes: [u8; KEY_BYTES]) -> Self {
		Self { id, bytes: Zeroizing::new(bytes) }
	}

	/// Returns the non-secret key identifier.
	pub const fn id(&self) -> &KeyId {
		&self.id
	}

	pub(crate) fn bytes(&self) -> &[u8; KEY_BYTES] {
		&self.bytes
	}
}

impl Clone for EncryptionKey {
	fn clone(&self) -> Self {
		Self::new(self.id.clone(), *self.bytes)
	}
}

impl fmt::Debug for EncryptionKey {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("EncryptionKey")
			.field("id", &self.id)
			.field("material", &"[REDACTED]")
			.finish()
	}
}

/// Failure to obtain persistent encryption key material.
#[derive(Clone, Eq, PartialEq, thiserror::Error)]
pub enum KeyError {
	/// The selected key source is not available in this environment.
	#[error("credential encryption key source is unavailable")]
	Unavailable,
	/// The requested historical key is unavailable.
	#[error("credential encryption key {0} is unavailable")]
	NotFound(KeyId),
	/// A key identifier was reused for different material.
	#[error("credential encryption key identifier {0} is already installed")]
	IdentifierInUse(KeyId),
	/// Stored key material has an invalid length.
	#[error("credential encryption key has an invalid length")]
	InvalidLength,
	/// The operating-system credential facility rejected the operation.
	#[error("operating-system credential facility rejected the key operation")]
	OsCredential,
	/// Secure random generation failed.
	#[error("secure random generation failed")]
	Random,
}

impl fmt::Debug for KeyError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(match self {
			Self::Unavailable => "KeyError::Unavailable",
			Self::NotFound(_) => "KeyError::NotFound",
			Self::IdentifierInUse(_) => "KeyError::IdentifierInUse",
			Self::InvalidLength => "KeyError::InvalidLength",
			Self::OsCredential => "KeyError::OsCredential",
			Self::Random => "KeyError::Random",
		})
	}
}

/// Supplies active and historical keys without exposing their origin to
/// persistence.
pub trait KeySource: Send + Sync {
	/// Loads the active key used for new writes.
	fn active_key(&self) -> Result<EncryptionKey, KeyError>;

	/// Loads a key by the identifier stored beside a ciphertext.
	fn key(&self, id: &KeyId) -> Result<EncryptionKey, KeyError>;
}

/// Explicit key source for headless deployments.
///
/// Callers are responsible for obtaining the bytes from a protected secret
/// injection mechanism. This type never reads an implicit environment value.
pub struct HeadlessKeySource {
	active: RwLock<KeyId>,
	keys:   RwLock<Vec<EncryptionKey>>,
}

impl HeadlessKeySource {
	/// Creates a source containing one active key.
	pub fn new(id: KeyId, bytes: [u8; KEY_BYTES]) -> Self {
		Self {
			active: RwLock::new(id.clone()),
			keys:   RwLock::new(vec![EncryptionKey::new(id, bytes)]),
		}
	}

	/// Adds a historical key that can decrypt records written before rotation.
	pub fn try_with_historical(self, id: KeyId, bytes: [u8; KEY_BYTES]) -> Result<Self, KeyError> {
		let mut keys = self.keys.write();
		if keys.iter().any(|key| key.id == id) {
			return Err(KeyError::IdentifierInUse(id));
		}
		keys.push(EncryptionKey::new(id, bytes));
		drop(keys);
		Ok(self)
	}

	/// Installs a new active key while retaining prior keys for atomic rotation.
	pub fn install_active(&self, id: KeyId, bytes: [u8; KEY_BYTES]) -> Result<(), KeyError> {
		let mut keys = self.keys.write();
		if keys.iter().any(|key| key.id == id) {
			return Err(KeyError::IdentifierInUse(id));
		}
		keys.push(EncryptionKey::new(id.clone(), bytes));
		*self.active.write() = id;
		Ok(())
	}
}

impl fmt::Debug for HeadlessKeySource {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		let active = self.active.read().clone();
		let key_count = self.keys.read().len();
		formatter
			.debug_struct("HeadlessKeySource")
			.field("active", &active)
			.field("key_count", &key_count)
			.finish()
	}
}

impl KeySource for HeadlessKeySource {
	fn active_key(&self) -> Result<EncryptionKey, KeyError> {
		let active = self.active.read().clone();
		self.key(&active)
	}

	fn key(&self, id: &KeyId) -> Result<EncryptionKey, KeyError> {
		self
			.keys
			.read()
			.iter()
			.find(|key| key.id == *id)
			.cloned()
			.ok_or_else(|| KeyError::NotFound(id.clone()))
	}
}

/// Key source that deterministically reports that no key is available.
#[derive(Clone, Copy, Debug, Default)]
pub struct UnavailableKeySource;

impl KeySource for UnavailableKeySource {
	fn active_key(&self) -> Result<EncryptionKey, KeyError> {
		Err(KeyError::Unavailable)
	}

	fn key(&self, _id: &KeyId) -> Result<EncryptionKey, KeyError> {
		Err(KeyError::Unavailable)
	}
}

/// A persistent encryption key stored in an owner-readable file.
///
/// This is the boring local-development equivalent of owner-only SQLite
/// credential storage: it avoids binding credential access to a particular
/// executable identity, so rebuilding an ad-hoc-signed macOS binary does not
/// trigger Keychain authorization. The adjacent key means encryption does not
/// protect credentials from an attacker who can read the user's data
/// directory; its protection boundary is the directory and this file's `0600`
/// mode. Release composition must therefore choose this source deliberately
/// rather than treating it as equivalent to an OS credential vault.
#[derive(Clone)]
pub struct FileCredentialKeySource {
	key: EncryptionKey,
}

/// Failure to load or create an owner-only credential key file.
#[derive(Debug, thiserror::Error)]
pub enum FileKeyError {
	/// The key path could not be accessed.
	#[error("could not access credential key file at {path}")]
	Io {
		/// Path of the key file.
		path:   PathBuf,
		/// Underlying filesystem failure.
		#[source]
		source: io::Error,
	},
	/// The key file is not the exact supported binary format.
	#[error("credential key file at {path} has an invalid format")]
	InvalidFormat {
		/// Path of the malformed key file.
		path: PathBuf,
	},
	/// Secure random generation failed while provisioning the file.
	#[error("secure random generation failed")]
	Random,
}

impl FileCredentialKeySource {
	/// Loads an existing key or atomically provisions a new owner-only key.
	///
	/// Concurrent creators converge on the first successfully created file.
	/// On Unix the file is opened without following symlinks and its mode is
	/// enforced as `0600` on every load.
	pub fn open(path: impl AsRef<Path>) -> Result<Self, FileKeyError> {
		let path = path.as_ref();
		match Self::read(path) {
			Ok(source) => Ok(source),
			Err(FileKeyError::Io { source, .. }) if source.kind() == io::ErrorKind::NotFound => {
				Self::create(path)
			},
			Err(error) => Err(error),
		}
	}

	fn create(path: &Path) -> Result<Self, FileKeyError> {
		let mut material = Zeroizing::new([0_u8; FILE_KEY_BYTES]);
		SystemRandom::new()
			.fill(material.as_mut())
			.map_err(|_| FileKeyError::Random)?;
		let mut options = OpenOptions::new();
		options.write(true).create_new(true);
		#[cfg(unix)]
		{
			use std::os::unix::fs::OpenOptionsExt as _;
			options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
		}
		match options.open(path) {
			Ok(mut file) => {
				file
					.write_all(material.as_ref())
					.and_then(|()| file.sync_all())
					.map_err(|source| FileKeyError::Io { path: path.to_path_buf(), source })?;
				Self::from_material(path, material.as_ref())
			},
			Err(source) if source.kind() == io::ErrorKind::AlreadyExists => Self::read(path),
			Err(source) => Err(FileKeyError::Io { path: path.to_path_buf(), source }),
		}
	}

	fn read(path: &Path) -> Result<Self, FileKeyError> {
		let mut options = File::options();
		options.read(true);
		#[cfg(unix)]
		{
			use std::os::unix::fs::OpenOptionsExt as _;
			options.custom_flags(libc::O_NOFOLLOW);
		}
		let mut file = options
			.open(path)
			.map_err(|source| FileKeyError::Io { path: path.to_path_buf(), source })?;
		let metadata = file
			.metadata()
			.map_err(|source| FileKeyError::Io { path: path.to_path_buf(), source })?;
		if !metadata.is_file() {
			return Err(FileKeyError::InvalidFormat { path: path.to_path_buf() });
		}
		#[cfg(unix)]
		file
			.set_permissions({
				use std::os::unix::fs::PermissionsExt as _;
				fs::Permissions::from_mode(0o600)
			})
			.map_err(|source| FileKeyError::Io { path: path.to_path_buf(), source })?;
		let mut material = Zeroizing::new(Vec::new());
		file
			.read_to_end(&mut material)
			.map_err(|source| FileKeyError::Io { path: path.to_path_buf(), source })?;
		Self::from_material(path, &material)
	}

	fn from_material(path: &Path, material: &[u8]) -> Result<Self, FileKeyError> {
		let material: &[u8; FILE_KEY_BYTES] = material
			.try_into()
			.map_err(|_| FileKeyError::InvalidFormat { path: path.to_path_buf() })?;
		let encoded = hex::encode_n::<16>(
			material[..16]
				.try_into()
				.expect("the fixed file-key identifier slice is 16 bytes"),
		);
		let id = KeyId::new(encoded.as_str());
		let bytes = material[16..]
			.try_into()
			.expect("the fixed file-key material slice is 32 bytes");
		Ok(Self { key: EncryptionKey::new(id, bytes) })
	}
}

impl fmt::Debug for FileCredentialKeySource {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("FileCredentialKeySource")
			.field("id", self.key.id())
			.finish()
	}
}

impl KeySource for FileCredentialKeySource {
	fn active_key(&self) -> Result<EncryptionKey, KeyError> {
		Ok(self.key.clone())
	}

	fn key(&self, id: &KeyId) -> Result<EncryptionKey, KeyError> {
		if self.key.id() == id {
			Ok(self.key.clone())
		} else {
			Err(KeyError::NotFound(id.clone()))
		}
	}
}

/// A primary key source with a historical fallback used for key migration.
///
/// New writes always use the primary source. The fallback is consulted only
/// when a requested historical identifier is absent from the primary source,
/// allowing callers to re-encrypt legacy records without making the fallback
/// part of the steady-state access path.
pub struct FallbackKeySource<P, F> {
	primary:  P,
	fallback: F,
}

impl<P, F> FallbackKeySource<P, F> {
	/// Creates a key source with a read-only historical fallback.
	pub const fn new(primary: P, fallback: F) -> Self {
		Self { primary, fallback }
	}
}

impl<P: KeySource, F: KeySource> KeySource for FallbackKeySource<P, F> {
	fn active_key(&self) -> Result<EncryptionKey, KeyError> {
		self.primary.active_key()
	}

	fn key(&self, id: &KeyId) -> Result<EncryptionKey, KeyError> {
		match self.primary.key(id) {
			Err(KeyError::NotFound(_)) => self.fallback.key(id),
			result => result,
		}
	}
}

/// Explicitly opted-in encryption-key source backed by the OS credential
/// facility.
///
/// Constructing the source performs no I/O, but [`KeySource::active_key`],
/// [`KeySource::key`], and [`Self::rotate`] may ask the OS credential service
/// to authorize access. Applications must therefore select this source
/// explicitly; it is never a steady-state default. A caller may use it as a
/// one-time [`FallbackKeySource`] to migrate existing ciphertext before
/// removing it from the access path. Tests and unattended deployments should
/// use [`HeadlessKeySource`] with injected key bytes instead.
///
/// The implementation is available on macOS, where keys are stored as generic
/// passwords in the user's Keychain. Unsupported targets return
/// [`KeyError::Unavailable`] and never fall back to plaintext or a local file.
#[derive(Clone)]
pub struct OsCredentialKeySource {
	service: Arc<str>,
	account: Arc<str>,
}

impl OsCredentialKeySource {
	/// Creates an explicitly opted-in service/account namespace without
	/// performing I/O.
	pub fn new(service: impl Into<Arc<str>>, account: impl Into<Arc<str>>) -> Self {
		Self { service: service.into(), account: account.into() }
	}

	/// Provisions a new active key while retaining historical keys in the OS
	/// facility.
	pub fn rotate(&self) -> Result<KeyId, KeyError> {
		#[cfg(target_os = "macos")]
		{
			use security_framework::passwords::set_generic_password;

			let random = SystemRandom::new();
			let mut id_bytes = [0_u8; 16];
			let mut key_bytes = Zeroizing::new([0_u8; KEY_BYTES]);
			random.fill(&mut id_bytes).map_err(|_| KeyError::Random)?;
			random
				.fill(key_bytes.as_mut())
				.map_err(|_| KeyError::Random)?;
			let encoded = hex::encode_n(&id_bytes);
			let id = KeyId::new(&encoded);
			set_generic_password(&self.service, &self.key_account(&id), key_bytes.as_ref())
				.map_err(|_| KeyError::OsCredential)?;
			set_generic_password(&self.service, &self.active_account(), id.as_str().as_bytes())
				.map_err(|_| KeyError::OsCredential)?;
			Ok(id)
		}
		#[cfg(not(target_os = "macos"))]
		{
			Err(KeyError::Unavailable)
		}
	}

	fn active_account(&self) -> String {
		format!("{}:active", self.account)
	}

	fn key_account(&self, id: &KeyId) -> String {
		format!("{}:key:{}", self.account, id.as_str())
	}
}

impl fmt::Debug for OsCredentialKeySource {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("OsCredentialKeySource")
			.finish_non_exhaustive()
	}
}

impl KeySource for OsCredentialKeySource {
	fn active_key(&self) -> Result<EncryptionKey, KeyError> {
		#[cfg(target_os = "macos")]
		{
			use security_framework::passwords::get_generic_password;

			let raw = get_generic_password(&self.service, &self.active_account())
				.map_err(|_| KeyError::Unavailable)?;
			let id = str::from_utf8(&raw).map_err(|_| KeyError::InvalidLength)?;
			self.key(&KeyId::new(id))
		}
		#[cfg(not(target_os = "macos"))]
		{
			Err(KeyError::Unavailable)
		}
	}

	fn key(&self, id: &KeyId) -> Result<EncryptionKey, KeyError> {
		#[cfg(target_os = "macos")]
		{
			use security_framework::passwords::get_generic_password;

			let raw = Zeroizing::new(
				get_generic_password(&self.service, &self.key_account(id))
					.map_err(|_| KeyError::NotFound(id.clone()))?,
			);
			let bytes: [u8; KEY_BYTES] = raw
				.as_slice()
				.try_into()
				.map_err(|_| KeyError::InvalidLength)?;
			Ok(EncryptionKey::new(id.clone(), bytes))
		}
		#[cfg(not(target_os = "macos"))]
		{
			let _ = id;
			Err(KeyError::Unavailable)
		}
	}
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::{
		FallbackKeySource, FileCredentialKeySource, FileKeyError, HeadlessKeySource, KeyId, KeySource,
	};

	#[test]
	fn file_key_is_stable_and_owner_only() {
		let directory = tempfile::tempdir().expect("temporary directory");
		let path = directory.path().join("credentials.key");
		let first = FileCredentialKeySource::open(&path).expect("create file key");
		let second = FileCredentialKeySource::open(&path).expect("reload file key");
		assert_eq!(
			first.active_key().expect("first key").id(),
			second.active_key().expect("second key").id()
		);
		assert_eq!(
			first.active_key().expect("first key").bytes(),
			second.active_key().expect("second key").bytes()
		);
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt as _;
			assert_eq!(
				std::fs::metadata(&path)
					.expect("key metadata")
					.permissions()
					.mode() & 0o777,
				0o600
			);
		}
	}

	#[test]
	fn fallback_is_historical_only() {
		let primary = HeadlessKeySource::new(KeyId::new("new"), [1; 32]);
		let historical = HeadlessKeySource::new(KeyId::new("old"), [2; 32]);
		let source = FallbackKeySource::new(primary, historical);
		assert_eq!(source.active_key().expect("active key").id().as_str(), "new");
		assert_eq!(
			source
				.key(&KeyId::new("old"))
				.expect("historical key")
				.id()
				.as_str(),
			"old"
		);
	}

	#[test]
	fn malformed_file_key_is_rejected_without_replacement() {
		let directory = tempfile::tempdir().expect("temporary directory");
		let path = directory.path().join("credentials.key");
		fs::write(&path, b"not-a-key").expect("malformed key");
		assert!(matches!(
			FileCredentialKeySource::open(&path),
			Err(FileKeyError::InvalidFormat { .. })
		));
		assert_eq!(std::fs::read(&path).expect("preserved malformed key"), b"not-a-key");
	}
}
