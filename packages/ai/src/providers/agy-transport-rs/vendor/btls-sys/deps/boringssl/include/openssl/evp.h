// Copyright 1995-2016 The OpenSSL Project Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#ifndef OPENSSL_HEADER_EVP_H
#define OPENSSL_HEADER_EVP_H

#include <openssl/base.h>   // IWYU pragma: export

#include <openssl/evp_errors.h>  // IWYU pragma: export

// OpenSSL included digest and cipher functions in this header so we include
// them for users that still expect that.
#include <openssl/aead.h>
#include <openssl/base64.h>
#include <openssl/cipher.h>
#include <openssl/digest.h>
#include <openssl/nid.h>

#if defined(__cplusplus)
extern "C" {
#endif


// EVP abstracts over public/private key algorithms.


// Public/private key objects.
//
// An |EVP_PKEY| object represents a public or private key. A given object may
// be used concurrently on multiple threads by non-mutating functions, provided
// no other thread is concurrently calling a mutating function. Unless otherwise
// documented, functions which take a |const| pointer are non-mutating and
// functions which take a non-|const| pointer are mutating.

// EVP_PKEY_new creates a new, empty public-key object and returns it or NULL
// on allocation failure.
OPENSSL_EXPORT EVP_PKEY *EVP_PKEY_new(void);

// EVP_PKEY_free frees all data referenced by |pkey| and then frees |pkey|
// itself.
OPENSSL_EXPORT void EVP_PKEY_free(EVP_PKEY *pkey);

// EVP_PKEY_up_ref increments the reference count of |pkey| and returns one. It
// does not mutate |pkey| for thread-safety purposes and may be used
// concurrently.
OPENSSL_EXPORT int EVP_PKEY_up_ref(EVP_PKEY *pkey);

// EVP_PKEY_is_opaque returns one if |pkey| is opaque. Opaque keys are backed by
// custom implementations which do not expose key material and parameters. It is
// an error to attempt to duplicate, export, or compare an opaque key.
OPENSSL_EXPORT int EVP_PKEY_is_opaque(const EVP_PKEY *pkey);

// EVP_PKEY_cmp compares |a| and |b| and returns one if they are equal, zero if
// not and a negative number on error.
//
// WARNING: this differs from the traditional return value of a "cmp"
// function.
OPENSSL_EXPORT int EVP_PKEY_cmp(const EVP_PKEY *a, const EVP_PKEY *b);

// EVP_PKEY_copy_parameters sets the parameters of |to| to equal the parameters
// of |from|. It returns one on success and zero on error.
OPENSSL_EXPORT int EVP_PKEY_copy_parameters(EVP_PKEY *to, const EVP_PKEY *from);

// EVP_PKEY_missing_parameters returns one if |pkey| is missing needed
// parameters or zero if not, or if the algorithm doesn't take parameters.
OPENSSL_EXPORT int EVP_PKEY_missing_parameters(const EVP_PKEY *pkey);

// EVP_PKEY_cmp_parameters compares the parameters of |a| and |b|. It returns
// one if they match, zero if not, or a negative number on error.
//
// WARNING: the return value differs from the usual return value convention.
OPENSSL_EXPORT int EVP_PKEY_cmp_parameters(const EVP_PKEY *a,
                                           const EVP_PKEY *b);

// EVP_PKEY_size returns the maximum size, in bytes, of a signature signed by
// |pkey|. For an RSA key, this returns the number of bytes needed to represent
// the modulus. For an EC key, this returns the maximum size of a DER-encoded
// ECDSA signature.
OPENSSL_EXPORT int EVP_PKEY_size(const EVP_PKEY *pkey);

// EVP_PKEY_bits returns the "size", in bits, of |pkey|. For an RSA key, this
// returns the bit length of the modulus. For an EC key, this returns the bit
// length of the group order.
OPENSSL_EXPORT int EVP_PKEY_bits(const EVP_PKEY *pkey);

// The following constants are returned by |EVP_PKEY_id| and specify the type of
// key.
#define EVP_PKEY_NONE NID_undef
#define EVP_PKEY_RSA NID_rsaEncryption
#define EVP_PKEY_RSA_PSS NID_rsassaPss
#define EVP_PKEY_DSA NID_dsa
#define EVP_PKEY_EC NID_X9_62_id_ecPublicKey
#define EVP_PKEY_ED25519 NID_ED25519
#define EVP_PKEY_X25519 NID_X25519
#define EVP_PKEY_HKDF NID_hkdf
#define EVP_PKEY_DH NID_dhKeyAgreement
#define EVP_PKEY_ML_DSA_44 NID_ML_DSA_44
#define EVP_PKEY_ML_DSA_65 NID_ML_DSA_65
#define EVP_PKEY_ML_DSA_87 NID_ML_DSA_87

// EVP_PKEY_id returns the type of |pkey|, which is one of the |EVP_PKEY_*|
// values above. These type values generally correspond to the algorithm OID,
// but not the parameters, of a SubjectPublicKeyInfo (RFC 5280) or
// PrivateKeyInfo (RFC 5208) AlgorithmIdentifier. Algorithm parameters can be
// inspected with algorithm-specific accessors, e.g.
// |EVP_PKEY_get_ec_curve_nid|.
OPENSSL_EXPORT int EVP_PKEY_id(const EVP_PKEY *pkey);


// Algorithms.
//
// An |EVP_PKEY| may carry a key from one of several algorithms, represented by
// |EVP_PKEY_ALG|. |EVP_PKEY_ALG|s are used by functions that construct
// |EVP_PKEY|s, such as parsing, so that callers can specify the algorithm(s) to
// use.
//
// Each |EVP_PKEY_ALG| generally corresponds to the AlgorithmIdentifier of a
// SubjectPublicKeyInfo (RFC 5280) or PrivateKeyInfo (RFC 5208), but some may
// support multiple sets of AlgorithmIdentifier parameters, while others may be
// specific to one parameter.

// EVP_pkey_rsa implements RSA keys (RFC 8017), encoded as rsaEncryption (RFC
// 3279, Section 2.3.1). The rsaEncryption encoding is confusingly named: these
// keys are used for all RSA operations, including signing. The |EVP_PKEY_id|
// value is |EVP_PKEY_RSA|.
//
// WARNING: This |EVP_PKEY_ALG| accepts all RSA key sizes supported by
// BoringSSL. When parsing RSA keys, callers should check the size is within
// their desired bounds with |EVP_PKEY_bits|. RSA public key operations scale
// quadratically and RSA private key operations scale cubicly, so key sizes may
// be a DoS vector.
OPENSSL_EXPORT const EVP_PKEY_ALG *EVP_pkey_rsa(void);

// EVP_pkey_ec_* implement EC keys, encoded as id-ecPublicKey (RFC 5480,
// Section 2.1.1). The id-ecPublicKey encoding is confusingly named: it is also
// used for private keys (RFC 5915). The |EVP_PKEY_id| value is |EVP_PKEY_EC|.
//
// Each function only supports the specified curve, but curves are not reflected
// in |EVP_PKEY_id|. The curve can be inspected with
// |EVP_PKEY_get_ec_curve_nid|.
OPENSSL_EXPORT const EVP_PKEY_ALG *EVP_pkey_ec_p224(void);
OPENSSL_EXPORT const EVP_PKEY_ALG *EVP_pkey_ec_p256(void);
OPENSSL_EXPORT const EVP_PKEY_ALG *EVP_pkey_ec_p384(void);
OPENSSL_EXPORT const EVP_PKEY_ALG *EVP_pkey_ec_p521(void);

// EVP_pkey_x25519 implements X25519 keys (RFC 7748), encoded as in RFC 8410.
// The |EVP_PKEY_id| value is |EVP_PKEY_X25519|.
OPENSSL_EXPORT const EVP_PKEY_ALG *EVP_pkey_x25519(void);

// EVP_pkey_ed25519 implements Ed25519 keys (RFC 8032), encoded as in RFC 8410.
// The |EVP_PKEY_id| value is |EVP_PKEY_ED25519|.
OPENSSL_EXPORT const EVP_PKEY_ALG *EVP_pkey_ed25519(void);

// EVP_pkey_ml_dsa_* implement ML-DSA keys, encoded as in
// draft-ietf-lamps-dilithium-certificates. The |EVP_PKEY_id| values are
// |EVP_PKEY_ML_DSA_*|. In the private key representation, only the "seed" form
// is serialized or parsed.
//
// To configure OpenSSL to output the standard "seed" form, configure the
// "ml-dsa.output_formats" provider parameter so that "seed-only" is first. This
// can be done programmatically with OpenSSL's
// |OSSL_PROVIDER_add_conf_parameter| function, or by passing "-provparam" to
// the command-line tool.
OPENSSL_EXPORT const EVP_PKEY_ALG *EVP_pkey_ml_dsa_44(void);
OPENSSL_EXPORT const EVP_PKEY_ALG *EVP_pkey_ml_dsa_65(void);
OPENSSL_EXPORT const EVP_PKEY_ALG *EVP_pkey_ml_dsa_87(void);

// EVP_pkey_dsa implements DSA keys, encoded as in RFC 3279, Section 2.3.2. The
// |EVP_PKEY_id| value is |EVP_PKEY_DSA|. This |EVP_PKEY_ALG| accepts all DSA
// parameters supported by BoringSSL.
//
// Keys of this type are not usable with any operations, though the underlying
// |DSA| object can be extracted with |EVP_PKEY_get0_DSA|. This key type is
// deprecated and only implemented for compatibility with legacy applications.
//
// TODO(crbug.com/42290364): We didn't wire up |EVP_PKEY_sign| and
// |EVP_PKEY_verify| just so it was auditable which callers used DSA. Once DSA
// is removed from the default SPKI and PKCS#8 parser and DSA users explicitly
// request |EVP_pkey_dsa|, we could change that.
OPENSSL_EXPORT const EVP_PKEY_ALG *EVP_pkey_dsa(void);

// EVP_pkey_rsa_pss_* implements RSASSA-PSS keys, encoded as id-RSASSA-PSS
// (RFC 4055, Section 3.1). The |EVP_PKEY_id| value is |EVP_PKEY_RSA_PSS|. Each
// |EVP_PKEY_ALG| only accepts keys whose parameters specify:
//
//  - A hashAlgorithm of the specified hash
//  - A maskGenAlgorithm of MGF1 with the specified hash
//  - A minimum saltLength of the specified hash's digest length
//  - A trailerField of one (must be omitted in the encoding)
//
// Keys of this type will only be usable with RSASSA-PSS with matching signature
// parameters.
//
// This algorithm type is not recommended. The id-RSASSA-PSS key type is not
// widely implemented. Using it negates any compatibility benefits of using RSA.
// More modern algorithms like ECDSA are more performant and more compatible
// than id-RSASSA-PSS keys. This key type also adds significant complexity to a
// system. It has a wide range of possible parameter sets, so any uses must
// ensure all components not only support id-RSASSA-PSS, but also the specific
// parameters chosen.
//
// Note the id-RSASSA-PSS key type is distinct from the RSASSA-PSS signature
// algorithm. The widely implemented id-rsaEncryption key type (|EVP_pkey_rsa|
// and |EVP_PKEY_RSA|) also supports RSASSA-PSS signatures.
//
// WARNING: Any |EVP_PKEY|s produced by this algorithm will return a non-NULL
// |RSA| object through |EVP_PKEY_get1_RSA| and |EVP_PKEY_get0_RSA|. This is
// dangerous as existing code may assume a non-NULL return implies the more
// common id-rsaEncryption key. Additionally, the operations on the underlying
// |RSA| object will not capture the RSA-PSS constraints, so callers risk
// misusing the key by calling these functions. Callers using this algorithm
// must use |EVP_PKEY_id| to distinguish |EVP_PKEY_RSA| and |EVP_PKEY_RSA_PSS|.
//
// WARNING: BoringSSL does not currently implement |RSA_get0_pss_params| with
// these keys. Callers that require this functionality should contact the
// BoringSSL team.
OPENSSL_EXPORT const EVP_PKEY_ALG *EVP_pkey_rsa_pss_sha256(void);
OPENSSL_EXPORT const EVP_PKEY_ALG *EVP_pkey_rsa_pss_sha384(void);
OPENSSL_EXPORT const EVP_PKEY_ALG *EVP_pkey_rsa_pss_sha512(void);


// Getting and setting concrete key types.
//
// The following functions get and set the underlying key representation in an
// |EVP_PKEY| object. The |set1| functions take an additional reference to the
// underlying key and return one on success or zero if |key| is NULL. The
// |assign| functions adopt the caller's reference and return one on success or
// zero if |key| is NULL. The |get1| functions return a fresh reference to the
// underlying object or NULL if |pkey| is not of the correct type. The |get0|
// functions behave the same but return a non-owning pointer.
//
// The |get0| and |get1| functions take |const| pointers and are thus
// non-mutating for thread-safety purposes, but mutating functions on the
// returned lower-level objects are considered to also mutate the |EVP_PKEY| and
// may not be called concurrently with other operations on the |EVP_PKEY|.
//
// WARNING: Matching OpenSSL, the RSA functions behave non-uniformly.
// |EVP_PKEY_set1_RSA| and |EVP_PKEY_assign_RSA| construct an |EVP_PKEY_RSA|
// key, while the |EVP_PKEY_get0_RSA| and |EVP_PKEY_get1_RSA| will return
// non-NULL for both |EVP_PKEY_RSA| and |EVP_PKEY_RSA_PSS|.
//
// This means callers risk misusing a key if they assume a non-NULL return from
// |EVP_PKEY_get0_RSA| or |EVP_PKEY_get1_RSA| implies |EVP_PKEY_RSA|. Prefer
// |EVP_PKEY_id| to check the type of a key. To reduce this risk, BoringSSL does
// not make |EVP_PKEY_RSA_PSS| available by default, only when callers opt in
// via |EVP_pkey_rsa_pss_sha256|. This differs from upstream OpenSSL, where
// callers are exposed to |EVP_PKEY_RSA_PSS| by default.

OPENSSL_EXPORT int EVP_PKEY_set1_RSA(EVP_PKEY *pkey, RSA *key);
OPENSSL_EXPORT int EVP_PKEY_assign_RSA(EVP_PKEY *pkey, RSA *key);
OPENSSL_EXPORT RSA *EVP_PKEY_get0_RSA(const EVP_PKEY *pkey);
OPENSSL_EXPORT RSA *EVP_PKEY_get1_RSA(const EVP_PKEY *pkey);

OPENSSL_EXPORT int EVP_PKEY_set1_DSA(EVP_PKEY *pkey, DSA *key);
OPENSSL_EXPORT int EVP_PKEY_assign_DSA(EVP_PKEY *pkey, DSA *key);
OPENSSL_EXPORT DSA *EVP_PKEY_get0_DSA(const EVP_PKEY *pkey);
OPENSSL_EXPORT DSA *EVP_PKEY_get1_DSA(const EVP_PKEY *pkey);

OPENSSL_EXPORT int EVP_PKEY_set1_EC_KEY(EVP_PKEY *pkey, EC_KEY *key);
OPENSSL_EXPORT int EVP_PKEY_assign_EC_KEY(EVP_PKEY *pkey, EC_KEY *key);
OPENSSL_EXPORT EC_KEY *EVP_PKEY_get0_EC_KEY(const EVP_PKEY *pkey);
OPENSSL_EXPORT EC_KEY *EVP_PKEY_get1_EC_KEY(const EVP_PKEY *pkey);

OPENSSL_EXPORT int EVP_PKEY_set1_DH(EVP_PKEY *pkey, DH *key);
OPENSSL_EXPORT int EVP_PKEY_assign_DH(EVP_PKEY *pkey, DH *key);
OPENSSL_EXPORT DH *EVP_PKEY_get0_DH(const EVP_PKEY *pkey);
OPENSSL_EXPORT DH *EVP_PKEY_get1_DH(const EVP_PKEY *pkey);


// ASN.1 functions

// EVP_PKEY_from_subject_public_key_info decodes a DER-encoded
// SubjectPublicKeyInfo structure (RFC 5280) from |in|. It returns a
// newly-allocated |EVP_PKEY| or NULL on error. Only the |num_algs| algorithms
// in |algs| will be considered when parsing.
OPENSSL_EXPORT EVP_PKEY *EVP_PKEY_from_subject_public_key_info(
    const uint8_t *in, size_t len, const EVP_PKEY_ALG *const *algs,
    size_t num_algs);

// EVP_parse_public_key decodes a DER-encoded SubjectPublicKeyInfo structure
// (RFC 5280) from |cbs| and advances |cbs|. It returns a newly-allocated
// |EVP_PKEY| or NULL on error.
//
// Prefer |EVP_PKEY_from_subject_public_key_info| instead. This function has
// several pitfalls:
//
// Callers are expected to handle trailing data returned from |cbs|, making more
// common cases error-prone.
//
// There is also no way to pass in supported algorithms. This function instead
// supports some default set of algorithms. Future versions of BoringSSL may add
// to this list, based on the needs of the other callers. Conversely, some
// algorithms may be intentionally omitted, if they cause too much risk to
// existing callers.
//
// This means callers must check the type of the parsed public key to ensure it
// is suitable and validate other desired key properties such as RSA modulus
// size or EC curve.
OPENSSL_EXPORT EVP_PKEY *EVP_parse_public_key(CBS *cbs);

// EVP_marshal_public_key marshals |key| as a DER-encoded SubjectPublicKeyInfo
// structure (RFC 5280) and appends the result to |cbb|. It returns one on
// success and zero on error.
OPENSSL_EXPORT int EVP_marshal_public_key(CBB *cbb, const EVP_PKEY *key);

// EVP_PKEY_from_private_key_info decodes a DER-encoded PrivateKeyInfo structure
// (RFC 5208) from |in|. It returns a newly-allocated |EVP_PKEY| or NULL on
// error. Only the |num_algs| algorithms in |algs| will be considered when
// parsing.
//
// A PrivateKeyInfo ends with an optional set of attributes. These are silently
// ignored.
OPENSSL_EXPORT EVP_PKEY *EVP_PKEY_from_private_key_info(
    const uint8_t *in, size_t len, const EVP_PKEY_ALG *const *algs,
    size_t num_algs);

// EVP_parse_private_key decodes a DER-encoded PrivateKeyInfo structure (RFC
// 5208) from |cbs| and advances |cbs|. It returns a newly-allocated |EVP_PKEY|
// or NULL on error.
//
// Prefer |EVP_PKEY_from_private_key_info| instead. This function has
// several pitfalls:
//
// Callers are expected to handle trailing data returned from |cbs|, making more
// common cases error-prone.
//
// There is also no way to pass in supported algorithms. This function instead
// supports some default set of algorithms. Future versions of BoringSSL may add
// to this list, based on the needs of the other callers. Conversely, some
// algorithms may be intentionally omitted, if they cause too much risk to
// existing callers.
//
// This means the caller must check the type of the parsed private key to ensure
// it is suitable and validate other desired key properties such as RSA modulus
// size or EC curve. In particular, RSA private key operations scale cubicly, so
// applications accepting RSA private keys from external sources may need to
// bound key sizes (use |EVP_PKEY_bits| or |RSA_bits|) to avoid a DoS vector.
//
// A PrivateKeyInfo ends with an optional set of attributes. These are silently
// ignored.
OPENSSL_EXPORT EVP_PKEY *EVP_parse_private_key(CBS *cbs);

// EVP_marshal_private_key marshals |key| as a DER-encoded PrivateKeyInfo
// structure (RFC 5208) and appends the result to |cbb|. It returns one on
// success and zero on error.
OPENSSL_EXPORT int EVP_marshal_private_key(CBB *cbb, const EVP_PKEY *key);


// Raw keys
//
// These functions give access to the "raw" type-specific public and private key
// formats. Algorithms with such formats are:
//
// - X25519, using the formats in RFC 7748.
//
// - Ed25519, using the formats in RFC 8032. Note the RFC 8032 private key
//   format is the 32-byte prefix of |ED25519_sign|'s 64-byte private key.
//
// - ML-DSA, using the formats in FIPS 204. The private key representation
//   supported by BoringSSL is the 32-byte "seed", defined in FIPS 204 as 𝜉, not
//   the larger expanded form. For OpenSSL compatibility, it is not used with
//   the |EVP_PKEY_from_raw_private_key| and |EVP_PKEY_get_raw_private_key|
//   APIs, but instead the |EVP_PKEY_from_private_seed| and
//   |EVP_PKEY_get_private_seed| APIs.
//
// These formats are suitable if serializing a key in a context where the
// algorithm is already known and there is no need to encode it.

// EVP_PKEY_from_raw_private_key interprets |in| as a raw private key of type
// |alg| and returns a newly-allocated |EVP_PKEY|, or nullptr on error.
OPENSSL_EXPORT EVP_PKEY *EVP_PKEY_from_raw_private_key(const EVP_PKEY_ALG *alg,
                                                       const uint8_t *in,
                                                       size_t len);

// EVP_PKEY_from_private_seed interprets |in| as a private seed of type |alg|
// and returns a newly-allocated |EVP_PKEY|, or nullptr on error.
OPENSSL_EXPORT EVP_PKEY *EVP_PKEY_from_private_seed(const EVP_PKEY_ALG *alg,
                                                    const uint8_t *in,
                                                    size_t len);

// EVP_PKEY_from_raw_public_key interprets |in| as a raw public key of type
// |alg| and returns a newly-allocated |EVP_PKEY|, or nullptr on error.
OPENSSL_EXPORT EVP_PKEY *EVP_PKEY_from_raw_public_key(const EVP_PKEY_ALG *alg,
                                                      const uint8_t *in,
                                                      size_t len);

// EVP_PKEY_get_raw_private_key outputs the private key for |pkey| in raw form.
// If |out| is NULL, it sets |*out_len| to the size of the raw private key.
// Otherwise, it writes at most |*out_len| bytes to |out| and sets |*out_len| to
// the number of bytes written.
//
// It returns one on success and zero if |pkey| has no private key, the key
// type does not support this format, or the buffer is too small.
OPENSSL_EXPORT int EVP_PKEY_get_raw_private_key(const EVP_PKEY *pkey,
                                                uint8_t *out, size_t *out_len);

// EVP_PKEY_get_private_seed outputs the private key for |pkey| as a private
// seed. If |out| is NULL, it sets |*out_len| to the size of the seed.
// Otherwise, it writes at most |*out_len| bytes to |out| and sets
// |*out_len| to the number of bytes written.
//
// It returns one on success and zero if |pkey| has no private key, the key
// type does not support this format, or the buffer is too small.
OPENSSL_EXPORT int EVP_PKEY_get_private_seed(const EVP_PKEY *pkey, uint8_t *out,
                                             size_t *out_len);

// EVP_PKEY_get_raw_public_key outputs the public key for |pkey| in raw form.
// If |out| is NULL, it sets |*out_len| to the size of the raw public key.
// Otherwise, it writes at most |*out_len| bytes to |out| and sets |*out_len| to
// the number of bytes written.
//
// It returns one on success and zero if |pkey| has no public key, the key
// type does not support this format, or the buffer is too small.
OPENSSL_EXPORT int EVP_PKEY_get_raw_public_key(const EVP_PKEY *pkey,
                                               uint8_t *out, size_t *out_len);


// Signing

// EVP_DigestSignInit sets up |ctx| for a signing operation with |type| and
// |pkey|. The |ctx| argument must have been initialised with
// |EVP_MD_CTX_init|. If |pctx| is not NULL, the |EVP_PKEY_CTX| of the signing
// operation will be written to |*pctx|; this can be used to set alternative
// signing options.
//
// For single-shot signing algorithms which do not use a pre-hash, such as
// Ed25519, |type| should be NULL. The |EVP_MD_CTX| itself is unused but is
// present so the API is uniform. See |EVP_DigestSign|.
//
// This function does not mutate |pkey| for thread-safety purposes and may be
// used concurrently with other non-mutating functions on |pkey|.
//
// It returns one on success, or zero on error.
OPENSSL_EXPORT int EVP_DigestSignInit(EVP_MD_CTX *ctx, EVP_PKEY_CTX **pctx,
                                      const EVP_MD *type, ENGINE *e,
                                      EVP_PKEY *pkey);

// EVP_DigestSignUpdate appends |len| bytes from |data| to the data which will
// be signed in |EVP_DigestSignFinal|. It returns one.
//
// This function performs a streaming signing operation and will fail for
// signature algorithms which do not support this. Use |EVP_DigestSign| for a
// single-shot operation.
OPENSSL_EXPORT int EVP_DigestSignUpdate(EVP_MD_CTX *ctx, const void *data,
                                        size_t len);

// EVP_DigestSignFinal signs the data that has been included by one or more
// calls to |EVP_DigestSignUpdate|. If |out_sig| is NULL then |*out_sig_len| is
// set to the maximum number of output bytes. Otherwise, on entry,
// |*out_sig_len| must contain the length of the |out_sig| buffer. If the call
// is successful, the signature is written to |out_sig| and |*out_sig_len| is
// set to its length.
//
// This function performs a streaming signing operation and will fail for
// signature algorithms which do not support this. Use |EVP_DigestSign| for a
// single-shot operation.
//
// It returns one on success, or zero on error.
OPENSSL_EXPORT int EVP_DigestSignFinal(EVP_MD_CTX *ctx, uint8_t *out_sig,
                                       size_t *out_sig_len);

// EVP_DigestSign signs |data_len| bytes from |data| using |ctx|. If |out_sig|
// is NULL then |*out_sig_len| is set to the maximum number of output
// bytes. Otherwise, on entry, |*out_sig_len| must contain the length of the
// |out_sig| buffer. If the call is successful, the signature is written to
// |out_sig| and |*out_sig_len| is set to its length.
//
// It returns one on success and zero on error.
OPENSSL_EXPORT int EVP_DigestSign(EVP_MD_CTX *ctx, uint8_t *out_sig,
                                  size_t *out_sig_len, const uint8_t *data,
                                  size_t data_len);


// Verifying

// EVP_DigestVerifyInit sets up |ctx| for a signature verification operation
// with |type| and |pkey|. The |ctx| argument must have been initialised with
// |EVP_MD_CTX_init|. If |pctx| is not NULL, the |EVP_PKEY_CTX| of the signing
// operation will be written to |*pctx|; this can be used to set alternative
// signing options.
//
// For single-shot signing algorithms which do not use a pre-hash, such as
// Ed25519, |type| should be NULL. The |EVP_MD_CTX| itself is unused but is
// present so the API is uniform. See |EVP_DigestVerify|.
//
// This function does not mutate |pkey| for thread-safety purposes and may be
// used concurrently with other non-mutating functions on |pkey|.
//
// It returns one on success, or zero on error.
OPENSSL_EXPORT int EVP_DigestVerifyInit(EVP_MD_CTX *ctx, EVP_PKEY_CTX **pctx,
                                        const EVP_MD *type, ENGINE *e,
                                        EVP_PKEY *pkey);

// EVP_DigestVerifyUpdate appends |len| bytes from |data| to the data which
// will be verified by |EVP_DigestVerifyFinal|. It returns one.
//
// This function performs streaming signature verification and will fail for
// signature algorithms which do not support this. Use |EVP_DigestVerify| for a
// single-shot verification.
OPENSSL_EXPORT int EVP_DigestVerifyUpdate(EVP_MD_CTX *ctx, const void *data,
                                          size_t len);

// EVP_DigestVerifyFinal verifies that |sig_len| bytes of |sig| are a valid
// signature for the data that has been included by one or more calls to
// |EVP_DigestVerifyUpdate|. It returns one on success and zero otherwise.
//
// This function performs streaming signature verification and will fail for
// signature algorithms which do not support this. Use |EVP_DigestVerify| for a
// single-shot verification.
OPENSSL_EXPORT int EVP_DigestVerifyFinal(EVP_MD_CTX *ctx, const uint8_t *sig,
                                         size_t sig_len);

// EVP_DigestVerify verifies that |sig_len| bytes from |sig| are a valid
// signature for |data|. It returns one on success or zero on error.
OPENSSL_EXPORT int EVP_DigestVerify(EVP_MD_CTX *ctx, const uint8_t *sig,
                                    size_t sig_len, const uint8_t *data,
                                    size_t len);


// Signing (old functions)

// EVP_SignInit_ex configures |ctx|, which must already have been initialised,
// for a fresh signing operation using the hash function |type|. It returns one
// on success and zero otherwise.
//
// (In order to initialise |ctx|, either obtain it initialised with
// |EVP_MD_CTX_create|, or use |EVP_MD_CTX_init|.)
OPENSSL_EXPORT int EVP_SignInit_ex(EVP_MD_CTX *ctx, const EVP_MD *type,
                                   ENGINE *impl);

// EVP_SignInit is a deprecated version of |EVP_SignInit_ex|.
//
// TODO(fork): remove.
OPENSSL_EXPORT int EVP_SignInit(EVP_MD_CTX *ctx, const EVP_MD *type);

// EVP_SignUpdate appends |len| bytes from |data| to the data which will be
// signed in |EVP_SignFinal|.
OPENSSL_EXPORT int EVP_SignUpdate(EVP_MD_CTX *ctx, const void *data,
                                  size_t len);

// EVP_SignFinal signs the data that has been included by one or more calls to
// |EVP_SignUpdate|, using the key |pkey|, and writes it to |sig|. On entry,
// |sig| must point to at least |EVP_PKEY_size(pkey)| bytes of space. The
// actual size of the signature is written to |*out_sig_len|.
//
// It returns one on success and zero otherwise.
//
// It does not modify |ctx|, thus it's possible to continue to use |ctx| in
// order to sign a longer message. It also does not mutate |pkey| for
// thread-safety purposes and may be used concurrently with other non-mutating
// functions on |pkey|.
OPENSSL_EXPORT int EVP_SignFinal(const EVP_MD_CTX *ctx, uint8_t *sig,
                                 unsigned int *out_sig_len, EVP_PKEY *pkey);


// Verifying (old functions)

// EVP_VerifyInit_ex configures |ctx|, which must already have been
// initialised, for a fresh signature verification operation using the hash
// function |type|. It returns one on success and zero otherwise.
//
// (In order to initialise |ctx|, either obtain it initialised with
// |EVP_MD_CTX_create|, or use |EVP_MD_CTX_init|.)
OPENSSL_EXPORT int EVP_VerifyInit_ex(EVP_MD_CTX *ctx, const EVP_MD *type,
                                     ENGINE *impl);

// EVP_VerifyInit is a deprecated version of |EVP_VerifyInit_ex|.
//
// TODO(fork): remove.
OPENSSL_EXPORT int EVP_VerifyInit(EVP_MD_CTX *ctx, const EVP_MD *type);

// EVP_VerifyUpdate appends |len| bytes from |data| to the data which will be
// signed in |EVP_VerifyFinal|.
OPENSSL_EXPORT int EVP_VerifyUpdate(EVP_MD_CTX *ctx, const void *data,
                                    size_t len);

// EVP_VerifyFinal verifies that |sig_len| bytes of |sig| are a valid
// signature, by |pkey|, for the data that has been included by one or more
// calls to |EVP_VerifyUpdate|.
//
// It returns one on success and zero otherwise.
//
// It does not modify |ctx|, thus it's possible to continue to use |ctx| in
// order to verify a longer message. It also does not mutate |pkey| for
// thread-safety purposes and may be used concurrently with other non-mutating
// functions on |pkey|.
OPENSSL_EXPORT int EVP_VerifyFinal(EVP_MD_CTX *ctx, const uint8_t *sig,
                                   size_t sig_len, EVP_PKEY *pkey);


// Printing

// EVP_PKEY_print_public prints a textual representation of the public key in
// |pkey| to |out|. Returns one on success or zero otherwise.
OPENSSL_EXPORT int EVP_PKEY_print_public(BIO *out, const EVP_PKEY *pkey,
                                         int indent, ASN1_PCTX *pctx);

// EVP_PKEY_print_private prints a textual representation of the private key in
// |pkey| to |out|. Returns one on success or zero otherwise.
OPENSSL_EXPORT int EVP_PKEY_print_private(BIO *out, const EVP_PKEY *pkey,
                                          int indent, ASN1_PCTX *pctx);

// EVP_PKEY_print_params prints a textual representation of the parameters in
// |pkey| to |out|. Returns one on success or zero otherwise.
OPENSSL_EXPORT int EVP_PKEY_print_params(BIO *out, const EVP_PKEY *pkey,
                                         int indent, ASN1_PCTX *pctx);


// Password stretching.
//
// Password stretching functions take a low-entropy password and apply a slow
// function that results in a key suitable for use in symmetric
// cryptography.

// PKCS5_PBKDF2_HMAC computes |iterations| iterations of PBKDF2 of |password|
// and |salt|, using |digest|, and outputs |key_len| bytes to |out_key|. It
// returns one on success and zero on allocation failure or if iterations is 0.
OPENSSL_EXPORT int PKCS5_PBKDF2_HMAC(const char *password, size_t password_len,
                                     const uint8_t *salt, size_t salt_len,
                                     uint32_t iterations, const EVP_MD *digest,
                                     size_t key_len, uint8_t *out_key);

// PKCS5_PBKDF2_HMAC_SHA1 is the same as PKCS5_PBKDF2_HMAC, but with |digest|
// fixed to |EVP_sha1|.
OPENSSL_EXPORT int PKCS5_PBKDF2_HMAC_SHA1(const char *password,
                                          size_t password_len,
                                          const uint8_t *salt, size_t salt_len,
                                          uint32_t iterations, size_t key_len,
                                          uint8_t *out_key);

// EVP_PBE_scrypt expands |password| into a secret key of length |key_len| using
// scrypt, as described in RFC 7914, and writes the result to |out_key|. It
// returns one on success and zero on allocation failure, if the memory required
// for the operation exceeds |max_mem|, or if any of the parameters are invalid
// as described below.
//
// |N|, |r|, and |p| are as described in RFC 7914 section 6. They determine the
// cost of the operation. If |max_mem| is zero, a default limit of 32MiB will be
// used.
//
// The parameters are considered invalid under any of the following conditions:
// - |r| or |p| are zero
// - |p| > (2^30 - 1) / |r|
// - |N| is not a power of two
// - |N| > 2^32
// - |N| > 2^(128 * |r| / 8)
OPENSSL_EXPORT int EVP_PBE_scrypt(const char *password, size_t password_len,
                                  const uint8_t *salt, size_t salt_len,
                                  uint64_t N, uint64_t r, uint64_t p,
                                  size_t max_mem, uint8_t *out_key,
                                  size_t key_len);


// Operations.
//
// |EVP_PKEY_CTX| objects hold the context for an operation (e.g. signing or
// encrypting) that uses an |EVP_PKEY|. They are used to configure
// algorithm-specific parameters for the operation before performing the
// operation. The general pattern for performing an operation in EVP is:
//
// 1. Construct an |EVP_PKEY_CTX|, either with |EVP_PKEY_CTX_new| (operations
//    using a key, like signing) or |EVP_PKEY_CTX_new_id| (operations not using
//    an existing key, like key generation).
//
// 2. Initialize it for an operation. For example, |EVP_PKEY_sign_init|
//    initializes an |EVP_PKEY_CTX| for signing.
//
// 3. Configure algorithm-specific parameters for the operation by calling
//    control functions on the |EVP_PKEY_CTX|. Some functions are generic, such
//    as |EVP_PKEY_CTX_set_signature_md|, and some are specific to an algorithm,
//    such as |EVP_PKEY_CTX_set_rsa_padding|.
//
// 4. Perform the operation. For example, |EVP_PKEY_sign| signs with the
//    corresponding parameters.
//
// 5. Release the |EVP_PKEY_CTX| with |EVP_PKEY_CTX_free|.
//
// Each |EVP_PKEY| algorithm interprets operations and parameters differently.
// Not all algorithms support all operations. Functions will fail if the
// algorithm does not support the parameter or operation.

// EVP_PKEY_CTX_new allocates a fresh |EVP_PKEY_CTX| for use with |pkey|. It
// returns the context or NULL on error.
OPENSSL_EXPORT EVP_PKEY_CTX *EVP_PKEY_CTX_new(EVP_PKEY *pkey, ENGINE *e);

// EVP_PKEY_CTX_new_id allocates a fresh |EVP_PKEY_CTX| for a key of type |id|
// (e.g. |EVP_PKEY_HMAC|). This can be used for key generation where
// |EVP_PKEY_CTX_new| can't be used because there isn't an |EVP_PKEY| to pass
// it. It returns the context or NULL on error.
OPENSSL_EXPORT EVP_PKEY_CTX *EVP_PKEY_CTX_new_id(int id, ENGINE *e);

// EVP_PKEY_CTX_free frees |ctx| and the data it owns.
OPENSSL_EXPORT void EVP_PKEY_CTX_free(EVP_PKEY_CTX *ctx);

// EVP_PKEY_CTX_dup allocates a fresh |EVP_PKEY_CTX| and sets it equal to the
// state of |ctx|. It returns the fresh |EVP_PKEY_CTX| or NULL on error.
OPENSSL_EXPORT EVP_PKEY_CTX *EVP_PKEY_CTX_dup(EVP_PKEY_CTX *ctx);

// EVP_PKEY_CTX_get0_pkey returns the |EVP_PKEY| associated with |ctx|.
OPENSSL_EXPORT EVP_PKEY *EVP_PKEY_CTX_get0_pkey(EVP_PKEY_CTX *ctx);

// EVP_PKEY_sign_init initialises an |EVP_PKEY_CTX| for a signing operation. It
// should be called before |EVP_PKEY_sign|.
//
// It returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_sign_init(EVP_PKEY_CTX *ctx);

// EVP_PKEY_sign signs |digest_len| bytes from |digest| using |ctx|. If |sig| is
// NULL, the maximum size of the signature is written to |out_sig_len|.
// Otherwise, |*sig_len| must contain the number of bytes of space available at
// |sig|. If sufficient, the signature will be written to |sig| and |*sig_len|
// updated with the true length. This function will fail for signature
// algorithms like Ed25519 that do not support signing pre-hashed inputs.
//
// WARNING: |digest| must be the output of some hash function on the data to be
// signed. Passing unhashed inputs will not result in a secure signature scheme.
// Use |EVP_DigestSignInit| to sign an unhashed input.
//
// WARNING: Setting |sig| to NULL only gives the maximum size of the
// signature. The actual signature may be smaller.
//
// It returns one on success or zero on error. (Note: this differs from
// OpenSSL, which can also return negative values to indicate an error. )
OPENSSL_EXPORT int EVP_PKEY_sign(EVP_PKEY_CTX *ctx, uint8_t *sig,
                                 size_t *sig_len, const uint8_t *digest,
                                 size_t digest_len);

// EVP_PKEY_verify_init initialises an |EVP_PKEY_CTX| for a signature
// verification operation. It should be called before |EVP_PKEY_verify|.
//
// It returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_verify_init(EVP_PKEY_CTX *ctx);

// EVP_PKEY_verify verifies that |sig_len| bytes from |sig| are a valid
// signature for |digest|. This function will fail for signature
// algorithms like Ed25519 that do not support signing pre-hashed inputs.
//
// WARNING: |digest| must be the output of some hash function on the data to be
// verified. Passing unhashed inputs will not result in a secure signature
// scheme. Use |EVP_DigestVerifyInit| to verify a signature given the unhashed
// input.
//
// It returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_verify(EVP_PKEY_CTX *ctx, const uint8_t *sig,
                                   size_t sig_len, const uint8_t *digest,
                                   size_t digest_len);

