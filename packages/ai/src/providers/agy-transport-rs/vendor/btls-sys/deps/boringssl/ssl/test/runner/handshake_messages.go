// Copyright 2009 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package runner

import (
	"errors"
	"fmt"

	"golang.org/x/crypto/cryptobyte"
)

func readUint8LengthPrefixedBytes(s *cryptobyte.String, out *[]byte) bool {
	var child cryptobyte.String
	if !s.ReadUint8LengthPrefixed(&child) {
		return false
	}
	*out = child
	return true
}

func readUint16LengthPrefixedBytes(s *cryptobyte.String, out *[]byte) bool {
	var child cryptobyte.String
	if !s.ReadUint16LengthPrefixed(&child) {
		return false
	}
	*out = child
	return true
}

func readUint24LengthPrefixedBytes(s *cryptobyte.String, out *[]byte) bool {
	var child cryptobyte.String
	if !s.ReadUint24LengthPrefixed(&child) {
		return false
	}
	*out = child
	return true
}

func addUint8LengthPrefixedBytes(b *cryptobyte.Builder, v []byte) {
	b.AddUint8LengthPrefixed(func(child *cryptobyte.Builder) { child.AddBytes(v) })
}

func addUint16LengthPrefixedBytes(b *cryptobyte.Builder, v []byte) {
	b.AddUint16LengthPrefixed(func(child *cryptobyte.Builder) { child.AddBytes(v) })
}

func addUint24LengthPrefixedBytes(b *cryptobyte.Builder, v []byte) {
	b.AddUint24LengthPrefixed(func(child *cryptobyte.Builder) { child.AddBytes(v) })
}

type keyShareEntry struct {
	group       CurveID
	keyExchange []byte
}

type pskIdentity struct {
	ticket              []uint8
	obfuscatedTicketAge uint32
}

type HPKECipherSuite struct {
	KDF  uint16
	AEAD uint16
}

type ECHConfig struct {
	Raw          []byte
	ConfigID     uint8
	KEM          uint16
	PublicKey    []byte
	MaxNameLen   uint8
	PublicName   string
	CipherSuites []HPKECipherSuite
	// The following fields are only used by CreateECHConfig().
	UnsupportedExtension          bool
	UnsupportedMandatoryExtension bool
}

func CreateECHConfig(template *ECHConfig) *ECHConfig {
	bb := cryptobyte.NewBuilder(nil)
	// ECHConfig reuses the encrypted_client_hello extension codepoint as a
	// version identifier.
	bb.AddUint16(extensionEncryptedClientHello)
	bb.AddUint16LengthPrefixed(func(contents *cryptobyte.Builder) {
		contents.AddUint8(template.ConfigID)
		contents.AddUint16(template.KEM)
		addUint16LengthPrefixedBytes(contents, template.PublicKey)
		contents.AddUint16LengthPrefixed(func(cipherSuites *cryptobyte.Builder) {
			for _, suite := range template.CipherSuites {
				cipherSuites.AddUint16(suite.KDF)
				cipherSuites.AddUint16(suite.AEAD)
			}
		})
		contents.AddUint8(template.MaxNameLen)
		addUint8LengthPrefixedBytes(contents, []byte(template.PublicName))
		contents.AddUint16LengthPrefixed(func(extensions *cryptobyte.Builder) {
			// Mandatory extensions have the high bit set.
			if template.UnsupportedExtension {
				extensions.AddUint16(0x1111)
				addUint16LengthPrefixedBytes(extensions, []byte("test"))
			}
			if template.UnsupportedMandatoryExtension {
				extensions.AddUint16(0xaaaa)
				addUint16LengthPrefixedBytes(extensions, []byte("test"))
			}
		})
	})

	// This ought to be a call to a function like ParseECHConfig(bb.BytesOrPanic()),
	// but this constrains us to constructing ECHConfigs we are willing to
	// support. We need to test the client's behavior in response to unparsable
	// or unsupported ECHConfigs, so populate fields from the template directly.
	ret := *template
	ret.Raw = bb.BytesOrPanic()
	return &ret
}

func CreateECHConfigList(configs ...[]byte) []byte {
	bb := cryptobyte.NewBuilder(nil)
	bb.AddUint16LengthPrefixed(func(list *cryptobyte.Builder) {
		for _, config := range configs {
			list.AddBytes(config)
		}
	})
	return bb.BytesOrPanic()
}

type ServerECHConfig struct {
	ECHConfig *ECHConfig
	Key       []byte
}

const (
	echClientTypeOuter byte = 0
	echClientTypeInner byte = 1
)

type echClientOuter struct {
	kdfID    uint16
	aeadID   uint16
	configID uint8
	enc      []byte
	payload  []byte
}

type pakeShare struct {
	id  uint16
	msg []byte
}

type flagSet struct {
	bytes       []byte
	mustInclude bool
	padding     int
}

func (f *flagSet) hasFlag(bit uint) bool {
	idx := bit / 8
	mask := byte(1 << (bit % 8))
	return idx < uint(len(f.bytes)) && f.bytes[idx]&mask != 0
}

func (f *flagSet) setFlag(bit uint) {
	idx := bit / 8
	mask := byte(1 << (bit % 8))
	for uint(len(f.bytes)) <= idx {
		f.bytes = append(f.bytes, 0)
	}
	f.bytes[idx] |= mask
}

func (f *flagSet) unmarshalExtensionValue(s cryptobyte.String) bool {
	if !readUint8LengthPrefixedBytes(&s, &f.bytes) || !s.Empty() || len(f.bytes) == 0 {
		return false
	}
	// Flags must be minimally-encoded.
	if f.bytes[len(f.bytes)-1] == 0 {
		return false
	}
	return true
}

func (f *flagSet) marshalExtension(b *cryptobyte.Builder) {
	if len(f.bytes) == 0 && !f.mustInclude {
		return
	}
	b.AddUint16(extensionTLSFlags)
	b.AddUint16LengthPrefixed(func(value *cryptobyte.Builder) {
		value.AddUint8LengthPrefixed(func(flags *cryptobyte.Builder) {
			flags.AddBytes(f.bytes)
			for range f.padding {
				flags.AddUint8(0)
			}
		})
	})
}

type clientHelloMsg struct {
	raw                                      []byte
	isDTLS                                   bool
	isV2ClientHello                          bool
	vers                                     uint16
	random                                   []byte
	v2Challenge                              []byte
	sessionID                                []byte
	cookie                                   []byte
	cipherSuites                             []uint16
	compressionMethods                       []uint8
	nextProtoNeg                             bool
	serverName                               string
	echOuter                                 *echClientOuter
	echInner                                 bool
	invalidECHInner                          []byte
	ocspStapling                             bool
	supportedCurves                          []CurveID
	supportedPoints                          []uint8
	hasKeyShares                             bool
	keyShares                                []keyShareEntry
	keySharesRaw                             []byte
	trailingKeyShareData                     bool
	pskIdentities                            []pskIdentity
	pskKEModes                               []byte
	pskBinders                               [][]uint8
	hasEarlyData                             bool
	tls13Cookie                              []byte
	ticketSupported                          bool
	sessionTicket                            []uint8
	signatureAlgorithms                      []signatureAlgorithm
	signatureAlgorithmsCert                  []signatureAlgorithm
	supportedVersions                        []uint16
	secureRenegotiation                      []byte
	alpnProtocols                            []string
	quicTransportParams                      []byte
	quicTransportParamsLegacy                []byte
	duplicateExtension                       bool
	channelIDSupported                       bool
	extendedMasterSecret                     bool
	srtpProtectionProfiles                   []uint16
	srtpMasterKeyIdentifier                  string
	sctListSupported                         bool
	customExtension                          string
	hasGREASEExtension                       bool
	omitExtensions                           bool
	emptyExtensions                          bool
	pad                                      int
	compressedCertAlgs                       []uint16
	delegatedCredential                      []signatureAlgorithm
	alpsProtocols                            []string
	alpsProtocolsOld                         []string
	pakeClientID                             []byte
	pakeServerID                             []byte
	pakeShares                               []pakeShare
	certificateAuthorities                   [][]byte
	trustAnchors                             [][]byte
	outerExtensions                          []uint16
	reorderOuterExtensionsWithoutCompressing bool
	prefixExtensions                         []uint16
	// The following fields are only filled in by |unmarshal| and ignored when
	// marshaling a new ClientHello.
	echPayloadStart int
	echPayloadEnd   int
	rawExtensions   []byte
}

func (m *clientHelloMsg) marshalKeyShares(bb *cryptobyte.Builder) {
	bb.AddUint16LengthPrefixed(func(keyShares *cryptobyte.Builder) {
		for _, keyShare := range m.keyShares {
			keyShares.AddUint16(uint16(keyShare.group))
			addUint16LengthPrefixedBytes(keyShares, keyShare.keyExchange)
		}
		if m.trailingKeyShareData {
			keyShares.AddUint8(0)
		}
	})
}

type clientHelloType int

const (
	clientHelloNormal clientHelloType = iota
	clientHelloEncodedInner
)

