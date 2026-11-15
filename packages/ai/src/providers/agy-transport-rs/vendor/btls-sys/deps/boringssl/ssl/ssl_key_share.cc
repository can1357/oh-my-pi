// Copyright 2015 The BoringSSL Authors
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

#include <openssl/ssl.h>

#include <assert.h>
#include <string.h>

#include <iterator>
#include <utility>

#include <openssl/bn.h>
#include <openssl/bytestring.h>
#include <openssl/curve25519.h>
#include <openssl/ec.h>
#include <openssl/err.h>
#include <openssl/hrss.h>
#include <openssl/mem.h>
#include <openssl/mlkem.h>
#include <openssl/nid.h>
#include <openssl/rand.h>
#include <openssl/span.h>

#include "../crypto/internal.h"
#include "../crypto/kyber/internal.h"
#include "internal.h"

BSSL_NAMESPACE_BEGIN

namespace {

class ECKeyShare : public SSLKeyShare {
 public:
  ECKeyShare(const EC_GROUP *group, uint16_t group_id)
      : group_(group), group_id_(group_id) {}

  uint16_t GroupID() const override { return group_id_; }

  bool Generate(CBB *out) override {
    assert(!private_key_);
    // Generate a private key.
    private_key_.reset(BN_new());
    if (!private_key_ ||
        !BN_rand_range_ex(private_key_.get(), 1, EC_GROUP_get0_order(group_))) {
      return false;
    }

    // Compute the corresponding public key and serialize it.
    UniquePtr<EC_POINT> public_key(EC_POINT_new(group_));
    if (!public_key ||
        !EC_POINT_mul(group_, public_key.get(), private_key_.get(), nullptr,
                      nullptr, /*ctx=*/nullptr) ||
        !EC_POINT_point2cbb(out, group_, public_key.get(),
                            POINT_CONVERSION_UNCOMPRESSED, /*ctx=*/nullptr)) {
      return false;
    }

    return true;
  }

  bool Encap(CBB *out_ciphertext, Array<uint8_t> *out_secret,
             uint8_t *out_alert, Span<const uint8_t> peer_key) override {
    // ECDH may be fit into a KEM-like abstraction by using a second keypair's
    // public key as the ciphertext.
    *out_alert = SSL_AD_INTERNAL_ERROR;
    return Generate(out_ciphertext) && Decap(out_secret, out_alert, peer_key);
  }

  bool Decap(Array<uint8_t> *out_secret, uint8_t *out_alert,
             Span<const uint8_t> ciphertext) override {
    assert(group_);
    assert(private_key_);
    *out_alert = SSL_AD_INTERNAL_ERROR;

    UniquePtr<EC_POINT> peer_point(EC_POINT_new(group_));
    UniquePtr<EC_POINT> result(EC_POINT_new(group_));
    UniquePtr<BIGNUM> x(BN_new());
    if (!peer_point || !result || !x) {
      return false;
    }

    if (ciphertext.empty() || ciphertext[0] != POINT_CONVERSION_UNCOMPRESSED ||
        !EC_POINT_oct2point(group_, peer_point.get(), ciphertext.data(),
                            ciphertext.size(), /*ctx=*/nullptr)) {
      OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_ECPOINT);
      *out_alert = SSL_AD_ILLEGAL_PARAMETER;
      return false;
    }

    // Compute the x-coordinate of |peer_key| * |private_key_|.
    if (!EC_POINT_mul(group_, result.get(), nullptr, peer_point.get(),
                      private_key_.get(), /*ctx=*/nullptr) ||
        !EC_POINT_get_affine_coordinates_GFp(group_, result.get(), x.get(),
                                             nullptr, /*ctx=*/nullptr)) {
      return false;
    }

    // Encode the x-coordinate left-padded with zeros.
    Array<uint8_t> secret;
    if (!secret.InitForOverwrite((EC_GROUP_get_degree(group_) + 7) / 8) ||
        !BN_bn2bin_padded(secret.data(), secret.size(), x.get())) {
      return false;
    }

    *out_secret = std::move(secret);
    return true;
  }

