// Copyright 2015-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <gtest/gtest.h>

#include <openssl/bn.h>
#include <openssl/bytestring.h>
#include <openssl/crypto.h>
#include <openssl/dh.h>
#include <openssl/digest.h>
#include <openssl/dsa.h>
#include <openssl/ec.h>
#include <openssl/err.h>
#include <openssl/obj.h>
#include <openssl/rsa.h>

#include "../test/der_trailing_data.h"
#include "../test/file_test.h"
#include "../test/test_util.h"
#include "../test/wycheproof_util.h"

namespace {
// evp_test dispatches between multiple test types. PublicKey and PrivateKey
// tests take a key name parameter and key information. If the test is
// successful, the key is saved under that key name. Decrypt, Sign, and Verify
// tests take a previously imported key name as parameter and test their
// respective operations.

const EVP_MD *GetDigest(std::string_view name) {
  if (name == "MD5") {
    return EVP_md5();
  } else if (name == "SHA1") {
    return EVP_sha1();
  } else if (name == "SHA224") {
    return EVP_sha224();
  } else if (name == "SHA256") {
    return EVP_sha256();
  } else if (name == "SHA384") {
    return EVP_sha384();
  } else if (name == "SHA512") {
    return EVP_sha512();
  }
  ADD_FAILURE() << "Unknown digest: " << name;
  return nullptr;
}

std::optional<int> GetRSAPadding(std::string_view name) {
  if (name == "PKCS1") {
    return RSA_PKCS1_PADDING;
  }
  if (name == "PSS") {
    return RSA_PKCS1_PSS_PADDING;
  }
  if (name == "OAEP") {
    return RSA_PKCS1_OAEP_PADDING;
  }
  if (name == "None") {
    return RSA_NO_PADDING;
  }
  ADD_FAILURE() << "Unknown RSA padding mode: " << name;
  return std::nullopt;
}

struct AlgorithmInfo {
  const EVP_PKEY_ALG *alg;
  int pkey_id;
  bool is_default;
};

const std::map<std::string, AlgorithmInfo> kAllAlgorithms = {
    {"RSA", {EVP_pkey_rsa(), EVP_PKEY_RSA, true}},
    {"RSA-PSS-SHA-256", {EVP_pkey_rsa_pss_sha256(), EVP_PKEY_RSA_PSS, false}},
    {"RSA-PSS-SHA-384", {EVP_pkey_rsa_pss_sha384(), EVP_PKEY_RSA_PSS, false}},
    {"RSA-PSS-SHA-512", {EVP_pkey_rsa_pss_sha512(), EVP_PKEY_RSA_PSS, false}},
    {"EC-P-224", {EVP_pkey_ec_p224(), EVP_PKEY_EC, true}},
    {"EC-P-256", {EVP_pkey_ec_p256(), EVP_PKEY_EC, true}},
    {"EC-P-384", {EVP_pkey_ec_p384(), EVP_PKEY_EC, true}},
    {"EC-P-521", {EVP_pkey_ec_p521(), EVP_PKEY_EC, true}},
    {"X25519", {EVP_pkey_x25519(), EVP_PKEY_X25519, true}},
    {"Ed25519", {EVP_pkey_ed25519(), EVP_PKEY_ED25519, true}},
    {"DSA", {EVP_pkey_dsa(), EVP_PKEY_DSA, true}},
    {"ML-DSA-44", {EVP_pkey_ml_dsa_44(), EVP_PKEY_ML_DSA_44, false}},
    {"ML-DSA-65", {EVP_pkey_ml_dsa_65(), EVP_PKEY_ML_DSA_65, false}},
    {"ML-DSA-87", {EVP_pkey_ml_dsa_87(), EVP_PKEY_ML_DSA_87, false}},
};

using KeyMap = std::map<std::string, bssl::UniquePtr<EVP_PKEY>>;

enum class KeyRole { kPublic, kPrivate };

void CheckRSAParam(FileTest *t, std::string_view attr_name,
                   const EVP_PKEY *pkey,
                   const BIGNUM *(*rsa_getter)(const RSA *)) {
  SCOPED_TRACE(attr_name);
  if (t->HasAttribute(attr_name)) {
    bssl::UniquePtr<BIGNUM> want =
        HexToBIGNUM(t->GetAttributeOrDie(attr_name).c_str());
    ASSERT_TRUE(want);

    const RSA *rsa = EVP_PKEY_get0_RSA(pkey);
    ASSERT_TRUE(rsa);
    const BIGNUM *got = rsa_getter(rsa);
    ASSERT_TRUE(got);
    EXPECT_EQ(BN_cmp(want.get(), got), 0)
        << "wanted: " << BIGNUMToHex(want.get())
        << "\ngot: " << BIGNUMToHex(got);
  }
  // We have many test RSA keys so, for now, don't require that all RSA keys
  // list out these parameters. That is, the absence of an RSA parameter does
  // not currently assert that we omit them.
}

bool CheckRawKey(FileTest *t, std::string_view attr_name, const EVP_PKEY *pkey,
                 int (*getter)(const EVP_PKEY *pkey, uint8_t *out,
                               size_t *out_len)) {
  if (!t->HasAttribute(attr_name)) {
    size_t len;
    EXPECT_FALSE(getter(pkey, nullptr, &len));
    return true;
  }

  std::vector<uint8_t> expected;
  if (!t->GetBytes(&expected, attr_name)) {
    return false;
  }

  std::vector<uint8_t> raw;
  size_t len;
  if (!getter(pkey, nullptr, &len)) {
    return false;
  }
  raw.resize(len);
  if (!getter(pkey, raw.data(), &len)) {
    return false;
  }
  raw.resize(len);
  EXPECT_EQ(Bytes(raw), Bytes(expected));

  // Short buffers should be rejected.
  raw.resize(len - 1);
  len = raw.size();
  EXPECT_FALSE(getter(pkey, raw.data(), &len));
  return true;
}

bool ImportKey(FileTest *t, KeyMap *key_map, KeyRole key_role) {
  std::string format_name = key_role == KeyRole::kPublic ? "spki" : "pkcs8";
  auto parse_func = key_role == KeyRole::kPublic
                        ? &EVP_PKEY_from_subject_public_key_info
                        : &EVP_PKEY_from_private_key_info;
  auto parse_default_func = key_role == KeyRole::kPublic
                                ? &EVP_parse_public_key
                                : &EVP_parse_private_key;
  auto marshal_func = key_role == KeyRole::kPublic ? &EVP_marshal_public_key
                                                   : &EVP_marshal_private_key;

  // This test will first import the key from all available methods, then check
  // that all properties on all keys match.
  std::vector<std::pair<std::string, bssl::UniquePtr<EVP_PKEY>>> keys;

  // Parse from SPKI or PKCS#8.
  std::vector<uint8_t> input;
  if (!t->GetBytes(&input, "Input")) {
    return false;
  }

  // First, parse the key with all algorithms active. Check this before
  // specifying an individual algorithm, so that error cases do not need to
  // specify an Algorithm key.
  std::vector<const EVP_PKEY_ALG *> algs;
  for (const auto &[name, info] : kAllAlgorithms) {
    algs.push_back(info.alg);
  }
  bssl::UniquePtr<EVP_PKEY> new_key(
      parse_func(input.data(), input.size(), algs.data(), algs.size()));
  if (new_key == nullptr) {
    return false;
  }
  keys.emplace_back(format_name + " - all algs", std::move(new_key));

  // Test that the parsers reject trailing data.
  bool ok = TestDERTrailingData(
      input, [&](bssl::Span<const uint8_t> rewritten, size_t n) {
        // We currently intentionally ignore trailing data in the outermost
        // PKCS#8 PrivateKeyInfo element because we don't parse the attributes.
        if (n == 0 && key_role == KeyRole::kPrivate) {
          return;
        }
        SCOPED_TRACE(n);
        bssl::UniquePtr<EVP_PKEY> parsed(parse_func(
            rewritten.data(), rewritten.size(), algs.data(), algs.size()));
        EXPECT_FALSE(parsed);
      });
  EXPECT_TRUE(ok);

  // Parse with just the specific algorithm.
  std::string alg_name;
  if (!t->GetAttribute(&alg_name, "Algorithm")) {
    return false;
  }
  auto it = kAllAlgorithms.find(alg_name);
  if (it == kAllAlgorithms.end()) {
    ADD_FAILURE() << "Unknown algorithm: " << alg_name;
    return false;
  }
  const AlgorithmInfo &alg_info = it->second;
  new_key.reset(parse_func(input.data(), input.size(), &alg_info.alg, 1));
  if (new_key == nullptr) {
    return false;
  }
  keys.emplace_back(format_name + " - " + alg_name + " only",
                    std::move(new_key));

  // Parsing with all other algorithms should fail. This currently assumes each
  // key can only be parsed by one algorithm. Make the field a list of
  // algorithms if this ever changes.
  algs.clear();
  for (const auto &[name, info] : kAllAlgorithms) {
    if (name != alg_name) {
      algs.push_back(info.alg);
    }
  }
  new_key.reset(
      parse_func(input.data(), input.size(), algs.data(), algs.size()));
  EXPECT_FALSE(new_key);
  ERR_clear_error();

  // Parse with the default parser.
  CBS cbs(input);
  new_key.reset(parse_default_func(&cbs));
  if (alg_info.is_default) {
    if (new_key == nullptr) {
      return false;
    }
    keys.emplace_back(format_name + " - default algorithms",
                      std::move(new_key));
  } else {
    EXPECT_FALSE(new_key);
    ERR_clear_error();
  }

  // Import as a raw key.
  if (key_role == KeyRole::kPublic && t->HasAttribute("RawPublic")) {
    std::vector<uint8_t> raw;
    if (!t->GetBytes(&raw, "RawPublic")) {
      return false;
    }
    new_key.reset(
        EVP_PKEY_from_raw_public_key(alg_info.alg, raw.data(), raw.size()));
    if (new_key == nullptr) {
      return false;
    }
    keys.emplace_back("raw public", std::move(new_key));
  }
  if (key_role == KeyRole::kPrivate && t->HasAttribute("RawPrivate")) {
    std::vector<uint8_t> raw;
    if (!t->GetBytes(&raw, "RawPrivate")) {
      return false;
    }
    new_key.reset(
        EVP_PKEY_from_raw_private_key(alg_info.alg, raw.data(), raw.size()));
    if (new_key == nullptr) {
      return false;
    }
    keys.emplace_back("raw private", std::move(new_key));
  }
  if (key_role == KeyRole::kPrivate && t->HasAttribute("PrivateSeed")) {
    std::vector<uint8_t> raw;
    if (!t->GetBytes(&raw, "PrivateSeed")) {
      return false;
    }
    new_key.reset(
        EVP_PKEY_from_private_seed(alg_info.alg, raw.data(), raw.size()));
    if (new_key == nullptr) {
      return false;
    }
    keys.emplace_back("private seed", std::move(new_key));
  }

  // Import RSA key from parameters.
  if (alg_info.pkey_id == EVP_PKEY_RSA) {
    if (key_role == KeyRole::kPublic && t->HasAttribute("RSAParamN") &&
        t->HasAttribute("RSAParamE")) {
      bssl::UniquePtr<BIGNUM> n =
          HexToBIGNUM(t->GetAttributeOrDie("RSAParamN").c_str());
      bssl::UniquePtr<BIGNUM> e =
          HexToBIGNUM(t->GetAttributeOrDie("RSAParamE").c_str());
      if (n == nullptr || e == nullptr) {
        return false;
      }
      bssl::UniquePtr<RSA> rsa(RSA_new_public_key(n.get(), e.get()));
      new_key.reset(EVP_PKEY_new());
      if (rsa == nullptr || new_key == nullptr ||
          !EVP_PKEY_set1_RSA(new_key.get(), rsa.get())) {
        return false;
      }
      keys.emplace_back("RSA public params", std::move(new_key));
    }
    if (key_role == KeyRole::kPrivate && t->HasAttribute("RSAParamN") &&
        t->HasAttribute("RSAParamE") && t->HasAttribute("RSAParamD") &&
        t->HasAttribute("RSAParamP") && t->HasAttribute("RSAParamQ") &&
        t->HasAttribute("RSAParamDMP1") && t->HasAttribute("RSAParamDMQ1") &&
        t->HasAttribute("RSAParamIQMP")) {
      bssl::UniquePtr<BIGNUM> n =
          HexToBIGNUM(t->GetAttributeOrDie("RSAParamN").c_str());
      bssl::UniquePtr<BIGNUM> e =
          HexToBIGNUM(t->GetAttributeOrDie("RSAParamE").c_str());
      bssl::UniquePtr<BIGNUM> d =
          HexToBIGNUM(t->GetAttributeOrDie("RSAParamD").c_str());
      bssl::UniquePtr<BIGNUM> p =
          HexToBIGNUM(t->GetAttributeOrDie("RSAParamP").c_str());
      bssl::UniquePtr<BIGNUM> q =
          HexToBIGNUM(t->GetAttributeOrDie("RSAParamQ").c_str());
      bssl::UniquePtr<BIGNUM> dmp1 =
          HexToBIGNUM(t->GetAttributeOrDie("RSAParamDMP1").c_str());
      bssl::UniquePtr<BIGNUM> dmq1 =
          HexToBIGNUM(t->GetAttributeOrDie("RSAParamDMQ1").c_str());
      bssl::UniquePtr<BIGNUM> iqmp =
          HexToBIGNUM(t->GetAttributeOrDie("RSAParamIQMP").c_str());
      if (n == nullptr || e == nullptr) {
        return false;
      }
      bssl::UniquePtr<RSA> rsa(RSA_new_private_key(n.get(), e.get(), d.get(),
                                                   p.get(), q.get(), dmp1.get(),
                                                   dmq1.get(), iqmp.get()));
      new_key.reset(EVP_PKEY_new());
      if (rsa == nullptr || new_key == nullptr ||
          !EVP_PKEY_set1_RSA(new_key.get(), rsa.get())) {
        return false;
      }
      keys.emplace_back("RSA private params", std::move(new_key));
    }
  }

  // Check properties of the keys.
  for (const auto &[name, pkey] : keys) {
    SCOPED_TRACE(name);

    EXPECT_EQ(alg_info.pkey_id, EVP_PKEY_id(pkey.get()));

    if (t->HasAttribute("Bits")) {
      EXPECT_EQ(EVP_PKEY_bits(pkey.get()),
                atoi(t->GetAttributeOrDie("Bits").c_str()));
    }

    if (t->HasAttribute("ECCurve")) {
      EXPECT_EQ(OBJ_nid2sn(EVP_PKEY_get_ec_curve_nid(pkey.get())),
                t->GetAttributeOrDie("ECCurve"));
    } else {
      EXPECT_EQ(EVP_PKEY_get_ec_curve_nid(pkey.get()), NID_undef);
    }

    CheckRSAParam(t, "RSAParamN", pkey.get(), RSA_get0_n);
    CheckRSAParam(t, "RSAParamE", pkey.get(), RSA_get0_e);
    CheckRSAParam(t, "RSAParamD", pkey.get(), RSA_get0_d);
    CheckRSAParam(t, "RSAParamP", pkey.get(), RSA_get0_p);
    CheckRSAParam(t, "RSAParamQ", pkey.get(), RSA_get0_q);
    CheckRSAParam(t, "RSAParamDMP1", pkey.get(), RSA_get0_dmp1);
    CheckRSAParam(t, "RSAParamDMQ1", pkey.get(), RSA_get0_dmq1);
    CheckRSAParam(t, "RSAParamIQMP", pkey.get(), RSA_get0_iqmp);

    // All keys must compare equal.
    EXPECT_EQ(EVP_PKEY_cmp(pkey.get(), keys.front().second.get()), 1);

    // The key must re-encode correctly.
    bssl::ScopedCBB cbb;
    if (!CBB_init(cbb.get(), 0) || !marshal_func(cbb.get(), pkey.get())) {
      return false;
    }
    std::vector<uint8_t> output = input;
    if (t->HasAttribute("Output") && !t->GetBytes(&output, "Output")) {
      return false;
    }
    EXPECT_EQ(Bytes(output), Bytes(CBB_data(cbb.get()), CBB_len(cbb.get())))
        << "Re-encoding the key did not match.";

    if (!CheckRawKey(t, "RawPrivate", pkey.get(),
                     EVP_PKEY_get_raw_private_key) ||
        !CheckRawKey(t, "RawPublic", pkey.get(), EVP_PKEY_get_raw_public_key) ||
        !CheckRawKey(t, "PrivateSeed", pkey.get(), EVP_PKEY_get_private_seed)) {
      return false;
    }
  }

  // Save the key for future tests.
  const std::string &key_name = t->GetParameter();
  EXPECT_EQ(0u, key_map->count(key_name)) << "Duplicate key: " << key_name;
  (*key_map)[key_name] = std::move(keys.front().second);
  return true;
}

bool GetOptionalBignum(FileTest *t, bssl::UniquePtr<BIGNUM> *out,
                       const std::string &key) {
  if (!t->HasAttribute(key)) {
    *out = nullptr;
    return true;
  }

  std::vector<uint8_t> bytes;
  if (!t->GetBytes(&bytes, key)) {
    return false;
  }

  out->reset(BN_bin2bn(bytes.data(), bytes.size(), nullptr));
  return *out != nullptr;
}

bool ImportDHKey(FileTest *t, KeyMap *key_map) {
  bssl::UniquePtr<BIGNUM> p, q, g, pub_key, priv_key;
  if (!GetOptionalBignum(t, &p, "P") ||  //
      !GetOptionalBignum(t, &q, "Q") ||  //
      !GetOptionalBignum(t, &g, "G") ||
      !GetOptionalBignum(t, &pub_key, "Public") ||
      !GetOptionalBignum(t, &priv_key, "Private")) {
    return false;
  }

  bssl::UniquePtr<DH> dh(DH_new());
  if (dh == nullptr || !DH_set0_pqg(dh.get(), p.get(), q.get(), g.get())) {
    return false;
  }
  // |DH_set0_pqg| takes ownership on success.
  p.release();
  q.release();
  g.release();

  if (!DH_set0_key(dh.get(), pub_key.get(), priv_key.get())) {
    return false;
  }
  // |DH_set0_key| takes ownership on success.
  pub_key.release();
  priv_key.release();

  bssl::UniquePtr<EVP_PKEY> pkey(EVP_PKEY_new());
  if (pkey == nullptr || !EVP_PKEY_set1_DH(pkey.get(), dh.get())) {
    return false;
  }

  // Save the key for future tests.
  const std::string &key_name = t->GetParameter();
  EXPECT_EQ(0u, key_map->count(key_name)) << "Duplicate key: " << key_name;
  (*key_map)[key_name] = std::move(pkey);
  return true;
}

// SetupContext configures |ctx| based on attributes in |t|, with the exception
// of the signing digest which must be configured externally.
bool SetupContext(FileTest *t, const KeyMap *key_map, EVP_PKEY_CTX *ctx) {
  if (t->HasAttribute("RSAPadding")) {
    auto padding = GetRSAPadding(t->GetAttributeOrDie("RSAPadding"));
    if (!padding || !EVP_PKEY_CTX_set_rsa_padding(ctx, *padding)) {
      return false;
    }
  }
  if (t->HasAttribute("PSSSaltLength") &&
      !EVP_PKEY_CTX_set_rsa_pss_saltlen(
          ctx, atoi(t->GetAttributeOrDie("PSSSaltLength").c_str()))) {
    return false;
  }
  if (t->HasAttribute("MGF1Digest")) {
    const EVP_MD *digest = GetDigest(t->GetAttributeOrDie("MGF1Digest"));
    if (digest == nullptr || !EVP_PKEY_CTX_set_rsa_mgf1_md(ctx, digest)) {
      return false;
    }
  }
  if (t->HasAttribute("OAEPDigest")) {
    const EVP_MD *digest = GetDigest(t->GetAttributeOrDie("OAEPDigest"));
    if (digest == nullptr || !EVP_PKEY_CTX_set_rsa_oaep_md(ctx, digest)) {
      return false;
    }
  }
  if (t->HasAttribute("OAEPLabel")) {
    std::vector<uint8_t> label;
    if (!t->GetBytes(&label, "OAEPLabel")) {
      return false;
    }
    // For historical reasons, |EVP_PKEY_CTX_set0_rsa_oaep_label| expects to be
    // take ownership of the input.
    bssl::UniquePtr<uint8_t> buf(reinterpret_cast<uint8_t *>(
        OPENSSL_memdup(label.data(), label.size())));
    if (!buf ||
        !EVP_PKEY_CTX_set0_rsa_oaep_label(ctx, buf.get(), label.size())) {
      return false;
    }
    buf.release();
  }
  if (t->HasAttribute("DerivePeer")) {
    std::string derive_peer = t->GetAttributeOrDie("DerivePeer");
    auto it = key_map->find(derive_peer);
    if (it == key_map->end()) {
      ADD_FAILURE() << "Could not find key " << derive_peer;
      return false;
    }
    EVP_PKEY *derive_peer_key = it->second.get();
    if (!EVP_PKEY_derive_set_peer(ctx, derive_peer_key)) {
      return false;
    }
  }
  if (t->HasAttribute("DiffieHellmanPad") && !EVP_PKEY_CTX_set_dh_pad(ctx, 1)) {
    return false;
  }
  return true;
}

bool MaybeReplaceWithCopy(bssl::UniquePtr<EVP_PKEY_CTX> *ctx, bool copy_ctx) {
  if (!copy_ctx) {
    return true;
  }
  bssl::UniquePtr<EVP_PKEY_CTX> copy(EVP_PKEY_CTX_dup(ctx->get()));
  if (!copy) {
    return false;
  }
  *ctx = std::move(copy);
  return true;
}

bool MaybeReplaceWithCopy(bssl::UniquePtr<EVP_MD_CTX> *ctx, bool copy_ctx) {
  if (!copy_ctx) {
    return true;
  }
  bssl::UniquePtr<EVP_MD_CTX> copy(EVP_MD_CTX_new());
  if (ctx == nullptr || !EVP_MD_CTX_copy_ex(copy.get(), ctx->get())) {
    return false;
  }
  *ctx = std::move(copy);
  return true;
}

bool TestDerive(FileTest *t, const KeyMap *key_map, EVP_PKEY *key,
                bool copy_ctx) {
  bssl::UniquePtr<EVP_PKEY_CTX> ctx(EVP_PKEY_CTX_new(key, nullptr));
  if (!ctx ||  //
      !EVP_PKEY_derive_init(ctx.get()) ||
      !MaybeReplaceWithCopy(&ctx, copy_ctx) ||
      !SetupContext(t, key_map, ctx.get()) ||
      !MaybeReplaceWithCopy(&ctx, copy_ctx)) {
    return false;
  }

  size_t len;
  std::vector<uint8_t> actual, output;
  if (!EVP_PKEY_derive(ctx.get(), nullptr, &len)) {
    return false;
  }
  actual.resize(len);
  if (!EVP_PKEY_derive(ctx.get(), actual.data(), &len)) {
    return false;
  }
  actual.resize(len);

  // Defer looking up the attribute so Error works properly.
  if (!t->GetBytes(&output, "Output")) {
    return false;
  }
  EXPECT_EQ(Bytes(output), Bytes(actual));

  // Test when the buffer is too large.
  actual.resize(len + 1);
  len = actual.size();
  if (!EVP_PKEY_derive(ctx.get(), actual.data(), &len)) {
    return false;
  }
  actual.resize(len);
  EXPECT_EQ(Bytes(output), Bytes(actual));

  // Test when the buffer is too small.
  actual.resize(len - 1);
  len = actual.size();
  if (t->HasAttribute("SmallBufferTruncates")) {
    if (!EVP_PKEY_derive(ctx.get(), actual.data(), &len)) {
      return false;
    }
    actual.resize(len);
    EXPECT_EQ(Bytes(output.data(), len), Bytes(actual));
  } else {
    EXPECT_FALSE(EVP_PKEY_derive(ctx.get(), actual.data(), &len));
    ERR_clear_error();
  }
  return true;
}

bool TestEVPOperation(FileTest *t, const KeyMap *key_map, bool copy_ctx) {
  SCOPED_TRACE(copy_ctx);
  // Load the key.
  const std::string &key_name = t->GetParameter();
  auto it = key_map->find(key_name);
  if (it == key_map->end()) {
    ADD_FAILURE() << "Could not find key " << key_name;
    return false;
  }
  EVP_PKEY *key = it->second.get();

  int (*key_op_init)(EVP_PKEY_CTX *ctx) = nullptr;
  int (*key_op)(EVP_PKEY_CTX *ctx, uint8_t *out, size_t *out_len,
                const uint8_t *in, size_t in_len) = nullptr;
  int (*md_op_init)(EVP_MD_CTX *ctx, EVP_PKEY_CTX **pctx, const EVP_MD *type,
                    ENGINE *e, EVP_PKEY *pkey) = nullptr;
  bool is_verify = false;
  if (t->GetType() == "Decrypt") {
    key_op_init = EVP_PKEY_decrypt_init;
    key_op = EVP_PKEY_decrypt;
  } else if (t->GetType() == "Sign") {
    key_op_init = EVP_PKEY_sign_init;
    key_op = EVP_PKEY_sign;
  } else if (t->GetType() == "Verify") {
    key_op_init = EVP_PKEY_verify_init;
    is_verify = true;
  } else if (t->GetType() == "SignMessage") {
    md_op_init = EVP_DigestSignInit;
  } else if (t->GetType() == "VerifyMessage") {
    md_op_init = EVP_DigestVerifyInit;
    is_verify = true;
  } else if (t->GetType() == "Encrypt") {
    key_op_init = EVP_PKEY_encrypt_init;
    key_op = EVP_PKEY_encrypt;
  } else if (t->GetType() == "Derive") {
    return TestDerive(t, key_map, key, copy_ctx);
  } else {
    ADD_FAILURE() << "Unknown test " << t->GetType();
    return false;
  }

  const EVP_MD *digest = nullptr;
  if (t->HasAttribute("Digest")) {
    digest = GetDigest(t->GetAttributeOrDie("Digest"));
    if (digest == nullptr) {
      return false;
    }
  }

  // For verify tests, the "output" is the signature. Read it now so that, for
  // tests which expect a failure in SetupContext, the attribute is still
  // consumed.
  std::vector<uint8_t> input, actual, output;
  if (!t->GetBytes(&input, "Input") ||
      (is_verify && !t->GetBytes(&output, "Output"))) {
    return false;
  }

  if (md_op_init) {
    bssl::UniquePtr<EVP_MD_CTX> ctx(EVP_MD_CTX_new());
    EVP_PKEY_CTX *pctx;
    if (ctx == nullptr ||  //
        !md_op_init(ctx.get(), &pctx, digest, nullptr, key) ||
        !MaybeReplaceWithCopy(&ctx, copy_ctx) ||
        !SetupContext(t, key_map, pctx) ||
        !MaybeReplaceWithCopy(&ctx, copy_ctx)) {
      return false;
    }

    if (is_verify) {
      return EVP_DigestVerify(ctx.get(), output.data(), output.size(),
                              input.data(), input.size());
    }

    size_t len;
    if (!EVP_DigestSign(ctx.get(), nullptr, &len, input.data(), input.size())) {
      return false;
    }
    actual.resize(len);
    if (!EVP_DigestSign(ctx.get(), actual.data(), &len, input.data(),
                        input.size())) {
      return false;
    }
    actual.resize(len);

    if (t->HasAttribute("CheckVerify")) {
      // Some signature schemes are non-deterministic, so we check by verifying.
      bssl::UniquePtr<EVP_MD_CTX> verify_ctx(EVP_MD_CTX_new());
      EVP_PKEY_CTX *verify_pctx;
      if (verify_ctx == nullptr ||
          !EVP_DigestVerifyInit(verify_ctx.get(), &verify_pctx, digest, nullptr,
                                key) ||

          !MaybeReplaceWithCopy(&verify_ctx, copy_ctx) ||
          !SetupContext(t, key_map, verify_pctx) ||
          !MaybeReplaceWithCopy(&verify_ctx, copy_ctx)) {
        return false;
      }
      EXPECT_TRUE(EVP_DigestVerify(verify_ctx.get(), actual.data(),
                                   actual.size(), input.data(), input.size()))
          << "Could not verify result.";
      return true;
    }

    if (!t->GetBytes(&output, "Output")) {
      return false;
    }
    EXPECT_EQ(Bytes(output), Bytes(actual));
    return true;
  }

  bssl::UniquePtr<EVP_PKEY_CTX> ctx(EVP_PKEY_CTX_new(key, nullptr));
  if (!ctx || !key_op_init(ctx.get()) ||
      !MaybeReplaceWithCopy(&ctx, copy_ctx) ||
      (digest != nullptr &&
       !EVP_PKEY_CTX_set_signature_md(ctx.get(), digest)) ||
      !SetupContext(t, key_map, ctx.get()) ||
      !MaybeReplaceWithCopy(&ctx, copy_ctx)) {
    return false;
  }

  if (is_verify) {
    return EVP_PKEY_verify(ctx.get(), output.data(), output.size(),
                           input.data(), input.size());
  }

  size_t len;
  if (!key_op(ctx.get(), nullptr, &len, input.data(), input.size())) {
    return false;
  }
  actual.resize(len);
  if (!key_op(ctx.get(), actual.data(), &len, input.data(), input.size())) {
    return false;
  }

  if (t->HasAttribute("CheckDecrypt")) {
    // Encryption is non-deterministic, so we check by decrypting.
    size_t plaintext_len;
    bssl::UniquePtr<EVP_PKEY_CTX> decrypt_ctx(EVP_PKEY_CTX_new(key, nullptr));
    if (!decrypt_ctx ||  //
        !EVP_PKEY_decrypt_init(decrypt_ctx.get()) ||
        !MaybeReplaceWithCopy(&decrypt_ctx, copy_ctx) ||
        (digest != nullptr &&
         !EVP_PKEY_CTX_set_signature_md(decrypt_ctx.get(), digest)) ||
        !SetupContext(t, key_map, decrypt_ctx.get()) ||
        !MaybeReplaceWithCopy(&decrypt_ctx, copy_ctx) ||
        !EVP_PKEY_decrypt(decrypt_ctx.get(), nullptr, &plaintext_len,
                          actual.data(), actual.size())) {
      return false;
    }
    output.resize(plaintext_len);
    if (!EVP_PKEY_decrypt(decrypt_ctx.get(), output.data(), &plaintext_len,
                          actual.data(), actual.size())) {
      ADD_FAILURE() << "Could not decrypt result.";
      return false;
    }
    output.resize(plaintext_len);
    EXPECT_EQ(Bytes(input), Bytes(output)) << "Decrypted result mismatch.";
  } else if (t->HasAttribute("CheckVerify")) {
    // Some signature schemes are non-deterministic, so we check by verifying.
    bssl::UniquePtr<EVP_PKEY_CTX> verify_ctx(EVP_PKEY_CTX_new(key, nullptr));
    if (!verify_ctx ||  //
        !EVP_PKEY_verify_init(verify_ctx.get()) ||
        !MaybeReplaceWithCopy(&verify_ctx, copy_ctx) ||
        (digest != nullptr &&
         !EVP_PKEY_CTX_set_signature_md(verify_ctx.get(), digest)) ||
        !SetupContext(t, key_map, verify_ctx.get()) ||
        !MaybeReplaceWithCopy(&verify_ctx, copy_ctx)) {
      return false;
    }
    if (t->HasAttribute("VerifyPSSSaltLength")) {
      if (!EVP_PKEY_CTX_set_rsa_pss_saltlen(
              verify_ctx.get(),
              atoi(t->GetAttributeOrDie("VerifyPSSSaltLength").c_str()))) {
        return false;
      }
    }
    EXPECT_TRUE(EVP_PKEY_verify(verify_ctx.get(), actual.data(), actual.size(),
                                input.data(), input.size()))
        << "Could not verify result.";
  } else {
    // By default, check by comparing the result against Output.
    if (!t->GetBytes(&output, "Output")) {
      return false;
    }
    actual.resize(len);
    EXPECT_EQ(Bytes(output), Bytes(actual));
  }
  return true;
}

bool TestEVP(FileTest *t, KeyMap *key_map) {
  if (t->GetType() == "PrivateKey") {
    return ImportKey(t, key_map, KeyRole::kPrivate);
  }

  if (t->GetType() == "PublicKey") {
    return ImportKey(t, key_map, KeyRole::kPublic);
  }

  if (t->GetType() == "DHKey") {
    return ImportDHKey(t, key_map);
  }

  // Run the test twice, once copying the context and once normally.
  return TestEVPOperation(t, key_map, /*copy_ctx=*/false) &&
         TestEVPOperation(t, key_map, /*copy_ctx=*/true);
}

void RunEVPTests(const char *path) {
  KeyMap key_map;
  FileTestGTest(path, [&](FileTest *t) {
    bool result = TestEVP(t, &key_map);
    if (t->HasAttribute("Error")) {
      ASSERT_FALSE(result) << "Operation unexpectedly succeeded.";
      uint32_t err = ERR_peek_error();
      EXPECT_EQ(t->GetAttributeOrDie("Error"), ERR_reason_error_string(err));
    } else if (!result) {
      ADD_FAILURE() << "Operation unexpectedly failed.";
    }
  });
}

TEST(EVPTest, GeneralTestVectors) {
  RunEVPTests("crypto/evp/test/evp_tests.txt");
}

TEST(EVPTest, DHTestVectors) { RunEVPTests("crypto/evp/test/dh_tests.txt"); }

TEST(EVPTest, ECTestVectors) { RunEVPTests("crypto/evp/test/ec_tests.txt"); }

TEST(EVPTest, Ed25519TestVectors) {
  RunEVPTests("crypto/evp/test/ed25519_tests.txt");
}

TEST(EVPTest, MLDSATestVectors) {
  RunEVPTests("crypto/evp/test/mldsa_tests.txt");
}

TEST(EVPTest, RSATestVectors) { RunEVPTests("crypto/evp/test/rsa_tests.txt"); }

TEST(EVPTest, X25519TestVectors) {
  RunEVPTests("crypto/evp/test/x25519_tests.txt");
}

void RunWycheproofVerifyTest(const char *path, const EVP_PKEY_ALG *alg) {
  SCOPED_TRACE(path);
  FileTestGTest(path, [&](FileTest *t) {
    t->IgnoreAllUnusedInstructions();

    const EVP_MD *md = nullptr;
    if (t->HasInstruction("sha")) {
      md = GetWycheproofDigest(t, "sha", true);
      ASSERT_TRUE(md);
    }

    bool is_pss = t->HasInstruction("mgf");
    const EVP_MD *mgf1_md = nullptr;
    int pss_salt_len = RSA_PSS_SALTLEN_DIGEST;
    if (is_pss) {
      ASSERT_EQ("MGF1", t->GetInstructionOrDie("mgf"));
      mgf1_md = GetWycheproofDigest(t, "mgfSha", true);

      std::string s_len;
      ASSERT_TRUE(t->GetInstruction(&s_len, "sLen"));
      pss_salt_len = atoi(s_len.c_str());
    }

    std::vector<uint8_t> msg;
    ASSERT_TRUE(t->GetBytes(&msg, "msg"));
    std::vector<uint8_t> sig;
    ASSERT_TRUE(t->GetBytes(&sig, "sig"));
    std::vector<uint8_t> sig_ctx;
    if (t->HasAttribute("ctx")) {
      ASSERT_TRUE(t->GetBytes(&sig_ctx, "ctx"));
    }
    WycheproofResult result;
    ASSERT_TRUE(GetWycheproofResult(t, &result));
    // BoringSSL does not enforce policies on weak keys and leaves it to the
    // caller.
    bool expect_valid =
        result.IsValid({"SmallModulus", "SmallPublicKey", "WeakHash"});

    std::vector<uint8_t> der;
    ASSERT_TRUE(t->GetInstructionBytes(&der, "publicKeyDer"));
    bssl::UniquePtr<EVP_PKEY> key(
        EVP_PKEY_from_subject_public_key_info(der.data(), der.size(), &alg, 1));
    if (!key) {
      EXPECT_FALSE(expect_valid);
      return;
    }

    // We do not currently support signature contexts.
    // TODO(crbug.com/449751916): Support this.
    if (!sig_ctx.empty()) {
      return;
    }

    if (EVP_PKEY_id(key.get()) == EVP_PKEY_DSA) {
      // DSA is deprecated and is not usable via EVP.
      DSA *dsa = EVP_PKEY_get0_DSA(key.get());
      uint8_t digest[EVP_MAX_MD_SIZE];
      unsigned digest_len;
      ASSERT_TRUE(
          EVP_Digest(msg.data(), msg.size(), digest, &digest_len, md, nullptr));
      int valid;
      bool sig_ok = DSA_check_signature(&valid, digest, digest_len, sig.data(),
                                        sig.size(), dsa) &&
                    valid;
      EXPECT_EQ(sig_ok, result.IsValid());
    } else {
      bssl::ScopedEVP_MD_CTX ctx;
      EVP_PKEY_CTX *pctx;
      ASSERT_TRUE(
          EVP_DigestVerifyInit(ctx.get(), &pctx, md, nullptr, key.get()));
      if (is_pss) {
        ASSERT_TRUE(EVP_PKEY_CTX_set_rsa_padding(pctx, RSA_PKCS1_PSS_PADDING));
        ASSERT_TRUE(EVP_PKEY_CTX_set_rsa_mgf1_md(pctx, mgf1_md));
        ASSERT_TRUE(EVP_PKEY_CTX_set_rsa_pss_saltlen(pctx, pss_salt_len));
      }
      int ret = EVP_DigestVerify(ctx.get(), sig.data(), sig.size(), msg.data(),
                                 msg.size());
      EXPECT_EQ(ret, expect_valid ? 1 : 0);
    }
  });
}

TEST(EVPTest, WycheproofDSA) {
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/dsa_2048_224_sha224_test.txt",
      EVP_pkey_dsa());
}

