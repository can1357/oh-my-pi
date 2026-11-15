// Copyright 2015 The Chromium Authors
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

#include "parse_certificate.h"

#include <optional>
#include <utility>

#include <openssl/base.h>
#include <openssl/bytestring.h>

#include "cert_error_params.h"
#include "cert_errors.h"
#include "general_names.h"
#include "input.h"
#include "parse_values.h"
#include "parser.h"
#include "string_util.h"

BSSL_NAMESPACE_BEGIN

namespace {

DEFINE_CERT_ERROR_ID(kCertificateNotSequence,
                     "Failed parsing Certificate SEQUENCE");
DEFINE_CERT_ERROR_ID(kUnconsumedDataInsideCertificateSequence,
                     "Unconsumed data inside Certificate SEQUENCE");
DEFINE_CERT_ERROR_ID(kUnconsumedDataAfterCertificateSequence,
                     "Unconsumed data after Certificate SEQUENCE");
DEFINE_CERT_ERROR_ID(kTbsCertificateNotSequence,
                     "Couldn't read tbsCertificate as SEQUENCE");
DEFINE_CERT_ERROR_ID(
    kSignatureAlgorithmNotSequence,
    "Couldn't read Certificate.signatureAlgorithm as SEQUENCE");
DEFINE_CERT_ERROR_ID(kSignatureValueNotBitString,
                     "Couldn't read Certificate.signatureValue as BIT STRING");
DEFINE_CERT_ERROR_ID(kUnconsumedDataInsideTbsCertificateSequence,
                     "Unconsumed data inside TBSCertificate");
DEFINE_CERT_ERROR_ID(kTbsNotSequence, "Failed parsing TBSCertificate SEQUENCE");
DEFINE_CERT_ERROR_ID(kFailedReadingVersion, "Failed reading version");
DEFINE_CERT_ERROR_ID(kFailedParsingVersion, "Failed parsing version");
DEFINE_CERT_ERROR_ID(kVersionExplicitlyV1,
                     "Version explicitly V1 (should be omitted)");
DEFINE_CERT_ERROR_ID(kFailedReadingSerialNumber, "Failed reading serialNumber");
DEFINE_CERT_ERROR_ID(kFailedReadingSignatureValue, "Failed reading signature");
DEFINE_CERT_ERROR_ID(kFailedReadingIssuer, "Failed reading issuer");
DEFINE_CERT_ERROR_ID(kFailedReadingValidity, "Failed reading validity");
DEFINE_CERT_ERROR_ID(kFailedParsingValidity, "Failed parsing validity");
DEFINE_CERT_ERROR_ID(kFailedReadingSubject, "Failed reading subject");
DEFINE_CERT_ERROR_ID(kFailedReadingSpki, "Failed reading subjectPublicKeyInfo");
DEFINE_CERT_ERROR_ID(kFailedReadingIssuerUniqueId,
                     "Failed reading issuerUniqueId");
DEFINE_CERT_ERROR_ID(kFailedParsingIssuerUniqueId,
                     "Failed parsing issuerUniqueId");
DEFINE_CERT_ERROR_ID(
    kIssuerUniqueIdNotExpected,
    "Unexpected issuerUniqueId (must be V2 or V3 certificate)");
DEFINE_CERT_ERROR_ID(kFailedReadingSubjectUniqueId,
                     "Failed reading subjectUniqueId");
DEFINE_CERT_ERROR_ID(kFailedParsingSubjectUniqueId,
                     "Failed parsing subjectUniqueId");
DEFINE_CERT_ERROR_ID(
    kSubjectUniqueIdNotExpected,
    "Unexpected subjectUniqueId (must be V2 or V3 certificate)");
DEFINE_CERT_ERROR_ID(kFailedReadingExtensions,
                     "Failed reading extensions SEQUENCE");
DEFINE_CERT_ERROR_ID(kUnexpectedExtensions,
                     "Unexpected extensions (must be V3 certificate)");
DEFINE_CERT_ERROR_ID(kSerialNumberIsNegative, "Serial number is negative");
DEFINE_CERT_ERROR_ID(kSerialNumberIsZero, "Serial number is zero");
DEFINE_CERT_ERROR_ID(kSerialNumberLengthOver20,
                     "Serial number is longer than 20 octets");
DEFINE_CERT_ERROR_ID(kSerialNumberNotValidInteger,
                     "Serial number is not a valid INTEGER");

// Returns true if |input| is a SEQUENCE and nothing else.
[[nodiscard]] bool IsSequenceTLV(der::Input input) {
  der::Parser parser(input);
  der::Parser unused_sequence_parser;
  if (!parser.ReadSequence(&unused_sequence_parser)) {
    return false;
  }
  // Should by a single SEQUENCE by definition of the function.
  return !parser.HasMore();
}

// Reads a SEQUENCE from |parser| and writes the full tag-length-value into
// |out|. On failure |parser| may or may not have been advanced.
[[nodiscard]] bool ReadSequenceTLV(der::Parser *parser, der::Input *out) {
  return parser->ReadRawTLV(out) && IsSequenceTLV(*out);
}

// Parses a Version according to RFC 5280:
//
//     Version  ::=  INTEGER  {  v1(0), v2(1), v3(2)  }
//
// No value other that v1, v2, or v3 is allowed (and if given will fail). RFC
// 5280 minimally requires the handling of v3 (and overwhelmingly these are the
// certificate versions in use today):
//
//     Implementations SHOULD be prepared to accept any version certificate.
//     At a minimum, conforming implementations MUST recognize version 3
//     certificates.
[[nodiscard]] bool ParseVersion(der::Input in, CertificateVersion *version) {
  der::Parser parser(in);
  uint64_t version64;
  if (!parser.ReadUint64(&version64)) {
    return false;
  }

  switch (version64) {
    case 0:
      *version = CertificateVersion::V1;
      break;
    case 1:
      *version = CertificateVersion::V2;
      break;
    case 2:
      *version = CertificateVersion::V3;
      break;
    default:
      // Don't allow any other version identifier.
      return false;
  }

  // By definition the input to this function was a single INTEGER, so there
  // shouldn't be anything else after it.
  return !parser.HasMore();
}

// Returns true if every bit in |bits| is zero (including empty).
[[nodiscard]] bool BitStringIsAllZeros(const der::BitString &bits) {
  // Note that it is OK to read from the unused bits, since BitString parsing
  // guarantees they are all zero.
  for (uint8_t b : bits.bytes()) {
    if (b != 0) {
      return false;
    }
  }
  return true;
}

// Parses a DistributionPointName.
//
// From RFC 5280:
//
//    DistributionPointName ::= CHOICE {
//      fullName                [0]     GeneralNames,
//      nameRelativeToCRLIssuer [1]     RelativeDistinguishedName }
bool ParseDistributionPointName(der::Input dp_name,
                                ParsedDistributionPoint *distribution_point) {
  der::Parser parser(dp_name);
  std::optional<der::Input> der_full_name;
  if (!parser.ReadOptionalTag(
          CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 0,
          &der_full_name)) {
    return false;
  }
  if (der_full_name) {
    // TODO(mattm): surface the CertErrors.
    CertErrors errors;
    distribution_point->distribution_point_fullname =
        GeneralNames::CreateFromValue(*der_full_name, &errors);
    if (!distribution_point->distribution_point_fullname) {
      return false;
    }
    return !parser.HasMore();
  }

  if (!parser.ReadOptionalTag(
          CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 1,
          &distribution_point
               ->distribution_point_name_relative_to_crl_issuer)) {
    return false;
  }
  if (distribution_point->distribution_point_name_relative_to_crl_issuer) {
    return !parser.HasMore();
  }

  // The CHOICE must contain either fullName or nameRelativeToCRLIssuer.
  return false;
}

// RFC 5280, section 4.2.1.13.
//
// DistributionPoint ::= SEQUENCE {
//  distributionPoint       [0]     DistributionPointName OPTIONAL,
//  reasons                 [1]     ReasonFlags OPTIONAL,
//  cRLIssuer               [2]     GeneralNames OPTIONAL }
bool ParseAndAddDistributionPoint(
    der::Parser *parser,
    std::vector<ParsedDistributionPoint> *distribution_points) {
  ParsedDistributionPoint distribution_point;

  // DistributionPoint ::= SEQUENCE {
  der::Parser distrib_point_parser;
  if (!parser->ReadSequence(&distrib_point_parser)) {
    return false;
  }

  //  distributionPoint       [0]     DistributionPointName OPTIONAL,
  std::optional<der::Input> distribution_point_name;
  if (!distrib_point_parser.ReadOptionalTag(
          CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 0,
          &distribution_point_name)) {
    return false;
  }

  if (distribution_point_name &&
      !ParseDistributionPointName(*distribution_point_name,
                                  &distribution_point)) {
    return false;
  }

  //  reasons                 [1]     ReasonFlags OPTIONAL,
  if (!distrib_point_parser.ReadOptionalTag(CBS_ASN1_CONTEXT_SPECIFIC | 1,
                                            &distribution_point.reasons)) {
    return false;
  }

  //  cRLIssuer               [2]     GeneralNames OPTIONAL }
  if (!distrib_point_parser.ReadOptionalTag(
          CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 2,
          &distribution_point.crl_issuer)) {
    return false;
  }
  // TODO(eroman): Parse "cRLIssuer"?

  // RFC 5280, section 4.2.1.13:
  // either distributionPoint or cRLIssuer MUST be present.
  if (!distribution_point_name && !distribution_point.crl_issuer) {
    return false;
  }

  if (distrib_point_parser.HasMore()) {
    return false;
  }

  distribution_points->push_back(std::move(distribution_point));
  return true;
}

}  // namespace

