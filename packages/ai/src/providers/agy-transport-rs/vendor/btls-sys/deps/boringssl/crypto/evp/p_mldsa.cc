// Copyright 2025 The BoringSSL Authors
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

#include <openssl/evp.h>

#include <assert.h>

#include <openssl/bytestring.h>
#include <openssl/err.h>
#include <openssl/nid.h>
#include <openssl/mldsa.h>
#include <openssl/span.h>

#include "../fipsmodule/bcm_interface.h"
#include "../mem_internal.h"
#include "internal.h"

namespace {

constexpr CBS_ASN1_TAG kSeedTag = CBS_ASN1_CONTEXT_SPECIFIC | 0;

constexpr uint8_t kMLDSA44OID[] = {OBJ_ENC_ML_DSA_44};
constexpr uint8_t kMLDSA65OID[] = {OBJ_ENC_ML_DSA_65};
constexpr uint8_t kMLDSA87OID[] = {OBJ_ENC_ML_DSA_87};

// We must generate EVP bindings for three ML-DSA algorithms. Define a traits
// type that captures the functions and other parameters of an ML-DSA algorithm.
#define MAKE_MLDSA_TRAITS(kl)                                                 \
  struct MLDSA##kl##Traits {                                                  \
    using PublicKey = MLDSA##kl##_public_key;                                 \
    using PrivateKey = MLDSA##kl##_private_key;                               \
    static constexpr size_t kPublicKeyBytes = MLDSA##kl##_PUBLIC_KEY_BYTES;   \
    static constexpr size_t kSignatureBytes = MLDSA##kl##_SIGNATURE_BYTES;    \
    static constexpr int kType = EVP_PKEY_ML_DSA_##kl;                        \
    static constexpr bssl::Span<const uint8_t> kOID = kMLDSA##kl##OID;        \
    static constexpr auto PrivateKeyFromSeed =                                \
        &MLDSA##kl##_private_key_from_seed;                                   \
    static constexpr auto Sign = &MLDSA##kl##_sign;                           \
    static constexpr auto ParsePublicKey = &MLDSA##kl##_parse_public_key;     \
    static constexpr auto PublicOfPrivate =                                   \
        &BCM_mldsa##kl##_public_of_private;                                   \
    static constexpr auto MarshalPublicKey = &MLDSA##kl##_marshal_public_key; \
    static constexpr auto PublicKeysEqual =                                   \
        &BCM_mldsa##kl##_public_keys_equal;                                   \
    static constexpr auto Verify = &MLDSA##kl##_verify;                       \
  };

MAKE_MLDSA_TRAITS(44)
MAKE_MLDSA_TRAITS(65)
MAKE_MLDSA_TRAITS(87)

// For each ML-DSA variant, the |EVP_PKEY| must hold a public or private key.
// EVP uses the same type for public and private keys, so the representation
// must support both. The private key type contains the public key struct in it,
// so we use a pointer to either a PrivateKeyData<Traits> or
// PublicKeyData<Traits>, with a common base class to dispatch between them.
//
// TODO(crbug.com/404286922): In C++20, we need fewer |typename|s in front of
// dependent type names.

template <typename Traits>
class PrivateKeyData;

template <typename Traits>
class KeyData {
 public:
  // Returns the underlying public key for the key.
  const typename Traits::PublicKey *GetPublicKey() const;

  // Returns the PrivateKeyData struct for the key, or nullptr if this is a
  // public key.
  PrivateKeyData<Traits> *AsPrivateKeyData();
  const PrivateKeyData<Traits> *AsPrivateKeyData() const {
    return const_cast<KeyData *>(this)->AsPrivateKeyData();
  }

  // A KeyData cannot be freed directly. Rather, it must use this wrapper which
  // calls the correct subclass's destructor.
  static void Free(KeyData *data);

 protected:
  explicit KeyData(bool is_private) : is_private_(is_private) {}
  ~KeyData() = default;
  bool is_private_;
};

template <typename Traits>
class PublicKeyData : public KeyData<Traits> {
 public:
  enum { kAllowUniquePtr = true };
  PublicKeyData() : KeyData<Traits>(/*is_private=*/false) {}
  typename Traits::PublicKey pub;
};

template <typename Traits>
class PrivateKeyData : public KeyData<Traits> {
 public:
  enum { kAllowUniquePtr = true };
  PrivateKeyData() : KeyData<Traits>(/*is_private=*/true) {}
  typename Traits::PrivateKey priv;
  uint8_t seed[MLDSA_SEED_BYTES];
};