func (m *clientHelloMsg) marshalBody(hello *cryptobyte.Builder, typ clientHelloType) {
	hello.AddUint16(m.vers)
	hello.AddBytes(m.random)
	hello.AddUint8LengthPrefixed(func(sessionID *cryptobyte.Builder) {
		if typ != clientHelloEncodedInner {
			sessionID.AddBytes(m.sessionID)
		}
	})
	if m.isDTLS {
		hello.AddUint8LengthPrefixed(func(cookie *cryptobyte.Builder) {
			cookie.AddBytes(m.cookie)
		})
	}
	hello.AddUint16LengthPrefixed(func(cipherSuites *cryptobyte.Builder) {
		for _, suite := range m.cipherSuites {
			cipherSuites.AddUint16(suite)
		}
	})
	hello.AddUint8LengthPrefixed(func(compressionMethods *cryptobyte.Builder) {
		compressionMethods.AddBytes(m.compressionMethods)
	})

	type extension struct {
		id   uint16
		body []byte
	}
	var extensions []extension

	if m.duplicateExtension {
		// Add a duplicate bogus extension at the beginning and end.
		extensions = append(extensions, extension{id: extensionDuplicate})
	}
	if m.nextProtoNeg {
		extensions = append(extensions, extension{id: extensionNextProtoNeg})
	}
	if len(m.serverName) > 0 {
		// RFC 3546, section 3.1
		//
		// struct {
		//     NameType name_type;
		//     select (name_type) {
		//         case host_name: HostName;
		//     } name;
		// } ServerName;
		//
		// enum {
		//     host_name(0), (255)
		// } NameType;
		//
		// opaque HostName<1..2^16-1>;
		//
		// struct {
		//     ServerName server_name_list<1..2^16-1>
		// } ServerNameList;

		serverNameList := cryptobyte.NewBuilder(nil)
		serverNameList.AddUint16LengthPrefixed(func(serverName *cryptobyte.Builder) {
			serverName.AddUint8(0) // NameType host_name(0)
			addUint16LengthPrefixedBytes(serverName, []byte(m.serverName))
		})

		extensions = append(extensions, extension{
			id:   extensionServerName,
			body: serverNameList.BytesOrPanic(),
		})
	}
	if m.echOuter != nil {
		body := cryptobyte.NewBuilder(nil)
		body.AddUint8(echClientTypeOuter)
		body.AddUint16(m.echOuter.kdfID)
		body.AddUint16(m.echOuter.aeadID)
		body.AddUint8(m.echOuter.configID)
		addUint16LengthPrefixedBytes(body, m.echOuter.enc)
		addUint16LengthPrefixedBytes(body, m.echOuter.payload)
		extensions = append(extensions, extension{
			id:   extensionEncryptedClientHello,
			body: body.BytesOrPanic(),
		})
	}
	if m.echInner {
		body := cryptobyte.NewBuilder(nil)
		body.AddUint8(echClientTypeInner)
		// If unset, invalidECHInner is empty, which is the correct serialization.
		body.AddBytes(m.invalidECHInner)
		extensions = append(extensions, extension{
			id:   extensionEncryptedClientHello,
			body: body.BytesOrPanic(),
		})
	}
	if m.ocspStapling {
		certificateStatusRequest := cryptobyte.NewBuilder(nil)
		// RFC 4366, section 3.6
		certificateStatusRequest.AddUint8(1) // OCSP type
		// Two zero valued uint16s for the two lengths.
		certificateStatusRequest.AddUint16(0) // ResponderID length
		certificateStatusRequest.AddUint16(0) // Extensions length
		extensions = append(extensions, extension{
			id:   extensionStatusRequest,
			body: certificateStatusRequest.BytesOrPanic(),
		})
	}
	if len(m.supportedCurves) > 0 {
		// http://tools.ietf.org/html/rfc4492#section-5.1.1
		supportedCurvesList := cryptobyte.NewBuilder(nil)
		supportedCurvesList.AddUint16LengthPrefixed(func(supportedCurves *cryptobyte.Builder) {
			for _, curve := range m.supportedCurves {
				supportedCurves.AddUint16(uint16(curve))
			}
		})
		extensions = append(extensions, extension{
			id:   extensionSupportedCurves,
			body: supportedCurvesList.BytesOrPanic(),
		})
	}
	if len(m.supportedPoints) > 0 {
		// http://tools.ietf.org/html/rfc4492#section-5.1.2
		supportedPointsList := cryptobyte.NewBuilder(nil)
		addUint8LengthPrefixedBytes(supportedPointsList, m.supportedPoints)
		extensions = append(extensions, extension{
			id:   extensionSupportedPoints,
			body: supportedPointsList.BytesOrPanic(),
		})
	}
	if m.hasKeyShares {
		keyShareList := cryptobyte.NewBuilder(nil)
		m.marshalKeyShares(keyShareList)
		extensions = append(extensions, extension{
			id:   extensionKeyShare,
			body: keyShareList.BytesOrPanic(),
		})
	}
	if len(m.pskKEModes) > 0 {
		pskModesExtension := cryptobyte.NewBuilder(nil)
		addUint8LengthPrefixedBytes(pskModesExtension, m.pskKEModes)
		extensions = append(extensions, extension{
			id:   extensionPSKKeyExchangeModes,
			body: pskModesExtension.BytesOrPanic(),
		})
	}
	if m.hasEarlyData {
		extensions = append(extensions, extension{id: extensionEarlyData})
	}
	if len(m.tls13Cookie) > 0 {
		body := cryptobyte.NewBuilder(nil)
		addUint16LengthPrefixedBytes(body, m.tls13Cookie)
		extensions = append(extensions, extension{
			id:   extensionCookie,
			body: body.BytesOrPanic(),
		})
	}
	if m.ticketSupported {
		// http://tools.ietf.org/html/rfc5077#section-3.2
		extensions = append(extensions, extension{
			id:   extensionSessionTicket,
			body: m.sessionTicket,
		})
	}
	if len(m.signatureAlgorithms) > 0 {
		// https://tools.ietf.org/html/rfc5246#section-7.4.1.4.1
		signatureAlgorithmsExtension := cryptobyte.NewBuilder(nil)
		signatureAlgorithmsExtension.AddUint16LengthPrefixed(func(signatureAlgorithms *cryptobyte.Builder) {
			for _, sigAlg := range m.signatureAlgorithms {
				signatureAlgorithms.AddUint16(uint16(sigAlg))
			}
		})
		extensions = append(extensions, extension{
			id:   extensionSignatureAlgorithms,
			body: signatureAlgorithmsExtension.BytesOrPanic(),
		})
	}
	if len(m.signatureAlgorithmsCert) > 0 {
		signatureAlgorithmsCertExtension := cryptobyte.NewBuilder(nil)
		signatureAlgorithmsCertExtension.AddUint16LengthPrefixed(func(signatureAlgorithmsCert *cryptobyte.Builder) {
			for _, sigAlg := range m.signatureAlgorithmsCert {
				signatureAlgorithmsCert.AddUint16(uint16(sigAlg))
			}
		})
		extensions = append(extensions, extension{
			id:   extensionSignatureAlgorithmsCert,
			body: signatureAlgorithmsCertExtension.BytesOrPanic(),
		})
	}
	if len(m.supportedVersions) > 0 {
		supportedVersionsExtension := cryptobyte.NewBuilder(nil)
		supportedVersionsExtension.AddUint8LengthPrefixed(func(supportedVersions *cryptobyte.Builder) {
			for _, version := range m.supportedVersions {
				supportedVersions.AddUint16(uint16(version))
			}
		})
		extensions = append(extensions, extension{
			id:   extensionSupportedVersions,
			body: supportedVersionsExtension.BytesOrPanic(),
		})
	}
	if m.secureRenegotiation != nil {
		secureRenegoExt := cryptobyte.NewBuilder(nil)
		addUint8LengthPrefixedBytes(secureRenegoExt, m.secureRenegotiation)
		extensions = append(extensions, extension{
			id:   extensionRenegotiationInfo,
			body: secureRenegoExt.BytesOrPanic(),
		})
	}
	if len(m.alpnProtocols) > 0 {
		// https://tools.ietf.org/html/rfc7301#section-3.1
		alpnExtension := cryptobyte.NewBuilder(nil)
		alpnExtension.AddUint16LengthPrefixed(func(protocolNameList *cryptobyte.Builder) {
			for _, s := range m.alpnProtocols {
				addUint8LengthPrefixedBytes(protocolNameList, []byte(s))
			}
		})
		extensions = append(extensions, extension{
			id:   extensionALPN,
			body: alpnExtension.BytesOrPanic(),
		})
	}
	if len(m.quicTransportParams) > 0 {
		extensions = append(extensions, extension{
			id:   extensionQUICTransportParams,
			body: m.quicTransportParams,
		})
	}
	if len(m.quicTransportParamsLegacy) > 0 {
		extensions = append(extensions, extension{
			id:   extensionQUICTransportParamsLegacy,
			body: m.quicTransportParamsLegacy,
		})
	}
	if m.channelIDSupported {
		extensions = append(extensions, extension{id: extensionChannelID})
	}
	if m.duplicateExtension {
		// Add a duplicate bogus extension at the beginning and end.
		extensions = append(extensions, extension{id: extensionDuplicate})
	}
	if m.extendedMasterSecret {
		// https://tools.ietf.org/html/rfc7627
		extensions = append(extensions, extension{id: extensionExtendedMasterSecret})
	}
	if len(m.srtpProtectionProfiles) > 0 {
		// https://tools.ietf.org/html/rfc5764#section-4.1.1
		useSrtpExt := cryptobyte.NewBuilder(nil)

		useSrtpExt.AddUint16LengthPrefixed(func(srtpProtectionProfiles *cryptobyte.Builder) {
			for _, p := range m.srtpProtectionProfiles {
				srtpProtectionProfiles.AddUint16(p)
			}
		})
		addUint8LengthPrefixedBytes(useSrtpExt, []byte(m.srtpMasterKeyIdentifier))

		extensions = append(extensions, extension{
			id:   extensionUseSRTP,
			body: useSrtpExt.BytesOrPanic(),
		})
	}
	if m.sctListSupported {
		extensions = append(extensions, extension{id: extensionSignedCertificateTimestamp})
	}
	if len(m.customExtension) > 0 {
		extensions = append(extensions, extension{
			id:   extensionCustom,
			body: []byte(m.customExtension),
		})
	}
	if len(m.compressedCertAlgs) > 0 {
		body := cryptobyte.NewBuilder(nil)
		body.AddUint8LengthPrefixed(func(algIDs *cryptobyte.Builder) {
			for _, v := range m.compressedCertAlgs {
				algIDs.AddUint16(v)
			}
		})
		extensions = append(extensions, extension{
			id:   extensionCompressedCertAlgs,
			body: body.BytesOrPanic(),
		})
	}
	if len(m.delegatedCredential) > 0 {
		body := cryptobyte.NewBuilder(nil)
		body.AddUint16LengthPrefixed(func(signatureSchemeList *cryptobyte.Builder) {
			for _, sigAlg := range m.delegatedCredential {
				signatureSchemeList.AddUint16(uint16(sigAlg))
			}
		})
		extensions = append(extensions, extension{
			id:   extensionDelegatedCredential,
			body: body.BytesOrPanic(),
		})
	}
	if len(m.alpsProtocols) > 0 {
		body := cryptobyte.NewBuilder(nil)
		body.AddUint16LengthPrefixed(func(protocolNameList *cryptobyte.Builder) {
			for _, s := range m.alpsProtocols {
				addUint8LengthPrefixedBytes(protocolNameList, []byte(s))
			}
		})
		extensions = append(extensions, extension{
			id:   extensionApplicationSettings,
			body: body.BytesOrPanic(),
		})
	}
	if len(m.alpsProtocolsOld) > 0 {
		body := cryptobyte.NewBuilder(nil)
		body.AddUint16LengthPrefixed(func(protocolNameList *cryptobyte.Builder) {
			for _, s := range m.alpsProtocolsOld {
				addUint8LengthPrefixedBytes(protocolNameList, []byte(s))
			}
		})
		extensions = append(extensions, extension{
			id:   extensionApplicationSettingsOld,
			body: body.BytesOrPanic(),
		})
	}
	if len(m.pakeShares) > 0 {
		body := cryptobyte.NewBuilder(nil)
		addUint16LengthPrefixedBytes(body, m.pakeClientID)
		addUint16LengthPrefixedBytes(body, m.pakeServerID)
		body.AddUint16LengthPrefixed(func(shares *cryptobyte.Builder) {
			for _, share := range m.pakeShares {
				shares.AddUint16(share.id)
				addUint16LengthPrefixedBytes(shares, share.msg)
			}
		})
		extensions = append(extensions, extension{
			id:   extensionPAKE,
			body: body.BytesOrPanic(),
		})
	}
	if len(m.certificateAuthorities) > 0 {
		body := cryptobyte.NewBuilder(nil)
		body.AddUint16LengthPrefixed(func(certificateAuthorities *cryptobyte.Builder) {
			for _, ca := range m.certificateAuthorities {
				addUint16LengthPrefixedBytes(certificateAuthorities, ca)
			}
		})
		extensions = append(extensions, extension{
			id:   extensionCertificateAuthorities,
			body: body.BytesOrPanic(),
		})
	}
	// Check against nil to distinguish missing and empty.
	if m.trustAnchors != nil {
		body := cryptobyte.NewBuilder(nil)
		body.AddUint16LengthPrefixed(func(trustAnchorList *cryptobyte.Builder) {
			for _, id := range m.trustAnchors {
				addUint8LengthPrefixedBytes(trustAnchorList, id)
			}
		})
		extensions = append(extensions, extension{
			id:   extensionTrustAnchors,
			body: body.BytesOrPanic(),
		})
	}
	// The PSK extension must be last. See https://tools.ietf.org/html/rfc8446#section-4.2.11
	if len(m.pskIdentities) > 0 {
		pskExtension := cryptobyte.NewBuilder(nil)
		pskExtension.AddUint16LengthPrefixed(func(pskIdentities *cryptobyte.Builder) {
			for _, psk := range m.pskIdentities {
				addUint16LengthPrefixedBytes(pskIdentities, psk.ticket)
				pskIdentities.AddUint32(psk.obfuscatedTicketAge)
			}
		})
		pskExtension.AddUint16LengthPrefixed(func(pskBinders *cryptobyte.Builder) {
			for _, binder := range m.pskBinders {
				addUint8LengthPrefixedBytes(pskBinders, binder)
			}
		})
		extensions = append(extensions, extension{
			id:   extensionPreSharedKey,
			body: pskExtension.BytesOrPanic(),
		})
	}

	if m.omitExtensions {
		return
	}
	hello.AddUint16LengthPrefixed(func(extensionsBB *cryptobyte.Builder) {
		if m.emptyExtensions {
			return
		}
		extMap := make(map[uint16][]byte)
		extsWritten := make(map[uint16]struct{})
		for _, ext := range extensions {
			extMap[ext.id] = ext.body
		}
		// Write each of the prefix extensions, if we have it.
		for _, extID := range m.prefixExtensions {
			if body, ok := extMap[extID]; ok {
				extensionsBB.AddUint16(extID)
				addUint16LengthPrefixedBytes(extensionsBB, body)
				extsWritten[extID] = struct{}{}
			}
		}
		// Write outer extensions, possibly in compressed form.
		if m.outerExtensions != nil {
			if typ == clientHelloEncodedInner && !m.reorderOuterExtensionsWithoutCompressing {
				extensionsBB.AddUint16(extensionECHOuterExtensions)
				extensionsBB.AddUint16LengthPrefixed(func(child *cryptobyte.Builder) {
					child.AddUint8LengthPrefixed(func(list *cryptobyte.Builder) {
						for _, extID := range m.outerExtensions {
							list.AddUint16(extID)
							extsWritten[extID] = struct{}{}
						}
					})
				})
			} else {
				for _, extID := range m.outerExtensions {
					// m.outerExtensions may intentionally contain duplicates to test the
					// server's reaction. If m.reorderOuterExtensionsWithoutCompressing
					// is set, we are targeting the second ClientHello and wish to send a
					// valid first ClientHello. In that case, deduplicate so the error
					// only appears later.
					if _, written := extsWritten[extID]; m.reorderOuterExtensionsWithoutCompressing && written {
						continue
					}
					if body, ok := extMap[extID]; ok {
						extensionsBB.AddUint16(extID)
						addUint16LengthPrefixedBytes(extensionsBB, body)
						extsWritten[extID] = struct{}{}
					}
				}
			}
		}

		// Write each of the remaining extensions in their original order.
		for _, ext := range extensions {
			if _, written := extsWritten[ext.id]; !written {
				extensionsBB.AddUint16(ext.id)
				addUint16LengthPrefixedBytes(extensionsBB, ext.body)
			}
		}

		if m.pad != 0 && len(hello.BytesOrPanic())%m.pad != 0 {
			extensionsBB.AddUint16(extensionPadding)
			extensionsBB.AddUint16LengthPrefixed(func(padding *cryptobyte.Builder) {
				// Note hello.len() has changed at this point from the length
				// prefix.
				if l := len(hello.BytesOrPanic()) % m.pad; l != 0 {
					padding.AddBytes(make([]byte, m.pad-l))
				}
			})
		}
	})
}