  bool SerializePrivateKey(CBB *out) override {
    assert(group_);
    assert(private_key_);
    // Padding is added to avoid leaking the length.
    size_t len = BN_num_bytes(EC_GROUP_get0_order(group_));
    return BN_bn2cbb_padded(out, len, private_key_.get());
  }

  bool DeserializePrivateKey(CBS *in) override {
    assert(!private_key_);
    private_key_.reset(BN_bin2bn(CBS_data(in), CBS_len(in), nullptr));
    return private_key_ != nullptr;
  }

 private:
  UniquePtr<BIGNUM> private_key_;
  const EC_GROUP *const group_ = nullptr;
  uint16_t group_id_;
};

class X25519KeyShare : public SSLKeyShare {
 public:
  X25519KeyShare() {}

  uint16_t GroupID() const override { return SSL_GROUP_X25519; }

  bool Generate(CBB *out) override {
    uint8_t public_key[32];
    X25519_keypair(public_key, private_key_);
    return !!CBB_add_bytes(out, public_key, sizeof(public_key));
  }

  bool Encap(CBB *out_ciphertext, Array<uint8_t> *out_secret,
             uint8_t *out_alert, Span<const uint8_t> peer_key) override {
    // X25519 may be fit into a KEM-like abstraction by using a second keypair's
    // public key as the ciphertext.
    *out_alert = SSL_AD_INTERNAL_ERROR;
    return Generate(out_ciphertext) && Decap(out_secret, out_alert, peer_key);
  }

  bool Decap(Array<uint8_t> *out_secret, uint8_t *out_alert,
             Span<const uint8_t> ciphertext) override {
    *out_alert = SSL_AD_INTERNAL_ERROR;

    Array<uint8_t> secret;
    if (!secret.InitForOverwrite(32)) {
      return false;
    }

    if (ciphertext.size() != 32 ||  //
        !X25519(secret.data(), private_key_, ciphertext.data())) {
      *out_alert = SSL_AD_ILLEGAL_PARAMETER;
      OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_ECPOINT);
      return false;
    }

    *out_secret = std::move(secret);
    return true;
  }

  bool SerializePrivateKey(CBB *out) override {
    return CBB_add_bytes(out, private_key_, sizeof(private_key_));
  }

  bool DeserializePrivateKey(CBS *in) override {
    if (CBS_len(in) != sizeof(private_key_) ||
        !CBS_copy_bytes(in, private_key_, sizeof(private_key_))) {
      return false;
    }
    return true;
  }

 private:
  uint8_t private_key_[32];
};

// draft-tls-westerbaan-xyber768d00-03
class X25519Kyber768KeyShare : public SSLKeyShare {
 public:
  X25519Kyber768KeyShare() {}

  uint16_t GroupID() const override {
    return SSL_GROUP_X25519_KYBER768_DRAFT00;
  }

  bool Generate(CBB *out) override {
    uint8_t x25519_public_key[32];
    X25519_keypair(x25519_public_key, x25519_private_key_);

    uint8_t kyber_public_key[KYBER_PUBLIC_KEY_BYTES];
    KYBER_generate_key(kyber_public_key, &kyber_private_key_);

    if (!CBB_add_bytes(out, x25519_public_key, sizeof(x25519_public_key)) ||
        !CBB_add_bytes(out, kyber_public_key, sizeof(kyber_public_key))) {
      return false;
    }

    return true;
  }

  bool Encap(CBB *out_ciphertext, Array<uint8_t> *out_secret,
             uint8_t *out_alert, Span<const uint8_t> peer_key) override {
    Array<uint8_t> secret;
    if (!secret.InitForOverwrite(32 + KYBER_SHARED_SECRET_BYTES)) {
      return false;
    }

    uint8_t x25519_public_key[32];
    X25519_keypair(x25519_public_key, x25519_private_key_);
    KYBER_public_key peer_kyber_pub;
    CBS peer_key_cbs, peer_x25519_cbs, peer_kyber_cbs;
    CBS_init(&peer_key_cbs, peer_key.data(), peer_key.size());
    if (!CBS_get_bytes(&peer_key_cbs, &peer_x25519_cbs, 32) ||
        !CBS_get_bytes(&peer_key_cbs, &peer_kyber_cbs,
                       KYBER_PUBLIC_KEY_BYTES) ||
        CBS_len(&peer_key_cbs) != 0 ||
        !X25519(secret.data(), x25519_private_key_,
                CBS_data(&peer_x25519_cbs)) ||
        !KYBER_parse_public_key(&peer_kyber_pub, &peer_kyber_cbs)) {
      *out_alert = SSL_AD_ILLEGAL_PARAMETER;
      OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_ECPOINT);
      return false;
    }