TEST(EVPTest, WycheproofECDSAP224) {
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/ecdsa_secp224r1_sha224_test.txt",
      EVP_pkey_ec_p224());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/ecdsa_secp224r1_sha256_test.txt",
      EVP_pkey_ec_p224());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/ecdsa_secp224r1_sha512_test.txt",
      EVP_pkey_ec_p224());
}

TEST(EVPTest, WycheproofECDSAP256) {
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/ecdsa_secp256r1_sha256_test.txt",
      EVP_pkey_ec_p256());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/ecdsa_secp256r1_sha512_test.txt",
      EVP_pkey_ec_p256());
}

TEST(EVPTest, WycheproofECDSAP384) {
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/ecdsa_secp384r1_sha384_test.txt",
      EVP_pkey_ec_p384());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/ecdsa_secp384r1_sha512_test.txt",
      EVP_pkey_ec_p384());
}

TEST(EVPTest, WycheproofECDSAP521) {
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/ecdsa_secp521r1_sha512_test.txt",
      EVP_pkey_ec_p521());
}

TEST(EVPTest, WycheproofEd25519) {
  RunWycheproofVerifyTest("third_party/wycheproof_testvectors/ed25519_test.txt",
                          EVP_pkey_ed25519());
}

// TODO(crbug.com/449751916): We also test these in the low-level ML-DSA code.
// The EVP-level tests are not yet redundant:
//
// * We can't yet run the tests with a context argument.
// * We can't yet run the signing tests with external entropy.
//
// When/if we add |EVP_PKEY|-based APIs for those, we may be able to remove the
// low-level copy.