ParsedTbsCertificate::ParsedTbsCertificate() = default;

ParsedTbsCertificate::ParsedTbsCertificate(ParsedTbsCertificate &&other) =
    default;

ParsedTbsCertificate::~ParsedTbsCertificate() = default;

bool VerifySerialNumber(der::Input value, bool warnings_only,
                        CertErrors *errors) {
  // If |warnings_only| was set to true, the exact same errors will be logged,
  // only they will be logged with a lower severity (warning rather than error).
  CertError::Severity error_severity =
      warnings_only ? CertError::SEVERITY_WARNING : CertError::SEVERITY_HIGH;

  bool negative;
  if (!der::IsValidInteger(value, &negative)) {
    errors->Add(error_severity, kSerialNumberNotValidInteger, nullptr);
    return false;
  }

  // RFC 5280 section 4.1.2.2:
  //
  //    Note: Non-conforming CAs may issue certificates with serial numbers
  //    that are negative or zero.  Certificate users SHOULD be prepared to
  //    gracefully handle such certificates.
  if (negative) {
    errors->AddWarning(kSerialNumberIsNegative);
  }
  if (value.size() == 1 && value[0] == 0) {
    errors->AddWarning(kSerialNumberIsZero);
  }

  // RFC 5280 section 4.1.2.2:
  //
  //    Certificate users MUST be able to handle serialNumber values up to 20
  //    octets. Conforming CAs MUST NOT use serialNumber values longer than 20
  //    octets.
  if (value.size() > 20) {
    errors->Add(error_severity, kSerialNumberLengthOver20,
                CreateCertErrorParams1SizeT("length", value.size()));
    return false;
  }

  return true;
}