func (m *clientHelloMsg) marshalForEncodedInner() []byte {
	hello := cryptobyte.NewBuilder(nil)
	m.marshalBody(hello, clientHelloEncodedInner)
	return hello.BytesOrPanic()
}

func (m *clientHelloMsg) marshal() []byte {
	if m.raw != nil {
		return m.raw
	}

	if m.isV2ClientHello {
		v2Msg := cryptobyte.NewBuilder(nil)
		v2Msg.AddUint8(1)
		v2Msg.AddUint16(m.vers)
		v2Msg.AddUint16(uint16(len(m.cipherSuites) * 3))
		v2Msg.AddUint16(uint16(len(m.sessionID)))
		v2Msg.AddUint16(uint16(len(m.v2Challenge)))
		for _, spec := range m.cipherSuites {
			v2Msg.AddUint24(uint32(spec))
		}
		v2Msg.AddBytes(m.sessionID)
		v2Msg.AddBytes(m.v2Challenge)
		m.raw = v2Msg.BytesOrPanic()
		return m.raw
	}

	handshakeMsg := cryptobyte.NewBuilder(nil)
	handshakeMsg.AddUint8(typeClientHello)
	handshakeMsg.AddUint24LengthPrefixed(func(hello *cryptobyte.Builder) {
		m.marshalBody(hello, clientHelloNormal)
	})
	m.raw = handshakeMsg.BytesOrPanic()
	// Sanity-check padding.
	if m.pad != 0 && (len(m.raw)-4)%m.pad != 0 {
		panic(fmt.Sprintf("%d is not a multiple of %d", len(m.raw)-4, m.pad))
	}
	return m.raw
}

func parseSignatureAlgorithms(reader *cryptobyte.String, out *[]signatureAlgorithm, allowEmpty bool) bool {
	var sigAlgs cryptobyte.String
	if !reader.ReadUint16LengthPrefixed(&sigAlgs) {
		return false
	}
	if !allowEmpty && len(sigAlgs) == 0 {
		return false
	}
	*out = make([]signatureAlgorithm, 0, len(sigAlgs)/2)
	for len(sigAlgs) > 0 {
		var v uint16
		if !sigAlgs.ReadUint16(&v) {
			return false
		}
		if signatureAlgorithm(v) == signatureRSAPKCS1WithMD5AndSHA1 {
			// signatureRSAPKCS1WithMD5AndSHA1 is an internal value BoringSSL
			// uses to represent the TLS 1.0 MD5/SHA-1 concatenation. It should
			// never appear on the wire.
			return false
		}
		*out = append(*out, signatureAlgorithm(v))
	}
	return true
}

func checkDuplicateExtensions(extensions cryptobyte.String) bool {
	seen := make(map[uint16]struct{})
	for len(extensions) > 0 {
		var extension uint16
		var body cryptobyte.String
		if !extensions.ReadUint16(&extension) ||
			!extensions.ReadUint16LengthPrefixed(&body) {
			return false
		}
		if _, ok := seen[extension]; ok {
			return false
		}
		seen[extension] = struct{}{}
	}
	return true
}

func (m *clientHelloMsg) unmarshal(data []byte) bool {
	m.raw = data
	reader := cryptobyte.String(data[4:])
	if !reader.ReadUint16(&m.vers) ||
		!reader.ReadBytes(&m.random, 32) ||
		!readUint8LengthPrefixedBytes(&reader, &m.sessionID) ||
		len(m.sessionID) > 32 {
		return false
	}
	if m.isDTLS && !readUint8LengthPrefixedBytes(&reader, &m.cookie) {
		return false
	}
	var cipherSuites cryptobyte.String
	if !reader.ReadUint16LengthPrefixed(&cipherSuites) ||
		!readUint8LengthPrefixedBytes(&reader, &m.compressionMethods) {
		return false
	}

	m.cipherSuites = make([]uint16, 0, len(cipherSuites)/2)
	for len(cipherSuites) > 0 {
		var v uint16
		if !cipherSuites.ReadUint16(&v) {
			return false
		}
		m.cipherSuites = append(m.cipherSuites, v)
		if v == scsvRenegotiation {
			m.secureRenegotiation = []byte{}
		}
	}

	m.nextProtoNeg = false
	m.serverName = ""
	m.ocspStapling = false
	m.keyShares = nil
	m.pskIdentities = nil
	m.hasEarlyData = false
	m.ticketSupported = false
	m.sessionTicket = nil
	m.signatureAlgorithms = nil
	m.signatureAlgorithmsCert = nil
	m.supportedVersions = nil
	m.alpnProtocols = nil
	m.extendedMasterSecret = false
	m.customExtension = ""
	m.delegatedCredential = nil
	m.alpsProtocols = nil
	m.alpsProtocolsOld = nil
	m.pakeClientID = nil
	m.pakeServerID = nil
	m.pakeShares = nil

	if len(reader) == 0 {
		// ClientHello is optionally followed by extension data
		return true
	}

	var extensions cryptobyte.String
	if !reader.ReadUint16LengthPrefixed(&extensions) || len(reader) != 0 || !checkDuplicateExtensions(extensions) {
		return false
	}
	m.rawExtensions = extensions
	for len(extensions) > 0 {
		var extension uint16
		var body cryptobyte.String
		if !extensions.ReadUint16(&extension) ||
			!extensions.ReadUint16LengthPrefixed(&body) {
			return false
		}
		switch extension {
		case extensionServerName:
			var names cryptobyte.String
			if !body.ReadUint16LengthPrefixed(&names) || len(body) != 0 {
				return false
			}
			for len(names) > 0 {
				var nameType byte
				var name []byte
				if !names.ReadUint8(&nameType) ||
					!readUint16LengthPrefixedBytes(&names, &name) {
					return false
				}
				if nameType == 0 {
					m.serverName = string(name)
				}
			}
		case extensionEncryptedClientHello:
			var typ byte
			if !body.ReadUint8(&typ) {
				return false
			}
			switch typ {
			case echClientTypeOuter:
				var echOuter echClientOuter
				if !body.ReadUint16(&echOuter.kdfID) ||
					!body.ReadUint16(&echOuter.aeadID) ||
					!body.ReadUint8(&echOuter.configID) ||
					!readUint16LengthPrefixedBytes(&body, &echOuter.enc) ||
					!readUint16LengthPrefixedBytes(&body, &echOuter.payload) ||
					len(echOuter.payload) == 0 ||
					len(body) > 0 {
					return false
				}
				m.echOuter = &echOuter
				m.echPayloadEnd = len(data) - len(extensions)
				m.echPayloadStart = m.echPayloadEnd - len(echOuter.payload)
			case echClientTypeInner:
				if len(body) > 0 {
					return false
				}
				m.echInner = true
			default:
				return false
			}
		case extensionNextProtoNeg:
			if len(body) != 0 {
				return false
			}
			m.nextProtoNeg = true
		case extensionStatusRequest:
			// This parse is stricter than a production implementation would
			// use. The status_request extension has many layers of interior
			// extensibility, but we expect our client to only send empty
			// requests of type OCSP.
			var statusType uint8
			var responderIDList, innerExtensions cryptobyte.String
			if !body.ReadUint8(&statusType) ||
				statusType != statusTypeOCSP ||
				!body.ReadUint16LengthPrefixed(&responderIDList) ||
				!body.ReadUint16LengthPrefixed(&innerExtensions) ||
				len(responderIDList) != 0 ||
				len(innerExtensions) != 0 ||
				len(body) != 0 {
				return false
			}
			m.ocspStapling = true
		case extensionSupportedCurves:
			// http://tools.ietf.org/html/rfc4492#section-5.5.1
			var curves cryptobyte.String
			if !body.ReadUint16LengthPrefixed(&curves) || len(body) != 0 {
				return false
			}
			m.supportedCurves = make([]CurveID, 0, len(curves)/2)
			for len(curves) > 0 {
				var v uint16
				if !curves.ReadUint16(&v) {
					return false
				}
				m.supportedCurves = append(m.supportedCurves, CurveID(v))
			}
		case extensionSupportedPoints:
			// http://tools.ietf.org/html/rfc4492#section-5.1.2
			if !readUint8LengthPrefixedBytes(&body, &m.supportedPoints) || len(m.supportedPoints) == 0 || len(body) != 0 {
				return false
			}
		case extensionSessionTicket:
			// http://tools.ietf.org/html/rfc5077#section-3.2
			m.ticketSupported = true
			m.sessionTicket = []byte(body)
		case extensionKeyShare:
			// https://tools.ietf.org/html/rfc8446#section-4.2.8
			m.hasKeyShares = true
			m.keySharesRaw = body
			var keyShares cryptobyte.String
			if !body.ReadUint16LengthPrefixed(&keyShares) || len(body) != 0 {
				return false
			}
			for len(keyShares) > 0 {
				var entry keyShareEntry
				var group uint16
				if !keyShares.ReadUint16(&group) ||
					!readUint16LengthPrefixedBytes(&keyShares, &entry.keyExchange) {
					return false
				}
				entry.group = CurveID(group)
				m.keyShares = append(m.keyShares, entry)
			}
		case extensionPreSharedKey:
			// https://tools.ietf.org/html/rfc8446#section-4.2.11
			var psks, binders cryptobyte.String
			if !body.ReadUint16LengthPrefixed(&psks) ||
				!body.ReadUint16LengthPrefixed(&binders) ||
				len(body) != 0 {
				return false
			}
			for len(psks) > 0 {
				var psk pskIdentity
				if !readUint16LengthPrefixedBytes(&psks, &psk.ticket) ||
					!psks.ReadUint32(&psk.obfuscatedTicketAge) {
					return false
				}
				m.pskIdentities = append(m.pskIdentities, psk)
			}
			for len(binders) > 0 {
				var binder []byte
				if !readUint8LengthPrefixedBytes(&binders, &binder) {
					return false
				}
				m.pskBinders = append(m.pskBinders, binder)
			}

			// There must be the same number of identities as binders.
			if len(m.pskIdentities) != len(m.pskBinders) {
				return false
			}
		case extensionPSKKeyExchangeModes:
			// https://tools.ietf.org/html/rfc8446#section-4.2.9
			if !readUint8LengthPrefixedBytes(&body, &m.pskKEModes) || len(body) != 0 {
				return false
			}
		case extensionEarlyData:
			// https://tools.ietf.org/html/rfc8446#section-4.2.10
			if len(body) != 0 {
				return false
			}
			m.hasEarlyData = true
		case extensionCookie:
			if !readUint16LengthPrefixedBytes(&body, &m.tls13Cookie) || len(body) != 0 {
				return false
			}
		case extensionSignatureAlgorithms:
			// https://tools.ietf.org/html/rfc5246#section-7.4.1.4.1
			if !parseSignatureAlgorithms(&body, &m.signatureAlgorithms, false) || len(body) != 0 {
				return false
			}
		case extensionSignatureAlgorithmsCert:
			if !parseSignatureAlgorithms(&body, &m.signatureAlgorithmsCert, false) || len(body) != 0 {
				return false
			}
		case extensionSupportedVersions:
			var versions cryptobyte.String
			if !body.ReadUint8LengthPrefixed(&versions) || len(body) != 0 {
				return false
			}
			m.supportedVersions = make([]uint16, 0, len(versions)/2)
			for len(versions) > 0 {
				var v uint16
				if !versions.ReadUint16(&v) {
					return false
				}
				m.supportedVersions = append(m.supportedVersions, v)
			}
		case extensionRenegotiationInfo:
			if !readUint8LengthPrefixedBytes(&body, &m.secureRenegotiation) || len(body) != 0 {
				return false
			}
		case extensionALPN:
			var protocols cryptobyte.String
			if !body.ReadUint16LengthPrefixed(&protocols) || len(body) != 0 {
				return false
			}
			for len(protocols) > 0 {
				var protocol []byte
				if !readUint8LengthPrefixedBytes(&protocols, &protocol) || len(protocol) == 0 {
					return false
				}
				m.alpnProtocols = append(m.alpnProtocols, string(protocol))
			}
		case extensionQUICTransportParams:
			m.quicTransportParams = body
		case extensionQUICTransportParamsLegacy:
			m.quicTransportParamsLegacy = body
		case extensionChannelID:
			if len(body) != 0 {
				return false
			}
			m.channelIDSupported = true
		case extensionExtendedMasterSecret:
			if len(body) != 0 {
				return false
			}
			m.extendedMasterSecret = true
		case extensionUseSRTP:
			var profiles cryptobyte.String
			var mki []byte
			if !body.ReadUint16LengthPrefixed(&profiles) ||
				!readUint8LengthPrefixedBytes(&body, &mki) ||
				len(body) != 0 {
				return false
			}
			m.srtpProtectionProfiles = make([]uint16, 0, len(profiles)/2)
			for len(profiles) > 0 {
				var v uint16
				if !profiles.ReadUint16(&v) {
					return false
				}
				m.srtpProtectionProfiles = append(m.srtpProtectionProfiles, v)
			}
			m.srtpMasterKeyIdentifier = string(mki)
		case extensionSignedCertificateTimestamp:
			if len(body) != 0 {
				return false
			}
			m.sctListSupported = true
		case extensionCustom:
			m.customExtension = string(body)
		case extensionCompressedCertAlgs:
			var algIDs cryptobyte.String
			if !body.ReadUint8LengthPrefixed(&algIDs) {
				return false
			}

			seen := make(map[uint16]struct{})
			for len(algIDs) > 0 {
				var algID uint16
				if !algIDs.ReadUint16(&algID) {
					return false
				}
				if _, ok := seen[algID]; ok {
					return false
				}
				seen[algID] = struct{}{}
				m.compressedCertAlgs = append(m.compressedCertAlgs, algID)
			}
		case extensionPadding:
			// Padding bytes must be all zero.
			for _, b := range body {
				if b != 0 {
					return false
				}
			}
		case extensionDelegatedCredential:
			if !parseSignatureAlgorithms(&body, &m.delegatedCredential, false) || len(body) != 0 {
				return false
			}
		case extensionApplicationSettings:
			var protocols cryptobyte.String
			if !body.ReadUint16LengthPrefixed(&protocols) || len(body) != 0 {
				return false
			}
			for len(protocols) > 0 {
				var protocol []byte
				if !readUint8LengthPrefixedBytes(&protocols, &protocol) || len(protocol) == 0 {
					return false
				}
				m.alpsProtocols = append(m.alpsProtocols, string(protocol))
			}
		case extensionApplicationSettingsOld:
			var protocols cryptobyte.String
			if !body.ReadUint16LengthPrefixed(&protocols) || len(body) != 0 {
				return false
			}
			for len(protocols) > 0 {
				var protocol []byte
				if !readUint8LengthPrefixedBytes(&protocols, &protocol) || len(protocol) == 0 {
					return false
				}
				m.alpsProtocolsOld = append(m.alpsProtocolsOld, string(protocol))
			}
		case extensionPAKE:
			var clientId, serverId, shares cryptobyte.String
			if !body.ReadUint16LengthPrefixed(&clientId) ||
				!body.ReadUint16LengthPrefixed(&serverId) ||
				!body.ReadUint16LengthPrefixed(&shares) ||
				len(body) != 0 {
				return false
			}
			for len(shares) > 0 {
				var id uint16
				var msg cryptobyte.String
				if !shares.ReadUint16(&id) ||
					!shares.ReadUint16LengthPrefixed(&msg) {
					return false
				}
				m.pakeClientID = []byte(clientId)
				m.pakeServerID = []byte(serverId)
				m.pakeShares = append(m.pakeShares, pakeShare{id: id, msg: msg})
			}
		case extensionCertificateAuthorities:
			if !parseCAs(&body, &m.certificateAuthorities) || len(body) != 0 ||
				// If present, the CA extension may not be empty.
				len(m.certificateAuthorities) == 0 {
				return false
			}
		case extensionTrustAnchors:
			// An empty list is allowed here.
			if !parseTrustAnchors(&body, &m.trustAnchors) || len(body) != 0 {
				return false
			}
		}

		if isGREASEValue(extension) {
			m.hasGREASEExtension = true
		}
	}

	return true
}