// EVP_PKEY_encrypt_init initialises an |EVP_PKEY_CTX| for an encryption
// operation. It should be called before |EVP_PKEY_encrypt|.
//
// It returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_encrypt_init(EVP_PKEY_CTX *ctx);

// EVP_PKEY_encrypt encrypts |in_len| bytes from |in|. If |out| is NULL, the
// maximum size of the ciphertext is written to |out_len|. Otherwise, |*out_len|
// must contain the number of bytes of space available at |out|. If sufficient,
// the ciphertext will be written to |out| and |*out_len| updated with the true
// length.
//
// WARNING: Setting |out| to NULL only gives the maximum size of the
// ciphertext. The actual ciphertext may be smaller.
//
// It returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_encrypt(EVP_PKEY_CTX *ctx, uint8_t *out,
                                    size_t *out_len, const uint8_t *in,
                                    size_t in_len);

// EVP_PKEY_decrypt_init initialises an |EVP_PKEY_CTX| for a decryption
// operation. It should be called before |EVP_PKEY_decrypt|.
//
// It returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_decrypt_init(EVP_PKEY_CTX *ctx);

// EVP_PKEY_decrypt decrypts |in_len| bytes from |in|. If |out| is NULL, the
// maximum size of the plaintext is written to |out_len|. Otherwise, |*out_len|
// must contain the number of bytes of space available at |out|. If sufficient,
// the ciphertext will be written to |out| and |*out_len| updated with the true
// length.
//
// WARNING: Setting |out| to NULL only gives the maximum size of the
// plaintext. The actual plaintext may be smaller.
//
// It returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_decrypt(EVP_PKEY_CTX *ctx, uint8_t *out,
                                    size_t *out_len, const uint8_t *in,
                                    size_t in_len);

