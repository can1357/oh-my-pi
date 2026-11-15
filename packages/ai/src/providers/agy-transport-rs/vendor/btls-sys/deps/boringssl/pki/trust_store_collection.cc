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

#include "trust_store_collection.h"

#include <openssl/base.h>

BSSL_NAMESPACE_BEGIN

TrustStoreCollection::TrustStoreCollection() = default;
TrustStoreCollection::~TrustStoreCollection() = default;

void TrustStoreCollection::AddTrustStore(TrustStore *store) {
  BSSL_CHECK(store);
  stores_.push_back(store);
}

void TrustStoreCollection::SyncGetIssuersOf(const ParsedCertificate *cert,
                                            ParsedCertificateList *issuers) {
  for (auto *store : stores_) {
    store->SyncGetIssuersOf(cert, issuers);
  }
}

CertificateTrust TrustStoreCollection::GetTrust(const ParsedCertificate *cert) {
  // The current aggregate result.
  CertificateTrust result = CertificateTrust::ForUnspecified();

  for (auto *store : stores_) {
    CertificateTrust cur_trust = store->GetTrust(cert);

    // * If any stores distrust the certificate, consider it untrusted.
    // * If multiple stores consider it trusted, use the trust result from the
    //   last one
    if (!cur_trust.HasUnspecifiedTrust()) {
      result = cur_trust;
      if (result.IsDistrusted()) {
        break;
      }
    }
  }

  return result;
}

BSSL_NAMESPACE_END