bool ReadUTCOrGeneralizedTime(der::Parser *parser, der::GeneralizedTime *out) {
  der::Input value;
  CBS_ASN1_TAG tag;

  if (!parser->ReadTagAndValue(&tag, &value)) {
    return false;
  }

  if (tag == CBS_ASN1_UTCTIME) {
    return der::ParseUTCTime(value, out);
  }

  if (tag == CBS_ASN1_GENERALIZEDTIME) {
    return der::ParseGeneralizedTime(value, out);
  }

  // Unrecognized tag.
  return false;
}

bool ParseValidity(der::Input validity_tlv, der::GeneralizedTime *not_before,
                   der::GeneralizedTime *not_after) {
  der::Parser parser(validity_tlv);

  //     Validity ::= SEQUENCE {
  der::Parser validity_parser;
  if (!parser.ReadSequence(&validity_parser)) {
    return false;
  }

  //          notBefore      Time,
  if (!ReadUTCOrGeneralizedTime(&validity_parser, not_before)) {
    return false;
  }

  //          notAfter       Time }
  if (!ReadUTCOrGeneralizedTime(&validity_parser, not_after)) {
    return false;
  }

  // By definition the input was a single Validity sequence, so there shouldn't
  // be unconsumed data.
  if (parser.HasMore()) {
    return false;
  }

  // The Validity type does not have an extension point.
  if (validity_parser.HasMore()) {
    return false;
  }

  // Note that RFC 5280 doesn't require notBefore to be <=
  // notAfter, so that will not be considered a "parsing" error here. Instead it
  // will be considered an expired certificate later when testing against the
  // current timestamp.
  return true;
}