// EVP_PKEY_verify_recover_init initialises an |EVP_PKEY_CTX| for a public-key
// decryption operation. It should be called before |EVP_PKEY_verify_recover|.
//
// Public-key decryption is a very obscure operation that is only implemented
// by RSA keys. It is effectively a signature verification operation that
// returns the signed message directly. It is almost certainly not what you
// want.
//
// It returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_verify_recover_init(EVP_PKEY_CTX *ctx);

// EVP_PKEY_verify_recover decrypts |sig_len| bytes from |sig|. If |out| is
// NULL, the maximum size of the plaintext is written to |out_len|. Otherwise,
// |*out_len| must contain the number of bytes of space available at |out|. If
// sufficient, the ciphertext will be written to |out| and |*out_len| updated
// with the true length.
//
// WARNING: Setting |out| to NULL only gives the maximum size of the
// plaintext. The actual plaintext may be smaller.
//
// See the warning about this operation in |EVP_PKEY_verify_recover_init|. It
// is probably not what you want.
//
// It returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_verify_recover(EVP_PKEY_CTX *ctx, uint8_t *out,
                                           size_t *out_len, const uint8_t *sig,
                                           size_t siglen);

// EVP_PKEY_derive_init initialises an |EVP_PKEY_CTX| for a key derivation
// operation. It should be called before |EVP_PKEY_derive_set_peer| and
// |EVP_PKEY_derive|.
//
// It returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_derive_init(EVP_PKEY_CTX *ctx);