    uint8_t kyber_ciphertext[KYBER_CIPHERTEXT_BYTES];
    KYBER_encap(kyber_ciphertext, secret.data() + 32, &peer_kyber_pub);

    if (!CBB_add_bytes(out_ciphertext, x25519_public_key,
                       sizeof(x25519_public_key)) ||
        !CBB_add_bytes(out_ciphertext, kyber_ciphertext,
                       sizeof(kyber_ciphertext))) {
      return false;
    }

    *out_secret = std::move(secret);
    return true;
  }

  bool Decap(Array<uint8_t> *out_secret, uint8_t *out_alert,
             Span<const uint8_t> ciphertext) override {
    *out_alert = SSL_AD_INTERNAL_ERROR;

    Array<uint8_t> secret;
    if (!secret.InitForOverwrite(32 + KYBER_SHARED_SECRET_BYTES)) {
      return false;
    }

    if (ciphertext.size() != 32 + KYBER_CIPHERTEXT_BYTES ||
        !X25519(secret.data(), x25519_private_key_, ciphertext.data())) {
      *out_alert = SSL_AD_ILLEGAL_PARAMETER;
      OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_ECPOINT);
      return false;
    }

    KYBER_decap(secret.data() + 32, ciphertext.data() + 32,
                &kyber_private_key_);
    *out_secret = std::move(secret);
    return true;
  }

 private:
  uint8_t x25519_private_key_[32];
  KYBER_private_key kyber_private_key_;
};

// draft-ietf-tls-ecdhe-mlkem-00
class X25519MLKEM768KeyShare : public SSLKeyShare {
 public:
  X25519MLKEM768KeyShare() {}

  uint16_t GroupID() const override { return SSL_GROUP_X25519_MLKEM768; }

  bool Generate(CBB *out) override {
    uint8_t mlkem_public_key[MLKEM768_PUBLIC_KEY_BYTES];
    MLKEM768_generate_key(mlkem_public_key, /*optional_out_seed=*/nullptr,
                          &mlkem_private_key_);

    uint8_t x25519_public_key[X25519_PUBLIC_VALUE_LEN];
    X25519_keypair(x25519_public_key, x25519_private_key_);

    if (!CBB_add_bytes(out, mlkem_public_key, sizeof(mlkem_public_key)) ||
        !CBB_add_bytes(out, x25519_public_key, sizeof(x25519_public_key))) {
      return false;
    }

    return true;
  }

  bool Encap(CBB *out_ciphertext, Array<uint8_t> *out_secret,
             uint8_t *out_alert, Span<const uint8_t> peer_key) override {
    Array<uint8_t> secret;
    if (!secret.InitForOverwrite(MLKEM_SHARED_SECRET_BYTES +
                                 X25519_SHARED_KEY_LEN)) {
      return false;
    }

    MLKEM768_public_key peer_mlkem_pub;
    uint8_t x25519_public_key[X25519_PUBLIC_VALUE_LEN];
    X25519_keypair(x25519_public_key, x25519_private_key_);
    CBS peer_key_cbs, peer_mlkem_cbs, peer_x25519_cbs;
    CBS_init(&peer_key_cbs, peer_key.data(), peer_key.size());
    if (!CBS_get_bytes(&peer_key_cbs, &peer_mlkem_cbs,
                       MLKEM768_PUBLIC_KEY_BYTES) ||
        !MLKEM768_parse_public_key(&peer_mlkem_pub, &peer_mlkem_cbs) ||
        !CBS_get_bytes(&peer_key_cbs, &peer_x25519_cbs,
                       X25519_PUBLIC_VALUE_LEN) ||
        CBS_len(&peer_key_cbs) != 0 ||
        !X25519(secret.data() + MLKEM_SHARED_SECRET_BYTES, x25519_private_key_,
                CBS_data(&peer_x25519_cbs))) {
      *out_alert = SSL_AD_ILLEGAL_PARAMETER;
      OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_ECPOINT);
      return false;
    }