func decodeClientHelloInner(config *Config, encoded []byte, helloOuter *clientHelloMsg) (*clientHelloMsg, error) {
	reader := cryptobyte.String(encoded)
	var versAndRandom, sessionID, cookie, cipherSuites, compressionMethods []byte
	var extensions cryptobyte.String
	if !reader.ReadBytes(&versAndRandom, 2+32) ||
		!readUint8LengthPrefixedBytes(&reader, &sessionID) ||
		len(sessionID) != 0 { // Copied from |helloOuter|
		return nil, errors.New("tls: error parsing EncodedClientHelloInner")
	}
	if helloOuter.isDTLS {
		if !readUint8LengthPrefixedBytes(&reader, &cookie) || len(cookie) != 0 {
			return nil, errors.New("tls: error parsing EncodedClientHelloInner")
		}
	}
	if !readUint16LengthPrefixedBytes(&reader, &cipherSuites) ||
		!readUint8LengthPrefixedBytes(&reader, &compressionMethods) ||
		!reader.ReadUint16LengthPrefixed(&extensions) {
		return nil, errors.New("tls: error parsing EncodedClientHelloInner")
	}

	// The remainder of the structure is padding.
	for _, padding := range reader {
		if padding != 0 {
			return nil, errors.New("tls: non-zero padding in EncodedClientHelloInner")
		}
	}

	copied := make(map[uint16]struct{})
	builder := cryptobyte.NewBuilder(nil)
	builder.AddUint8(typeClientHello)
	builder.AddUint24LengthPrefixed(func(body *cryptobyte.Builder) {
		body.AddBytes(versAndRandom)
		addUint8LengthPrefixedBytes(body, helloOuter.sessionID)
		if helloOuter.isDTLS {
			addUint8LengthPrefixedBytes(body, cookie)
		}
		addUint16LengthPrefixedBytes(body, cipherSuites)
		addUint8LengthPrefixedBytes(body, compressionMethods)
		body.AddUint16LengthPrefixed(func(newExtensions *cryptobyte.Builder) {
			var seenOuterExtensions bool
			outerExtensions := cryptobyte.String(helloOuter.rawExtensions)
			for len(extensions) > 0 {
				var extType uint16
				var extBody cryptobyte.String
				if !extensions.ReadUint16(&extType) ||
					!extensions.ReadUint16LengthPrefixed(&extBody) {
					newExtensions.SetError(errors.New("tls: error parsing EncodedClientHelloInner"))
					return
				}
				if extType != extensionECHOuterExtensions {
					newExtensions.AddUint16(extType)
					addUint16LengthPrefixedBytes(newExtensions, extBody)
					continue
				}
				if seenOuterExtensions {
					newExtensions.SetError(errors.New("tls: duplicate ech_outer_extensions extension"))
					return
				}
				seenOuterExtensions = true
				var extList cryptobyte.String
				if !extBody.ReadUint8LengthPrefixed(&extList) || len(extList) == 0 || len(extBody) != 0 {
					newExtensions.SetError(errors.New("tls: error parsing ech_outer_extensions"))
					return
				}
				for len(extList) != 0 {
					var newExtType uint16
					if !extList.ReadUint16(&newExtType) {
						newExtensions.SetError(errors.New("tls: error parsing ech_outer_extensions"))
						return
					}
					if newExtType == extensionEncryptedClientHello {
						newExtensions.SetError(errors.New("tls: error parsing ech_outer_extensions"))
						return
					}
					for {
						if len(outerExtensions) == 0 {
							newExtensions.SetError(fmt.Errorf("tls: extension %d not found in ClientHelloOuter", newExtType))
							return
						}
						var foundExt uint16
						var newExtBody []byte
						if !outerExtensions.ReadUint16(&foundExt) ||
							!readUint16LengthPrefixedBytes(&outerExtensions, &newExtBody) {
							newExtensions.SetError(errors.New("tls: error parsing ClientHelloOuter"))
							return
						}
						if foundExt == newExtType {
							newExtensions.AddUint16(newExtType)
							addUint16LengthPrefixedBytes(newExtensions, newExtBody)
							copied[newExtType] = struct{}{}
							break
						}
					}
				}
			}
		})
	})

	bytes, err := builder.Bytes()
	if err != nil {
		return nil, err
	}

	for _, expected := range config.Bugs.ExpectECHOuterExtensions {
		if _, ok := copied[expected]; !ok {
			return nil, fmt.Errorf("tls: extension %d not found in ech_outer_extensions", expected)
		}
	}
	for _, expected := range config.Bugs.ExpectECHUncompressedExtensions {
		if _, ok := copied[expected]; ok {
			return nil, fmt.Errorf("tls: extension %d unexpectedly found in ech_outer_extensions", expected)
		}
	}

	ret := &clientHelloMsg{isDTLS: helloOuter.isDTLS}
	if !ret.unmarshal(bytes) {
		return nil, errors.New("tls: error parsing reconstructed ClientHello")
	}

	return ret, nil
}

type serverHelloMsg struct {
	raw                   []byte
	isDTLS                bool
	vers                  uint16
	versOverride          uint16
	supportedVersOverride uint16
	omitSupportedVers     bool
	random                []byte
	sessionID             []byte
	cipherSuite           uint16
	hasKeyShare           bool
	keyShare              keyShareEntry
	hasPSKIdentity        bool
	pskIdentity           uint16
	compressionMethod     uint8
	customExtension       string
	unencryptedALPN       string
	omitExtensions        bool
	emptyExtensions       bool
	extensions            serverExtensions
	pakeID                uint16
	pakeMessage           []byte
}

func (m *serverHelloMsg) marshal() []byte {
	if m.raw != nil {
		return m.raw
	}

	handshakeMsg := cryptobyte.NewBuilder(nil)
	handshakeMsg.AddUint8(typeServerHello)
	handshakeMsg.AddUint24LengthPrefixed(func(hello *cryptobyte.Builder) {
		// m.vers is used both to determine the format of the rest of the
		// ServerHello and to override the value, so include a second version
		// field.
		vers, ok := wireToVersion(m.vers, m.isDTLS)
		if !ok {
			panic("unknown version")
		}
		if m.versOverride != 0 {
			hello.AddUint16(m.versOverride)
		} else if vers >= VersionTLS13 {
			legacyVersion := uint16(VersionTLS12)
			if m.isDTLS {
				legacyVersion = VersionDTLS12
			}
			hello.AddUint16(legacyVersion)
		} else {
			hello.AddUint16(m.vers)
		}

		hello.AddBytes(m.random)
		addUint8LengthPrefixedBytes(hello, m.sessionID)
		hello.AddUint16(m.cipherSuite)
		hello.AddUint8(m.compressionMethod)

		hello.AddUint16LengthPrefixed(func(extensions *cryptobyte.Builder) {
			if vers >= VersionTLS13 {
				if m.hasKeyShare {
					extensions.AddUint16(extensionKeyShare)
					extensions.AddUint16LengthPrefixed(func(keyShare *cryptobyte.Builder) {
						keyShare.AddUint16(uint16(m.keyShare.group))
						addUint16LengthPrefixedBytes(keyShare, m.keyShare.keyExchange)
					})
				}
				if m.hasPSKIdentity {
					extensions.AddUint16(extensionPreSharedKey)
					extensions.AddUint16(2) // Length
					extensions.AddUint16(m.pskIdentity)
				}
				if !m.omitSupportedVers {
					extensions.AddUint16(extensionSupportedVersions)
					extensions.AddUint16(2) // Length
					if m.supportedVersOverride != 0 {
						extensions.AddUint16(m.supportedVersOverride)
					} else {
						extensions.AddUint16(m.vers)
					}
				}
				if len(m.pakeMessage) != 0 {
					extensions.AddUint16(extensionPAKE)
					extensions.AddUint16LengthPrefixed(func(share *cryptobyte.Builder) {
						share.AddUint16(m.pakeID)
						addUint16LengthPrefixedBytes(share, m.pakeMessage)
					})
				}
				if len(m.customExtension) > 0 {
					extensions.AddUint16(extensionCustom)
					addUint16LengthPrefixedBytes(extensions, []byte(m.customExtension))
				}
				if len(m.unencryptedALPN) > 0 {
					extensions.AddUint16(extensionALPN)
					extensions.AddUint16LengthPrefixed(func(extension *cryptobyte.Builder) {
						extension.AddUint16LengthPrefixed(func(protocolNameList *cryptobyte.Builder) {
							addUint8LengthPrefixedBytes(protocolNameList, []byte(m.unencryptedALPN))
						})
					})
				}
			} else {
				m.extensions.marshal(extensions)
			}
			if m.omitExtensions || m.emptyExtensions {
				// Silently erasing server extensions will break the handshake. Instead,
				// assert that tests which use this field also disable all features which
				// would write an extension. Note the length includes the length prefix.
				if b := extensions.BytesOrPanic(); len(b) != 2 {
					panic(fmt.Sprintf("ServerHello unexpectedly contained extensions: %x, %+v", b, m))
				}
			}
		})
		// Remove the length prefix.
		if m.omitExtensions {
			hello.Unwrite(2)
		}
	})

	m.raw = handshakeMsg.BytesOrPanic()
	return m.raw
}

