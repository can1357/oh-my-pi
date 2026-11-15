// Copyright 2023 The BoringSSL Authors
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

#include <openssl/pki/verify.h>

#include <assert.h>

#include <chrono>
#include <optional>
#include <string_view>

#include <openssl/base.h>
#include <openssl/bytestring.h>
#include <openssl/pool.h>

#include <openssl/pki/signature_verify_cache.h>

#include "cert_errors.h"
#include "cert_issuer_source_static.h"
#include "certificate_policies.h"
#include "common_cert_errors.h"
#include "encode_values.h"
#include "input.h"
#include "parse_certificate.h"
#include "parse_values.h"
#include "parsed_certificate.h"
#include "path_builder.h"
#include "simple_path_builder_delegate.h"
#include "trust_store.h"
#include "trust_store_in_memory.h"
#include "verify_certificate_chain.h"

BSSL_NAMESPACE_BEGIN

namespace {

std::optional<std::shared_ptr<const ParsedCertificate>>
InternalParseCertificate(Span<const uint8_t> cert, std::string *out_diagnostic) {
  ParseCertificateOptions default_options{};
  // We follow Chromium in setting |allow_invalid_serial_numbers| in order to
  // not choke on 21-byte serial numbers, which are common.
  //
  // The reason for the discrepancy is that unsigned numbers with the high bit
  // otherwise set get an extra 0 byte in front to keep them positive. So if you
  // do:
  //    var num [20]byte
  //    fillWithRandom(num[:])
  //    serialNumber := new(big.Int).SetBytes(num[:])
  //    encodeASN1Integer(serialNumber)
  //
  // Then half of your serial numbers will be encoded with 21 bytes. (And
  // 1/512th will have 19 bytes instead of 20.)
  default_options.allow_invalid_serial_numbers = true;

  UniquePtr<CRYPTO_BUFFER> buffer(
      CRYPTO_BUFFER_new(cert.data(), cert.size(), nullptr));
  CertErrors errors;
  std::shared_ptr<const ParsedCertificate> parsed_cert(
      ParsedCertificate::Create(std::move(buffer), default_options, &errors));
  if (!parsed_cert) {
    *out_diagnostic = errors.ToDebugString();
    return {};
  }
  return parsed_cert;
}
}  // namespace


CertPool::CertPool() {}

CertificateVerifyOptions::CertificateVerifyOptions() {}

static std::unique_ptr<VerifyTrustStore> WrapTrustStore(
    std::unique_ptr<TrustStoreInMemory> trust_store) {
  std::unique_ptr<VerifyTrustStore> ret(new VerifyTrustStore);
  ret->trust_store = std::move(trust_store);
  return ret;
}

VerifyTrustStore::~VerifyTrustStore() {}

std::unique_ptr<VerifyTrustStore> VerifyTrustStore::FromDER(
    std::string_view der_certs, std::string *out_diagnostic) {
  auto store = std::make_unique<TrustStoreInMemory>();
  CBS cbs = StringAsBytes(der_certs);

  for (size_t cert_num = 1; CBS_len(&cbs) != 0; cert_num++) {
    CBS cert;
    if (!CBS_get_asn1_element(&cbs, &cert, CBS_ASN1_SEQUENCE)) {
      *out_diagnostic = "failed to get ASN.1 SEQUENCE from input at cert " +
                        std::to_string(cert_num);
      return {};
    }

    auto parsed_cert = InternalParseCertificate(cert, out_diagnostic);
    if (!parsed_cert.has_value()) {
      return {};
    }
    store->AddTrustAnchor(parsed_cert.value());
  }

  return WrapTrustStore(std::move(store));
}

std::unique_ptr<VerifyTrustStore> VerifyTrustStore::FromDER(
    const std::vector<std::string_view> &der_roots,
    std::string *out_diagnostic) {
  auto store = std::make_unique<TrustStoreInMemory>();

  for (const std::string_view &cert : der_roots) {
    auto parsed_cert = InternalParseCertificate(StringAsBytes(cert), out_diagnostic);
    if (!parsed_cert.has_value()) {
      return {};
    }
    store->AddTrustAnchor(parsed_cert.value());
  }

  return WrapTrustStore(std::move(store));
}

CertPool::~CertPool() {}