TEST(EVPTest, WycheproofMLDSA44) {
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/mldsa_44_verify_test.txt",
      EVP_pkey_ml_dsa_44());
}

TEST(EVPTest, WycheproofMLDSA65) {
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/mldsa_65_verify_test.txt",
      EVP_pkey_ml_dsa_65());
}

TEST(EVPTest, WycheproofMLDSA87) {
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/mldsa_87_verify_test.txt",
      EVP_pkey_ml_dsa_87());
}

TEST(EVPTest, WycheproofRSAPKCS1) {
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_signature_2048_sha224_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_signature_2048_sha256_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_signature_2048_sha384_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_signature_2048_sha512_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_signature_3072_sha256_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_signature_3072_sha384_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_signature_3072_sha512_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_signature_4096_sha256_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_signature_4096_sha384_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_signature_4096_sha512_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_signature_8192_sha256_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_signature_8192_sha384_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_signature_8192_sha512_test.txt",
      EVP_pkey_rsa());
}

void RunWycheproofSignTest(FileTest *t) {
  t->IgnoreAllUnusedInstructions();

  std::vector<uint8_t> pkcs8;
  ASSERT_TRUE(t->GetInstructionBytes(&pkcs8, "privateKeyPkcs8"));
  CBS cbs;
  CBS_init(&cbs, pkcs8.data(), pkcs8.size());
  bssl::UniquePtr<EVP_PKEY> key(EVP_parse_private_key(&cbs));
  ASSERT_TRUE(key);

  const EVP_MD *md = GetWycheproofDigest(t, "sha", true);
  ASSERT_TRUE(md);

  std::vector<uint8_t> msg, sig;
  ASSERT_TRUE(t->GetBytes(&msg, "msg"));
  ASSERT_TRUE(t->GetBytes(&sig, "sig"));
  WycheproofResult result;
  ASSERT_TRUE(GetWycheproofResult(t, &result));

  bssl::ScopedEVP_MD_CTX ctx;
  EVP_PKEY_CTX *pctx;
  ASSERT_TRUE(EVP_DigestSignInit(ctx.get(), &pctx, md, nullptr, key.get()));
  std::vector<uint8_t> out(EVP_PKEY_size(key.get()));
  size_t len = out.size();
  int ret = EVP_DigestSign(ctx.get(), out.data(), &len, msg.data(), msg.size());
  // BoringSSL does not enforce policies on weak keys and leaves it to the
  // caller.
  bool is_valid =
      result.IsValid({"SmallModulus", "SmallPublicKey", "WeakHash"});
  EXPECT_EQ(ret, is_valid ? 1 : 0);
  if (is_valid) {
    out.resize(len);
    EXPECT_EQ(Bytes(sig), Bytes(out));
  }
}