func (m *serverHelloMsg) unmarshal(data []byte) bool {
	m.raw = data
	reader := cryptobyte.String(data[4:])
	if !reader.ReadUint16(&m.vers) ||
		!reader.ReadBytes(&m.random, 32) {
		return false
	}
	vers, ok := wireToVersion(m.vers, m.isDTLS)
	if !ok {
		return false
	}
	if !readUint8LengthPrefixedBytes(&reader, &m.sessionID) ||
		!reader.ReadUint16(&m.cipherSuite) ||
		!reader.ReadUint8(&m.compressionMethod) {
		return false
	}

	if len(reader) == 0 && m.vers < VersionTLS13 {
		// Extension data is optional before TLS 1.3.
		m.extensions = serverExtensions{}
		m.omitExtensions = true
		return true
	}

	var extensions cryptobyte.String
	if !reader.ReadUint16LengthPrefixed(&extensions) || len(reader) != 0 || !checkDuplicateExtensions(extensions) {
		return false
	}

	// Parse out the version from supported_versions if available.
	if vers == VersionTLS12 {
		extensionsCopy := extensions
		for len(extensionsCopy) > 0 {
			var extension uint16
			var body cryptobyte.String
			if !extensionsCopy.ReadUint16(&extension) ||
				!extensionsCopy.ReadUint16LengthPrefixed(&body) {
				return false
			}
			if extension == extensionSupportedVersions {
				if !body.ReadUint16(&m.vers) || len(body) != 0 {
					return false
				}
				vers, ok = wireToVersion(m.vers, m.isDTLS)
				if !ok {
					return false
				}
			}
		}
	}

	if vers >= VersionTLS13 {
		for len(extensions) > 0 {
			var extension uint16
			var body cryptobyte.String
			if !extensions.ReadUint16(&extension) ||
				!extensions.ReadUint16LengthPrefixed(&body) {
				return false
			}
			switch extension {
			case extensionKeyShare:
				m.hasKeyShare = true
				var group uint16
				if !body.ReadUint16(&group) ||
					!readUint16LengthPrefixedBytes(&body, &m.keyShare.keyExchange) ||
					len(body) != 0 {
					return false
				}
				m.keyShare.group = CurveID(group)
			case extensionPreSharedKey:
				if !body.ReadUint16(&m.pskIdentity) || len(body) != 0 {
					return false
				}
				m.hasPSKIdentity = true
			case extensionSupportedVersions:
				// Parsed above.
			case extensionPAKE:
				if !body.ReadUint16(&m.pakeID) || !readUint16LengthPrefixedBytes(&body, &m.pakeMessage) {
					return false
				}
			default:
				// Only allow the 3 extensions that are sent in
				// the clear in TLS 1.3.
				return false
			}
		}
	} else if !m.extensions.unmarshal(extensions, vers) {
		return false
	}

	return true
}

type encryptedExtensionsMsg struct {
	raw        []byte
	extensions serverExtensions
	empty      bool
}

func (m *encryptedExtensionsMsg) marshal() []byte {
	if m.raw != nil {
		return m.raw
	}

	encryptedExtensionsMsg := cryptobyte.NewBuilder(nil)
	encryptedExtensionsMsg.AddUint8(typeEncryptedExtensions)
	encryptedExtensionsMsg.AddUint24LengthPrefixed(func(encryptedExtensions *cryptobyte.Builder) {
		if !m.empty {
			encryptedExtensions.AddUint16LengthPrefixed(func(extensions *cryptobyte.Builder) {
				m.extensions.marshal(extensions)
			})
		}
	})

	m.raw = encryptedExtensionsMsg.BytesOrPanic()
	return m.raw
}

func (m *encryptedExtensionsMsg) unmarshal(data []byte) bool {
	m.raw = data
	reader := cryptobyte.String(data[4:])
	var extensions cryptobyte.String
	if !reader.ReadUint16LengthPrefixed(&extensions) || len(reader) != 0 {
		return false
	}
	return m.extensions.unmarshal(extensions, VersionTLS13)
}

type serverExtensions struct {
	nextProtoNeg              bool
	nextProtos                []string
	ocspStapling              bool
	ticketSupported           bool
	secureRenegotiation       []byte
	alpnProtocol              string
	alpnProtocolEmpty         bool
	duplicateExtension        bool
	channelIDRequested        bool
	extendedMasterSecret      bool
	srtpProtectionProfile     uint16
	srtpMasterKeyIdentifier   string
	sctList                   []byte
	customExtension           string
	npnAfterAlpn              bool
	hasKeyShare               bool
	hasEarlyData              bool
	keyShare                  keyShareEntry
	supportedVersion          uint16
	supportedPoints           []uint8
	supportedCurves           []CurveID
	quicTransportParams       []byte
	quicTransportParamsLegacy []byte
	serverNameAck             bool
	applicationSettings       []byte
	hasApplicationSettings    bool
	applicationSettingsOld    []byte
	hasApplicationSettingsOld bool
	echRetryConfigs           []byte
	trustAnchors              [][]byte
}

func (m *serverExtensions) marshal(extensions *cryptobyte.Builder) {
	if m.duplicateExtension {
		// Add a duplicate bogus extension at the beginning and end.
		extensions.AddUint16(extensionDuplicate)
		extensions.AddUint16(0) // length = 0 for empty extension
	}
	if m.nextProtoNeg && !m.npnAfterAlpn {
		extensions.AddUint16(extensionNextProtoNeg)
		extensions.AddUint16LengthPrefixed(func(extension *cryptobyte.Builder) {
			for _, v := range m.nextProtos {
				addUint8LengthPrefixedBytes(extension, []byte(v))
			}
		})
	}
	if m.ocspStapling {
		extensions.AddUint16(extensionStatusRequest)
		extensions.AddUint16(0)
	}
	if m.ticketSupported {
		extensions.AddUint16(extensionSessionTicket)
		extensions.AddUint16(0)
	}
	if m.secureRenegotiation != nil {
		extensions.AddUint16(extensionRenegotiationInfo)
		extensions.AddUint16LengthPrefixed(func(extension *cryptobyte.Builder) {
			addUint8LengthPrefixedBytes(extension, m.secureRenegotiation)
		})
	}
	if len(m.alpnProtocol) > 0 || m.alpnProtocolEmpty {
		extensions.AddUint16(extensionALPN)
		extensions.AddUint16LengthPrefixed(func(extension *cryptobyte.Builder) {
			extension.AddUint16LengthPrefixed(func(protocolNameList *cryptobyte.Builder) {
				addUint8LengthPrefixedBytes(protocolNameList, []byte(m.alpnProtocol))
			})
		})
	}
	if m.channelIDRequested {
		extensions.AddUint16(extensionChannelID)
		extensions.AddUint16(0)
	}
	if m.duplicateExtension {
		// Add a duplicate bogus extension at the beginning and end.
		extensions.AddUint16(extensionDuplicate)
		extensions.AddUint16(0)
	}
	if m.extendedMasterSecret {
		extensions.AddUint16(extensionExtendedMasterSecret)
		extensions.AddUint16(0)
	}
	if m.srtpProtectionProfile != 0 {
		extensions.AddUint16(extensionUseSRTP)
		extensions.AddUint16LengthPrefixed(func(extension *cryptobyte.Builder) {
			extension.AddUint16LengthPrefixed(func(srtpProtectionProfiles *cryptobyte.Builder) {
				srtpProtectionProfiles.AddUint16(m.srtpProtectionProfile)
			})
			addUint8LengthPrefixedBytes(extension, []byte(m.srtpMasterKeyIdentifier))
		})
	}
	if m.sctList != nil {
		extensions.AddUint16(extensionSignedCertificateTimestamp)
		addUint16LengthPrefixedBytes(extensions, m.sctList)
	}
	if l := len(m.customExtension); l > 0 {
		extensions.AddUint16(extensionCustom)
		addUint16LengthPrefixedBytes(extensions, []byte(m.customExtension))
	}
	if m.nextProtoNeg && m.npnAfterAlpn {
		extensions.AddUint16(extensionNextProtoNeg)
		extensions.AddUint16LengthPrefixed(func(extension *cryptobyte.Builder) {
			for _, v := range m.nextProtos {
				addUint8LengthPrefixedBytes(extension, []byte(v))
			}
		})
	}
	if m.hasKeyShare {
		extensions.AddUint16(extensionKeyShare)
		extensions.AddUint16LengthPrefixed(func(keyShare *cryptobyte.Builder) {
			keyShare.AddUint16(uint16(m.keyShare.group))
			addUint16LengthPrefixedBytes(keyShare, m.keyShare.keyExchange)
		})
	}
	if m.supportedVersion != 0 {
		extensions.AddUint16(extensionSupportedVersions)
		extensions.AddUint16(2) // Length
		extensions.AddUint16(m.supportedVersion)
	}
	if len(m.supportedPoints) > 0 {
		// http://tools.ietf.org/html/rfc4492#section-5.1.2
		extensions.AddUint16(extensionSupportedPoints)
		extensions.AddUint16LengthPrefixed(func(supportedPointsList *cryptobyte.Builder) {
			addUint8LengthPrefixedBytes(supportedPointsList, m.supportedPoints)
		})
	}
	if len(m.supportedCurves) > 0 {
		// https://tools.ietf.org/html/rfc8446#section-4.2.7
		extensions.AddUint16(extensionSupportedCurves)
		extensions.AddUint16LengthPrefixed(func(supportedCurvesList *cryptobyte.Builder) {
			supportedCurvesList.AddUint16LengthPrefixed(func(supportedCurves *cryptobyte.Builder) {
				for _, curve := range m.supportedCurves {
					supportedCurves.AddUint16(uint16(curve))
				}
			})
		})
	}
	if len(m.quicTransportParams) > 0 {
		extensions.AddUint16(extensionQUICTransportParams)
		addUint16LengthPrefixedBytes(extensions, m.quicTransportParams)
	}
	if len(m.quicTransportParamsLegacy) > 0 {
		extensions.AddUint16(extensionQUICTransportParamsLegacy)
		addUint16LengthPrefixedBytes(extensions, m.quicTransportParamsLegacy)
	}
	if m.hasEarlyData {
		extensions.AddUint16(extensionEarlyData)
		extensions.AddBytes([]byte{0, 0})
	}
	if m.serverNameAck {
		extensions.AddUint16(extensionServerName)
		extensions.AddUint16(0) // zero length
	}
	if m.hasApplicationSettings {
		extensions.AddUint16(extensionApplicationSettings)
		addUint16LengthPrefixedBytes(extensions, m.applicationSettings)
	}
	if m.hasApplicationSettingsOld {
		extensions.AddUint16(extensionApplicationSettingsOld)
		addUint16LengthPrefixedBytes(extensions, m.applicationSettingsOld)
	}
	if len(m.echRetryConfigs) > 0 {
		extensions.AddUint16(extensionEncryptedClientHello)
		addUint16LengthPrefixedBytes(extensions, m.echRetryConfigs)
	}
	if len(m.trustAnchors) > 0 {
		extensions.AddUint16(extensionTrustAnchors)
		extensions.AddUint16LengthPrefixed(func(extension *cryptobyte.Builder) {
			extension.AddUint16LengthPrefixed(func(trustAnchorList *cryptobyte.Builder) {
				for _, id := range m.trustAnchors {
					addUint8LengthPrefixedBytes(trustAnchorList, id)
				}
			})
		})
	}
}