template <typename Traits>
const typename Traits::PublicKey *KeyData<Traits>::GetPublicKey() const {
  auto *priv_data = AsPrivateKeyData();
  if (priv_data != nullptr) {
    return Traits::PublicOfPrivate(&priv_data->priv);
  }
  return &static_cast<const PublicKeyData<Traits> *>(this)->pub;
}

template <typename Traits>
PrivateKeyData<Traits> *KeyData<Traits>::AsPrivateKeyData() {
  if (is_private_) {
    return static_cast<PrivateKeyData<Traits> *>(this);
  }
  return nullptr;
}

template <typename Traits>
void KeyData<Traits>::Free(KeyData<Traits> *data) {
  if (data == nullptr) {
    return;
  }
  // Delete the more specific subclass. This is moot for now, because neither
  // type has a non-trivial destructor.
  auto *priv_data = data->AsPrivateKeyData();
  if (priv_data) {
    bssl::Delete(priv_data);
  } else {
    bssl::Delete(static_cast<PublicKeyData<Traits> *>(data));
  }
}

// Finally, MLDSAImplementation instantiates the methods themselves.

template <typename Traits>
struct MLDSAImplementation {
  static KeyData<Traits> *GetKeyData(EVP_PKEY *pkey) {
    assert(pkey->ameth == &asn1_method);
    return static_cast<KeyData<Traits> *>(pkey->pkey);
  }

  static const KeyData<Traits> *GetKeyData(const EVP_PKEY *pkey) {
    return GetKeyData(const_cast<EVP_PKEY *>(pkey));
  }

  static void PkeyFree(EVP_PKEY *pkey) {
    KeyData<Traits>::Free(GetKeyData(pkey));
    pkey->pkey = nullptr;
  }