bool ParseCertificate(der::Input certificate_tlv,
                      der::Input *out_tbs_certificate_tlv,
                      der::Input *out_signature_algorithm_tlv,
                      der::BitString *out_signature_value,
                      CertErrors *out_errors) {
  // |out_errors| is optional. But ensure it is non-null for the remainder of
  // this function.
  CertErrors unused_errors;
  if (!out_errors) {
    out_errors = &unused_errors;
  }

  der::Parser parser(certificate_tlv);

  //   Certificate  ::=  SEQUENCE  {
  der::Parser certificate_parser;
  if (!parser.ReadSequence(&certificate_parser)) {
    out_errors->AddError(kCertificateNotSequence);
    return false;
  }

  //        tbsCertificate       TBSCertificate,
  if (!ReadSequenceTLV(&certificate_parser, out_tbs_certificate_tlv)) {
    out_errors->AddError(kTbsCertificateNotSequence);
    return false;
  }

  //        signatureAlgorithm   AlgorithmIdentifier,
  if (!ReadSequenceTLV(&certificate_parser, out_signature_algorithm_tlv)) {
    out_errors->AddError(kSignatureAlgorithmNotSequence);
    return false;
  }

  //        signatureValue       BIT STRING  }
  std::optional<der::BitString> signature_value =
      certificate_parser.ReadBitString();
  if (!signature_value) {
    out_errors->AddError(kSignatureValueNotBitString);
    return false;
  }
  *out_signature_value = signature_value.value();

  // There isn't an extension point at the end of Certificate.
  if (certificate_parser.HasMore()) {
    out_errors->AddError(kUnconsumedDataInsideCertificateSequence);
    return false;
  }

  // By definition the input was a single Certificate, so there shouldn't be
  // unconsumed data.
  if (parser.HasMore()) {
    out_errors->AddError(kUnconsumedDataAfterCertificateSequence);
    return false;
  }

  return true;
}