TEST(EVPTest, WycheproofRSAPKCS1Sign) {
  FileTestGTest(
      "third_party/wycheproof_testvectors/rsa_pkcs1_1024_sig_gen_test.txt",
      RunWycheproofSignTest);
  FileTestGTest(
      "third_party/wycheproof_testvectors/rsa_pkcs1_1536_sig_gen_test.txt",
      RunWycheproofSignTest);
  FileTestGTest(
      "third_party/wycheproof_testvectors/rsa_pkcs1_2048_sig_gen_test.txt",
      RunWycheproofSignTest);
  FileTestGTest(
      "third_party/wycheproof_testvectors/rsa_pkcs1_3072_sig_gen_test.txt",
      RunWycheproofSignTest);
  FileTestGTest(
      "third_party/wycheproof_testvectors/rsa_pkcs1_4096_sig_gen_test.txt",
      RunWycheproofSignTest);
}

TEST(EVPTest, WycheproofRSAPSS) {
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_pss_2048_sha1_mgf1_20_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_pss_2048_sha256_mgf1_0_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_pss_2048_sha256_mgf1_32_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_pss_3072_sha256_mgf1_32_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_pss_4096_sha256_mgf1_32_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_pss_4096_sha512_mgf1_32_test.txt",
      EVP_pkey_rsa());
  RunWycheproofVerifyTest(
      "third_party/wycheproof_testvectors/rsa_pss_misc_test.txt",
      EVP_pkey_rsa());
}