std::unique_ptr<CertPool> CertPool::FromCerts(
    const std::vector<std::string_view> &der_certs,
    std::string *out_diagnostic) {
  auto pool = std::make_unique<CertPool>();
  pool->impl_ = std::make_unique<CertIssuerSourceStatic>();

  for (const std::string_view &cert : der_certs) {
    auto parsed_cert =
        InternalParseCertificate(StringAsBytes(cert), out_diagnostic);
    if (!parsed_cert.has_value()) {
      return {};
    }
    pool->impl_->AddCert(std::move(parsed_cert.value()));
  }

  return pool;
}

CertificateVerifyStatus::CertificateVerifyStatus() {}

size_t CertificateVerifyStatus::IterationCount() const {
  return iteration_count_;
}

size_t CertificateVerifyStatus::MaxDepthSeen() const { return max_depth_seen_; }

// PathBuilderDelegateImpl implements a deadline and allows for the
// use of a SignatureVerifyCache if an implementation is provided.
class PathBuilderDelegateImpl : public SimplePathBuilderDelegate {
 public:
  PathBuilderDelegateImpl(
      size_t min_rsa_modulus_length_bits, DigestPolicy digest_policy,
      std::chrono::time_point<std::chrono::steady_clock> deadline,
      SignatureVerifyCache *cache)
      : SimplePathBuilderDelegate(min_rsa_modulus_length_bits, digest_policy),
        deadline_(deadline),
        cache_(cache) {}

  bool IsDeadlineExpired() override {
    return (std::chrono::steady_clock::now() > deadline_);
  }

  SignatureVerifyCache *GetVerifyCache() override { return cache_; }

 private:
  const std::chrono::time_point<std::chrono::steady_clock> deadline_;
  SignatureVerifyCache *cache_;
};