// From RFC 5280 section 4.1:
//
//   TBSCertificate  ::=  SEQUENCE  {
//        version         [0]  EXPLICIT Version DEFAULT v1,
//        serialNumber         CertificateSerialNumber,
//        signature            AlgorithmIdentifier,
//        issuer               Name,
//        validity             Validity,
//        subject              Name,
//        subjectPublicKeyInfo SubjectPublicKeyInfo,
//        issuerUniqueID  [1]  IMPLICIT UniqueIdentifier OPTIONAL,
//                             -- If present, version MUST be v2 or v3
//        subjectUniqueID [2]  IMPLICIT UniqueIdentifier OPTIONAL,
//                             -- If present, version MUST be v2 or v3
//        extensions      [3]  EXPLICIT Extensions OPTIONAL
//                             -- If present, version MUST be v3
//        }
bool ParseTbsCertificate(der::Input tbs_tlv,
                         const ParseCertificateOptions &options,
                         ParsedTbsCertificate *out, CertErrors *errors) {
  // The rest of this function assumes that |errors| is non-null.
  CertErrors unused_errors;
  if (!errors) {
    errors = &unused_errors;
  }

  // TODO(crbug.com/634443): Add useful error information to |errors|.

  der::Parser parser(tbs_tlv);

  //   TBSCertificate  ::=  SEQUENCE  {
  der::Parser tbs_parser;
  if (!parser.ReadSequence(&tbs_parser)) {
    errors->AddError(kTbsNotSequence);
    return false;
  }

  //        version         [0]  EXPLICIT Version DEFAULT v1,
  std::optional<der::Input> version;
  if (!tbs_parser.ReadOptionalTag(
          CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 0, &version)) {
    errors->AddError(kFailedReadingVersion);
    return false;
  }
  if (version) {
    if (!ParseVersion(version.value(), &out->version)) {
      errors->AddError(kFailedParsingVersion);
      return false;
    }
    if (out->version == CertificateVersion::V1) {
      errors->AddError(kVersionExplicitlyV1);
      // The correct way to specify v1 is to omit the version field since v1 is
      // the DEFAULT.
      return false;
    }
  } else {
    out->version = CertificateVersion::V1;
  }

  //        serialNumber         CertificateSerialNumber,
  if (!tbs_parser.ReadTag(CBS_ASN1_INTEGER, &out->serial_number)) {
    errors->AddError(kFailedReadingSerialNumber);
    return false;
  }
  if (!VerifySerialNumber(out->serial_number,
                          options.allow_invalid_serial_numbers, errors)) {
    // Invalid serial numbers are only considered fatal failures if
    // |!allow_invalid_serial_numbers|.
    if (!options.allow_invalid_serial_numbers) {
      return false;
    }
  }

  //        signature            AlgorithmIdentifier,
  if (!ReadSequenceTLV(&tbs_parser, &out->signature_algorithm_tlv)) {
    errors->AddError(kFailedReadingSignatureValue);
    return false;
  }

  //        issuer               Name,
  if (!ReadSequenceTLV(&tbs_parser, &out->issuer_tlv)) {
    errors->AddError(kFailedReadingIssuer);
    return false;
  }

  //        validity             Validity,
  der::Input validity_tlv;
  if (!tbs_parser.ReadRawTLV(&validity_tlv)) {
    errors->AddError(kFailedReadingValidity);
    return false;
  }
  if (!ParseValidity(validity_tlv, &out->validity_not_before,
                     &out->validity_not_after)) {
    errors->AddError(kFailedParsingValidity);
    return false;
  }

  //        subject              Name,
  if (!ReadSequenceTLV(&tbs_parser, &out->subject_tlv)) {
    errors->AddError(kFailedReadingSubject);
    return false;
  }

  //        subjectPublicKeyInfo SubjectPublicKeyInfo,
  if (!ReadSequenceTLV(&tbs_parser, &out->spki_tlv)) {
    errors->AddError(kFailedReadingSpki);
    return false;
  }

  //        issuerUniqueID  [1]  IMPLICIT UniqueIdentifier OPTIONAL,
  //                             -- If present, version MUST be v2 or v3
  std::optional<der::Input> issuer_unique_id;
  if (!tbs_parser.ReadOptionalTag(CBS_ASN1_CONTEXT_SPECIFIC | 1,
                                  &issuer_unique_id)) {
    errors->AddError(kFailedReadingIssuerUniqueId);
    return false;
  }
  if (issuer_unique_id) {
    out->issuer_unique_id = der::ParseBitString(issuer_unique_id.value());
    if (!out->issuer_unique_id) {
      errors->AddError(kFailedParsingIssuerUniqueId);
      return false;
    }
    if (out->version != CertificateVersion::V2 &&
        out->version != CertificateVersion::V3) {
      errors->AddError(kIssuerUniqueIdNotExpected);
      return false;
    }
  }

  //        subjectUniqueID [2]  IMPLICIT UniqueIdentifier OPTIONAL,
  //                             -- If present, version MUST be v2 or v3
  std::optional<der::Input> subject_unique_id;
  if (!tbs_parser.ReadOptionalTag(CBS_ASN1_CONTEXT_SPECIFIC | 2,
                                  &subject_unique_id)) {
    errors->AddError(kFailedReadingSubjectUniqueId);
    return false;
  }
  if (subject_unique_id) {
    out->subject_unique_id = der::ParseBitString(subject_unique_id.value());
    if (!out->subject_unique_id) {
      errors->AddError(kFailedParsingSubjectUniqueId);
      return false;
    }
    if (out->version != CertificateVersion::V2 &&
        out->version != CertificateVersion::V3) {
      errors->AddError(kSubjectUniqueIdNotExpected);
      return false;
    }
  }

  //        extensions      [3]  EXPLICIT Extensions OPTIONAL
  //                             -- If present, version MUST be v3
  if (!tbs_parser.ReadOptionalTag(
          CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 3,
          &out->extensions_tlv)) {
    errors->AddError(kFailedReadingExtensions);
    return false;
  }
  if (out->extensions_tlv) {
    // extensions_tlv must be a single element. Also check that it is a
    // SEQUENCE.
    if (!IsSequenceTLV(out->extensions_tlv.value())) {
      errors->AddError(kFailedReadingExtensions);
      return false;
    }
    if (out->version != CertificateVersion::V3) {
      errors->AddError(kUnexpectedExtensions);
      return false;
    }
  }

  // Note that there IS an extension point at the end of TBSCertificate
  // (according to RFC 5912), so from that interpretation, unconsumed data would
  // be allowed in |tbs_parser|.
  //
  // However because only v1, v2, and v3 certificates are supported by the
  // parsing, there shouldn't be any subsequent data in those versions, so
  // reject.
  if (tbs_parser.HasMore()) {
    errors->AddError(kUnconsumedDataInsideTbsCertificateSequence);
    return false;
  }

  // By definition the input was a single TBSCertificate, so there shouldn't be
  // unconsumed data.
  if (parser.HasMore()) {
    return false;
  }

  return true;
}