void RunWycheproofDecryptTest(
    const char *path,
    std::function<void(FileTest *, EVP_PKEY_CTX *)> setup_cb) {
  FileTestGTest(path, [&](FileTest *t) {
    t->IgnoreAllUnusedInstructions();

    std::vector<uint8_t> pkcs8;
    ASSERT_TRUE(t->GetInstructionBytes(&pkcs8, "privateKeyPkcs8"));
    CBS cbs;
    CBS_init(&cbs, pkcs8.data(), pkcs8.size());
    bssl::UniquePtr<EVP_PKEY> key(EVP_parse_private_key(&cbs));
    ASSERT_TRUE(key);

    std::vector<uint8_t> ct, msg;
    ASSERT_TRUE(t->GetBytes(&ct, "ct"));
    ASSERT_TRUE(t->GetBytes(&msg, "msg"));
    WycheproofResult result;
    ASSERT_TRUE(GetWycheproofResult(t, &result));

    bssl::UniquePtr<EVP_PKEY_CTX> ctx(EVP_PKEY_CTX_new(key.get(), nullptr));
    ASSERT_TRUE(ctx);
    ASSERT_TRUE(EVP_PKEY_decrypt_init(ctx.get()));
    ASSERT_NO_FATAL_FAILURE(setup_cb(t, ctx.get()));
    std::vector<uint8_t> out(EVP_PKEY_size(key.get()));
    size_t len = out.size();
    int ret =
        EVP_PKEY_decrypt(ctx.get(), out.data(), &len, ct.data(), ct.size());
    // BoringSSL does not enforce policies on weak keys and leaves it to the
    // caller.
    bool is_valid =
        result.IsValid({"SmallModulus", "Constructed", "EncryptionWithLabel",
                        "SmallIntegerCiphertext"});
    EXPECT_EQ(ret, is_valid ? 1 : 0);
    if (is_valid) {
      out.resize(len);
      EXPECT_EQ(Bytes(msg), Bytes(out));
    }
  });
}