func (m *serverExtensions) unmarshal(data cryptobyte.String, version uint16) bool {
	// Reset all fields.
	*m = serverExtensions{}

	if !checkDuplicateExtensions(data) {
		return false
	}

	for len(data) > 0 {
		var extension uint16
		var body cryptobyte.String
		if !data.ReadUint16(&extension) ||
			!data.ReadUint16LengthPrefixed(&body) {
			return false
		}
		switch extension {
		case extensionNextProtoNeg:
			m.nextProtoNeg = true
			for len(body) > 0 {
				var protocol []byte
				if !readUint8LengthPrefixedBytes(&body, &protocol) {
					return false
				}
				m.nextProtos = append(m.nextProtos, string(protocol))
			}
		case extensionStatusRequest:
			if len(body) != 0 {
				return false
			}
			m.ocspStapling = true
		case extensionSessionTicket:
			if len(body) != 0 {
				return false
			}
			m.ticketSupported = true
		case extensionRenegotiationInfo:
			if !readUint8LengthPrefixedBytes(&body, &m.secureRenegotiation) || len(body) != 0 {
				return false
			}
		case extensionALPN:
			var pakes, protocol cryptobyte.String
			if !body.ReadUint16LengthPrefixed(&pakes) ||
				len(body) != 0 ||
				!pakes.ReadUint8LengthPrefixed(&protocol) ||
				len(pakes) != 0 {
				return false
			}
			m.alpnProtocol = string(protocol)
			m.alpnProtocolEmpty = len(protocol) == 0
		case extensionChannelID:
			if len(body) != 0 {
				return false
			}
			m.channelIDRequested = true
		case extensionExtendedMasterSecret:
			if len(body) != 0 {
				return false
			}
			m.extendedMasterSecret = true
		case extensionUseSRTP:
			var profiles, mki cryptobyte.String
			if !body.ReadUint16LengthPrefixed(&profiles) ||
				!profiles.ReadUint16(&m.srtpProtectionProfile) ||
				len(profiles) != 0 ||
				!body.ReadUint8LengthPrefixed(&mki) ||
				len(body) != 0 {
				return false
			}
			m.srtpMasterKeyIdentifier = string(mki)
		case extensionSignedCertificateTimestamp:
			m.sctList = []byte(body)
		case extensionCustom:
			m.customExtension = string(body)
		case extensionServerName:
			if len(body) != 0 {
				return false
			}
			m.serverNameAck = true
		case extensionSupportedPoints:
			// supported_points is illegal in TLS 1.3.
			if version >= VersionTLS13 {
				return false
			}
			// http://tools.ietf.org/html/rfc4492#section-5.5.2
			if !readUint8LengthPrefixedBytes(&body, &m.supportedPoints) || len(body) != 0 {
				return false
			}
		case extensionSupportedCurves:
			// The server can only send supported_curves in TLS 1.3.
			if version < VersionTLS13 {
				return false
			}
		case extensionQUICTransportParams:
			m.quicTransportParams = body
		case extensionQUICTransportParamsLegacy:
			m.quicTransportParamsLegacy = body
		case extensionEarlyData:
			if version < VersionTLS13 || len(body) != 0 {
				return false
			}
			m.hasEarlyData = true
		case extensionApplicationSettings:
			m.hasApplicationSettings = true
			m.applicationSettings = body
		case extensionApplicationSettingsOld:
			m.hasApplicationSettingsOld = true
			m.applicationSettingsOld = body
		case extensionEncryptedClientHello:
			if version < VersionTLS13 {
				return false
			}
			m.echRetryConfigs = body

			// Validate the ECHConfig with a top-level parse.
			var echConfigs cryptobyte.String
			if !body.ReadUint16LengthPrefixed(&echConfigs) {
				return false
			}
			for len(echConfigs) > 0 {
				var version uint16
				var contents cryptobyte.String
				if !echConfigs.ReadUint16(&version) ||
					!echConfigs.ReadUint16LengthPrefixed(&contents) {
					return false
				}
			}
			if len(body) > 0 {
				return false
			}
		case extensionTrustAnchors:
			if version < VersionTLS13 {
				return false
			}
			// The list cannot be empty here. If empty, the peer should have omitted the extension.
			if !parseTrustAnchors(&body, &m.trustAnchors) || len(m.trustAnchors) == 0 || len(body) != 0 {
				return false
			}
		default:
			// Unknown extensions are illegal from the server.
			return false
		}
	}

	return true
}

type clientEncryptedExtensionsMsg struct {
	raw                       []byte
	applicationSettings       []byte
	hasApplicationSettings    bool
	applicationSettingsOld    []byte
	hasApplicationSettingsOld bool
	customExtension           []byte
}

func (m *clientEncryptedExtensionsMsg) marshal() (x []byte) {
	if m.raw != nil {
		return m.raw
	}

	builder := cryptobyte.NewBuilder(nil)
	builder.AddUint8(typeEncryptedExtensions)
	builder.AddUint24LengthPrefixed(func(body *cryptobyte.Builder) {
		body.AddUint16LengthPrefixed(func(extensions *cryptobyte.Builder) {
			if m.hasApplicationSettings {
				extensions.AddUint16(extensionApplicationSettings)
				addUint16LengthPrefixedBytes(extensions, m.applicationSettings)
			}
			if m.hasApplicationSettingsOld {
				extensions.AddUint16(extensionApplicationSettingsOld)
				addUint16LengthPrefixedBytes(extensions, m.applicationSettingsOld)
			}
			if len(m.customExtension) > 0 {
				extensions.AddUint16(extensionCustom)
				addUint16LengthPrefixedBytes(extensions, m.customExtension)
			}
		})
	})

	m.raw = builder.BytesOrPanic()
	return m.raw
}

func (m *clientEncryptedExtensionsMsg) unmarshal(data []byte) bool {
	m.raw = data
	reader := cryptobyte.String(data[4:])

	var extensions cryptobyte.String
	if !reader.ReadUint16LengthPrefixed(&extensions) ||
		len(reader) != 0 {
		return false
	}

	if !checkDuplicateExtensions(extensions) {
		return false
	}

	for len(extensions) > 0 {
		var extension uint16
		var body cryptobyte.String
		if !extensions.ReadUint16(&extension) ||
			!extensions.ReadUint16LengthPrefixed(&body) {
			return false
		}
		switch extension {
		case extensionApplicationSettings:
			m.hasApplicationSettings = true
			m.applicationSettings = body
		case extensionApplicationSettingsOld:
			m.hasApplicationSettingsOld = true
			m.applicationSettingsOld = body
		default:
			// Unknown extensions are illegal in EncryptedExtensions.
			return false
		}
	}
	return true
}

type helloRetryRequestMsg struct {
	isDTLS                bool
	raw                   []byte
	vers                  uint16
	sessionID             []byte
	cipherSuite           uint16
	compressionMethod     uint8
	hasSelectedGroup      bool
	selectedGroup         CurveID
	cookie                []byte
	customExtension       string
	echConfirmation       []byte
	echConfirmationOffset int
	duplicateExtensions   bool
	pakeID                uint16
	pakeMessage           []byte
}

func (m *helloRetryRequestMsg) marshal() []byte {
	if m.raw != nil {
		return m.raw
	}

	retryRequestMsg := cryptobyte.NewBuilder(nil)
	retryRequestMsg.AddUint8(typeServerHello)
	retryRequestMsg.AddUint24LengthPrefixed(func(retryRequest *cryptobyte.Builder) {
		legacyVersion := uint16(VersionTLS12)
		if m.isDTLS {
			legacyVersion = VersionDTLS12
		}
		retryRequest.AddUint16(legacyVersion)
		retryRequest.AddBytes(tls13HelloRetryRequest)
		addUint8LengthPrefixedBytes(retryRequest, m.sessionID)
		retryRequest.AddUint16(m.cipherSuite)
		retryRequest.AddUint8(m.compressionMethod)

		retryRequest.AddUint16LengthPrefixed(func(extensions *cryptobyte.Builder) {
			count := 1
			if m.duplicateExtensions {
				count = 2
			}

			for i := 0; i < count; i++ {
				extensions.AddUint16(extensionSupportedVersions)
				extensions.AddUint16(2) // Length
				extensions.AddUint16(m.vers)
				if m.hasSelectedGroup {
					extensions.AddUint16(extensionKeyShare)
					extensions.AddUint16(2) // length
					extensions.AddUint16(uint16(m.selectedGroup))
				}
				if len(m.pakeMessage) != 0 {
					extensions.AddUint16(extensionPAKE)
					extensions.AddUint16LengthPrefixed(func(share *cryptobyte.Builder) {
						share.AddUint16(m.pakeID)
						addUint16LengthPrefixedBytes(share, m.pakeMessage)
					})
				}
				// m.cookie may be a non-nil empty slice for empty cookie tests.
				if m.cookie != nil {
					extensions.AddUint16(extensionCookie)
					extensions.AddUint16LengthPrefixed(func(body *cryptobyte.Builder) {
						addUint16LengthPrefixedBytes(body, m.cookie)
					})
				}
				if len(m.customExtension) > 0 {
					extensions.AddUint16(extensionCustom)
					addUint16LengthPrefixedBytes(extensions, []byte(m.customExtension))
				}
				if len(m.echConfirmation) > 0 {
					extensions.AddUint16(extensionEncryptedClientHello)
					addUint16LengthPrefixedBytes(extensions, m.echConfirmation)
				}
			}
		})
	})

	m.raw = retryRequestMsg.BytesOrPanic()
	return m.raw
}

func (m *helloRetryRequestMsg) unmarshal(data []byte) bool {
	expectedLegacyVers := uint16(VersionTLS12)
	if m.isDTLS {
		expectedLegacyVers = VersionDTLS12
	}

	m.raw = data
	reader := cryptobyte.String(data[4:])
	var legacyVers uint16
	var random []byte
	var compressionMethod byte
	var extensions cryptobyte.String
	if !reader.ReadUint16(&legacyVers) ||
		legacyVers != expectedLegacyVers ||
		!reader.ReadBytes(&random, 32) ||
		!readUint8LengthPrefixedBytes(&reader, &m.sessionID) ||
		!reader.ReadUint16(&m.cipherSuite) ||
		!reader.ReadUint8(&compressionMethod) ||
		compressionMethod != 0 ||
		!reader.ReadUint16LengthPrefixed(&extensions) ||
		len(reader) != 0 {
		return false
	}
	for len(extensions) > 0 {
		var extension uint16
		var body cryptobyte.String
		if !extensions.ReadUint16(&extension) ||
			!extensions.ReadUint16LengthPrefixed(&body) {
			return false
		}
		switch extension {
		case extensionSupportedVersions:
			if !body.ReadUint16(&m.vers) ||
				len(body) != 0 {
				return false
			}
		case extensionKeyShare:
			var v uint16
			if !body.ReadUint16(&v) || len(body) != 0 {
				return false
			}
			m.hasSelectedGroup = true
			m.selectedGroup = CurveID(v)
		case extensionCookie:
			if !readUint16LengthPrefixedBytes(&body, &m.cookie) ||
				len(m.cookie) == 0 ||
				len(body) != 0 {
				return false
			}
		case extensionEncryptedClientHello:
			if len(body) != echAcceptConfirmationLength {
				return false
			}
			m.echConfirmation = body
			m.echConfirmationOffset = len(m.raw) - len(extensions) - len(body)
		default:
			// Unknown extensions are illegal from the server.
			return false
		}
	}
	return true
}

type certificateEntry struct {
	data                []byte
	ocspResponse        []byte
	sctList             []byte
	duplicateExtensions bool
	extraExtension      []byte
	delegatedCredential *delegatedCredential
}

type delegatedCredential struct {
	// https://www.rfc-editor.org/rfc/rfc9345.html#section-4
	raw              []byte
	signedBytes      []byte
	lifetimeSecs     uint32
	dcCertVerifyAlgo signatureAlgorithm
	pkixPublicKey    []byte
	algorithm        signatureAlgorithm
	signature        []byte
}

type certificateMsg struct {
	raw                             []byte
	hasRequestContext               bool
	requestContext                  []byte
	certificates                    []certificateEntry
	matchedTrustAnchor              bool
	sendTrustAnchorWrongCertificate bool
	sendNonEmptyTrustAnchorMatch    bool
}