// From RFC 5280:
//
//    Extension  ::=  SEQUENCE  {
//            extnID      OBJECT IDENTIFIER,
//            critical    BOOLEAN DEFAULT FALSE,
//            extnValue   OCTET STRING
//                        -- contains the DER encoding of an ASN.1 value
//                        -- corresponding to the extension type identified
//                        -- by extnID
//            }
bool ParseExtension(der::Input extension_tlv, ParsedExtension *out) {
  der::Parser parser(extension_tlv);

  //    Extension  ::=  SEQUENCE  {
  der::Parser extension_parser;
  if (!parser.ReadSequence(&extension_parser)) {
    return false;
  }

  //            extnID      OBJECT IDENTIFIER,
  if (!extension_parser.ReadTag(CBS_ASN1_OBJECT, &out->oid)) {
    return false;
  }

  //            critical    BOOLEAN DEFAULT FALSE,
  out->critical = false;
  bool has_critical;
  der::Input critical;
  if (!extension_parser.ReadOptionalTag(CBS_ASN1_BOOLEAN, &critical,
                                        &has_critical)) {
    return false;
  }
  if (has_critical) {
    if (!der::ParseBool(critical, &out->critical)) {
      return false;
    }
    if (!out->critical) {
      return false;  // DER-encoding requires DEFAULT values be omitted.
    }
  }

  //            extnValue   OCTET STRING
  if (!extension_parser.ReadTag(CBS_ASN1_OCTETSTRING, &out->value)) {
    return false;
  }

  // The Extension type does not have an extension point (everything goes in
  // extnValue).
  if (extension_parser.HasMore()) {
    return false;
  }

  // By definition the input was a single Extension sequence, so there shouldn't
  // be unconsumed data.
  if (parser.HasMore()) {
    return false;
  }

  return true;
}

OPENSSL_EXPORT bool ParseExtensions(
    der::Input extensions_tlv,
    std::map<der::Input, ParsedExtension> *extensions) {
  der::Parser parser(extensions_tlv);

  //    Extensions  ::=  SEQUENCE SIZE (1..MAX) OF Extension
  der::Parser extensions_parser;
  if (!parser.ReadSequence(&extensions_parser)) {
    return false;
  }

  // The Extensions SEQUENCE must contains at least 1 element (otherwise it
  // should have been omitted).
  if (!extensions_parser.HasMore()) {
    return false;
  }

  extensions->clear();

  while (extensions_parser.HasMore()) {
    ParsedExtension extension;

    der::Input extension_tlv;
    if (!extensions_parser.ReadRawTLV(&extension_tlv)) {
      return false;
    }

    if (!ParseExtension(extension_tlv, &extension)) {
      return false;
    }

    bool is_duplicate =
        !extensions->insert(std::make_pair(extension.oid, extension)).second;

    // RFC 5280 says that an extension should not appear more than once.
    if (is_duplicate) {
      return false;
    }
  }

  // By definition the input was a single Extensions sequence, so there
  // shouldn't be unconsumed data.
  if (parser.HasMore()) {
    return false;
  }

  return true;
}

OPENSSL_EXPORT bool ConsumeExtension(
    der::Input oid,
    std::map<der::Input, ParsedExtension> *unconsumed_extensions,
    ParsedExtension *extension) {
  auto it = unconsumed_extensions->find(oid);
  if (it == unconsumed_extensions->end()) {
    return false;
  }

  *extension = it->second;
  unconsumed_extensions->erase(it);
  return true;
}

bool ParseBasicConstraints(der::Input basic_constraints_tlv,
                           ParsedBasicConstraints *out) {
  der::Parser parser(basic_constraints_tlv);

  //    BasicConstraints ::= SEQUENCE {
  der::Parser sequence_parser;
  if (!parser.ReadSequence(&sequence_parser)) {
    return false;
  }

  //         cA                      BOOLEAN DEFAULT FALSE,
  out->is_ca = false;
  bool has_ca;
  der::Input ca;
  if (!sequence_parser.ReadOptionalTag(CBS_ASN1_BOOLEAN, &ca, &has_ca)) {
    return false;
  }
  if (has_ca) {
    if (!der::ParseBool(ca, &out->is_ca)) {
      return false;
    }
    // TODO(eroman): Should reject if CA was set to false, since
    // DER-encoding requires DEFAULT values be omitted. In
    // practice however there are a lot of certificates that use
    // the broken encoding.
  }

  //         pathLenConstraint       INTEGER (0..MAX) OPTIONAL }
  der::Input encoded_path_len;
  if (!sequence_parser.ReadOptionalTag(CBS_ASN1_INTEGER, &encoded_path_len,
                                       &out->has_path_len)) {
    return false;
  }
  if (out->has_path_len) {
    // TODO(eroman): Surface reason for failure if length was longer than uint8.
    if (!der::ParseUint8(encoded_path_len, &out->path_len)) {
      return false;
    }
  } else {
    // Default initialize to 0 as a precaution.
    out->path_len = 0;
  }

  // There shouldn't be any unconsumed data in the extension.
  if (sequence_parser.HasMore()) {
    return false;
  }

  // By definition the input was a single BasicConstraints sequence, so there
  // shouldn't be unconsumed data.
  if (parser.HasMore()) {
    return false;
  }

  return true;
}