    uint8_t mlkem_ciphertext[MLKEM768_CIPHERTEXT_BYTES];
    MLKEM768_encap(mlkem_ciphertext, secret.data(), &peer_mlkem_pub);

    if (!CBB_add_bytes(out_ciphertext, mlkem_ciphertext,
                       sizeof(mlkem_ciphertext)) ||
        !CBB_add_bytes(out_ciphertext, x25519_public_key,
                       sizeof(x25519_public_key))) {
      return false;
    }

    *out_secret = std::move(secret);
    return true;
  }

  bool Decap(Array<uint8_t> *out_secret, uint8_t *out_alert,
             Span<const uint8_t> ciphertext) override {
    *out_alert = SSL_AD_INTERNAL_ERROR;

    Array<uint8_t> secret;
    if (!secret.InitForOverwrite(MLKEM_SHARED_SECRET_BYTES +
                                 X25519_SHARED_KEY_LEN)) {
      return false;
    }

    if (ciphertext.size() !=
            MLKEM768_CIPHERTEXT_BYTES + X25519_PUBLIC_VALUE_LEN ||
        !MLKEM768_decap(secret.data(), ciphertext.data(),
                        MLKEM768_CIPHERTEXT_BYTES, &mlkem_private_key_) ||
        !X25519(secret.data() + MLKEM_SHARED_SECRET_BYTES, x25519_private_key_,
                ciphertext.data() + MLKEM768_CIPHERTEXT_BYTES)) {
      *out_alert = SSL_AD_ILLEGAL_PARAMETER;
      OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_ECPOINT);
      return false;
    }

    *out_secret = std::move(secret);
    return true;
  }

 private:
  uint8_t x25519_private_key_[32];
  MLKEM768_private_key mlkem_private_key_;
};

// draft-ietf-tls-mlkem-04
class MLKEM1024KeyShare : public SSLKeyShare {
 public:
  MLKEM1024KeyShare() = default;

  uint16_t GroupID() const override { return SSL_GROUP_MLKEM1024; }

  bool Generate(CBB *out_public_key) override {
    uint8_t public_key[MLKEM1024_PUBLIC_KEY_BYTES];
    MLKEM1024_generate_key(public_key, /*optional_out_seed=*/nullptr,
                           &private_key_);
    return CBB_add_bytes(out_public_key, public_key, sizeof(public_key));
  }

  bool Encap(CBB *out_ciphertext, Array<uint8_t> *out_secret,
             uint8_t *out_alert, Span<const uint8_t> peer_key) override {
    MLKEM1024_public_key peer_pub;
    CBS peer_pub_cbs;
    CBS_init(&peer_pub_cbs, peer_key.data(), peer_key.size());
    if (!MLKEM1024_parse_public_key(&peer_pub, &peer_pub_cbs)) {
      *out_alert = SSL_AD_ILLEGAL_PARAMETER;
      OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_ECPOINT);
      return false;
    }

    Array<uint8_t> secret;
    if (!secret.InitForOverwrite(MLKEM_SHARED_SECRET_BYTES)) {
      return false;
    }
    uint8_t ciphertext[MLKEM1024_CIPHERTEXT_BYTES];
    MLKEM1024_encap(ciphertext, secret.data(), &peer_pub);
    if (!CBB_add_bytes(out_ciphertext, ciphertext, sizeof(ciphertext))) {
      return false;
    }
    *out_secret = std::move(secret);
    return true;
  }

  bool Decap(Array<uint8_t> *out_secret, uint8_t *out_alert,
             Span<const uint8_t> ciphertext) override {
    Array<uint8_t> secret;
    if (!secret.InitForOverwrite(MLKEM_SHARED_SECRET_BYTES)) {
      *out_alert = SSL_AD_INTERNAL_ERROR;
      return false;
    }

    if (!MLKEM1024_decap(secret.data(), ciphertext.data(), ciphertext.size(),
                         &private_key_)) {
      *out_alert = SSL_AD_ILLEGAL_PARAMETER;
      OPENSSL_PUT_ERROR(SSL, SSL_R_BAD_ECPOINT);
      return false;
    }
    *out_secret = std::move(secret);
    return true;
  }

 private:
  MLKEM1024_private_key private_key_;
};