// EVP_PKEY_derive_set_peer sets the peer's key to be used for key derivation
// by |ctx| to |peer|. It should be called after |EVP_PKEY_derive_init|. (For
// example, this is used to set the peer's key in (EC)DH.) It returns one on
// success and zero on error.
OPENSSL_EXPORT int EVP_PKEY_derive_set_peer(EVP_PKEY_CTX *ctx, EVP_PKEY *peer);

// EVP_PKEY_derive derives a shared key from |ctx|. If |key| is non-NULL then,
// on entry, |out_key_len| must contain the amount of space at |key|. If
// sufficient then the shared key will be written to |key| and |*out_key_len|
// will be set to the length. If |key| is NULL then |out_key_len| will be set to
// the maximum length.
//
// WARNING: Setting |out| to NULL only gives the maximum size of the key. The
// actual key may be smaller.
//
// It returns one on success and zero on error.
OPENSSL_EXPORT int EVP_PKEY_derive(EVP_PKEY_CTX *ctx, uint8_t *key,
                                   size_t *out_key_len);

// EVP_PKEY_keygen_init initialises an |EVP_PKEY_CTX| for a key generation
// operation. It should be called before |EVP_PKEY_keygen|.
//
// It returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_keygen_init(EVP_PKEY_CTX *ctx);