void RunWycheproofOAEPTest(const char *path) {
  RunWycheproofDecryptTest(path, [](FileTest *t, EVP_PKEY_CTX *ctx) {
    const EVP_MD *md = GetWycheproofDigest(t, "sha", true);
    ASSERT_TRUE(md);
    const EVP_MD *mgf1_md = GetWycheproofDigest(t, "mgfSha", true);
    ASSERT_TRUE(mgf1_md);
    std::vector<uint8_t> label;
    ASSERT_TRUE(t->GetBytes(&label, "label"));

    ASSERT_TRUE(EVP_PKEY_CTX_set_rsa_padding(ctx, RSA_PKCS1_OAEP_PADDING));
    ASSERT_TRUE(EVP_PKEY_CTX_set_rsa_oaep_md(ctx, md));
    ASSERT_TRUE(EVP_PKEY_CTX_set_rsa_mgf1_md(ctx, mgf1_md));
    bssl::UniquePtr<uint8_t> label_copy(
        static_cast<uint8_t *>(OPENSSL_memdup(label.data(), label.size())));
    ASSERT_TRUE(label_copy || label.empty());
    ASSERT_TRUE(
        EVP_PKEY_CTX_set0_rsa_oaep_label(ctx, label_copy.get(), label.size()));
    // |EVP_PKEY_CTX_set0_rsa_oaep_label| takes ownership on success.
    label_copy.release();
  });
}