func (m *certificateMsg) marshal() (x []byte) {
	if m.raw != nil {
		return m.raw
	}

	certMsg := cryptobyte.NewBuilder(nil)
	certMsg.AddUint8(typeCertificate)
	certMsg.AddUint24LengthPrefixed(func(certificate *cryptobyte.Builder) {
		if m.hasRequestContext {
			addUint8LengthPrefixedBytes(certificate, m.requestContext)
		}
		certificate.AddUint24LengthPrefixed(func(certificateList *cryptobyte.Builder) {
			for i, cert := range m.certificates {
				addUint24LengthPrefixedBytes(certificateList, cert.data)
				if m.hasRequestContext {
					certificateList.AddUint16LengthPrefixed(func(extensions *cryptobyte.Builder) {
						if (i == 0 && m.matchedTrustAnchor) || (i == 1 && m.sendTrustAnchorWrongCertificate) {
							extensions.AddUint16(extensionTrustAnchors)
							if m.sendNonEmptyTrustAnchorMatch {
								addUint16LengthPrefixedBytes(extensions, []byte{0x03, 0xba, 0xdb, 0x0b})
							} else {
								extensions.AddUint16(0) // Empty extension
							}
						}
						count := 1
						if cert.duplicateExtensions {
							count = 2
						}

						for i := 0; i < count; i++ {
							if cert.ocspResponse != nil {
								extensions.AddUint16(extensionStatusRequest)
								extensions.AddUint16LengthPrefixed(func(body *cryptobyte.Builder) {
									body.AddUint8(statusTypeOCSP)
									addUint24LengthPrefixedBytes(body, cert.ocspResponse)
								})
							}

							if cert.sctList != nil {
								extensions.AddUint16(extensionSignedCertificateTimestamp)
								addUint16LengthPrefixedBytes(extensions, cert.sctList)
							}
						}
						if cert.extraExtension != nil {
							extensions.AddBytes(cert.extraExtension)
						}
					})
				}
			}
		})
	})

	m.raw = certMsg.BytesOrPanic()
	return m.raw
}

func (m *certificateMsg) unmarshal(data []byte) bool {
	m.raw = data
	reader := cryptobyte.String(data[4:])

	if m.hasRequestContext && !readUint8LengthPrefixedBytes(&reader, &m.requestContext) {
		return false
	}

	var certs cryptobyte.String
	if !reader.ReadUint24LengthPrefixed(&certs) || len(reader) != 0 {
		return false
	}
	m.certificates = nil
	for len(certs) > 0 {
		var cert certificateEntry
		if !readUint24LengthPrefixedBytes(&certs, &cert.data) {
			return false
		}
		if m.hasRequestContext {
			var extensions cryptobyte.String
			if !certs.ReadUint16LengthPrefixed(&extensions) || !checkDuplicateExtensions(extensions) {
				return false
			}
			for len(extensions) > 0 {
				var extension uint16
				var body cryptobyte.String
				if !extensions.ReadUint16(&extension) ||
					!extensions.ReadUint16LengthPrefixed(&body) {
					return false
				}
				switch extension {
				case extensionStatusRequest:
					var statusType byte
					if !body.ReadUint8(&statusType) ||
						statusType != statusTypeOCSP ||
						!readUint24LengthPrefixedBytes(&body, &cert.ocspResponse) ||
						len(cert.ocspResponse) == 0 ||
						len(body) != 0 {
						return false
					}
				case extensionSignedCertificateTimestamp:
					cert.sctList = []byte(body)
				case extensionDelegatedCredential:
					// https://www.rfc-editor.org/rfc/rfc9345.html#section-4
					if cert.delegatedCredential != nil {
						return false
					}

					dc := new(delegatedCredential)
					origBody := body
					var dcCertVerifyAlgo, algorithm uint16

					if !body.ReadUint32(&dc.lifetimeSecs) ||
						!body.ReadUint16(&dcCertVerifyAlgo) ||
						!readUint24LengthPrefixedBytes(&body, &dc.pkixPublicKey) ||
						!body.ReadUint16(&algorithm) ||
						!readUint16LengthPrefixedBytes(&body, &dc.signature) ||
						len(body) != 0 {
						return false
					}

					dc.dcCertVerifyAlgo = signatureAlgorithm(dcCertVerifyAlgo)
					dc.algorithm = signatureAlgorithm(algorithm)
					dc.raw = origBody
					dc.signedBytes = []byte(origBody)[:4+2+3+len(dc.pkixPublicKey)]
					cert.delegatedCredential = dc
				case extensionTrustAnchors:
					if len(m.certificates) != 0 {
						return false // Only allowed in first certificate.
					}
					if len(body) != 0 {
						return false
					}
					m.matchedTrustAnchor = true
				default:
					return false
				}
			}
		}
		m.certificates = append(m.certificates, cert)
	}

	return true
}

type compressedCertificateMsg struct {
	raw                []byte
	algID              uint16
	uncompressedLength uint32
	compressed         []byte
}

func (m *compressedCertificateMsg) marshal() (x []byte) {
	if m.raw != nil {
		return m.raw
	}

	certMsg := cryptobyte.NewBuilder(nil)
	certMsg.AddUint8(typeCompressedCertificate)
	certMsg.AddUint24LengthPrefixed(func(certificate *cryptobyte.Builder) {
		certificate.AddUint16(m.algID)
		certificate.AddUint24(m.uncompressedLength)
		addUint24LengthPrefixedBytes(certificate, m.compressed)
	})

	m.raw = certMsg.BytesOrPanic()
	return m.raw
}

func (m *compressedCertificateMsg) unmarshal(data []byte) bool {
	m.raw = data
	reader := cryptobyte.String(data[4:])

	if !reader.ReadUint16(&m.algID) ||
		!reader.ReadUint24(&m.uncompressedLength) ||
		!readUint24LengthPrefixedBytes(&reader, &m.compressed) ||
		len(reader) != 0 {
		return false
	}

	if m.uncompressedLength >= 1<<17 {
		return false
	}

	return true
}

type serverKeyExchangeMsg struct {
	raw []byte
	key []byte
}

func (m *serverKeyExchangeMsg) marshal() []byte {
	if m.raw != nil {
		return m.raw
	}
	msg := cryptobyte.NewBuilder(nil)
	msg.AddUint8(typeServerKeyExchange)
	addUint24LengthPrefixedBytes(msg, m.key)
	m.raw = msg.BytesOrPanic()
	return m.raw
}

func (m *serverKeyExchangeMsg) unmarshal(data []byte) bool {
	m.raw = data
	if len(data) < 4 {
		return false
	}
	m.key = data[4:]
	return true
}

type certificateStatusMsg struct {
	raw        []byte
	statusType uint8
	response   []byte
}

func (m *certificateStatusMsg) marshal() []byte {
	if m.raw != nil {
		return m.raw
	}

	var x []byte
	if m.statusType == statusTypeOCSP {
		msg := cryptobyte.NewBuilder(nil)
		msg.AddUint8(typeCertificateStatus)
		msg.AddUint24LengthPrefixed(func(body *cryptobyte.Builder) {
			body.AddUint8(statusTypeOCSP)
			addUint24LengthPrefixedBytes(body, m.response)
		})
		x = msg.BytesOrPanic()
	} else {
		x = []byte{typeCertificateStatus, 0, 0, 1, m.statusType}
	}

	m.raw = x
	return x
}

func (m *certificateStatusMsg) unmarshal(data []byte) bool {
	m.raw = data
	reader := cryptobyte.String(data[4:])
	if !reader.ReadUint8(&m.statusType) ||
		m.statusType != statusTypeOCSP ||
		!readUint24LengthPrefixedBytes(&reader, &m.response) ||
		len(m.response) == 0 ||
		len(reader) != 0 {
		return false
	}
	return true
}

type serverHelloDoneMsg struct{}

func (m *serverHelloDoneMsg) marshal() []byte {
	x := make([]byte, 4)
	x[0] = typeServerHelloDone
	return x
}

func (m *serverHelloDoneMsg) unmarshal(data []byte) bool {
	return len(data) == 4
}

type clientKeyExchangeMsg struct {
	raw        []byte
	ciphertext []byte
}

func (m *clientKeyExchangeMsg) marshal() []byte {
	if m.raw != nil {
		return m.raw
	}
	msg := cryptobyte.NewBuilder(nil)
	msg.AddUint8(typeClientKeyExchange)
	addUint24LengthPrefixedBytes(msg, m.ciphertext)
	m.raw = msg.BytesOrPanic()
	return m.raw
}

func (m *clientKeyExchangeMsg) unmarshal(data []byte) bool {
	m.raw = data
	if len(data) < 4 {
		return false
	}
	l := int(data[1])<<16 | int(data[2])<<8 | int(data[3])
	if l != len(data)-4 {
		return false
	}
	m.ciphertext = data[4:]
	return true
}

type finishedMsg struct {
	raw        []byte
	verifyData []byte
}

func (m *finishedMsg) marshal() []byte {
	if m.raw != nil {
		return m.raw
	}

	msg := cryptobyte.NewBuilder(nil)
	msg.AddUint8(typeFinished)
	addUint24LengthPrefixedBytes(msg, m.verifyData)
	m.raw = msg.BytesOrPanic()
	return m.raw
}

func (m *finishedMsg) unmarshal(data []byte) bool {
	m.raw = data
	if len(data) < 4 {
		return false
	}
	m.verifyData = data[4:]
	return true
}

type nextProtoMsg struct {
	raw   []byte
	proto string
}

func (m *nextProtoMsg) marshal() []byte {
	if m.raw != nil {
		return m.raw
	}

	padding := 32 - (len(m.proto)+2)%32

	msg := cryptobyte.NewBuilder(nil)
	msg.AddUint8(typeNextProtocol)
	msg.AddUint24LengthPrefixed(func(body *cryptobyte.Builder) {
		addUint8LengthPrefixedBytes(body, []byte(m.proto))
		addUint8LengthPrefixedBytes(body, make([]byte, padding))
	})
	m.raw = msg.BytesOrPanic()
	return m.raw
}

func (m *nextProtoMsg) unmarshal(data []byte) bool {
	m.raw = data
	reader := cryptobyte.String(data[4:])
	var proto, padding []byte
	if !readUint8LengthPrefixedBytes(&reader, &proto) ||
		!readUint8LengthPrefixedBytes(&reader, &padding) ||
		len(reader) != 0 {
		return false
	}
	m.proto = string(proto)

	// Padding is not meant to be checked normally, but as this is a testing
	// implementation, we check the padding is as expected.
	if len(padding) != 32-(len(m.proto)+2)%32 {
		return false
	}
	for _, v := range padding {
		if v != 0 {
			return false
		}
	}

	return true
}

type certificateRequestMsg struct {
	raw  []byte
	vers uint16
	// hasSignatureAlgorithm indicates whether this message includes a list
	// of signature and hash functions. This change was introduced with TLS
	// 1.2.
	hasSignatureAlgorithm bool
	// hasRequestContext indicates whether this message includes a context
	// field instead of certificateTypes. This change was introduced with
	// TLS 1.3.
	hasRequestContext bool

	certificateTypes        []byte
	requestContext          []byte
	signatureAlgorithms     []signatureAlgorithm
	signatureAlgorithmsCert []signatureAlgorithm
	certificateAuthorities  [][]byte
	customExtension         uint16
}

func (m *certificateRequestMsg) marshal() []byte {
	if m.raw != nil {
		return m.raw
	}

	// See http://tools.ietf.org/html/rfc4346#section-7.4.4
	builder := cryptobyte.NewBuilder(nil)
	builder.AddUint8(typeCertificateRequest)
	builder.AddUint24LengthPrefixed(func(body *cryptobyte.Builder) {
		if m.hasRequestContext {
			addUint8LengthPrefixedBytes(body, m.requestContext)
			body.AddUint16LengthPrefixed(func(extensions *cryptobyte.Builder) {
				if m.hasSignatureAlgorithm {
					extensions.AddUint16(extensionSignatureAlgorithms)
					extensions.AddUint16LengthPrefixed(func(extension *cryptobyte.Builder) {
						extension.AddUint16LengthPrefixed(func(signatureAlgorithms *cryptobyte.Builder) {
							for _, sigAlg := range m.signatureAlgorithms {
								signatureAlgorithms.AddUint16(uint16(sigAlg))
							}
						})
					})
				}
				if len(m.signatureAlgorithmsCert) > 0 {
					extensions.AddUint16(extensionSignatureAlgorithmsCert)
					extensions.AddUint16LengthPrefixed(func(extension *cryptobyte.Builder) {
						extension.AddUint16LengthPrefixed(func(signatureAlgorithmsCert *cryptobyte.Builder) {
							for _, sigAlg := range m.signatureAlgorithmsCert {
								signatureAlgorithmsCert.AddUint16(uint16(sigAlg))
							}
						})
					})
				}
				if len(m.certificateAuthorities) > 0 {
					extensions.AddUint16(extensionCertificateAuthorities)
					extensions.AddUint16LengthPrefixed(func(extension *cryptobyte.Builder) {
						extension.AddUint16LengthPrefixed(func(certificateAuthorities *cryptobyte.Builder) {
							for _, ca := range m.certificateAuthorities {
								addUint16LengthPrefixedBytes(certificateAuthorities, ca)
							}
						})
					})
				}
				if m.customExtension > 0 {
					extensions.AddUint16(m.customExtension)
					extensions.AddUint16(0) // Empty extension
				}
			})
		} else {
			addUint8LengthPrefixedBytes(body, m.certificateTypes)

			if m.hasSignatureAlgorithm {
				body.AddUint16LengthPrefixed(func(signatureAlgorithms *cryptobyte.Builder) {
					for _, sigAlg := range m.signatureAlgorithms {
						signatureAlgorithms.AddUint16(uint16(sigAlg))
					}
				})
			}

			body.AddUint16LengthPrefixed(func(certificateAuthorities *cryptobyte.Builder) {
				for _, ca := range m.certificateAuthorities {
					addUint16LengthPrefixedBytes(certificateAuthorities, ca)
				}
			})
		}
	})

	m.raw = builder.BytesOrPanic()
	return m.raw
}