// EVP_PKEY_keygen performs a key generation operation using the values from
// |ctx|. If |*out_pkey| is non-NULL, it overwrites |*out_pkey| with the
// resulting key. Otherwise, it sets |*out_pkey| to a newly-allocated |EVP_PKEY|
// containing the result. It returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_keygen(EVP_PKEY_CTX *ctx, EVP_PKEY **out_pkey);

// EVP_PKEY_paramgen_init initialises an |EVP_PKEY_CTX| for a parameter
// generation operation. It should be called before |EVP_PKEY_paramgen|.
//
// It returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_paramgen_init(EVP_PKEY_CTX *ctx);

// EVP_PKEY_paramgen performs a parameter generation using the values from
// |ctx|. If |*out_pkey| is non-NULL, it overwrites |*out_pkey| with the
// resulting parameters, but no key. Otherwise, it sets |*out_pkey| to a
// newly-allocated |EVP_PKEY| containing the result. It returns one on success
// or zero on error.
OPENSSL_EXPORT int EVP_PKEY_paramgen(EVP_PKEY_CTX *ctx, EVP_PKEY **out_pkey);


// Generic control functions.

// EVP_PKEY_CTX_set_signature_md sets |md| as the digest to be used in a
// signature operation. It returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_CTX_set_signature_md(EVP_PKEY_CTX *ctx,
                                                 const EVP_MD *md);

