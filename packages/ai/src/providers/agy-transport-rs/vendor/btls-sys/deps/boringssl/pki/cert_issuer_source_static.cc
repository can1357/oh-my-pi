// Copyright 2016 The Chromium Authors
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

#include "cert_issuer_source_static.h"

BSSL_NAMESPACE_BEGIN

CertIssuerSourceStatic::CertIssuerSourceStatic() = default;
CertIssuerSourceStatic::~CertIssuerSourceStatic() = default;

void CertIssuerSourceStatic::AddCert(
    std::shared_ptr<const ParsedCertificate> cert) {
  intermediates_.insert(std::make_pair(
      BytesAsStringView(cert->normalized_subject()), std::move(cert)));
}

void CertIssuerSourceStatic::Clear() { intermediates_.clear(); }

std::vector<std::shared_ptr<const ParsedCertificate>>
CertIssuerSourceStatic::Certs() const {
  std::vector<std::shared_ptr<const ParsedCertificate>> result;
  result.reserve(intermediates_.size());
  for (const auto& [key, cert] : intermediates_) {
    result.push_back(cert);
  }
  return result;
}

void CertIssuerSourceStatic::SyncGetIssuersOf(const ParsedCertificate *cert,
                                              ParsedCertificateList *issuers) {
  auto range =
      intermediates_.equal_range(BytesAsStringView(cert->normalized_issuer()));
  for (auto it = range.first; it != range.second; ++it) {
    issuers->push_back(it->second);
  }
}

void CertIssuerSourceStatic::AsyncGetIssuersOf(
    const ParsedCertificate *cert, std::unique_ptr<Request> *out_req) {
  // CertIssuerSourceStatic never returns asynchronous results.
  out_req->reset();
}

BSSL_NAMESPACE_END
