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

#include <optional>
#include <string_view>

#include <openssl/pki/certificate.h>
#include <openssl/pool.h>

#include "cert_errors.h"
#include "encode_values.h"
#include "parsed_certificate.h"
#include "pem.h"
#include "parse_values.h"

BSSL_NAMESPACE_BEGIN

namespace {

std::shared_ptr<const bssl::ParsedCertificate> ParseCertificateFromDer(
    bssl::Span<const uint8_t>cert, std::string *out_diagnostic) {
  bssl::ParseCertificateOptions default_options{};
  // We follow Chromium in setting |allow_invalid_serial_numbers| in order to
  // not choke on 21-byte serial numbers, which are common.  davidben explains
  // why:
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

  bssl::UniquePtr<CRYPTO_BUFFER> buffer(
      CRYPTO_BUFFER_new(cert.data(), cert.size(), nullptr));
  bssl::CertErrors errors;
  std::shared_ptr<const bssl::ParsedCertificate> parsed_cert(
      bssl::ParsedCertificate::Create(std::move(buffer), default_options, &errors));
  if (!parsed_cert) {
    *out_diagnostic = errors.ToDebugString();
    return nullptr;
  }
  return parsed_cert;
}

} // namespace

struct CertificateInternals {
  std::shared_ptr<const bssl::ParsedCertificate> cert;
};

Certificate::Certificate(std::unique_ptr<CertificateInternals> internals)
    : internals_(std::move(internals)) {}
Certificate::~Certificate() = default;
Certificate::Certificate(Certificate&& other) = default;

std::unique_ptr<Certificate> Certificate::FromDER(bssl::Span<const uint8_t> der,
                                                  std::string *out_diagnostic) {
  std::shared_ptr<const bssl::ParsedCertificate> result =
      ParseCertificateFromDer(der, out_diagnostic);
  if (result == nullptr) {
    return nullptr;
  }

  auto internals = std::make_unique<CertificateInternals>();
  internals->cert = std::move(result);
  std::unique_ptr<Certificate> ret(new Certificate(std::move(internals)));
  return ret;
}

std::unique_ptr<Certificate> Certificate::FromPEM(std::string_view pem,
                                                  std::string *out_diagnostic) {
  bssl::PEMTokenizer tokenizer(pem, {"CERTIFICATE"});
  if (!tokenizer.GetNext()) {
    return nullptr;
  }
  return FromDER(StringAsBytes(tokenizer.data()), out_diagnostic);
}

bool Certificate::IsSelfIssued() const {
  return internals_->cert->normalized_subject() ==
         internals_->cert->normalized_issuer();
}

Certificate::Validity Certificate::GetValidity() const {
  Certificate::Validity validity;

  // As this is a previously parsed certificate, we know the not_before
  // and not after are valid, so these conversions can not fail.
  (void) GeneralizedTimeToPosixTime(
      internals_->cert->tbs().validity_not_before, &validity.not_before);
  (void) GeneralizedTimeToPosixTime(
      internals_->cert->tbs().validity_not_after, &validity.not_after);
  return validity;
}

bssl::Span<const uint8_t> Certificate::GetSerialNumber() const {
  return internals_->cert->tbs().serial_number;
}

BSSL_NAMESPACE_END