// EVP_PKEY_CTX_get_signature_md sets |*out_md| to the digest to be used in a
// signature operation. It returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_CTX_get_signature_md(EVP_PKEY_CTX *ctx,
                                                 const EVP_MD **out_md);


// RSA specific control functions.

// EVP_PKEY_CTX_set_rsa_padding sets the padding type to use. It should be one
// of the |RSA_*_PADDING| values. Returns one on success or zero on error. By
// default, the padding is |RSA_PKCS1_PADDING|.
OPENSSL_EXPORT int EVP_PKEY_CTX_set_rsa_padding(EVP_PKEY_CTX *ctx, int padding);

// EVP_PKEY_CTX_get_rsa_padding sets |*out_padding| to the current padding
// value, which is one of the |RSA_*_PADDING| values. Returns one on success or
// zero on error.
OPENSSL_EXPORT int EVP_PKEY_CTX_get_rsa_padding(EVP_PKEY_CTX *ctx,
                                                int *out_padding);

// EVP_PKEY_CTX_set_rsa_pss_saltlen sets the length of the salt in a PSS-padded
// signature. A value of |RSA_PSS_SALTLEN_DIGEST| causes the salt to be the same
// length as the digest in the signature. A value of |RSA_PSS_SALTLEN_AUTO|
// causes the salt to be the maximum length that will fit when signing and
// recovered from the signature when verifying. Otherwise the value gives the
// size of the salt in bytes.
//
// If unsure, use |RSA_PSS_SALTLEN_DIGEST|, which is the default. Note this
// differs from OpenSSL, which defaults to |RSA_PSS_SALTLEN_AUTO|.
//
// Returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_CTX_set_rsa_pss_saltlen(EVP_PKEY_CTX *ctx,
                                                    int salt_len);

// EVP_PKEY_CTX_get_rsa_pss_saltlen sets |*out_salt_len| to the salt length of
// a PSS-padded signature. See the documentation for
// |EVP_PKEY_CTX_set_rsa_pss_saltlen| for details of the special values that it
// can take.
//
// Returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_CTX_get_rsa_pss_saltlen(EVP_PKEY_CTX *ctx,
                                                    int *out_salt_len);

// EVP_PKEY_CTX_set_rsa_keygen_bits sets the size of the desired RSA modulus,
// in bits, for key generation. Returns one on success or zero on
// error.
OPENSSL_EXPORT int EVP_PKEY_CTX_set_rsa_keygen_bits(EVP_PKEY_CTX *ctx,
                                                    int bits);

// EVP_PKEY_CTX_set_rsa_keygen_pubexp sets |e| as the public exponent for key
// generation. Returns one on success or zero on error. On success, |ctx| takes
// ownership of |e|. The library will then call |BN_free| on |e| when |ctx| is
// destroyed.
OPENSSL_EXPORT int EVP_PKEY_CTX_set_rsa_keygen_pubexp(EVP_PKEY_CTX *ctx,
                                                      BIGNUM *e);

// EVP_PKEY_CTX_set_rsa_oaep_md sets |md| as the digest used in OAEP padding.
// Returns one on success or zero on error. If unset, the default is SHA-1.
// Callers are recommended to overwrite this default.
//
// TODO(davidben): Remove the default and require callers specify this.
OPENSSL_EXPORT int EVP_PKEY_CTX_set_rsa_oaep_md(EVP_PKEY_CTX *ctx,
                                                const EVP_MD *md);

// EVP_PKEY_CTX_get_rsa_oaep_md sets |*out_md| to the digest function used in
// OAEP padding. Returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_CTX_get_rsa_oaep_md(EVP_PKEY_CTX *ctx,
                                                const EVP_MD **out_md);

// EVP_PKEY_CTX_set_rsa_mgf1_md sets |md| as the digest used in MGF1. Returns
// one on success or zero on error.
//
// If unset, the default is the signing hash for |RSA_PKCS1_PSS_PADDING| and the
// OAEP hash for |RSA_PKCS1_OAEP_PADDING|. Callers are recommended to use this
// default and not call this function.
OPENSSL_EXPORT int EVP_PKEY_CTX_set_rsa_mgf1_md(EVP_PKEY_CTX *ctx,
                                                const EVP_MD *md);

// EVP_PKEY_CTX_get_rsa_mgf1_md sets |*out_md| to the digest function used in
// MGF1. Returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_CTX_get_rsa_mgf1_md(EVP_PKEY_CTX *ctx,
                                                const EVP_MD **out_md);

// EVP_PKEY_CTX_set0_rsa_oaep_label sets |label_len| bytes from |label| as the
// label used in OAEP. DANGER: On success, this call takes ownership of |label|
// and will call |OPENSSL_free| on it when |ctx| is destroyed.
//
// Returns one on success or zero on error.
OPENSSL_EXPORT int EVP_PKEY_CTX_set0_rsa_oaep_label(EVP_PKEY_CTX *ctx,
                                                    uint8_t *label,
                                                    size_t label_len);

// EVP_PKEY_CTX_get0_rsa_oaep_label sets |*out_label| to point to the internal
// buffer containing the OAEP label (which may be NULL) and returns the length
// of the label or a negative value on error.
//
// WARNING: the return value differs from the usual return value convention.
OPENSSL_EXPORT int EVP_PKEY_CTX_get0_rsa_oaep_label(EVP_PKEY_CTX *ctx,
                                                    const uint8_t **out_label);