TEST(EVPTest, WycheproofRSAOAEP2048) {
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/"
      "rsa_oaep_2048_sha1_mgf1sha1_test.txt");
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/"
      "rsa_oaep_2048_sha224_mgf1sha1_test.txt");
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/"
      "rsa_oaep_2048_sha224_mgf1sha224_test.txt");
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/"
      "rsa_oaep_2048_sha256_mgf1sha1_test.txt");
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/"
      "rsa_oaep_2048_sha256_mgf1sha256_test.txt");
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/"
      "rsa_oaep_2048_sha384_mgf1sha1_test.txt");
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/"
      "rsa_oaep_2048_sha384_mgf1sha384_test.txt");
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/"
      "rsa_oaep_2048_sha512_mgf1sha1_test.txt");
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/"
      "rsa_oaep_2048_sha512_mgf1sha512_test.txt");
}

TEST(EVPTest, WycheproofRSAOAEP3072) {
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/"
      "rsa_oaep_3072_sha256_mgf1sha1_test.txt");
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/"
      "rsa_oaep_3072_sha256_mgf1sha256_test.txt");
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/"
      "rsa_oaep_3072_sha512_mgf1sha1_test.txt");
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/"
      "rsa_oaep_3072_sha512_mgf1sha512_test.txt");
}