// TODO(crbug.com/1314019): return std::optional<BitString> when converting
// has_key_usage_ and key_usage_ into single std::optional field.
bool ParseKeyUsage(der::Input key_usage_tlv, der::BitString *key_usage) {
  der::Parser parser(key_usage_tlv);
  std::optional<der::BitString> key_usage_internal = parser.ReadBitString();
  if (!key_usage_internal) {
    return false;
  }

  // By definition the input was a single BIT STRING.
  if (parser.HasMore()) {
    return false;
  }

  // RFC 5280 section 4.2.1.3:
  //
  //     When the keyUsage extension appears in a certificate, at least
  //     one of the bits MUST be set to 1.
  if (BitStringIsAllZeros(key_usage_internal.value())) {
    return false;
  }

  *key_usage = key_usage_internal.value();
  return true;
}

bool ParseAuthorityInfoAccess(
    der::Input authority_info_access_tlv,
    std::vector<AuthorityInfoAccessDescription> *out_access_descriptions) {
  der::Parser parser(authority_info_access_tlv);

  out_access_descriptions->clear();

  //    AuthorityInfoAccessSyntax  ::=
  //            SEQUENCE SIZE (1..MAX) OF AccessDescription
  der::Parser sequence_parser;
  if (!parser.ReadSequence(&sequence_parser)) {
    return false;
  }
  if (!sequence_parser.HasMore()) {
    return false;
  }

  while (sequence_parser.HasMore()) {
    AuthorityInfoAccessDescription access_description;

    //    AccessDescription  ::=  SEQUENCE {
    der::Parser access_description_sequence_parser;
    if (!sequence_parser.ReadSequence(&access_description_sequence_parser)) {
      return false;
    }

    //            accessMethod          OBJECT IDENTIFIER,
    if (!access_description_sequence_parser.ReadTag(
            CBS_ASN1_OBJECT, &access_description.access_method_oid)) {
      return false;
    }

    //            accessLocation        GeneralName  }
    if (!access_description_sequence_parser.ReadRawTLV(
            &access_description.access_location)) {
      return false;
    }

    if (access_description_sequence_parser.HasMore()) {
      return false;
    }

    out_access_descriptions->push_back(access_description);
  }

  return true;
}

bool ParseAuthorityInfoAccessURIs(
    der::Input authority_info_access_tlv,
    std::vector<std::string_view> *out_ca_issuers_uris,
    std::vector<std::string_view> *out_ocsp_uris) {
  std::vector<AuthorityInfoAccessDescription> access_descriptions;
  if (!ParseAuthorityInfoAccess(authority_info_access_tlv,
                                &access_descriptions)) {
    return false;
  }

  for (const auto &access_description : access_descriptions) {
    der::Parser access_location_parser(access_description.access_location);
    CBS_ASN1_TAG access_location_tag;
    der::Input access_location_value;
    if (!access_location_parser.ReadTagAndValue(&access_location_tag,
                                                &access_location_value)) {
      return false;
    }

    // GeneralName ::= CHOICE {
    if (access_location_tag == (CBS_ASN1_CONTEXT_SPECIFIC | 6)) {
      // uniformResourceIdentifier       [6]     IA5String,
      std::string_view uri = BytesAsStringView(access_location_value);
      if (!bssl::string_util::IsAscii(uri)) {
        return false;
      }

      if (access_description.access_method_oid == der::Input(kAdCaIssuersOid)) {
        out_ca_issuers_uris->push_back(uri);
      } else if (access_description.access_method_oid ==
                 der::Input(kAdOcspOid)) {
        out_ocsp_uris->push_back(uri);
      }
    }
  }
  return true;
}

ParsedDistributionPoint::ParsedDistributionPoint() = default;
ParsedDistributionPoint::ParsedDistributionPoint(
    ParsedDistributionPoint &&other) = default;
ParsedDistributionPoint::~ParsedDistributionPoint() = default;

