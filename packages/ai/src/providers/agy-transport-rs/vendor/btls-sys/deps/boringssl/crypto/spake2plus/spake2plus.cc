// Copyright 2024 The BoringSSL Authors
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

#include <openssl/base.h>

#include <assert.h>
#include <string.h>

#include <openssl/bn.h>
#include <openssl/bytestring.h>
#include <openssl/crypto.h>
#include <openssl/ec.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/hkdf.h>
#include <openssl/hmac.h>
#include <openssl/mem.h>
#include <openssl/rand.h>
#include <openssl/sha2.h>

#include "../fipsmodule/bn/internal.h"
#include "../fipsmodule/ec/internal.h"
#include "../internal.h"
#include "./internal.h"

BSSL_NAMESPACE_BEGIN
namespace spake2plus {
namespace {

const uint8_t kDefaultAdditionalData[32] = {0};

// https://www.rfc-editor.org/rfc/rfc9383.html#appendix-B
// seed: 1.2.840.10045.3.1.7 point generation seed (M)
// M =
// 02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f
//
// `M` is interpreted as a X9.62-format compressed point. This is then the
// uncompressed form:
const uint8_t kM_bytes[] = {
    0x04, 0x88, 0x6e, 0x2f, 0x97, 0xac, 0xe4, 0x6e, 0x55, 0xba, 0x9d,
    0xd7, 0x24, 0x25, 0x79, 0xf2, 0x99, 0x3b, 0x64, 0xe1, 0x6e, 0xf3,
    0xdc, 0xab, 0x95, 0xaf, 0xd4, 0x97, 0x33, 0x3d, 0x8f, 0xa1, 0x2f,
    0x5f, 0xf3, 0x55, 0x16, 0x3e, 0x43, 0xce, 0x22, 0x4e, 0x0b, 0x0e,
    0x65, 0xff, 0x02, 0xac, 0x8e, 0x5c, 0x7b, 0xe0, 0x94, 0x19, 0xc7,
    0x85, 0xe0, 0xca, 0x54, 0x7d, 0x55, 0xa1, 0x2e, 0x2d, 0x20};

// https://www.rfc-editor.org/rfc/rfc9383.html#appendix-B
// seed: 1.2.840.10045.3.1.7 point generation seed (N)
// N =
// 03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49
//
// `N` is interpreted as a X9.62-format compressed point. This is then the
// uncompressed form:
const uint8_t kN_bytes[] = {
    0x04, 0xd8, 0xbb, 0xd6, 0xc6, 0x39, 0xc6, 0x29, 0x37, 0xb0, 0x4d,
    0x99, 0x7f, 0x38, 0xc3, 0x77, 0x07, 0x19, 0xc6, 0x29, 0xd7, 0x01,
    0x4d, 0x49, 0xa2, 0x4b, 0x4f, 0x98, 0xba, 0xa1, 0x29, 0x2b, 0x49,
    0x07, 0xd6, 0x0a, 0xa6, 0xbf, 0xad, 0xe4, 0x50, 0x08, 0xa6, 0x36,
    0x33, 0x7f, 0x51, 0x68, 0xc6, 0x4d, 0x9b, 0xd3, 0x60, 0x34, 0x80,
    0x8c, 0xd5, 0x64, 0x49, 0x0b, 0x1e, 0x65, 0x6e, 0xdb, 0xe7};

void UpdateWithLengthPrefix(SHA256_CTX *sha, Span<const uint8_t> data) {
  uint8_t len_le[8];
  CRYPTO_store_u64_le(len_le, data.size());
  SHA256_Update(sha, len_le, sizeof(len_le));
  SHA256_Update(sha, data.data(), data.size());
}

void ConstantToJacobian(const EC_GROUP *group, EC_JACOBIAN *out,
                        bssl::Span<const uint8_t> in) {
  EC_AFFINE point;
  BSSL_CHECK(ec_point_from_uncompressed(group, &point, in.data(), in.size()));
  ec_affine_to_jacobian(group, out, &point);
}

void ScalarToSizedBuffer(const EC_GROUP *group, const EC_SCALAR *s,
                         Span<uint8_t> out_buf) {
  size_t out_bytes;
  ec_scalar_to_bytes(group, out_buf.data(), &out_bytes, s);
  BSSL_CHECK(out_bytes == out_buf.size());
}

bool AddLengthPrefixed(CBB *cbb, Span<const uint8_t> bytes) {
  return CBB_add_u64le(cbb, bytes.size()) &&
         CBB_add_bytes(cbb, bytes.data(), bytes.size());
}

void InitTranscriptHash(SHA256_CTX *sha, Span<const uint8_t> context,
                        Span<const uint8_t> id_prover,
                        Span<const uint8_t> id_verifier) {
  SHA256_Init(sha);
  UpdateWithLengthPrefix(sha, context);
  UpdateWithLengthPrefix(sha, id_prover);
  UpdateWithLengthPrefix(sha, id_verifier);
  UpdateWithLengthPrefix(sha, kM_bytes);
  UpdateWithLengthPrefix(sha, kN_bytes);
}

bool ComputeTranscript(uint8_t out_prover_confirm[kConfirmSize],
                       uint8_t out_verifier_confirm[kConfirmSize],
                       uint8_t out_secret[kSecretSize],
                       const uint8_t prover_share[kShareSize],
                       const uint8_t verifier_share[kShareSize],
                       SHA256_CTX *sha, const EC_AFFINE *Z, const EC_AFFINE *V,
                       const EC_SCALAR *w0) {
  const EC_GROUP *group = EC_group_p256();

  uint8_t Z_enc[kShareSize];
  size_t Z_enc_len = ec_point_to_bytes(group, Z, POINT_CONVERSION_UNCOMPRESSED,
                                       Z_enc, sizeof(Z_enc));
  BSSL_CHECK(Z_enc_len == sizeof(Z_enc));

  uint8_t V_enc[kShareSize];
  size_t V_enc_len = ec_point_to_bytes(group, V, POINT_CONVERSION_UNCOMPRESSED,
                                       V_enc, sizeof(V_enc));
  BSSL_CHECK(V_enc_len == sizeof(V_enc));

  uint8_t w0_enc[kVerifierSize];
  ScalarToSizedBuffer(group, w0, w0_enc);

  uint8_t K_main[SHA256_DIGEST_LENGTH];
  UpdateWithLengthPrefix(sha, Span(prover_share, kShareSize));
  UpdateWithLengthPrefix(sha, Span(verifier_share, kShareSize));
  UpdateWithLengthPrefix(sha, Z_enc);
  UpdateWithLengthPrefix(sha, V_enc);
  UpdateWithLengthPrefix(sha, w0_enc);
  SHA256_Final(K_main, sha);

  auto confirmation_str = StringAsBytes("ConfirmationKeys");
  uint8_t keys[kSecretSize * 2];
  if (!HKDF(keys, sizeof(keys), EVP_sha256(), K_main, sizeof(K_main), nullptr,
            0, confirmation_str.data(), confirmation_str.size())) {
    return false;
  }

  auto secret_info_str = StringAsBytes("SharedKey");
  if (!HKDF(out_secret, kSecretSize, EVP_sha256(), K_main, sizeof(K_main),
            nullptr, 0, secret_info_str.data(), secret_info_str.size())) {
    return false;
  }

  unsigned prover_confirm_len;
  if (HMAC(EVP_sha256(), keys, kSecretSize, verifier_share, kShareSize,
           out_prover_confirm, &prover_confirm_len) == nullptr) {
    return false;
  }
  BSSL_CHECK(prover_confirm_len == kConfirmSize);

  unsigned verifier_confirm_len;
  if (HMAC(EVP_sha256(), keys + kSecretSize, kSecretSize, prover_share,
           kShareSize, out_verifier_confirm,
           &verifier_confirm_len) == nullptr) {
    return false;
  }
  BSSL_CHECK(verifier_confirm_len == kConfirmSize);

  return true;
}

}  // namespace

bool Register(Span<uint8_t> out_w0, Span<uint8_t> out_w1,
              Span<uint8_t> out_registration_record,
              Span<const uint8_t> password, Span<const uint8_t> id_prover,
              Span<const uint8_t> id_verifier) {
  if (out_w0.size() != kVerifierSize || out_w1.size() != kVerifierSize ||
      out_registration_record.size() != kRegistrationRecordSize) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  // Offline registration format from:
  // https://www.rfc-editor.org/rfc/rfc9383.html#section-3.2
  ScopedCBB mhf_input;
  if (!CBB_init(mhf_input.get(), password.size() + id_prover.size() +
                                     id_verifier.size() +
                                     3 * sizeof(uint64_t)) ||  //
      !AddLengthPrefixed(mhf_input.get(), password) ||
      !AddLengthPrefixed(mhf_input.get(), id_prover) ||
      !AddLengthPrefixed(mhf_input.get(), id_verifier) ||
      !CBB_flush(mhf_input.get())) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  // https://neuromancer.sk/std/nist/P-256
  //   sage: p =
  //   0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff
  //   ....: K = GF(p)
  //   ....: a =
  //   K(0xffffffff00000001000000000000000000000000fffffffffffffffffffffffc)
  //   ....: b =
  //   K(0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b)
  //   ....: E = EllipticCurve(K, (a, b))
  //   ....: G =
  //   E(0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296,
  //   ....: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5)
  //   ....:
  //   E.set_order(0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc63
  //   ....: 2551 * 0x1)
  //   sage: k = 64
  //   sage: L = (2 * (ceil(log(p)/log(2)) + k)) / 8

  // RFC 9383 Section 3.2
  constexpr size_t kKDFOutputSize = 80;
  constexpr size_t kKDFOutputWords = kKDFOutputSize / BN_BYTES;

  uint8_t key[kKDFOutputSize];
  if (!EVP_PBE_scrypt((const char *)CBB_data(mhf_input.get()),
                      CBB_len(mhf_input.get()), nullptr, 0,
                      /*N=*/32768, /*r=*/8, /*p=*/1,
                      /*max_mem=*/1024 * 1024 * 33, key, kKDFOutputSize)) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  const EC_GROUP *group = EC_group_p256();
  BN_ULONG w0_words[kKDFOutputWords / 2];
  bn_big_endian_to_words(w0_words, kKDFOutputWords / 2, key,
                         kKDFOutputSize / 2);
  EC_SCALAR w0;
  ec_scalar_reduce(group, &w0, w0_words, kKDFOutputWords / 2);
  ScalarToSizedBuffer(group, &w0, out_w0);

  BN_ULONG w1_words[kKDFOutputWords / 2];
  bn_big_endian_to_words(w1_words, kKDFOutputWords / 2,
                         key + kKDFOutputSize / 2, kKDFOutputSize / 2);
  EC_SCALAR w1;
  ec_scalar_reduce(group, &w1, w1_words, kKDFOutputWords / 2);
  ScalarToSizedBuffer(group, &w1, out_w1);

  EC_JACOBIAN L_j;
  EC_AFFINE L;
  if (!ec_point_mul_scalar_base(group, &L_j, &w1) ||  //
      !ec_jacobian_to_affine(group, &L, &L_j) ||      //
      !ec_point_to_bytes(group, &L, POINT_CONVERSION_UNCOMPRESSED,
                         out_registration_record.data(),
                         kRegistrationRecordSize)) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  return true;
}

Prover::Prover() = default;
Prover::~Prover() = default;

bool Prover::Init(Span<const uint8_t> context, Span<const uint8_t> id_prover,
                  Span<const uint8_t> id_verifier, Span<const uint8_t> w0,
                  Span<const uint8_t> w1, Span<const uint8_t> x) {
  const EC_GROUP *group = EC_group_p256();

  if (!ec_scalar_from_bytes(group, &w0_, w0.data(), w0.size()) ||
      !ec_scalar_from_bytes(group, &w1_, w1.data(), w1.size()) ||
      (!x.empty() &&
       !ec_scalar_from_bytes(group, &x_, x.data(), x.size())) ||  //
      (x.empty() && !ec_random_scalar(group, &x_, kDefaultAdditionalData))) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  InitTranscriptHash(&transcript_hash_, context, id_prover, id_verifier);

  return true;
}

bool Prover::GenerateShare(Span<uint8_t> out_share) {
  if (state_ != State::kInit || out_share.size() != kShareSize) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  // Compute X = x×P + w0×M.
  // TODO(crbug.com/383778231): This could be sped up with a constant-time,
  // two-point multiplication.
  const EC_GROUP *group = EC_group_p256();
  EC_JACOBIAN l;
  if (!ec_point_mul_scalar_base(group, &l, &x_)) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  EC_JACOBIAN M_j;
  ConstantToJacobian(group, &M_j, kM_bytes);

  EC_JACOBIAN r;
  if (!ec_point_mul_scalar(group, &r, &M_j, &w0_)) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  EC_JACOBIAN X_j;
  group->meth->add(group, &X_j, &l, &r);
  if (!ec_jacobian_to_affine(group, &X_, &X_j)) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  size_t written = ec_point_to_bytes(group, &X_, POINT_CONVERSION_UNCOMPRESSED,
                                     out_share.data(), kShareSize);
  BSSL_CHECK(written == kShareSize);

  memcpy(share_, out_share.data(), kShareSize);
  state_ = State::kShareGenerated;
  return true;
}

bool Prover::ComputeConfirmation(Span<uint8_t> out_confirm,
                                 Span<uint8_t> out_secret,
                                 Span<const uint8_t> peer_share,
                                 Span<const uint8_t> peer_confirm) {
  if (state_ != State::kShareGenerated || out_confirm.size() != kConfirmSize ||
      out_secret.size() != kSecretSize || peer_share.size() != kShareSize ||
      peer_confirm.size() != kConfirmSize) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  const EC_GROUP *group = EC_group_p256();
  EC_AFFINE Y;
  if (!ec_point_from_uncompressed(group, &Y, peer_share.data(),
                                  peer_share.size())) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  EC_JACOBIAN N_j;
  ConstantToJacobian(group, &N_j, kN_bytes);

  EC_JACOBIAN r;
  if (!ec_point_mul_scalar(group, &r, &N_j, &w0_)) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  ec_felem_neg(group, &r.Y, &r.Y);

  EC_JACOBIAN Y_j;
  ec_affine_to_jacobian(group, &Y_j, &Y);

  EC_JACOBIAN t;
  group->meth->add(group, &t, &Y_j, &r);

  EC_JACOBIAN tmp;
  EC_AFFINE Z, V;
  // TODO(crbug.com/383778231): The two affine conversions could be batched
  // together.
  if (!ec_point_mul_scalar(group, &tmp, &t, &x_) ||   //
      !ec_jacobian_to_affine(group, &Z, &tmp) ||      //
      !ec_point_mul_scalar(group, &tmp, &t, &w1_) ||  //
      !ec_jacobian_to_affine(group, &V, &tmp)) {
    return 0;
  }

  uint8_t verifier_confirm[kConfirmSize];
  if (!ComputeTranscript(out_confirm.data(), verifier_confirm,
                         out_secret.data(), share_, peer_share.data(),
                         &transcript_hash_, &Z, &V, &w0_) ||
      CRYPTO_memcmp(verifier_confirm, peer_confirm.data(),
                    sizeof(verifier_confirm)) != 0) {
    return 0;
  }

  state_ = State::kDone;
  return true;
}

Verifier::Verifier() = default;
Verifier::~Verifier() = default;

bool Verifier::Init(Span<const uint8_t> context, Span<const uint8_t> id_prover,
                    Span<const uint8_t> id_verifier, Span<const uint8_t> w0,
                    Span<const uint8_t> registration_record,
                    Span<const uint8_t> y) {
  const EC_GROUP *group = EC_group_p256();

  if (!ec_scalar_from_bytes(group, &w0_, w0.data(), w0.size()) ||
      !ec_point_from_uncompressed(group, &L_, registration_record.data(),
                                  registration_record.size()) ||  //
      (!y.empty() &&
       !ec_scalar_from_bytes(group, &y_, y.data(), y.size())) ||  //
      (y.empty() && !ec_random_scalar(group, &y_, kDefaultAdditionalData))) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  InitTranscriptHash(&transcript_hash_, context, id_prover, id_verifier);

  return true;
}


bool Verifier::ProcessProverShare(Span<uint8_t> out_share,
                                  Span<uint8_t> out_confirm,
                                  Span<uint8_t> out_secret,
                                  Span<const uint8_t> prover_share) {
  if (state_ != State::kInit ||  //
      out_share.size() != kShareSize || out_confirm.size() != kConfirmSize ||
      out_secret.size() != kSecretSize || prover_share.size() != kShareSize) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  const EC_GROUP *group = EC_group_p256();
  EC_JACOBIAN l, r, M_j, N_j;
  ConstantToJacobian(group, &M_j, kM_bytes);
  ConstantToJacobian(group, &N_j, kN_bytes);

  // Compute Y = y×P + w0×M.
  // TODO(crbug.com/383778231): This could be sped up with a constant-time,
  // two-point multiplication.
  if (!ec_point_mul_scalar_base(group, &l, &y_) ||
      !ec_point_mul_scalar(group, &r, &N_j, &w0_)) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  EC_JACOBIAN Y_j;
  EC_AFFINE Y;
  group->meth->add(group, &Y_j, &l, &r);
  if (!ec_jacobian_to_affine(group, &Y, &Y_j)) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  const size_t written = ec_point_to_bytes(
      group, &Y, POINT_CONVERSION_UNCOMPRESSED, out_share.data(), kShareSize);
  BSSL_CHECK(written == kShareSize);

  EC_JACOBIAN r2;
  EC_AFFINE X;
  if (!ec_point_from_uncompressed(group, &X, prover_share.data(),
                                  prover_share.size()) ||
      !ec_point_mul_scalar(group, &r2, &M_j, &w0_)) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  ec_felem_neg(group, &r2.Y, &r2.Y);

  EC_JACOBIAN X_j, T;
  ec_affine_to_jacobian(group, &X_j, &X);
  group->meth->add(group, &T, &X_j, &r2);

  // TODO(crbug.com/383778231): The two affine conversions could be batched
  // together.
  EC_JACOBIAN tmp;
  EC_AFFINE Z;
  if (!ec_point_mul_scalar(group, &tmp, &T, &y_) ||  //
      !ec_jacobian_to_affine(group, &Z, &tmp)) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  EC_JACOBIAN L_j;
  EC_AFFINE V;
  ec_affine_to_jacobian(group, &L_j, &L_);
  if (!ec_point_mul_scalar(group, &tmp, &L_j, &y_) ||  //
      !ec_jacobian_to_affine(group, &V, &tmp)) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  if (!ComputeTranscript(confirm_, out_confirm.data(), out_secret.data(),
                         prover_share.data(), out_share.data(),
                         &transcript_hash_, &Z, &V, &w0_)) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  state_ = State::kProverShareSeen;
  return true;
}

bool Verifier::VerifyProverConfirmation(Span<const uint8_t> peer_confirm) {
  if (state_ != State::kProverShareSeen ||    //
      peer_confirm.size() != kConfirmSize ||  //
      CRYPTO_memcmp(confirm_, peer_confirm.data(), sizeof(confirm_)) != 0) {
    OPENSSL_PUT_ERROR(CRYPTO, ERR_R_INTERNAL_ERROR);
    return false;
  }

  state_ = State::kDone;
  return true;
}

}  // namespace spake2plus

BSSL_NAMESPACE_END