constexpr NamedGroup kNamedGroups[] = {
    {NID_X9_62_prime256v1, SSL_GROUP_SECP256R1, "P-256", "prime256v1"},
    {NID_secp384r1, SSL_GROUP_SECP384R1, "P-384", "secp384r1"},
    {NID_secp521r1, SSL_GROUP_SECP521R1, "P-521", "secp521r1"},
    {NID_X25519, SSL_GROUP_X25519, "X25519", "x25519"},
    {NID_X25519Kyber768Draft00, SSL_GROUP_X25519_KYBER768_DRAFT00,
     "X25519Kyber768Draft00", ""},
    {NID_X25519MLKEM768, SSL_GROUP_X25519_MLKEM768, "X25519MLKEM768", ""},
    {NID_ML_KEM_1024, SSL_GROUP_MLKEM1024, "MLKEM1024", ""},
};

static_assert(std::size(kNamedGroups) == kNumNamedGroups,
              "kNamedGroups size mismatch");

}  // namespace

Span<const NamedGroup> NamedGroups() { return kNamedGroups; }

Span<const uint16_t> DefaultSupportedGroupIds() {
  static const uint16_t kDefaultSupportedGroupIds[] = {
      SSL_GROUP_X25519,
      SSL_GROUP_SECP256R1,
      SSL_GROUP_SECP384R1,
  };
  return Span(kDefaultSupportedGroupIds);
}

UniquePtr<SSLKeyShare> SSLKeyShare::Create(uint16_t group_id) {
  switch (group_id) {
    case SSL_GROUP_SECP256R1:
      return MakeUnique<ECKeyShare>(EC_group_p256(), SSL_GROUP_SECP256R1);
    case SSL_GROUP_SECP384R1:
      return MakeUnique<ECKeyShare>(EC_group_p384(), SSL_GROUP_SECP384R1);
    case SSL_GROUP_SECP521R1:
      return MakeUnique<ECKeyShare>(EC_group_p521(), SSL_GROUP_SECP521R1);
    case SSL_GROUP_X25519:
      return MakeUnique<X25519KeyShare>();
    case SSL_GROUP_X25519_KYBER768_DRAFT00:
      return MakeUnique<X25519Kyber768KeyShare>();
    case SSL_GROUP_X25519_MLKEM768:
      return MakeUnique<X25519MLKEM768KeyShare>();
    case SSL_GROUP_MLKEM1024:
      return MakeUnique<MLKEM1024KeyShare>();
    default:
      return nullptr;
  }
}

bool ssl_nid_to_group_id(uint16_t *out_group_id, int nid) {
  for (const auto &group : kNamedGroups) {
    if (group.nid == nid) {
      *out_group_id = group.group_id;
      return true;
    }
  }
  return false;
}

bool ssl_name_to_group_id(uint16_t *out_group_id, const char *name,
                          size_t len) {
  for (const auto &group : kNamedGroups) {
    if (len == strlen(group.name) &&  //
        !strncmp(group.name, name, len)) {
      *out_group_id = group.group_id;
      return true;
    }
    if (strlen(group.alias) > 0 && len == strlen(group.alias) &&
        !strncmp(group.alias, name, len)) {
      *out_group_id = group.group_id;
      return true;
    }
  }
  return false;
}

int ssl_group_id_to_nid(uint16_t group_id) {
  for (const auto &group : kNamedGroups) {
    if (group.group_id == group_id) {
      return group.nid;
    }
  }
  return NID_undef;
}

BSSL_NAMESPACE_END

using namespace bssl;

const char *SSL_get_group_name(uint16_t group_id) {
  for (const auto &group : kNamedGroups) {
    if (group.group_id == group_id) {
      return group.name;
    }
  }
  return nullptr;
}

size_t SSL_get_all_group_names(const char **out, size_t max_out) {
  return GetAllNames(out, max_out, Span<const char *const>(), &NamedGroup::name,
                     Span(kNamedGroups));
}