bool ParseCrlDistributionPoints(
    der::Input extension_value,
    std::vector<ParsedDistributionPoint> *distribution_points) {
  distribution_points->clear();

  // RFC 5280, section 4.2.1.13.
  //
  // CRLDistributionPoints ::= SEQUENCE SIZE (1..MAX) OF DistributionPoint
  der::Parser extension_value_parser(extension_value);
  der::Parser distribution_points_parser;
  if (!extension_value_parser.ReadSequence(&distribution_points_parser)) {
    return false;
  }
  if (extension_value_parser.HasMore()) {
    return false;
  }

  // Sequence must have a minimum of 1 item.
  if (!distribution_points_parser.HasMore()) {
    return false;
  }

  while (distribution_points_parser.HasMore()) {
    if (!ParseAndAddDistributionPoint(&distribution_points_parser,
                                      distribution_points)) {
      return false;
    }
  }

  return true;
}

ParsedAuthorityKeyIdentifier::ParsedAuthorityKeyIdentifier() = default;
ParsedAuthorityKeyIdentifier::~ParsedAuthorityKeyIdentifier() = default;
ParsedAuthorityKeyIdentifier::ParsedAuthorityKeyIdentifier(
    ParsedAuthorityKeyIdentifier &&other) = default;
ParsedAuthorityKeyIdentifier &ParsedAuthorityKeyIdentifier::operator=(
    ParsedAuthorityKeyIdentifier &&other) = default;

bool ParseAuthorityKeyIdentifier(
    der::Input extension_value,
    ParsedAuthorityKeyIdentifier *authority_key_identifier) {
  // RFC 5280, section 4.2.1.1.
  //    AuthorityKeyIdentifier ::= SEQUENCE {
  //       keyIdentifier             [0] KeyIdentifier           OPTIONAL,
  //       authorityCertIssuer       [1] GeneralNames            OPTIONAL,
  //       authorityCertSerialNumber [2] CertificateSerialNumber OPTIONAL  }
  //
  //    KeyIdentifier ::= OCTET STRING

  der::Parser extension_value_parser(extension_value);
  der::Parser aki_parser;
  if (!extension_value_parser.ReadSequence(&aki_parser)) {
    return false;
  }
  if (extension_value_parser.HasMore()) {
    return false;
  }

  // TODO(mattm): Should having an empty AuthorityKeyIdentifier SEQUENCE be an
  // error? RFC 5280 doesn't explicitly say it.

  //       keyIdentifier             [0] KeyIdentifier           OPTIONAL,
  if (!aki_parser.ReadOptionalTag(CBS_ASN1_CONTEXT_SPECIFIC | 0,
                                  &authority_key_identifier->key_identifier)) {
    return false;
  }

  //       authorityCertIssuer       [1] GeneralNames            OPTIONAL,
  if (!aki_parser.ReadOptionalTag(
          CBS_ASN1_CONTEXT_SPECIFIC | CBS_ASN1_CONSTRUCTED | 1,
          &authority_key_identifier->authority_cert_issuer)) {
    return false;
  }

  //       authorityCertSerialNumber [2] CertificateSerialNumber OPTIONAL  }
  if (!aki_parser.ReadOptionalTag(
          CBS_ASN1_CONTEXT_SPECIFIC | 2,
          &authority_key_identifier->authority_cert_serial_number)) {
    return false;
  }

  //     -- authorityCertIssuer and authorityCertSerialNumber MUST both
  //     -- be present or both be absent
  if (authority_key_identifier->authority_cert_issuer.has_value() !=
      authority_key_identifier->authority_cert_serial_number.has_value()) {
    return false;
  }

  // There shouldn't be any unconsumed data in the AuthorityKeyIdentifier
  // SEQUENCE.
  if (aki_parser.HasMore()) {
    return false;
  }

  return true;
}

bool ParseSubjectKeyIdentifier(der::Input extension_value,
                               der::Input *subject_key_identifier) {
  //    SubjectKeyIdentifier ::= KeyIdentifier
  //
  //    KeyIdentifier ::= OCTET STRING
  der::Parser extension_value_parser(extension_value);
  if (!extension_value_parser.ReadTag(CBS_ASN1_OCTETSTRING,
                                      subject_key_identifier)) {
    return false;
  }

  // There shouldn't be any unconsumed data in the extension SEQUENCE.
  if (extension_value_parser.HasMore()) {
    return false;
  }

  return true;
}

BSSL_NAMESPACE_END