TEST(EVPTest, WycheproofRSAOAEP4096) {
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/"
      "rsa_oaep_4096_sha256_mgf1sha1_test.txt");
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/"
      "rsa_oaep_4096_sha256_mgf1sha256_test.txt");
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/"
      "rsa_oaep_4096_sha512_mgf1sha1_test.txt");
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/"
      "rsa_oaep_4096_sha512_mgf1sha512_test.txt");
}

TEST(EVPTest, WycheproofRSAOAEPMisc) {
  RunWycheproofOAEPTest(
      "third_party/wycheproof_testvectors/rsa_oaep_misc_test.txt");
}

void RunWycheproofPKCS1DecryptTest(const char *path) {
  RunWycheproofDecryptTest(path, [](FileTest *t, EVP_PKEY_CTX *ctx) {
    // No setup needed. PKCS#1 is, sadly, the default.
  });
}

TEST(EVPTest, WycheproofRSAPKCS1Decrypt) {
  RunWycheproofPKCS1DecryptTest(
      "third_party/wycheproof_testvectors/rsa_pkcs1_2048_test.txt");
  RunWycheproofPKCS1DecryptTest(
      "third_party/wycheproof_testvectors/rsa_pkcs1_3072_test.txt");
  RunWycheproofPKCS1DecryptTest(
      "third_party/wycheproof_testvectors/rsa_pkcs1_4096_test.txt");
}
}  // namespace