  static int SetPrivateSeed(EVP_PKEY *pkey, const uint8_t *in, size_t len) {
    auto priv = bssl::MakeUnique<PrivateKeyData<Traits>>();
    if (priv == nullptr) {
      return 0;
    }

    if (len != MLDSA_SEED_BYTES ||
        !Traits::PrivateKeyFromSeed(&priv->priv, in, len)) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
      return 0;
    }
    OPENSSL_memcpy(priv->seed, in, len);
    evp_pkey_set0(pkey, &asn1_method, priv.release());
    return 1;
  }

  static int SetRawPublic(EVP_PKEY *pkey, const uint8_t *in, size_t len) {
    auto pub = bssl::MakeUnique<PublicKeyData<Traits>>();
    if (pub == nullptr) {
      return 0;
    }
    CBS cbs;
    CBS_init(&cbs, in, len);
    if (!Traits::ParsePublicKey(&pub->pub, &cbs) || CBS_len(&cbs) != 0) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
      return 0;
    }
    evp_pkey_set0(pkey, &asn1_method, pub.release());
    return 1;
  }

  static int GetPrivateSeed(const EVP_PKEY *pkey, uint8_t *out,
                            size_t *out_len) {
    const auto *priv = GetKeyData(pkey)->AsPrivateKeyData();
    if (priv == nullptr) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_NOT_A_PRIVATE_KEY);
      return 0;
    }
    if (out == nullptr) {
      *out_len = MLDSA_SEED_BYTES;
      return 1;
    }
    if (*out_len < MLDSA_SEED_BYTES) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_BUFFER_TOO_SMALL);
      return 0;
    }
    OPENSSL_memcpy(out, priv->seed, MLDSA_SEED_BYTES);
    *out_len = MLDSA_SEED_BYTES;
    return 1;
  }

  static int GetRawPublic(const EVP_PKEY *pkey, uint8_t *out, size_t *out_len) {
    const auto *pub = GetKeyData(pkey)->GetPublicKey();
    if (out == nullptr) {
      *out_len = Traits::kPublicKeyBytes;
      return 1;
    }
    if (*out_len < Traits::kPublicKeyBytes) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_BUFFER_TOO_SMALL);
      return 0;
    }
    CBB cbb;
    CBB_init_fixed(&cbb, out, Traits::kPublicKeyBytes);
    BSSL_CHECK(Traits::MarshalPublicKey(&cbb, pub));
    BSSL_CHECK(CBB_len(&cbb) == Traits::kPublicKeyBytes);
    *out_len = Traits::kPublicKeyBytes;
    return 1;
  }

  static evp_decode_result_t DecodePublic(const EVP_PKEY_ALG *alg,
                                          EVP_PKEY *out, CBS *params,
                                          CBS *key) {
    // The parameters must be omitted. See
    // draft-ietf-lamps-dilithium-certificates-13, Section 2.
    if (CBS_len(params) != 0) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
      return evp_decode_error;
    }
    return SetRawPublic(out, CBS_data(key), CBS_len(key)) ? evp_decode_ok
                                                          : evp_decode_error;
  }

  static int EncodePublic(CBB *out, const EVP_PKEY *pkey) {
    const auto *pub = GetKeyData(pkey)->GetPublicKey();
    // See draft-ietf-lamps-dilithium-certificates-13, Sections 2 and 4.
    CBB spki, algorithm, key_bitstring;
    if (!CBB_add_asn1(out, &spki, CBS_ASN1_SEQUENCE) ||
        !CBB_add_asn1(&spki, &algorithm, CBS_ASN1_SEQUENCE) ||
        !CBB_add_asn1_element(&algorithm, CBS_ASN1_OBJECT, Traits::kOID.data(),
                              Traits::kOID.size()) ||
        !CBB_add_asn1(&spki, &key_bitstring, CBS_ASN1_BITSTRING) ||
        !CBB_add_u8(&key_bitstring, 0 /* padding */) ||
        !Traits::MarshalPublicKey(&key_bitstring, pub) ||
        !CBB_flush(out)) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_ENCODE_ERROR);
      return 0;
    }
    return 1;
  }

  static int ComparePublic(const EVP_PKEY *a, const EVP_PKEY *b) {
    const auto *a_pub = GetKeyData(a)->GetPublicKey();
    const auto *b_pub = GetKeyData(b)->GetPublicKey();
    return Traits::PublicKeysEqual(a_pub, b_pub);
  }

  static evp_decode_result_t DecodePrivate(const EVP_PKEY_ALG *alg,
                                           EVP_PKEY *out, CBS *params,
                                           CBS *key) {
    // The parameters must be omitted. See
    // draft-ietf-lamps-dilithium-certificates-13, Section 2.
    if (CBS_len(params) != 0) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
      return evp_decode_error;
    }

    // See draft-ietf-lamps-dilithium-certificates-13, Section 6. Three
    // different encodings were specified, adding complexity to the question of
    // whether a private key is valid. We only implement the "seed"
    // representation. Give this case a different error for easier diagnostics.
    //
    // The "expandedKey" representation was a last-minute accommodation for
    // legacy hardware, which should be updated to use seeds. Supporting it
    // complicates the notion of a private key with both seedful and seedless
    // variants.
    //
    // The "both" representation is technically unsound and
    // dangerous, so we do not implement it. Systems composed of components,
    // some of which look at one half of the "both" representation, and half of
    // the other, will appear to interop, but break when an input is
    // inconsistent. The expanded key can be computed from the seed, so there is
    // no purpose in this form.
    CBS seed;
    if (!CBS_get_asn1(key, &seed, kSeedTag)) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_PRIVATE_KEY_WAS_NOT_SEED);
      return evp_decode_error;
    }
    if (CBS_len(key) != 0) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_DECODE_ERROR);
      return evp_decode_error;
    }
    return SetPrivateSeed(out, CBS_data(&seed), CBS_len(&seed))
               ? evp_decode_ok
               : evp_decode_error;
  }

  static int EncodePrivate(CBB *out, const EVP_PKEY *pkey) {
    const auto *priv = GetKeyData(pkey)->AsPrivateKeyData();
    if (priv == nullptr) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_NOT_A_PRIVATE_KEY);
      return 0;
    }
    // See draft-ietf-lamps-dilithium-certificates-13, Sections 2 and 6. We
    // encode only the seed representation.
    CBB pkcs8, algorithm, private_key;
    if (!CBB_add_asn1(out, &pkcs8, CBS_ASN1_SEQUENCE) ||
        !CBB_add_asn1_uint64(&pkcs8, 0 /* version */) ||
        !CBB_add_asn1(&pkcs8, &algorithm, CBS_ASN1_SEQUENCE) ||
        !CBB_add_asn1_element(&algorithm, CBS_ASN1_OBJECT, Traits::kOID.data(),
                              Traits::kOID.size()) ||
        !CBB_add_asn1(&pkcs8, &private_key, CBS_ASN1_OCTETSTRING) ||
        !CBB_add_asn1_element(&private_key, kSeedTag, priv->seed,
                              sizeof(priv->seed)) ||
        !CBB_flush(out)) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_ENCODE_ERROR);
      return 0;
    }
    return 1;
  }

  static int PkeySize(const EVP_PKEY *pkey) { return Traits::kSignatureBytes; }
  static int PkeyBits(const EVP_PKEY *pkey) {
    // OpenSSL counts the bits in the public key serialization.
    return Traits::kPublicKeyBytes * 8;
  }

  // There is, for now, no context state to copy. When we add support for
  // streaming signing, that will change.
  static int CopyContext(EVP_PKEY_CTX *dst, EVP_PKEY_CTX *src) { return 1; }

  static int SignMessage(EVP_PKEY_CTX *ctx, uint8_t *sig, size_t *siglen,
                         const uint8_t *tbs, size_t tbslen) {
    const auto *priv_data = GetKeyData(ctx->pkey.get())->AsPrivateKeyData();
    if (priv_data == nullptr) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_NOT_A_PRIVATE_KEY);
      return 0;
    }
    if (sig == nullptr) {
      *siglen = Traits::kSignatureBytes;
      return 1;
    }
    if (*siglen < Traits::kSignatureBytes) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_BUFFER_TOO_SMALL);
      return 0;
    }
    if (!Traits::Sign(sig, &priv_data->priv, tbs, tbslen, /*context=*/nullptr,
                      /*context_len=*/0)) {
      return 0;
    }
    *siglen = Traits::kSignatureBytes;
    return 1;
  }

  static int VerifyMessage(EVP_PKEY_CTX *ctx, const uint8_t *sig, size_t siglen,
                           const uint8_t *tbs, size_t tbslen) {
    const auto *pub = GetKeyData(ctx->pkey.get())->GetPublicKey();
    if (!Traits::Verify(pub, sig, siglen, tbs, tbslen, /*context=*/nullptr,
                        /*context_len=*/0)) {
      OPENSSL_PUT_ERROR(EVP, EVP_R_INVALID_SIGNATURE);
      return 0;
    }
    return 1;
  }

  static constexpr EVP_PKEY_CTX_METHOD pkey_method = {
      Traits::kType,
      /*init=*/nullptr,
      &CopyContext,
      /*cleanup=*/nullptr,
      // TODO(crbug.com/449751916): Add keygen support.
      /*keygen=*/nullptr,
      /*sign=*/nullptr,
      &SignMessage,
      /*verify=*/nullptr,
      &VerifyMessage,
      /*verify_recover=*/nullptr,
      /*encrypt=*/nullptr,
      /*decrypt=*/nullptr,
      /*derive=*/nullptr,
      /*paramgen=*/nullptr,
      /*ctrl=*/nullptr,
  };

  static constexpr EVP_PKEY_ASN1_METHOD BuildASN1Method() {
    EVP_PKEY_ASN1_METHOD ret = {
        Traits::kType,
        // The OID is filled in below.
        /*oid=*/{},
        /*oid_len=*/0,
        &pkey_method,
        &DecodePublic,
        &EncodePublic,
        &ComparePublic,
        &DecodePrivate,
        &EncodePrivate,
        // While exporting the seed as the "raw" private key would be natural,
        // OpenSSL connected these APIs to the "raw private key", so we export
        // the seed separately.
        /*set_priv_raw=*/nullptr,
        &SetPrivateSeed,
        &SetRawPublic,
        /*get_priv_raw=*/nullptr,
        &GetPrivateSeed,
        &GetRawPublic,
        /*set1_tls_encodedpoint=*/nullptr,
        /*get1_tls_encodedpoint=*/nullptr,
        /*pkey_opaque=*/nullptr,
        &PkeySize,
        &PkeyBits,
        /*param_missing=*/nullptr,
        /*param_copy=*/nullptr,
        /*param_cmp=*/nullptr,
        &PkeyFree,
    };
    // TODO(crbug.com/404286922): Use std::copy in C++20, when it's constexpr.
    // TODO(crbug.com/450823446): Better yet, make this field an InplaceVector
    // and give it a suitable constructor.
    constexpr auto oid = Traits::kOID;
    static_assert(oid.size() <= sizeof(ret.oid));
    for (size_t i = 0; i < oid.size(); i++) {
      ret.oid[i] = oid[i];
    }
    ret.oid_len = oid.size();
    return ret;
  }

  static constexpr EVP_PKEY_ASN1_METHOD asn1_method = BuildASN1Method();
  static constexpr EVP_PKEY_ALG pkey_alg = {&asn1_method};
};

}  // namespace

const EVP_PKEY_ALG *EVP_pkey_ml_dsa_44() {
  return &MLDSAImplementation<MLDSA44Traits>::pkey_alg;
}

const EVP_PKEY_ALG *EVP_pkey_ml_dsa_65() {
  return &MLDSAImplementation<MLDSA65Traits>::pkey_alg;
}

const EVP_PKEY_ALG *EVP_pkey_ml_dsa_87() {
  return &MLDSAImplementation<MLDSA87Traits>::pkey_alg;
}