// EC specific control functions.

// EVP_PKEY_get_ec_curve_nid returns |pkey|'s curve as a NID constant, such as
// |NID_X9_62_prime256v1|, or |NID_undef| if |pkey| is not an EC key.
OPENSSL_EXPORT int EVP_PKEY_get_ec_curve_nid(const EVP_PKEY *pkey);

// EVP_PKEY_get_ec_point_conv_form returns |pkey|'s point conversion form as a
// |POINT_CONVERSION_*| constant, or zero if |pkey| is not an EC key.
OPENSSL_EXPORT int EVP_PKEY_get_ec_point_conv_form(const EVP_PKEY *pkey);

// EVP_PKEY_CTX_set_ec_paramgen_curve_nid sets the curve used for
// |EVP_PKEY_keygen| or |EVP_PKEY_paramgen| operations to |nid|. It returns one
// on success and zero on error.
OPENSSL_EXPORT int EVP_PKEY_CTX_set_ec_paramgen_curve_nid(EVP_PKEY_CTX *ctx,
                                                          int nid);


// Diffie-Hellman-specific control functions.

// EVP_PKEY_CTX_set_dh_pad configures configures whether |ctx|, which must be an
// |EVP_PKEY_derive| operation, configures the handling of leading zeros in the
// Diffie-Hellman shared secret. If |pad| is zero, leading zeros are removed
// from the secret. If |pad| is non-zero, the fixed-width shared secret is used
// unmodified, as in PKCS #3. If this function is not called, the default is to
// remove leading zeros.
//
// WARNING: The behavior when |pad| is zero leaks information about the shared
// secret. This may result in side channel attacks such as
// https://raccoon-attack.com/, particularly when the same private key is used
// for multiple operations.
OPENSSL_EXPORT int EVP_PKEY_CTX_set_dh_pad(EVP_PKEY_CTX *ctx, int pad);


// Deprecated functions.

// EVP_PKEY_RSA2 was historically an alternate form for RSA public keys (OID
// 2.5.8.1.1), but is no longer accepted.
#define EVP_PKEY_RSA2 NID_rsa

// EVP_PKEY_X448 is defined for OpenSSL compatibility, but we do not support
// X448 and attempts to create keys will fail.
#define EVP_PKEY_X448 NID_X448

// EVP_PKEY_ED448 is defined for OpenSSL compatibility, but we do not support
// Ed448 and attempts to create keys will fail.
#define EVP_PKEY_ED448 NID_ED448

// EVP_PKEY_get0 returns NULL. This function is provided for compatibility with
// OpenSSL but does not return anything. Use the typed |EVP_PKEY_get0_*|
// functions instead.
OPENSSL_EXPORT void *EVP_PKEY_get0(const EVP_PKEY *pkey);

// OpenSSL_add_all_algorithms does nothing.
OPENSSL_EXPORT void OpenSSL_add_all_algorithms(void);

// OPENSSL_add_all_algorithms_conf does nothing.
OPENSSL_EXPORT void OPENSSL_add_all_algorithms_conf(void);

// OpenSSL_add_all_ciphers does nothing.
OPENSSL_EXPORT void OpenSSL_add_all_ciphers(void);

// OpenSSL_add_all_digests does nothing.
OPENSSL_EXPORT void OpenSSL_add_all_digests(void);

// EVP_cleanup does nothing.
OPENSSL_EXPORT void EVP_cleanup(void);

OPENSSL_EXPORT void EVP_CIPHER_do_all_sorted(
    void (*callback)(const EVP_CIPHER *cipher, const char *name,
                     const char *unused, void *arg),
    void *arg);

OPENSSL_EXPORT void EVP_MD_do_all_sorted(void (*callback)(const EVP_MD *cipher,
                                                          const char *name,
                                                          const char *unused,
                                                          void *arg),
                                         void *arg);

OPENSSL_EXPORT void EVP_MD_do_all(void (*callback)(const EVP_MD *cipher,
                                                   const char *name,
                                                   const char *unused,
                                                   void *arg),
                                  void *arg);

// i2d_PrivateKey marshals a private key from |key| to type-specific format, as
// described in |i2d_SAMPLE|.
//
// RSA keys are serialized as a DER-encoded RSAPublicKey (RFC 8017) structure.
// EC keys are serialized as a DER-encoded ECPrivateKey (RFC 5915) structure.
//
// Use |RSA_marshal_private_key| or |EC_KEY_marshal_private_key| instead.
OPENSSL_EXPORT int i2d_PrivateKey(const EVP_PKEY *key, uint8_t **outp);

// i2d_PublicKey marshals a public key from |key| to a type-specific format, as
// described in |i2d_SAMPLE|.
//
// RSA keys are serialized as a DER-encoded RSAPublicKey (RFC 8017) structure.
// EC keys are serialized as an EC point per SEC 1.
//
// Use |RSA_marshal_public_key| or |EC_POINT_point2cbb| instead.
OPENSSL_EXPORT int i2d_PublicKey(const EVP_PKEY *key, uint8_t **outp);

// d2i_PrivateKey parses a DER-encoded private key from |len| bytes at |*inp|,
// as described in |d2i_SAMPLE|. The private key must have type |type|,
// otherwise it will be rejected.
//
// This function tries to detect one of several formats. Instead, use
// |EVP_parse_private_key| for a PrivateKeyInfo, |RSA_parse_private_key| for an
// RSAPrivateKey, and |EC_parse_private_key| for an ECPrivateKey.
OPENSSL_EXPORT EVP_PKEY *d2i_PrivateKey(int type, EVP_PKEY **out,
                                        const uint8_t **inp, long len);

// d2i_AutoPrivateKey acts the same as |d2i_PrivateKey|, but detects the type
// of the private key.
//
// This function tries to detect one of several formats. Instead, use
// |EVP_parse_private_key| for a PrivateKeyInfo, |RSA_parse_private_key| for an
// RSAPrivateKey, and |EC_parse_private_key| for an ECPrivateKey.
OPENSSL_EXPORT EVP_PKEY *d2i_AutoPrivateKey(EVP_PKEY **out, const uint8_t **inp,
                                            long len);

// d2i_PublicKey parses a public key from |len| bytes at |*inp| in a type-
// specific format specified by |type|, as described in |d2i_SAMPLE|.
//
// The only supported value for |type| is |EVP_PKEY_RSA|, which parses a
// DER-encoded RSAPublicKey (RFC 8017) structure. Parsing EC keys is not
// supported by this function.
//
// Use |RSA_parse_public_key| instead.
OPENSSL_EXPORT EVP_PKEY *d2i_PublicKey(int type, EVP_PKEY **out,
                                       const uint8_t **inp, long len);

// EVP_PKEY_CTX_set_ec_param_enc returns one if |encoding| is
// |OPENSSL_EC_NAMED_CURVE| or zero with an error otherwise.
OPENSSL_EXPORT int EVP_PKEY_CTX_set_ec_param_enc(EVP_PKEY_CTX *ctx,
                                                 int encoding);

// EVP_PKEY_set_type sets the type of |pkey| to |type|. It returns one if
// successful or zero if the |type| argument is not one of the |EVP_PKEY_*|
// values supported for use with this function. If |pkey| is NULL, it simply
// reports whether the type is known.
//
// There are very few cases where this function is useful. Changing |pkey|'s
// type clears any previously stored keys, so there is no benefit to loading a
// key and then changing its type. Although |pkey| is left with a type
// configured, it has no key, and functions which set a key, such as
// |EVP_PKEY_set1_RSA|, will configure a type anyway. If writing unit tests that
// are only sensitive to the type of a key, it is preferable to construct a real
// key, so that tests are more representative of production code.
//
// The only API pattern which requires this function is
// |EVP_PKEY_set1_tls_encodedpoint| with X25519, which requires a half-empty
// |EVP_PKEY| that was first configured with |EVP_PKEY_X25519|. Currently, all
// other values of |type| will result in an error.
OPENSSL_EXPORT int EVP_PKEY_set_type(EVP_PKEY *pkey, int type);

// EVP_PKEY_set1_tls_encodedpoint replaces |pkey| with a public key encoded by
// |in|. It returns one on success and zero on error.
//
// If |pkey| is an EC key, the format is an X9.62 point and |pkey| must already
// have an EC group configured. If it is an X25519 key, it is the 32-byte X25519
// public key representation. This function is not supported for other key types
// and will fail.
OPENSSL_EXPORT int EVP_PKEY_set1_tls_encodedpoint(EVP_PKEY *pkey,
                                                  const uint8_t *in,
                                                  size_t len);