func parseCAs(reader *cryptobyte.String, out *[][]byte) bool {
	var cas cryptobyte.String
	if !reader.ReadUint16LengthPrefixed(&cas) {
		return false
	}
	for len(cas) > 0 {
		var ca []byte
		if !readUint16LengthPrefixedBytes(&cas, &ca) || len(ca) == 0 {
			return false
		}
		*out = append(*out, ca)
	}
	return true
}

func parseTrustAnchors(reader *cryptobyte.String, out *[][]byte) bool {
	var ids cryptobyte.String
	if !reader.ReadUint16LengthPrefixed(&ids) {
		return false
	}
	// Distinguish nil and empty.
	*out = [][]byte{}
	for len(ids) > 0 {
		var id []byte
		if !readUint8LengthPrefixedBytes(&ids, &id) {
			return false
		}
		*out = append(*out, id)
	}
	return true
}

func (m *certificateRequestMsg) unmarshal(data []byte) bool {
	m.raw = data
	reader := cryptobyte.String(data[4:])

	if m.hasRequestContext {
		var extensions cryptobyte.String
		if !readUint8LengthPrefixedBytes(&reader, &m.requestContext) ||
			!reader.ReadUint16LengthPrefixed(&extensions) ||
			len(reader) != 0 ||
			!checkDuplicateExtensions(extensions) {
			return false
		}
		for len(extensions) > 0 {
			var extension uint16
			var body cryptobyte.String
			if !extensions.ReadUint16(&extension) ||
				!extensions.ReadUint16LengthPrefixed(&body) {
				return false
			}
			switch extension {
			case extensionSignatureAlgorithms:
				if !parseSignatureAlgorithms(&body, &m.signatureAlgorithms, false) || len(body) != 0 {
					return false
				}
			case extensionSignatureAlgorithmsCert:
				if !parseSignatureAlgorithms(&body, &m.signatureAlgorithmsCert, false) || len(body) != 0 {
					return false
				}
			case extensionCertificateAuthorities:
				if !parseCAs(&body, &m.certificateAuthorities) || len(body) != 0 ||
					// If present, the CA extension may not be empty.
					len(m.certificateAuthorities) == 0 {
					return false
				}
			}
		}
	} else {
		if !readUint8LengthPrefixedBytes(&reader, &m.certificateTypes) {
			return false
		}
		// In TLS 1.2, the supported_signature_algorithms field in
		// CertificateRequest may be empty.
		if m.hasSignatureAlgorithm && !parseSignatureAlgorithms(&reader, &m.signatureAlgorithms, true) {
			return false
		}
		if !parseCAs(&reader, &m.certificateAuthorities) ||
			len(reader) != 0 {
			return false
		}
	}

	return true
}

type certificateVerifyMsg struct {
	raw                   []byte
	hasSignatureAlgorithm bool
	signatureAlgorithm    signatureAlgorithm
	signature             []byte
}

func (m *certificateVerifyMsg) marshal() []byte {
	if m.raw != nil {
		return m.raw
	}

	// See http://tools.ietf.org/html/rfc4346#section-7.4.8
	msg := cryptobyte.NewBuilder(nil)
	msg.AddUint8(typeCertificateVerify)
	msg.AddUint24LengthPrefixed(func(body *cryptobyte.Builder) {
		if m.hasSignatureAlgorithm {
			body.AddUint16(uint16(m.signatureAlgorithm))
		}
		addUint16LengthPrefixedBytes(body, m.signature)
	})

	m.raw = msg.BytesOrPanic()
	return m.raw
}

func (m *certificateVerifyMsg) unmarshal(data []byte) bool {
	m.raw = data
	reader := cryptobyte.String(data[4:])
	if m.hasSignatureAlgorithm {
		var v uint16
		if !reader.ReadUint16(&v) {
			return false
		}
		m.signatureAlgorithm = signatureAlgorithm(v)
	}
	if !readUint16LengthPrefixedBytes(&reader, &m.signature) ||
		!reader.Empty() {
		return false
	}
	return true
}

type newSessionTicketMsg struct {
	raw                         []byte
	vers                        uint16
	isDTLS                      bool
	ticketLifetime              uint32
	ticketAgeAdd                uint32
	ticketNonce                 []byte
	ticket                      []byte
	maxEarlyDataSize            uint32
	customExtension             string
	duplicateEarlyDataExtension bool
	hasGREASEExtension          bool
	flags                       flagSet
}

func (m *newSessionTicketMsg) marshal() []byte {
	if m.raw != nil {
		return m.raw
	}

	version, ok := wireToVersion(m.vers, m.isDTLS)
	if !ok {
		panic("unknown version")
	}

	// See http://tools.ietf.org/html/rfc5077#section-3.3
	ticketMsg := cryptobyte.NewBuilder(nil)
	ticketMsg.AddUint8(typeNewSessionTicket)
	ticketMsg.AddUint24LengthPrefixed(func(body *cryptobyte.Builder) {
		body.AddUint32(m.ticketLifetime)
		if version >= VersionTLS13 {
			body.AddUint32(m.ticketAgeAdd)
			addUint8LengthPrefixedBytes(body, m.ticketNonce)
		}

		addUint16LengthPrefixedBytes(body, m.ticket)

		if version >= VersionTLS13 {
			body.AddUint16LengthPrefixed(func(extensions *cryptobyte.Builder) {
				if m.maxEarlyDataSize > 0 {
					extensions.AddUint16(extensionEarlyData)
					extensions.AddUint16LengthPrefixed(func(child *cryptobyte.Builder) {
						child.AddUint32(m.maxEarlyDataSize)
					})
					if m.duplicateEarlyDataExtension {
						extensions.AddUint16(extensionEarlyData)
						extensions.AddUint16LengthPrefixed(func(child *cryptobyte.Builder) {
							child.AddUint32(m.maxEarlyDataSize)
						})
					}
				}
				if len(m.customExtension) > 0 {
					extensions.AddUint16(extensionCustom)
					addUint16LengthPrefixedBytes(extensions, []byte(m.customExtension))
				}
				m.flags.marshalExtension(extensions)
			})
		}
	})

	m.raw = ticketMsg.BytesOrPanic()
	return m.raw
}

func (m *newSessionTicketMsg) unmarshal(data []byte) bool {
	m.raw = data

	version, ok := wireToVersion(m.vers, m.isDTLS)
	if !ok {
		panic("unknown version")
	}

	reader := cryptobyte.String(data[4:])
	if !reader.ReadUint32(&m.ticketLifetime) {
		return false
	}

	if version >= VersionTLS13 {
		if !reader.ReadUint32(&m.ticketAgeAdd) ||
			!readUint8LengthPrefixedBytes(&reader, &m.ticketNonce) {
			return false
		}
	}

	if !readUint16LengthPrefixedBytes(&reader, &m.ticket) ||
		(version >= VersionTLS13 && len(m.ticket) == 0) {
		return false
	}

	if version >= VersionTLS13 {
		var extensions cryptobyte.String
		if !reader.ReadUint16LengthPrefixed(&extensions) || !reader.Empty() {
			return false
		}

		for !extensions.Empty() {
			var extension uint16
			var body cryptobyte.String
			if !extensions.ReadUint16(&extension) ||
				!extensions.ReadUint16LengthPrefixed(&body) {
				return false
			}

			switch extension {
			case extensionEarlyData:
				if !body.ReadUint32(&m.maxEarlyDataSize) || !body.Empty() {
					return false
				}
			case extensionTLSFlags:
				if !m.flags.unmarshalExtensionValue(body) {
					return false
				}
			default:
				if isGREASEValue(extension) {
					m.hasGREASEExtension = true
				}
			}
		}
	}

	return reader.Empty()
}

type helloVerifyRequestMsg struct {
	raw    []byte
	vers   uint16
	cookie []byte
}

func (m *helloVerifyRequestMsg) marshal() []byte {
	if m.raw != nil {
		return m.raw
	}

	length := 2 + 1 + len(m.cookie)

	x := make([]byte, 4+length)
	x[0] = typeHelloVerifyRequest
	x[1] = uint8(length >> 16)
	x[2] = uint8(length >> 8)
	x[3] = uint8(length)
	vers := m.vers
	x[4] = uint8(vers >> 8)
	x[5] = uint8(vers)
	x[6] = uint8(len(m.cookie))
	copy(x[7:7+len(m.cookie)], m.cookie)

	return x
}

func (m *helloVerifyRequestMsg) unmarshal(data []byte) bool {
	if len(data) < 4+2+1 {
		return false
	}
	m.raw = data
	m.vers = uint16(data[4])<<8 | uint16(data[5])
	cookieLen := int(data[6])
	if cookieLen > 32 || len(data) != 7+cookieLen {
		return false
	}
	m.cookie = data[7 : 7+cookieLen]

	return true
}

type channelIDMsg struct {
	raw       []byte
	channelID []byte
}

func (m *channelIDMsg) marshal() []byte {
	if m.raw != nil {
		return m.raw
	}

	length := 2 + 2 + len(m.channelID)

	x := make([]byte, 4+length)
	x[0] = typeChannelID
	x[1] = uint8(length >> 16)
	x[2] = uint8(length >> 8)
	x[3] = uint8(length)
	x[4] = uint8(extensionChannelID >> 8)
	x[5] = uint8(extensionChannelID & 0xff)
	x[6] = uint8(len(m.channelID) >> 8)
	x[7] = uint8(len(m.channelID) & 0xff)
	copy(x[8:], m.channelID)

	return x
}

func (m *channelIDMsg) unmarshal(data []byte) bool {
	if len(data) != 4+2+2+128 {
		return false
	}
	m.raw = data
	if (uint16(data[4])<<8)|uint16(data[5]) != extensionChannelID {
		return false
	}
	if int(data[6])<<8|int(data[7]) != 128 {
		return false
	}
	m.channelID = data[4+2+2:]

	return true
}

type helloRequestMsg struct{}

func (*helloRequestMsg) marshal() []byte {
	return []byte{typeHelloRequest, 0, 0, 0}
}

func (*helloRequestMsg) unmarshal(data []byte) bool {
	return len(data) == 4
}

type keyUpdateMsg struct {
	raw              []byte
	keyUpdateRequest byte
}

func (m *keyUpdateMsg) marshal() []byte {
	if m.raw != nil {
		return m.raw
	}

	return []byte{typeKeyUpdate, 0, 0, 1, m.keyUpdateRequest}
}

func (m *keyUpdateMsg) unmarshal(data []byte) bool {
	m.raw = data

	if len(data) != 5 {
		return false
	}

	length := int(data[1])<<16 | int(data[2])<<8 | int(data[3])
	if len(data)-4 != length {
		return false
	}

	m.keyUpdateRequest = data[4]
	return m.keyUpdateRequest == keyUpdateNotRequested || m.keyUpdateRequest == keyUpdateRequested
}

type endOfEarlyDataMsg struct {
	nonEmpty bool
}

func (m *endOfEarlyDataMsg) marshal() []byte {
	if m.nonEmpty {
		return []byte{typeEndOfEarlyData, 0, 0, 1, 42}
	}
	return []byte{typeEndOfEarlyData, 0, 0, 0}
}

func (*endOfEarlyDataMsg) unmarshal(data []byte) bool {
	return len(data) == 4
}