std::optional<std::vector<std::vector<std::string>>> CertificateVerifyInternal(
    const CertificateVerifyOptions &opts, VerifyError *out_error,
    CertificateVerifyStatus *out_status, bool all_paths) {
  VerifyError dummy;
  if (!out_error) {
    out_error = &dummy;
  }
  if (out_status != nullptr) {
    out_status->iteration_count_ = 0;
    out_status->max_depth_seen_ = 0;
  }

  std::string diagnostic;
  std::optional<std::shared_ptr<const ParsedCertificate>> maybe_leaf =
      InternalParseCertificate(StringAsBytes(opts.leaf_cert), &diagnostic);

  if (!maybe_leaf.has_value()) {
    *out_error = {VerifyError::StatusCode::CERTIFICATE_INVALID, 0, diagnostic};
    return {};
  }
  std::shared_ptr<const ParsedCertificate> leaf_cert = maybe_leaf.value();

  int64_t now;
  if (opts.time.has_value()) {
    now = opts.time.value();
  } else {
    now = time(nullptr);
  }

  der::GeneralizedTime verification_time;
  if (!der::EncodePosixTimeAsGeneralizedTime(now, &verification_time)) {
    *out_error = {VerifyError::StatusCode::VERIFICATION_FAILURE, -1,
                  "\nCould not encode verification time\n"};
    return {};
  }

  TrustStore *trust_store = nullptr;
  if (opts.trust_store) {
    trust_store = opts.trust_store->trust_store.get();
  }

  auto digest_policy = SimplePathBuilderDelegate::DigestPolicy::kStrong;
  // TODO(b/111551631): remove this
  if (opts.insecurely_allow_sha1) {
    digest_policy = SimplePathBuilderDelegate::DigestPolicy::kWeakAllowSha1;
  }

  std::chrono::time_point<std::chrono::steady_clock> deadline =
      std::chrono::time_point<std::chrono::steady_clock>::max();
  if (opts.deadline.has_value()) {
    deadline = opts.deadline.value();
  }

  PathBuilderDelegateImpl path_builder_delegate(
      opts.min_rsa_modulus_length, digest_policy, deadline,
      opts.signature_verify_cache);

  KeyPurpose key_purpose = KeyPurpose::SERVER_AUTH;
  switch (opts.key_purpose) {
    case CertificateVerifyOptions::KeyPurpose::ANY_EKU:
      key_purpose = KeyPurpose::ANY_EKU;
      break;
    case CertificateVerifyOptions::KeyPurpose::SERVER_AUTH:
      key_purpose = KeyPurpose::SERVER_AUTH;
      break;
    case CertificateVerifyOptions::KeyPurpose::CLIENT_AUTH:
      key_purpose = KeyPurpose::CLIENT_AUTH;
      break;
    case CertificateVerifyOptions::KeyPurpose::SERVER_AUTH_STRICT:
      key_purpose = KeyPurpose::SERVER_AUTH_STRICT;
      break;
    case CertificateVerifyOptions::KeyPurpose::CLIENT_AUTH_STRICT:
      key_purpose = KeyPurpose::CLIENT_AUTH_STRICT;
      break;
    case CertificateVerifyOptions::KeyPurpose::SERVER_AUTH_STRICT_LEAF:
      key_purpose = KeyPurpose::SERVER_AUTH_STRICT_LEAF;
      break;
    case CertificateVerifyOptions::KeyPurpose::CLIENT_AUTH_STRICT_LEAF:
      key_purpose = KeyPurpose::CLIENT_AUTH_STRICT_LEAF;
      break;
    case CertificateVerifyOptions::KeyPurpose::RCS_MLS_CLIENT_AUTH:
      key_purpose = KeyPurpose::RCS_MLS_CLIENT_AUTH;
      break;
    case CertificateVerifyOptions::KeyPurpose::C2PA_TIMESTAMPING:
      key_purpose = KeyPurpose::C2PA_TIMESTAMPING;
      break;
    case CertificateVerifyOptions::KeyPurpose::C2PA_MANIFEST:
      key_purpose = KeyPurpose::C2PA_MANIFEST;
      break;
  }
  CertPathBuilder path_builder(leaf_cert, trust_store, &path_builder_delegate,
                               verification_time, key_purpose,
                               InitialExplicitPolicy::kFalse,
                               /* user_initial_policy_set= */
                               {der::Input(kAnyPolicyOid)},
                               InitialPolicyMappingInhibit::kFalse,
                               InitialAnyPolicyInhibit::kFalse);

  CertIssuerSourceStatic intermediates;
  for (const std::string_view &cert : opts.intermediates) {
    std::string diag_string;
    std::optional<std::shared_ptr<const ParsedCertificate>> parsed =
        InternalParseCertificate(StringAsBytes(cert), &diag_string);
    if (!parsed.has_value()) {
      if (path_builder_delegate.IsDebugLogEnabled()) {
        path_builder_delegate.DebugLog("skipping bad intermediate: " +
                                       diag_string);
      }
      continue;
    }
    intermediates.AddCert(std::move(parsed.value()));
  }
  path_builder.AddCertIssuerSource(&intermediates);

  if (opts.extra_intermediates != nullptr) {
    path_builder.AddCertIssuerSource(opts.extra_intermediates->impl_.get());
  }

  if (opts.max_iteration_count > 0) {
    path_builder.SetIterationLimit(opts.max_iteration_count);
  }

  if (opts.max_path_building_depth > 0) {
    path_builder.SetDepthLimit(opts.max_path_building_depth);
  }

  path_builder.SetExploreAllPaths(all_paths);

  CertPathBuilder::Result result = path_builder.Run();

  if (out_status != nullptr) {
    out_status->iteration_count_ = result.iteration_count;
    out_status->max_depth_seen_ = result.max_depth_seen;
  }

  *out_error = result.GetBestPathVerifyError();

  if (result.HasValidPath()) {
    std::vector<std::vector<std::string>> ret;
    if (!all_paths) {
      auto best_path = result.GetBestValidPath();
      ret.push_back(std::vector<std::string>());
      for (size_t i = 0; i < best_path->certs.size(); i++) {
        ret[0].emplace_back(BytesAsStringView(best_path->certs[i]->der_cert()));
      }
      return ret;
    }
    for (const auto &path : result.paths) {
      if (!path->IsValid()) {
        continue;
      }
      std::vector<std::string> ret_path;
      for (const auto &cert : path->certs) {
        ret_path.emplace_back(BytesAsStringView(cert->der_cert()));
      }
      ret.push_back(ret_path);
    }
    return ret;
  }

  return {};
}

std::optional<std::vector<std::string>> CertificateVerify(
    const CertificateVerifyOptions &opts, VerifyError *out_error,
    CertificateVerifyStatus *out_status) {
  auto single_path = CertificateVerifyInternal(opts, out_error, out_status,
                                               /*all_paths=*/false);
  if (!single_path.has_value()) {
    return {};
  }
  return single_path.value()[0];
}

std::optional<std::vector<std::vector<std::string>>> CertificateVerifyAllPaths(
    const CertificateVerifyOptions &opts) {
  return CertificateVerifyInternal(opts, nullptr, nullptr, /*all_paths=*/true);
}

BSSL_NAMESPACE_END