// EVP_PKEY_get1_tls_encodedpoint sets |*out_ptr| to a newly-allocated buffer
// containing the raw encoded public key for |pkey|. The caller must call
// |OPENSSL_free| to release this buffer. The function returns the length of the
// buffer on success and zero on error.
//
// If |pkey| is an EC key, the format is an X9.62 point with uncompressed
// coordinates. If it is an X25519 key, it is the 32-byte X25519 public key
// representation. This function is not supported for other key types and will
// fail.
OPENSSL_EXPORT size_t EVP_PKEY_get1_tls_encodedpoint(const EVP_PKEY *pkey,
                                                     uint8_t **out_ptr);

// EVP_PKEY_base_id calls |EVP_PKEY_id|.
OPENSSL_EXPORT int EVP_PKEY_base_id(const EVP_PKEY *pkey);

// EVP_PKEY_CTX_set_rsa_pss_keygen_md returns 0.
OPENSSL_EXPORT int EVP_PKEY_CTX_set_rsa_pss_keygen_md(EVP_PKEY_CTX *ctx,
                                                      const EVP_MD *md);

// EVP_PKEY_CTX_set_rsa_pss_keygen_saltlen returns 0.
OPENSSL_EXPORT int EVP_PKEY_CTX_set_rsa_pss_keygen_saltlen(EVP_PKEY_CTX *ctx,
                                                           int salt_len);

// EVP_PKEY_CTX_set_rsa_pss_keygen_mgf1_md returns 0.
OPENSSL_EXPORT int EVP_PKEY_CTX_set_rsa_pss_keygen_mgf1_md(EVP_PKEY_CTX *ctx,
                                                           const EVP_MD *md);

// i2d_PUBKEY marshals |pkey| as a DER-encoded SubjectPublicKeyInfo, as
// described in |i2d_SAMPLE|.
//
// Use |EVP_marshal_public_key| instead.
OPENSSL_EXPORT int i2d_PUBKEY(const EVP_PKEY *pkey, uint8_t **outp);

// d2i_PUBKEY parses a DER-encoded SubjectPublicKeyInfo from |len| bytes at
// |*inp|, as described in |d2i_SAMPLE|.
//
// Use |EVP_parse_public_key| instead.
OPENSSL_EXPORT EVP_PKEY *d2i_PUBKEY(EVP_PKEY **out, const uint8_t **inp,
                                    long len);

// i2d_RSA_PUBKEY marshals |rsa| as a DER-encoded SubjectPublicKeyInfo
// structure, as described in |i2d_SAMPLE|.
//
// Use |EVP_marshal_public_key| instead.
OPENSSL_EXPORT int i2d_RSA_PUBKEY(const RSA *rsa, uint8_t **outp);

// d2i_RSA_PUBKEY parses an RSA public key as a DER-encoded SubjectPublicKeyInfo
// from |len| bytes at |*inp|, as described in |d2i_SAMPLE|.
// SubjectPublicKeyInfo structures containing other key types are rejected.
//
// Use |EVP_parse_public_key| instead.
OPENSSL_EXPORT RSA *d2i_RSA_PUBKEY(RSA **out, const uint8_t **inp, long len);

// i2d_DSA_PUBKEY marshals |dsa| as a DER-encoded SubjectPublicKeyInfo, as
// described in |i2d_SAMPLE|.
//
// Use |EVP_marshal_public_key| instead.
OPENSSL_EXPORT int i2d_DSA_PUBKEY(const DSA *dsa, uint8_t **outp);

// d2i_DSA_PUBKEY parses a DSA public key as a DER-encoded SubjectPublicKeyInfo
// from |len| bytes at |*inp|, as described in |d2i_SAMPLE|.
// SubjectPublicKeyInfo structures containing other key types are rejected.
//
// Use |EVP_parse_public_key| instead.
OPENSSL_EXPORT DSA *d2i_DSA_PUBKEY(DSA **out, const uint8_t **inp, long len);

// i2d_EC_PUBKEY marshals |ec_key| as a DER-encoded SubjectPublicKeyInfo, as
// described in |i2d_SAMPLE|.
//
// Use |EVP_marshal_public_key| instead.
OPENSSL_EXPORT int i2d_EC_PUBKEY(const EC_KEY *ec_key, uint8_t **outp);

// d2i_EC_PUBKEY parses an EC public key as a DER-encoded SubjectPublicKeyInfo
// from |len| bytes at |*inp|, as described in |d2i_SAMPLE|.
// SubjectPublicKeyInfo structures containing other key types are rejected.
//
// Use |EVP_parse_public_key| instead.
OPENSSL_EXPORT EC_KEY *d2i_EC_PUBKEY(EC_KEY **out, const uint8_t **inp,
                                     long len);

// EVP_PKEY_CTX_set_dsa_paramgen_bits returns zero.
OPENSSL_EXPORT int EVP_PKEY_CTX_set_dsa_paramgen_bits(EVP_PKEY_CTX *ctx,
                                                      int nbits);

// EVP_PKEY_CTX_set_dsa_paramgen_q_bits returns zero.
OPENSSL_EXPORT int EVP_PKEY_CTX_set_dsa_paramgen_q_bits(EVP_PKEY_CTX *ctx,
                                                        int qbits);

// EVP_PKEY_assign sets the underlying key of |pkey| to |key|, which must be of
// the given type. If successful, it returns one. If the |type| argument
// is not one of |EVP_PKEY_RSA|, |EVP_PKEY_DSA|, or |EVP_PKEY_EC| values or if
// |key| is NULL, it returns zero. This function may not be used with other
// |EVP_PKEY_*| types.
//
// Use the |EVP_PKEY_assign_*| functions instead.
OPENSSL_EXPORT int EVP_PKEY_assign(EVP_PKEY *pkey, int type, void *key);

// EVP_PKEY_type returns |nid|.
OPENSSL_EXPORT int EVP_PKEY_type(int nid);

// EVP_PKEY_new_raw_private_key interprets |in| as a raw private key of type
// |type|, which must be an |EVP_PKEY_*| constant, such as |EVP_PKEY_X25519|,
// and returns a newly-allocated |EVP_PKEY|, or nullptr on error.
//
// Prefer |EVP_PKEY_from_raw_private_key|, which allows dead code elimination to
// discard algorithms that aren't reachable from the caller.
OPENSSL_EXPORT EVP_PKEY *EVP_PKEY_new_raw_private_key(int type, ENGINE *unused,
                                                      const uint8_t *in,
                                                      size_t len);

// EVP_PKEY_new_raw_public_key interprets |in| as a raw public key of type
// |type|, which must be an |EVP_PKEY_*| constant, such as |EVP_PKEY_X25519|,
// and returns a newly-allocated |EVP_PKEY|, or nullptr on error.
//
// Prefer |EVP_PKEY_from_raw_private_key|, which allows dead code elimination to
// discard algorithms that aren't reachable from the caller.
OPENSSL_EXPORT EVP_PKEY *EVP_PKEY_new_raw_public_key(int type, ENGINE *unused,
                                                     const uint8_t *in,
                                                     size_t len);


// Preprocessor compatibility section (hidden).
//
// Historically, a number of APIs were implemented in OpenSSL as macros and
// constants to 'ctrl' functions. To avoid breaking #ifdefs in consumers, this
// section defines a number of legacy macros.

// |BORINGSSL_PREFIX| already makes each of these symbols into macros, so there
// is no need to define conflicting macros.
#if !defined(BORINGSSL_PREFIX)
#define EVP_PKEY_CTX_set_rsa_oaep_md EVP_PKEY_CTX_set_rsa_oaep_md
#define EVP_PKEY_CTX_set0_rsa_oaep_label EVP_PKEY_CTX_set0_rsa_oaep_label
#endif


// Nodejs compatibility section (hidden).
//
// These defines exist for node.js, with the hope that we can eliminate the
// need for them over time.

#define EVPerr(function, reason) \
  ERR_put_error(ERR_LIB_EVP, 0, reason, __FILE__, __LINE__)


#if defined(__cplusplus)
}  // extern C

extern "C++" {
BSSL_NAMESPACE_BEGIN

BORINGSSL_MAKE_DELETER(EVP_PKEY, EVP_PKEY_free)
BORINGSSL_MAKE_UP_REF(EVP_PKEY, EVP_PKEY_up_ref)
BORINGSSL_MAKE_DELETER(EVP_PKEY_CTX, EVP_PKEY_CTX_free)

BSSL_NAMESPACE_END

}  // extern C++

#endif

#endif  // OPENSSL_HEADER_EVP_H
