// Copyright 2009 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package runner

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/subtle"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"slices"
	"time"

	"boringssl.googlesource.com/boringssl.git/ssl/test/runner/hpke"
	"boringssl.googlesource.com/boringssl.git/ssl/test/runner/spake2plus"
	"golang.org/x/crypto/cryptobyte"
)

const echBadPayloadByte = 0xff

type clientHandshakeState struct {
	c              *Conn
	serverHello    *serverHelloMsg
	hello          *clientHelloMsg
	innerHello     *clientHelloMsg
	echHPKEContext *hpke.Context
	suite          *cipherSuite
	finishedHash   finishedHash
	keyShares      map[CurveID]kemImplementation
	masterSecret   []byte
	session        *ClientSessionState
	finishedBytes  []byte
	peerPublicKey  crypto.PublicKey
	pakeContext    *spake2plus.Context
}

func mapClientHelloVersion(vers uint16, isDTLS bool) uint16 {
	if !isDTLS {
		return vers
	}

	switch vers {
	case VersionTLS12:
		return VersionDTLS12
	case VersionTLS10:
		return VersionDTLS10
	}

	panic("Unknown ClientHello version.")
}

// replaceClientHello returns a new clientHelloMsg which serializes to |in|, but
// with key shares copied from |hello|. This allows sending an exact
// externally-specified ClientHello in tests. However, we use |hello|'s key
// shares. This ensures we have the private keys to complete the handshake. Note
// this function does not update internal handshake state, so the test must be
// configured compatibly with |in|.
func replaceClientHello(hello *clientHelloMsg, in []byte) (*clientHelloMsg, error) {
	copied := slices.Clone(in)
	newHello := new(clientHelloMsg)
	if !newHello.unmarshal(copied) {
		return nil, errors.New("tls: invalid ClientHello")
	}

	// Replace |newHellos|'s key shares with those of |hello|. For simplicity,
	// we require their lengths match, which is satisfied by matching the
	// DefaultCurves setting to the selection in the replacement ClientHello.
	bb := cryptobyte.NewBuilder(nil)
	hello.marshalKeyShares(bb)
	keyShares, err := bb.Bytes()
	if err != nil {
		return nil, err
	}
	if len(keyShares) != len(newHello.keySharesRaw) {
		return nil, errors.New("tls: ClientHello key share length is inconsistent with DefaultCurves setting")
	}
	// |newHello.keySharesRaw| aliases |copied|.
	copy(newHello.keySharesRaw, keyShares)
	newHello.keyShares = hello.keyShares

	return newHello, nil
}

func (c *Conn) clientHandshake() error {
	if c.config == nil {
		c.config = defaultConfig()
	}

	if len(c.config.ServerName) == 0 && !c.config.InsecureSkipVerify {
		return errors.New("tls: either ServerName or InsecureSkipVerify must be specified in the tls.Config")
	}

	c.sendHandshakeSeq = 0
	c.recvHandshakeSeq = 0

	hs := &clientHandshakeState{
		c:         c,
		keyShares: make(map[CurveID]kemImplementation),
	}

	// Pick a session to resume.
	var session *ClientSessionState
	var cacheKey string
	sessionCache := c.config.ClientSessionCache
	if sessionCache != nil {
		// Try to resume a previously negotiated TLS session, if
		// available.
		cacheKey = clientSessionCacheKey(c.conn.RemoteAddr(), c.config)
		// TODO(nharper): Support storing more than one session
		// ticket for TLS 1.3.
		candidateSession, ok := sessionCache.Get(cacheKey)
		if ok {
			ticketOk := !c.config.SessionTicketsDisabled || candidateSession.sessionTicket == nil

			// Check that the ciphersuite/version used for the
			// previous session are still valid.
			cipherSuiteOk := false
			if candidateSession.vers <= VersionTLS12 {
				for _, id := range c.config.cipherSuites() {
					if id == candidateSession.cipherSuite.id {
						cipherSuiteOk = true
						break
					}
				}
			} else {
				// TLS 1.3 allows the cipher to change on
				// resumption.
				cipherSuiteOk = true
			}

			_, versOk := c.config.isSupportedVersion(candidateSession.wireVersion, c.isDTLS)
			if ticketOk && versOk && cipherSuiteOk {
				session = candidateSession
				hs.session = session
			}
		}
	}

	// Set up ECH parameters.
	var err error
	var earlyHello *clientHelloMsg
	if c.config.ClientECHConfig != nil {
		if c.config.ClientECHConfig.KEM != hpke.X25519WithHKDFSHA256 {
			return errors.New("tls: unsupported KEM type in ECHConfig")
		}

		echCipherSuite, ok := chooseECHCipherSuite(c.config.ClientECHConfig, c.config)
		if !ok {
			return errors.New("tls: did not find compatible cipher suite in ECHConfig")
		}

		info := []byte("tls ech\x00")
		info = append(info, c.config.ClientECHConfig.Raw...)

		var echEnc []byte
		hs.echHPKEContext, echEnc, err = hpke.SetupBaseSenderX25519(echCipherSuite.KDF, echCipherSuite.AEAD, c.config.ClientECHConfig.PublicKey, info, nil)
		if err != nil {
			return errors.New("tls: ech: failed to set up client's HPKE sender context")
		}

		hs.innerHello, err = hs.createClientHello(nil, nil)
		if err != nil {
			return err
		}
		hs.hello, err = hs.createClientHello(hs.innerHello, echEnc)
		if err != nil {
			return err
		}
		earlyHello = hs.innerHello
	} else {
		hs.hello, err = hs.createClientHello(nil, nil)
		if err != nil {
			return err
		}
		earlyHello = hs.hello
	}

	if len(earlyHello.pskIdentities) == 0 || c.config.Bugs.SendEarlyData == nil {
		earlyHello = nil
	}

	if c.config.Bugs.SendV2ClientHello {
		hs.hello.isV2ClientHello = true

		// The V2ClientHello "challenge" field is variable-length and is
		// left-padded or truncated to become the SSL3/TLS random.
		challengeLength := c.config.Bugs.V2ClientHelloChallengeLength
		if challengeLength == 0 {
			challengeLength = len(hs.hello.random)
		}
		if challengeLength <= len(hs.hello.random) {
			skip := len(hs.hello.random) - challengeLength
			clear(hs.hello.random[:skip])
			hs.hello.v2Challenge = hs.hello.random[skip:]
		} else {
			hs.hello.v2Challenge = make([]byte, challengeLength)
			copy(hs.hello.v2Challenge, hs.hello.random)
			if _, err := io.ReadFull(c.config.rand(), hs.hello.v2Challenge[len(hs.hello.random):]); err != nil {
				c.sendAlert(alertInternalError)
				return fmt.Errorf("tls: short read from Rand: %s", err)
			}
		}

		c.writeV2Record(hs.hello.marshal())
	} else {
		helloBytes := hs.hello.marshal()
		var appendToHello byte
		if c.config.Bugs.PartialClientFinishedWithClientHello {
			appendToHello = typeFinished
		} else if c.config.Bugs.PartialEndOfEarlyDataWithClientHello {
			appendToHello = typeEndOfEarlyData
		} else if c.config.Bugs.PartialSecondClientHelloAfterFirst {
			appendToHello = typeClientHello
		} else if c.config.Bugs.PartialClientKeyExchangeWithClientHello {
			appendToHello = typeClientKeyExchange
		}
		if appendToHello != 0 {
			c.writeRecord(recordTypeHandshake, append(helloBytes[:len(helloBytes):len(helloBytes)], appendToHello))
		} else {
			c.writeRecord(recordTypeHandshake, helloBytes)
		}
	}
	if err := c.flushHandshake(); err != nil {
		return err
	}

	if c.config.Bugs.SendEarlyAlert {
		c.sendAlert(alertHandshakeFailure)
	}
	if c.config.Bugs.SendFakeEarlyDataLength > 0 {
		c.sendFakeEarlyData(c.config.Bugs.SendFakeEarlyDataLength)
	}

	// Derive early write keys and set Conn state to allow early writes.
	if earlyHello != nil {
		finishedHash := newFinishedHash(session.wireVersion, c.isDTLS, session.cipherSuite)
		finishedHash.addEntropy(session.secret)
		finishedHash.Write(earlyHello.marshal())

		if !c.config.Bugs.SkipChangeCipherSpec {
			c.wireVersion = session.wireVersion
			c.vers = VersionTLS13
			c.writeRecord(recordTypeChangeCipherSpec, []byte{1})
			c.wireVersion = 0
			c.vers = 0
		}

		earlyTrafficSecret := finishedHash.deriveSecret(earlyTrafficLabel)
		c.earlyExporterSecret = finishedHash.deriveSecret(earlyExporterLabel)

		c.useOutTrafficSecret(uint16(encryptionEarlyData), session.wireVersion, session.cipherSuite, earlyTrafficSecret)
		for _, earlyData := range c.config.Bugs.SendEarlyData {
			if _, err := c.writeRecord(recordTypeApplicationData, earlyData); err != nil {
				return err
			}
		}
	}

	msg, err := c.readHandshake()
	if err != nil {
		return err
	}

	if c.isDTLS {
		helloVerifyRequest, ok := msg.(*helloVerifyRequestMsg)
		if ok {
			if helloVerifyRequest.vers != VersionDTLS10 {
				// Per RFC 6347, the version field in
				// HelloVerifyRequest SHOULD be always DTLS
				// 1.0. Enforce this for testing purposes.
				return errors.New("dtls: bad HelloVerifyRequest version")
			}

			hs.hello.raw = nil
			hs.hello.cookie = helloVerifyRequest.cookie
			c.writeRecord(recordTypeHandshake, hs.hello.marshal())
			if err := c.flushHandshake(); err != nil {
				return err
			}

			msg, err = c.readHandshake()
			if err != nil {
				return err
			}
		}
	}

	// The first message is either ServerHello or HelloRetryRequest, either of
	// which determines the version and cipher suite.
	var serverWireVersion, suiteID uint16
	switch m := msg.(type) {
	case *helloRetryRequestMsg:
		serverWireVersion = m.vers
		suiteID = m.cipherSuite
	case *serverHelloMsg:
		serverWireVersion = m.vers
		suiteID = m.cipherSuite
	default:
		c.sendAlert(alertUnexpectedMessage)
		return fmt.Errorf("tls: received unexpected message of type %T when waiting for HelloRetryRequest or ServerHello", msg)
	}

	serverVersion, ok := c.config.isSupportedVersion(serverWireVersion, c.isDTLS)
	if !ok {
		c.sendAlert(alertProtocolVersion)
		return fmt.Errorf("tls: server selected unsupported protocol version %x", c.vers)
	}
	c.wireVersion = serverWireVersion
	c.vers = serverVersion
	c.haveVers = true

	// We only implement enough of SSL 3.0 to test that the server doesn't:
	// we can send a ClientHello and attempt to read a ServerHello. The server
	// should respond with a protocol_version alert and not get this far.
	if c.vers == VersionSSL30 {
		return errors.New("tls: server selected SSL 3.0")
	}

	cipherSuites := hs.hello.cipherSuites
	if hs.innerHello != nil && c.config.Bugs.MinimalClientHelloOuter {
		// hs.hello has a placeholder list of ciphers if testing with
		// MinimalClientHelloOuter, so we use hs.innerHello instead. (We do not
		// attempt to support actual different cipher suite preferences between
		// the two.)
		cipherSuites = hs.innerHello.cipherSuites
	}
	hs.suite = mutualCipherSuite(cipherSuites, suiteID)
	if hs.suite == nil {
		c.sendAlert(alertHandshakeFailure)
		return fmt.Errorf("tls: server selected an unsupported cipher suite")
	}

	hs.finishedHash = newFinishedHash(c.wireVersion, c.isDTLS, hs.suite)
	hs.finishedHash.WriteHandshake(hs.hello.marshal(), hs.c.sendHandshakeSeq-1)

	if c.vers >= VersionTLS13 {
		if err := hs.doTLS13Handshake(msg); err != nil {
			return err
		}
	} else {
		hs.serverHello, ok = msg.(*serverHelloMsg)
		if !ok {
			c.sendAlert(alertUnexpectedMessage)
			return unexpectedMessageError(hs.serverHello, msg)
		}
		if isAllZero(hs.serverHello.random) {
			// If the server forgets to fill in the server random, it will
			// likely be all zero.
			return errors.New("tls: ServerHello random was all zero")
		}

		hs.writeServerHash(hs.serverHello.marshal())
		if c.config.Bugs.EarlyChangeCipherSpec > 0 {
			hs.establishKeys()
			c.writeRecord(recordTypeChangeCipherSpec, []byte{1})
		}

		if hs.serverHello.compressionMethod != compressionNone {
			c.sendAlert(alertUnexpectedMessage)
			return errors.New("tls: server selected unsupported compression format")
		}

		err = hs.processServerExtensions(&hs.serverHello.extensions)
		if err != nil {
			return err
		}

		isResume, err := hs.processServerHello()
		if err != nil {
			return err
		}

		if isResume {
			if c.config.Bugs.EarlyChangeCipherSpec == 0 {
				if err := hs.establishKeys(); err != nil {
					return err
				}
			}
			if err := hs.readSessionTicket(); err != nil {
				return err
			}
			if err := hs.readFinished(c.firstFinished[:]); err != nil {
				return err
			}
			if err := hs.sendFinished(nil, isResume); err != nil {
				return err
			}
		} else {
			if err := hs.doFullHandshake(); err != nil {
				return err
			}
			if err := hs.establishKeys(); err != nil {
				return err
			}
			if err := hs.sendFinished(c.firstFinished[:], isResume); err != nil {
				return err
			}
			if err := hs.readSessionTicket(); err != nil {
				return err
			}
			if err := hs.readFinished(nil); err != nil {
				return err
			}
			if err := c.ackHandshake(); err != nil {
				return err
			}
		}

		if sessionCache != nil && hs.session != nil && session != hs.session {
			if c.config.Bugs.RequireSessionTickets && len(hs.session.sessionTicket) == 0 {
				return errors.New("tls: new session used session IDs instead of tickets")
			}
			if c.config.Bugs.RequireSessionIDs && len(hs.session.sessionID) == 0 {
				return errors.New("tls: new session used session tickets instead of IDs")
			}
			sessionCache.Put(cacheKey, hs.session)
		}

		c.didResume = isResume
		c.exporterSecret = hs.masterSecret
	}

	c.handshakeComplete = true
	c.cipherSuite = hs.suite
	copy(c.clientRandom[:], hs.hello.random)
	copy(c.serverRandom[:], hs.serverHello.random)

	return nil
}

func chooseECHCipherSuite(echConfig *ECHConfig, config *Config) (HPKECipherSuite, bool) {
	if echConfig.KEM != hpke.X25519WithHKDFSHA256 {
		return HPKECipherSuite{}, false
	}

	for _, suite := range config.echCipherSuitePreferences() {
		if config.Bugs.IgnoreECHConfigCipherPreferences || slices.Contains(echConfig.CipherSuites, suite) {
			return suite, true
		}
	}
	return HPKECipherSuite{}, false
}

// createClientHello creates a new ClientHello message. If |innerHello| is not
// nil, this is a ClientHelloOuter that should contain an encrypted |innerHello|
// with |echEnc| as the encapsulated public key. Otherwise, the ClientHello
// should reflect the connection's true preferences.
func (hs *clientHandshakeState) createClientHello(innerHello *clientHelloMsg, echEnc []byte) (*clientHelloMsg, error) {
	c := hs.c
	nextProtosLength := 0
	for _, proto := range c.config.NextProtos {
		if l := len(proto); l > 255 {
			return nil, errors.New("tls: invalid NextProtos value")
		} else {
			nextProtosLength += 1 + l
		}
	}
	if nextProtosLength > 0xffff {
		return nil, errors.New("tls: NextProtos values too large")
	}

	quicTransportParams := c.config.QUICTransportParams
	quicTransportParamsLegacy := c.config.QUICTransportParams
	if !c.config.QUICTransportParamsUseLegacyCodepoint.IncludeStandard() {
		quicTransportParams = nil
	}
	if !c.config.QUICTransportParamsUseLegacyCodepoint.IncludeLegacy() {
		quicTransportParamsLegacy = nil
	}

	isInner := innerHello == nil && hs.echHPKEContext != nil

	minVersion := c.config.minVersion(c.isDTLS)
	maxVersion := c.config.maxVersion(c.isDTLS)
	// The ClientHelloInner may not offer TLS 1.2 or below.
	requireTLS13 := isInner && !c.config.Bugs.AllowTLS12InClientHelloInner
	if requireTLS13 && minVersion < VersionTLS13 {
		minVersion = VersionTLS13
		if minVersion > maxVersion {
			return nil, errors.New("tls: ECH requires TLS 1.3")
		}
	}

	hello := &clientHelloMsg{
		isDTLS:                    c.isDTLS,
		compressionMethods:        []uint8{compressionNone},
		random:                    make([]byte, 32),
		ocspStapling:              !c.config.Bugs.NoOCSPStapling,
		sctListSupported:          !c.config.Bugs.NoSignedCertificateTimestamps,
		supportedCurves:           c.config.curvePreferences(),
		supportedPoints:           []uint8{pointFormatUncompressed},
		nextProtoNeg:              len(c.config.NextProtos) > 0,
		secureRenegotiation:       []byte{},
		alpnProtocols:             c.config.NextProtos,
		quicTransportParams:       quicTransportParams,
		quicTransportParamsLegacy: quicTransportParamsLegacy,
		duplicateExtension:        c.config.Bugs.DuplicateExtension,
		channelIDSupported:        c.config.ChannelID != nil,
		extendedMasterSecret:      maxVersion >= VersionTLS10,
		srtpProtectionProfiles:    c.config.SRTPProtectionProfiles,
		srtpMasterKeyIdentifier:   c.config.Bugs.SRTPMasterKeyIdentifier,
		customExtension:           c.config.Bugs.CustomExtension,
		omitExtensions:            c.config.Bugs.OmitExtensions,
		emptyExtensions:           c.config.Bugs.EmptyExtensions,
		delegatedCredential:       c.config.DelegatedCredentialAlgorithms,
		trustAnchors:              c.config.RequestTrustAnchors,
	}

	// Translate the bugs that modify ClientHello extension order into a
	// list of prefix extensions. The marshal function will try these
	// extensions before any others, followed by any remaining extensions in
	// the default order.
	if c.config.Bugs.PSKBinderFirst && !c.config.Bugs.OnlyCorruptSecondPSKBinder {
		hello.prefixExtensions = append(hello.prefixExtensions, extensionPreSharedKey)
	}
	if c.config.Bugs.SwapNPNAndALPN {
		hello.prefixExtensions = append(hello.prefixExtensions, extensionALPN)
		hello.prefixExtensions = append(hello.prefixExtensions, extensionNextProtoNeg)
	}

	// Configure ech_outer_extensions.
	if isInner {
		hello.outerExtensions = c.config.ECHOuterExtensions
		// If |OnlyCompressSecondClientHelloInner| is set, we still configure
		// |hello.outerExtensions| for ordering, so that we do not introduce an
		// unsolicited change across HelloRetryRequest.
		hello.reorderOuterExtensionsWithoutCompressing = c.config.Bugs.OnlyCompressSecondClientHelloInner
	} else {
		// Compressed extensions must appear in the same relative order between
		// ClientHelloInner and ClientHelloOuter. For simplicity, we default to
		// forcing their order to match, but the caller can override this with
		// either valid or invalid explicit orders.
		if c.config.Bugs.ECHOuterExtensionOrder != nil {
			hello.prefixExtensions = append(hello.prefixExtensions, c.config.Bugs.ECHOuterExtensionOrder...)
		} else {
			hello.prefixExtensions = append(hello.prefixExtensions, c.config.ECHOuterExtensions...)
		}
	}

	if maxVersion >= VersionTLS13 {
		hello.vers = mapClientHelloVersion(VersionTLS12, c.isDTLS)
		if !c.config.Bugs.OmitSupportedVersions {
			hello.supportedVersions = c.config.supportedVersions(c.isDTLS, requireTLS13)
		}
		hello.pskKEModes = []byte{pskDHEKEMode}
	} else {
		hello.vers = mapClientHelloVersion(maxVersion, c.isDTLS)
	}

	if c.config.Bugs.SendClientVersion != 0 {
		hello.vers = c.config.Bugs.SendClientVersion
	}

	if len(c.config.Bugs.SendSupportedVersions) > 0 {
		hello.supportedVersions = c.config.Bugs.SendSupportedVersions
	}

	if innerHello != nil {
		hello.serverName = c.config.ClientECHConfig.PublicName
	} else {
		hello.serverName = c.config.ServerName
	}

	if !isInner && c.config.Bugs.OmitPublicName {
		hello.serverName = ""
	}

	disableEMS := c.config.Bugs.NoExtendedMasterSecret
	if c.cipherSuite != nil {
		disableEMS = c.config.Bugs.NoExtendedMasterSecretOnRenegotiation
	}

	if disableEMS {
		hello.extendedMasterSecret = false
	}

	if c.config.Bugs.NoSupportedCurves {
		hello.supportedCurves = nil
	}

	if c.config.Bugs.SendPSKKeyExchangeModes != nil {
		hello.pskKEModes = c.config.Bugs.SendPSKKeyExchangeModes
	}

	if c.config.Bugs.SendCompressionMethods != nil {
		hello.compressionMethods = c.config.Bugs.SendCompressionMethods
	}

	if c.config.Bugs.SendSupportedPointFormats != nil {
		hello.supportedPoints = c.config.Bugs.SendSupportedPointFormats
	}

	if len(c.clientVerify) > 0 && !c.config.Bugs.EmptyRenegotiationInfo {
		if c.config.Bugs.BadRenegotiationInfo {
			hello.secureRenegotiation = append(hello.secureRenegotiation, c.clientVerify...)
			hello.secureRenegotiation[0] ^= 0x80
		} else {
			hello.secureRenegotiation = c.clientVerify
		}
	}

	if c.config.Bugs.DuplicateCompressedCertAlgs {
		hello.compressedCertAlgs = []uint16{1, 1}
	} else if len(c.config.CertCompressionAlgs) > 0 {
		hello.compressedCertAlgs = make([]uint16, 0, len(c.config.CertCompressionAlgs))
		for id := range c.config.CertCompressionAlgs {
			hello.compressedCertAlgs = append(hello.compressedCertAlgs, uint16(id))
		}
	}

	if c.noRenegotiationInfo() {
		hello.secureRenegotiation = nil
	}

	if c.config.ALPSUseNewCodepoint.IncludeNew() {
		for protocol := range c.config.ApplicationSettings {
			hello.alpsProtocols = append(hello.alpsProtocols, protocol)
		}
	}
	if c.config.ALPSUseNewCodepoint.IncludeOld() {
		for protocol := range c.config.ApplicationSettings {
			hello.alpsProtocolsOld = append(hello.alpsProtocolsOld, protocol)
		}
	}

	if c.config.SendRootCAs && c.config.RootCAs != nil {
		hello.certificateAuthorities = c.config.RootCAs.Subjects()
	}

	if maxVersion >= VersionTLS13 {
		// Use the same key shares between ClientHelloInner and ClientHelloOuter.
		if innerHello != nil {
			hello.hasKeyShares = innerHello.hasKeyShares
			hello.keyShares = innerHello.keyShares
		} else {
			hello.hasKeyShares = true
			hello.trailingKeyShareData = c.config.Bugs.TrailingKeyShareData
			curvesToSend := c.config.defaultCurves()
			for _, curveID := range hello.supportedCurves {
				if !curvesToSend[curveID] {
					continue
				}
				kem, ok := kemForCurveID(curveID, c.config)
				if !ok {
					continue
				}
				publicKey, err := kem.generate(c.config)
				if err != nil {
					return nil, err
				}

				if c.config.Bugs.SendCurve != 0 {
					curveID = c.config.Bugs.SendCurve
				}

				hello.keyShares = append(hello.keyShares, keyShareEntry{
					group:       curveID,
					keyExchange: publicKey,
				})
				hs.keyShares[curveID] = kem

				if c.config.Bugs.DuplicateKeyShares {
					hello.keyShares = append(hello.keyShares, hello.keyShares[len(hello.keyShares)-1])
				}
			}

			if c.config.Bugs.MissingKeyShare {
				hello.hasKeyShares = false
			}
		}
	}

	for _, id := range c.config.Bugs.OfferExtraPAKEs {
		hello.pakeClientID = c.config.Bugs.OfferExtraPAKEClientID
		hello.pakeServerID = c.config.Bugs.OfferExtraPAKEServerID
		hello.pakeShares = append(hello.pakeShares, pakeShare{id: id, msg: []byte{1}})
	}
	if cred := c.config.Credential; cred != nil && cred.Type == CredentialTypeSPAKE2PlusV1 {
		if maxVersion < VersionTLS13 {
			panic("The PAKE extension is only supported in TLS 1.3")
		}
		w0, w1, _, err := spake2plus.Register(cred.PAKEPassword, cred.PAKEClientID, cred.PAKEServerID)
		if err != nil {
			return nil, err
		}
		hs.pakeContext, err = spake2plus.NewProver(cred.PAKEContext, cred.PAKEClientID, cred.PAKEServerID, w0, w1)
		if err != nil {
			return nil, err
		}
		share, err := hs.pakeContext.GenerateProverShare()
		if err != nil {
			return nil, err
		}
		if c.config.Bugs.TruncatePAKEMessage {
			share = share[:len(share)-1]
		}
		hello.pakeClientID = cred.PAKEClientID
		hello.pakeServerID = cred.PAKEServerID
		id := spakeID
		if cred.OverridePAKECodepoint != 0 {
			id = cred.OverridePAKECodepoint
		}
		hello.pakeShares = append(hello.pakeShares, pakeShare{id: id, msg: share})
		hello.hasKeyShares = false
		hello.keyShares = nil
	}

	possibleCipherSuites := c.config.cipherSuites()
	hello.cipherSuites = make([]uint16, 0, len(possibleCipherSuites))

	for _, suiteID := range possibleCipherSuites {
		suite := cipherSuiteFromID(suiteID)
		if suite == nil {
			continue
		}
		// Don't advertise TLS 1.2-only cipher suites unless
		// we're attempting TLS 1.2.
		if maxVersion < VersionTLS12 && suite.flags&suiteTLS12 != 0 {
			continue
		}
		hello.cipherSuites = append(hello.cipherSuites, suiteID)
	}

	if c.config.Bugs.AdvertiseAllConfiguredCiphers {
		hello.cipherSuites = possibleCipherSuites
	}

	if c.config.Bugs.SendRenegotiationSCSV {
		hello.cipherSuites = append(hello.cipherSuites, renegotiationSCSV)
	}

	if c.config.Bugs.SendFallbackSCSV {
		hello.cipherSuites = append(hello.cipherSuites, fallbackSCSV)
	}

	_, err := io.ReadFull(c.config.rand(), hello.random)
	if err != nil {
		c.sendAlert(alertInternalError)
		return nil, errors.New("tls: short read from Rand: " + err.Error())
	}

	if maxVersion >= VersionTLS12 && !c.config.Bugs.NoSignatureAlgorithms {
		hello.signatureAlgorithms = c.config.verifySignatureAlgorithms()
	}

	if c.config.ClientSessionCache != nil {
		hello.ticketSupported = !c.config.SessionTicketsDisabled
	}

	session := hs.session

	// ClientHelloOuter cannot offer sessions.
	if innerHello != nil && !c.config.Bugs.OfferSessionInClientHelloOuter {
		session = nil
	}

	if session != nil && c.config.time().Before(session.ticketExpiration) {
		ticket := session.sessionTicket
		if c.config.Bugs.FilterTicket != nil && len(ticket) > 0 {
			// Copy the ticket so FilterTicket may act in-place.
			ticket = make([]byte, len(session.sessionTicket))
			copy(ticket, session.sessionTicket)

			ticket, err = c.config.Bugs.FilterTicket(ticket)
			if err != nil {
				return nil, err
			}
		}

		if session.vers >= VersionTLS13 || c.config.Bugs.SendBothTickets {
			// TODO(nharper): Support sending more
			// than one PSK identity.
			ticketAge := uint32(c.config.time().Sub(session.ticketCreationTime) / time.Millisecond)
			if c.config.Bugs.SendTicketAge != 0 {
				ticketAge = uint32(c.config.Bugs.SendTicketAge / time.Millisecond)
			}
			psk := pskIdentity{
				ticket:              ticket,
				obfuscatedTicketAge: session.ticketAgeAdd + ticketAge,
			}
			hello.pskIdentities = []pskIdentity{psk}

			if c.config.Bugs.ExtraPSKIdentity {
				hello.pskIdentities = append(hello.pskIdentities, psk)
			}
		}

		if session.vers < VersionTLS13 || c.config.Bugs.SendBothTickets {
			if ticket != nil {
				hello.sessionTicket = ticket
				// A random session ID is used to detect when the
				// server accepted the ticket and is resuming a session
				// (see RFC 5077).
				sessionIDLen := 16
				if c.config.Bugs.TicketSessionIDLength != 0 {
					sessionIDLen = c.config.Bugs.TicketSessionIDLength
				}
				if c.config.Bugs.EmptyTicketSessionID {
					sessionIDLen = 0
				}
				hello.sessionID = make([]byte, sessionIDLen)
				if _, err := io.ReadFull(c.config.rand(), hello.sessionID); err != nil {
					c.sendAlert(alertInternalError)
					return nil, errors.New("tls: short read from Rand: " + err.Error())
				}
			} else {
				hello.sessionID = session.sessionID
			}
		}
	}

	if innerHello == nil {
		// Request compatibility mode from the client by sending a fake session
		// ID. Although BoringSSL always enables compatibility mode, other
		// implementations make it conditional on the ClientHello. We test
		// BoringSSL's expected behavior with SendClientHelloSessionID.
		if len(hello.sessionID) == 0 && maxVersion >= VersionTLS13 {
			hello.sessionID = make([]byte, 32)
			if _, err := io.ReadFull(c.config.rand(), hello.sessionID); err != nil {
				c.sendAlert(alertInternalError)
				return nil, errors.New("tls: short read from Rand: " + err.Error())
			}
		}
		if c.config.Bugs.MockQUICTransport != nil && !c.config.Bugs.CompatModeWithQUIC {
			hello.sessionID = []byte{}
		}
		if c.config.Bugs.SendClientHelloSessionID != nil {
			hello.sessionID = c.config.Bugs.SendClientHelloSessionID
		}
	} else {
		// ClientHelloOuter's session ID is copied from ClientHelloINnner.
		hello.sessionID = innerHello.sessionID
	}

	if c.config.Bugs.SendCipherSuites != nil {
		hello.cipherSuites = c.config.Bugs.SendCipherSuites
	}

	if innerHello == nil {
		if len(hello.pskIdentities) > 0 && c.config.Bugs.SendEarlyData != nil {
			hello.hasEarlyData = true
		}
		if c.config.Bugs.SendFakeEarlyDataLength > 0 {
			hello.hasEarlyData = true
		}
		if c.config.Bugs.OmitEarlyDataExtension {
			hello.hasEarlyData = false
		}
	} else {
		hello.hasEarlyData = innerHello.hasEarlyData
	}

	if (isInner && !c.config.Bugs.OmitECHInner) || c.config.Bugs.AlwaysSendECHInner {
		hello.echInner = true
		hello.invalidECHInner = c.config.Bugs.SendInvalidECHInner
	}

	if innerHello != nil {
		if err := hs.encryptClientHello(hello, innerHello, c.config.ClientECHConfig.ConfigID, echEnc); err != nil {
			return nil, err
		}
		if c.config.Bugs.CorruptEncryptedClientHello {
			if c.config.Bugs.NullAllCiphers {
				hello.echOuter.payload = []byte{echBadPayloadByte}
			} else {
				hello.echOuter.payload[0] ^= 1
			}
		}
	}

	// PSK binders and ECH both must be computed last because they incorporate
	// the rest of the ClientHello and conflict. ECH resolves this by forbidding
	// clients from offering PSKs on ClientHelloOuter, but we still need to test
	// servers handle it correctly so they tolerate GREASE. In other cases, we
	// expect the server to reject ECH, so we put PSK last. Note this renders
	// ECH undecryptable.
	if len(hello.pskIdentities) > 0 {
		version := session.wireVersion
		// We may have a pre-1.3 session if SendBothTickets is set.
		if session.vers < VersionTLS13 {
			version = VersionTLS13
			if c.isDTLS {
				version = VersionDTLS13
			}
		}
		generatePSKBinders(version, c.isDTLS, hello, session, nil, nil, c.config)
	}

	if c.config.Bugs.SendClientHelloWithFixes != nil {
		hello, err = replaceClientHello(hello, c.config.Bugs.SendClientHelloWithFixes)
		if err != nil {
			return nil, err
		}
	}

	return hello, nil
}

// encryptClientHello encrypts |innerHello| using the specified HPKE context and
// adds the extension to |hello|.
func (hs *clientHandshakeState) encryptClientHello(hello, innerHello *clientHelloMsg, configID uint8, enc []byte) error {
	c := hs.c

	if c.config.Bugs.MinimalClientHelloOuter {
		*hello = clientHelloMsg{
			isDTLS:             c.isDTLS,
			vers:               VersionTLS12,
			random:             hello.random,
			sessionID:          hello.sessionID,
			cipherSuites:       []uint16{0x0a0a},
			compressionMethods: hello.compressionMethods,
		}
		if c.isDTLS {
			hello.vers = VersionDTLS12
		}
	}

	if c.config.Bugs.TruncateClientECHEnc {
		enc = enc[:1]
	}

	encodedInner := innerHello.marshalForEncodedInner()
	padding := make([]byte, c.config.Bugs.ClientECHPadding)
	if c.config.Bugs.BadClientECHPadding {
		padding[0] = 1
	}
	encodedInner = append(encodedInner, padding...)

	// Encode ClientHelloOuter with a placeholder payload string.
	payloadLength := len(encodedInner)
	if !c.config.Bugs.NullAllCiphers {
		payloadLength += hs.echHPKEContext.Overhead()
	}
	hello.echOuter = &echClientOuter{
		kdfID:    hs.echHPKEContext.KDF(),
		aeadID:   hs.echHPKEContext.AEAD(),
		configID: configID,
		enc:      enc,
		payload:  make([]byte, payloadLength),
	}
	aad := hello.marshal()[4:] // Remove message header

	hello.raw = nil
	hello.echOuter.payload = hs.echHPKEContext.Seal(encodedInner, aad)
	if c.config.Bugs.NullAllCiphers {
		hello.echOuter.payload = encodedInner
	}

	if c.config.Bugs.RecordClientHelloInner != nil {
		if err := c.config.Bugs.RecordClientHelloInner(encodedInner, hello.marshal()[4:]); err != nil {
			return err
		}
		// ECH is normally the last extension added to |hello|, but, when
		// OfferSessionInClientHelloOuter is enabled, we may modify it again.
		hello.raw = nil
	}

	return nil
}

func (hs *clientHandshakeState) checkECHConfirmation(msg any, hello *clientHelloMsg, finishedHash *finishedHash) bool {
	var offset int
	var raw, label []byte
	if hrr, ok := msg.(*helloRetryRequestMsg); ok {
		if hrr.echConfirmationOffset == 0 {
			return false
		}
		raw = hrr.raw
		label = echAcceptConfirmationHRRLabel
		offset = hrr.echConfirmationOffset
	} else {
		raw = msg.(*serverHelloMsg).raw
		label = echAcceptConfirmationLabel
		offset = 4 + 2 + 32 - echAcceptConfirmationLength
	}

	withZeros := slices.Clone(raw)
	clear(withZeros[offset : offset+echAcceptConfirmationLength])

	confirmation := finishedHash.echAcceptConfirmation(hello.random, label, withZeros)
	return bytes.Equal(confirmation, raw[offset:offset+echAcceptConfirmationLength])
}

func (hs *clientHandshakeState) doTLS13Handshake(msg any) error {
	c := hs.c

	// The first message may be a ServerHello or HelloRetryRequest.
	helloRetryRequest, haveHelloRetryRequest := msg.(*helloRetryRequestMsg)
	if haveHelloRetryRequest {
		hs.finishedHash.UpdateForHelloRetryRequest()
	}

	// Determine whether the server accepted ECH and drop the unnecessary
	// transcript.
	if hs.innerHello != nil {
		innerFinishedHash := newFinishedHash(c.wireVersion, c.isDTLS, hs.suite)
		innerFinishedHash.WriteHandshake(hs.innerHello.marshal(), hs.c.sendHandshakeSeq-1)
		if haveHelloRetryRequest {
			innerFinishedHash.UpdateForHelloRetryRequest()
		}
		if hs.checkECHConfirmation(msg, hs.innerHello, &innerFinishedHash) {
			c.echAccepted = true
			// Replace the transcript. For now, leave hs.hello and hs.innerHello
			// as-is. HelloRetryRequest requires both be available.
			hs.finishedHash = innerFinishedHash
		}
	} else {
		// When not offering ECH, test that the backend server does not (or does)
		// send a confirmation as expected.
		confirmed := hs.checkECHConfirmation(msg, hs.hello, &hs.finishedHash)
		if hs.hello.echInner && !confirmed {
			return fmt.Errorf("tls: server did not send ECH confirmation in %T when requested", msg)
		} else if !hs.hello.echInner && confirmed {
			return fmt.Errorf("tls: server sent ECH confirmation in %T when not requested", msg)
		}
	}

	// Once the PRF hash is known, TLS 1.3 does not require a handshake buffer.
	hs.finishedHash.discardHandshakeBuffer()

	// The first server message must be followed by a ChangeCipherSpec.
	c.expectTLS13ChangeCipherSpec = !c.isDTLS

	expectedSessionID := hs.hello.sessionID
	if c.isDTLS {
		expectedSessionID = nil
	}
	if haveHelloRetryRequest {
		hs.writeServerHash(helloRetryRequest.marshal())

		if !bytes.Equal(expectedSessionID, helloRetryRequest.sessionID) {
			return errors.New("tls: ClientHello and HelloRetryRequest session IDs did not match.")
		}

		if c.config.Bugs.FailIfHelloRetryRequested {
			return errors.New("tls: unexpected HelloRetryRequest")
		}
		// Explicitly read the ChangeCipherSpec now; it should
		// be attached to the first flight, not the second flight.
		if err := c.readTLS13ChangeCipherSpec(); err != nil {
			return err
		}

		// Reset the encryption state, in case we sent 0-RTT data.
		c.out.resetCipher()

		if c.echAccepted {
			if err := hs.applyHelloRetryRequest(helloRetryRequest, hs.innerHello, hs.hello); err != nil {
				return err
			}
			hs.writeClientHash(hs.innerHello.marshal())
		} else {
			if err := hs.applyHelloRetryRequest(helloRetryRequest, hs.hello, nil); err != nil {
				return err
			}
			hs.writeClientHash(hs.hello.marshal())
		}
		toWrite := hs.hello.marshal()

		if c.config.Bugs.PartialSecondClientHelloAfterFirst {
			// The first byte has already been sent.
			toWrite = toWrite[1:]
		}

		if c.config.Bugs.InterleaveEarlyData {
			c.sendFakeEarlyData(4)
			c.writeRecord(recordTypeHandshake, toWrite[:16])
			c.sendFakeEarlyData(4)
			c.writeRecord(recordTypeHandshake, toWrite[16:])
		} else if c.config.Bugs.PartialClientFinishedWithSecondClientHello {
			toWrite = append(make([]byte, 0, len(toWrite)+1), toWrite...)
			toWrite = append(toWrite, typeFinished)
			c.writeRecord(recordTypeHandshake, toWrite)
		} else {
			c.writeRecord(recordTypeHandshake, toWrite)
		}
		if err := c.flushHandshake(); err != nil {
			return err
		}

		if c.config.Bugs.SendEarlyDataOnSecondClientHello {
			c.sendFakeEarlyData(4)
		}

		var err error
		msg, err = c.readHandshake()
		if err != nil {
			return err
		}
	}

	// We no longer need to retain two ClientHellos.
	if c.echAccepted {
		hs.hello = hs.innerHello
	}
	hs.innerHello = nil

	var ok bool
	hs.serverHello, ok = msg.(*serverHelloMsg)
	if !ok {
		c.sendAlert(alertUnexpectedMessage)
		return unexpectedMessageError(hs.serverHello, msg)
	}

	if isAllZero(hs.serverHello.random) {
		// If the server forgets to fill in the server random, it will
		// likely be all zero.
		return errors.New("tls: ServerHello random was all zero")
	}

	if c.wireVersion != hs.serverHello.vers {
		c.sendAlert(alertIllegalParameter)
		return fmt.Errorf("tls: server sent non-matching version %x vs %x", c.wireVersion, hs.serverHello.vers)
	}

	if hs.suite.id != hs.serverHello.cipherSuite {
		c.sendAlert(alertIllegalParameter)
		return fmt.Errorf("tls: server sent non-matching cipher suite %04x vs %04x", hs.suite.id, hs.serverHello.cipherSuite)
	}

	// ServerHello must be consistent with HelloRetryRequest, if any.
	if haveHelloRetryRequest {
		if helloRetryRequest.hasSelectedGroup && (!hs.serverHello.hasKeyShare || helloRetryRequest.selectedGroup != hs.serverHello.keyShare.group) {
			c.sendAlert(alertHandshakeFailure)
			return errors.New("tls: ServerHello parameters did not match HelloRetryRequest")
		}

		// Both the ServerHello and HelloRetryRequest must have an ECH confirmation.
		echConfirmed := hs.checkECHConfirmation(hs.serverHello, hs.hello, &hs.finishedHash)
		if hs.hello.echInner && !echConfirmed {
			return errors.New("tls: server did not send ECH confirmation in ServerHello when requested")
		} else if !hs.hello.echInner && echConfirmed {
			return errors.New("tls: server sent ECH confirmation in ServerHello when not requested")
		}
	}

	if !bytes.Equal(expectedSessionID, hs.serverHello.sessionID) {
		return errors.New("tls: ClientHello and ServerHello session IDs did not match.")
	}

	// Resolve PSK and compute the early secret.
	zeroSecret := hs.finishedHash.zeroSecret()
	pskSecret := zeroSecret
	if hs.serverHello.hasPSKIdentity {
		// We send at most one PSK identity.
		if hs.session == nil || hs.serverHello.pskIdentity != 0 {
			c.sendAlert(alertUnknownPSKIdentity)
			return errors.New("tls: server sent unknown PSK identity")
		}
		if hs.session.cipherSuite.hash() != hs.suite.hash() {
			c.sendAlert(alertHandshakeFailure)
			return errors.New("tls: server resumed an invalid session for the cipher suite")
		}
		pskSecret = hs.session.secret
		c.didResume = true
	}
	hs.finishedHash.addEntropy(pskSecret)

	sharedSecret := zeroSecret
	if len(hs.serverHello.pakeMessage) != 0 {
		if c.didResume {
			return errors.New("server resumed and returned a PAKE extension")
		}
		if hs.pakeContext == nil {
			return errors.New("server selected a PAKE unexpectedly")
		}
		if hs.serverHello.pakeID != spakeID {
			return errors.New("server selected an unknown PAKE")
		}
		if expected := 65 + 32; len(hs.serverHello.pakeMessage) != expected {
			return fmt.Errorf("wrong length SPAKE2+ message, got %d, want %d", len(hs.serverHello.pakeMessage), expected)
		}
		if hs.serverHello.hasKeyShare || hs.serverHello.hasPSKIdentity {
			return errors.New("server included invalid extension with PAKE extension")
		}

		var err error
		if _, sharedSecret, err = hs.pakeContext.ComputeProverConfirmation(hs.serverHello.pakeMessage[:65], hs.serverHello.pakeMessage[65:]); err != nil {
			return fmt.Errorf("while computing SPAKE2+ confirmation: %w", err)
		}
	} else if hs.pakeContext != nil {
		return errors.New("server didn't respond with PAKE message")
	} else {
		if !hs.serverHello.hasKeyShare {
			c.sendAlert(alertUnsupportedExtension)
			return errors.New("tls: server omitted KeyShare on resumption.")
		}

		// Resolve ECDHE and compute the handshake secret.
		if !c.config.Bugs.MissingKeyShare && !c.config.Bugs.SecondClientHelloMissingKeyShare {
			kem, ok := hs.keyShares[hs.serverHello.keyShare.group]
			if !ok {
				c.sendAlert(alertHandshakeFailure)
				return errors.New("tls: server selected an unsupported group")
			}
			c.curveID = hs.serverHello.keyShare.group

			var err error
			sharedSecret, err = kem.decap(c.config, hs.serverHello.keyShare.keyExchange)
			if err != nil {
				return err
			}
		}
	}

	hs.finishedHash.nextSecret()
	hs.finishedHash.addEntropy(sharedSecret)
	hs.writeServerHash(hs.serverHello.marshal())

	// Derive handshake traffic keys and switch read key to handshake
	// traffic key.
	clientHandshakeTrafficSecret := hs.finishedHash.deriveSecret(clientHandshakeTrafficLabel)
	serverHandshakeTrafficSecret := hs.finishedHash.deriveSecret(serverHandshakeTrafficLabel)
	if err := c.useInTrafficSecret(uint16(encryptionHandshake), c.wireVersion, hs.suite, serverHandshakeTrafficSecret); err != nil {
		return err
	}

	encryptedExtensions, err := readHandshakeType[encryptedExtensionsMsg](c)
	if err != nil {
		return err
	}
	hs.writeServerHash(encryptedExtensions.marshal())

	if !bytes.Equal(encryptedExtensions.extensions.echRetryConfigs, c.config.Bugs.ExpectECHRetryConfigs) {
		return errors.New("tls: server sent ECH retry_configs with unexpected contents")
	}

	err = hs.processServerExtensions(&encryptedExtensions.extensions)
	if err != nil {
		return err
	}

	var credential *Credential
	var certReq *certificateRequestMsg
	if c.didResume {
		// Copy over authentication from the session.
		c.peerCertificates = hs.session.serverCertificates
		c.sctList = hs.session.sctList
		c.ocspResponse = hs.session.ocspResponse
	} else if hs.pakeContext != nil {
		// The PAKE authenticates the connection.
	} else {
		msg, err := c.readHandshake()
		if err != nil {
			return err
		}

		var ok bool
		certReq, ok = msg.(*certificateRequestMsg)
		if ok {
			if len(certReq.requestContext) != 0 {
				return errors.New("tls: non-empty certificate request context sent in handshake")
			}

			hs.writeServerHash(certReq.marshal())

			credential = c.config.Credential
			if credential != nil && c.config.Bugs.IgnorePeerSignatureAlgorithmPreferences {
				certReq.signatureAlgorithms = credential.signatureAlgorithms()
			}

			msg, err = c.readHandshake()
			if err != nil {
				return err
			}
		}

		var certMsg *certificateMsg

		if compressedCertMsg, ok := msg.(*compressedCertificateMsg); ok {
			hs.writeServerHash(compressedCertMsg.marshal())

			alg, ok := c.config.CertCompressionAlgs[compressedCertMsg.algID]
			if !ok {
				c.sendAlert(alertBadCertificate)
				return fmt.Errorf("tls: received certificate compressed with unknown algorithm %x", compressedCertMsg.algID)
			}

			decompressed := make([]byte, 4+int(compressedCertMsg.uncompressedLength))
			if !alg.Decompress(decompressed[4:], compressedCertMsg.compressed) {
				c.sendAlert(alertBadCertificate)
				return fmt.Errorf("tls: failed to decompress certificate with algorithm %x", compressedCertMsg.algID)
			}

			certMsg = &certificateMsg{
				hasRequestContext: true,
			}

			if !certMsg.unmarshal(decompressed) {
				c.sendAlert(alertBadCertificate)
				return errors.New("tls: failed to parse decompressed certificate")
			}

			if expected := c.config.Bugs.ExpectedCompressedCert; expected != 0 && expected != compressedCertMsg.algID {
				return fmt.Errorf("tls: expected certificate compressed with algorithm %x, but message used %x", expected, compressedCertMsg.algID)
			}

			if c.config.Bugs.ExpectUncompressedCert {
				return errors.New("tls: compressed certificate received")
			}
		} else {
			if certMsg, ok = msg.(*certificateMsg); !ok {
				c.sendAlert(alertUnexpectedMessage)
				return unexpectedMessageError(certMsg, msg)
			}
			hs.writeServerHash(certMsg.marshal())

			if c.config.Bugs.ExpectedCompressedCert != 0 {
				return errors.New("tls: uncompressed certificate received")
			}
		}

		// Check for unsolicited extensions.
		for i, cert := range certMsg.certificates {
			if c.config.Bugs.NoOCSPStapling && cert.ocspResponse != nil {
				c.sendAlert(alertUnsupportedExtension)
				return errors.New("tls: unexpected OCSP response in the server certificate")
			}
			if c.config.Bugs.NoSignedCertificateTimestamps && cert.sctList != nil {
				c.sendAlert(alertUnsupportedExtension)
				return errors.New("tls: unexpected SCT list in the server certificate")
			}
			if i > 0 && c.config.Bugs.ExpectNoExtensionsOnIntermediate && (cert.ocspResponse != nil || cert.sctList != nil) {
				c.sendAlert(alertUnsupportedExtension)
				return errors.New("tls: unexpected extensions in the server certificate")
			}
		}
		if c.config.RequestTrustAnchors == nil && certMsg.matchedTrustAnchor {
			return errors.New("tls: unsolicited trust_anchors extension in the server certificate")
		}
		if expected := c.config.Bugs.ExpectPeerMatchTrustAnchor; expected != nil && certMsg.matchedTrustAnchor != *expected {
			if certMsg.matchedTrustAnchor {
				return errors.New("tls: server certificate unexpectedly matched trust anchor")
			}
			return errors.New("tls: server certificate unexpectedly did not match trust anchor")
		}

		if err := hs.verifyCertificates(certMsg); err != nil {
			return err
		}
		c.ocspResponse = certMsg.certificates[0].ocspResponse
		c.sctList = certMsg.certificates[0].sctList

		certVerifyMsg, err := readHandshakeType[certificateVerifyMsg](c)
		if err != nil {
			return err
		}

		c.peerSignatureAlgorithm = certVerifyMsg.signatureAlgorithm
		input := hs.finishedHash.certificateVerifyInput(serverCertificateVerifyContextTLS13)
		if c.peerDelegatedCredential != nil {
			err = verifyMessageDC(c.isClient, c.vers, hs.peerPublicKey, c.config, certVerifyMsg.signatureAlgorithm, input, certVerifyMsg.signature)
		} else {
			err = verifyMessage(c.isClient, c.vers, hs.peerPublicKey, c.config, certVerifyMsg.signatureAlgorithm, input, certVerifyMsg.signature)
		}
		if err != nil {
			return err
		}

		hs.writeServerHash(certVerifyMsg.marshal())
	}

	serverFinished, err := readHandshakeType[finishedMsg](c)
	if err != nil {
		return err
	}
	verify := hs.finishedHash.serverSum(serverHandshakeTrafficSecret)
	if len(verify) != len(serverFinished.verifyData) ||
		subtle.ConstantTimeCompare(verify, serverFinished.verifyData) != 1 {
		c.sendAlert(alertHandshakeFailure)
		return errors.New("tls: server's Finished message was incorrect")
	}

	hs.writeServerHash(serverFinished.marshal())

	// The various secrets do not incorporate the client's final leg, so
	// derive them now before updating the handshake context.
	hs.finishedHash.nextSecret()
	hs.finishedHash.addEntropy(zeroSecret)

	clientTrafficSecret := hs.finishedHash.deriveSecret(clientApplicationTrafficLabel)
	serverTrafficSecret := hs.finishedHash.deriveSecret(serverApplicationTrafficLabel)
	c.exporterSecret = hs.finishedHash.deriveSecret(exporterLabel)

	// Switch to application data keys on read. In particular, any alerts
	// from the client certificate are read over these keys.
	if err := c.useInTrafficSecret(uint16(encryptionApplication), c.wireVersion, hs.suite, serverTrafficSecret); err != nil {
		return err
	}

	// If we're expecting 0.5-RTT messages from the server, read them now.
	var deferredTickets []*newSessionTicketMsg
	if encryptedExtensions.extensions.hasEarlyData {
		// BoringSSL will always send two tickets half-RTT when
		// negotiating 0-RTT.
		for i := 0; i < shimConfig.HalfRTTTickets; i++ {
			newSessionTicket, err := readHandshakeType[newSessionTicketMsg](c)
			if err != nil {
				return fmt.Errorf("tls: error reading half-RTT ticket: %s", err)
			}
			// Defer processing until the resumption secret is computed.
			deferredTickets = append(deferredTickets, newSessionTicket)
		}
		for _, expectedMsg := range c.config.Bugs.ExpectHalfRTTData {
			if err := c.readRecord(recordTypeApplicationData); err != nil {
				return err
			}
			if !bytes.Equal(c.input.Bytes(), expectedMsg) {
				return fmt.Errorf("tls: got half-RTT data record %x, wanted %x", c.input.Bytes(), expectedMsg)
			}
			c.input.Reset()
		}
	}

	// Send EndOfEarlyData and then switch write key to handshake
	// traffic key.
	if encryptedExtensions.extensions.hasEarlyData && !c.config.Bugs.SkipEndOfEarlyData && c.usesEndOfEarlyData() {
		if c.config.Bugs.SendStrayEarlyHandshake {
			helloRequest := new(helloRequestMsg)
			c.writeRecord(recordTypeHandshake, helloRequest.marshal())
		}
		endOfEarlyData := new(endOfEarlyDataMsg)
		endOfEarlyData.nonEmpty = c.config.Bugs.NonEmptyEndOfEarlyData
		hs.writeClientHash(endOfEarlyData.marshal())
		if c.config.Bugs.PartialEndOfEarlyDataWithClientHello {
			// The first byte has already been sent.
			c.writeRecord(recordTypeHandshake, endOfEarlyData.marshal()[1:])
		} else {
			c.writeRecord(recordTypeHandshake, endOfEarlyData.marshal())
		}
	}

	if !c.config.Bugs.SkipChangeCipherSpec && !hs.hello.hasEarlyData && !c.isDTLS {
		c.writeRecord(recordTypeChangeCipherSpec, []byte{1})
	}

	for i := 0; i < c.config.Bugs.SendExtraChangeCipherSpec; i++ {
		c.writeRecord(recordTypeChangeCipherSpec, []byte{1})
	}

	c.useOutTrafficSecret(uint16(encryptionHandshake), c.wireVersion, hs.suite, clientHandshakeTrafficSecret)

	// The client EncryptedExtensions message is sent if some extension uses it.
	// (Currently only ALPS does.)
	hasEncryptedExtensions := c.config.Bugs.AlwaysSendClientEncryptedExtensions
	clientEncryptedExtensions := new(clientEncryptedExtensionsMsg)
	if encryptedExtensions.extensions.hasApplicationSettings || (c.config.Bugs.SendApplicationSettingsWithEarlyData && c.hasApplicationSettings) {
		hasEncryptedExtensions = true
		if !c.config.Bugs.OmitClientApplicationSettings {
			clientEncryptedExtensions.hasApplicationSettings = true
			clientEncryptedExtensions.applicationSettings = c.localApplicationSettings
		}
	}
	if encryptedExtensions.extensions.hasApplicationSettingsOld || (c.config.Bugs.SendApplicationSettingsWithEarlyData && c.hasApplicationSettingsOld) {
		hasEncryptedExtensions = true
		if !c.config.Bugs.OmitClientApplicationSettings {
			clientEncryptedExtensions.hasApplicationSettingsOld = true
			clientEncryptedExtensions.applicationSettingsOld = c.localApplicationSettingsOld
		}
	}
	if c.config.Bugs.SendExtraClientEncryptedExtension {
		hasEncryptedExtensions = true
		clientEncryptedExtensions.customExtension = []byte{0}
	}
	if hasEncryptedExtensions && !c.config.Bugs.OmitClientEncryptedExtensions {
		hs.writeClientHash(clientEncryptedExtensions.marshal())
		c.writeRecord(recordTypeHandshake, clientEncryptedExtensions.marshal())
	}

	if certReq != nil && !c.config.Bugs.SkipClientCertificate {
		certMsg := &certificateMsg{
			hasRequestContext: true,
			requestContext:    certReq.requestContext,
		}
		if credential != nil {
			for _, certData := range credential.Certificate {
				certMsg.certificates = append(certMsg.certificates, certificateEntry{
					data:           certData,
					extraExtension: c.config.Bugs.SendExtensionOnCertificate,
				})
			}
		}
		hs.writeClientHash(certMsg.marshal())
		c.writeRecord(recordTypeHandshake, certMsg.marshal())

		if credential != nil {
			certVerify := &certificateVerifyMsg{
				hasSignatureAlgorithm: true,
			}

			// Determine the hash to sign.
			var err error
			certVerify.signatureAlgorithm, err = selectSignatureAlgorithm(c.isClient, c.vers, credential, c.config, certReq.signatureAlgorithms)
			if err != nil {
				c.sendAlert(alertInternalError)
				return err
			}

			privKey := credential.PrivateKey
			input := hs.finishedHash.certificateVerifyInput(clientCertificateVerifyContextTLS13)
			certVerify.signature, err = signMessage(c.isClient, c.vers, privKey, c.config, certVerify.signatureAlgorithm, input)
			if err != nil {
				c.sendAlert(alertInternalError)
				return err
			}
			if c.config.Bugs.SendSignatureAlgorithm != 0 {
				certVerify.signatureAlgorithm = c.config.Bugs.SendSignatureAlgorithm
			}

			if !c.config.Bugs.SkipCertificateVerify {
				hs.writeClientHash(certVerify.marshal())
				c.writeRecord(recordTypeHandshake, certVerify.marshal())
			}
		}
	}

	if encryptedExtensions.extensions.channelIDRequested {
		channelIDHash := crypto.SHA256.New()
		channelIDHash.Write(hs.finishedHash.certificateVerifyInput(channelIDContextTLS13))
		channelIDMsgBytes, err := hs.writeChannelIDMessage(channelIDHash.Sum(nil))
		if err != nil {
			return err
		}
		hs.writeClientHash(channelIDMsgBytes)
		c.writeRecord(recordTypeHandshake, channelIDMsgBytes)
	}

	// Send a client Finished message.
	finished := new(finishedMsg)
	finished.verifyData = hs.finishedHash.clientSum(clientHandshakeTrafficSecret)
	if c.config.Bugs.BadFinished {
		finished.verifyData[0]++
	}
	hs.writeClientHash(finished.marshal())
	if c.config.Bugs.PartialClientFinishedWithClientHello {
		// The first byte has already been sent.
		c.writeRecord(recordTypeHandshake, finished.marshal()[1:])
	} else if c.config.Bugs.InterleaveEarlyData {
		finishedBytes := finished.marshal()
		c.sendFakeEarlyData(4)
		c.writeRecord(recordTypeHandshake, finishedBytes[:1])
		c.sendFakeEarlyData(4)
		c.writeRecord(recordTypeHandshake, finishedBytes[1:])
	} else {
		c.writeRecord(recordTypeHandshake, finished.marshal())
	}
	if c.config.Bugs.SendExtraFinished {
		c.writeRecord(recordTypeHandshake, finished.marshal())
	}

	if data := c.config.Bugs.AppDataBeforeTLS13KeyChange; data != nil {
		c.writeRecord(recordTypeApplicationData, data)
	}

	// Switch to application data keys.
	c.useOutTrafficSecret(uint16(encryptionApplication), c.wireVersion, hs.suite, clientTrafficSecret)
	c.resumptionSecret = hs.finishedHash.deriveSecret(resumptionLabel)

	if err := c.flushHandshake(); err != nil {
		return err
	}
	if c.isDTLS && len(c.expectedACK) != 0 && !c.config.Bugs.SkipImplicitACKRead {
		if err := c.readRecord(recordTypeACK); err != nil {
			return err
		}
	}

	for _, ticket := range deferredTickets {
		if err := c.processTLS13NewSessionTicket(ticket, hs.suite); err != nil {
			return err
		}
	}

	return nil
}

// applyHelloRetryRequest updates |hello| in-place based on |helloRetryRequest|.
// If |outerHello| is not nil, |outerHello| will be updated to contain an
// encrypted copy of |hello|.
func (hs *clientHandshakeState) applyHelloRetryRequest(helloRetryRequest *helloRetryRequestMsg, hello, outerHello *clientHelloMsg) error {
	c := hs.c
	firstHelloBytes := hello.marshal()
	if len(helloRetryRequest.cookie) > 0 {
		hello.tls13Cookie = helloRetryRequest.cookie
	}

	if c.config.Bugs.MisinterpretHelloRetryRequestCurve != 0 {
		helloRetryRequest.hasSelectedGroup = true
		helloRetryRequest.selectedGroup = c.config.Bugs.MisinterpretHelloRetryRequestCurve
	}
	if helloRetryRequest.hasSelectedGroup {
		group := helloRetryRequest.selectedGroup
		if !slices.Contains(hello.supportedCurves, group) || hs.keyShares[group] != nil {
			c.sendAlert(alertHandshakeFailure)
			return errors.New("tls: received invalid HelloRetryRequest")
		}
		kem, ok := kemForCurveID(group, c.config)
		if !ok {
			return errors.New("tls: Unable to get curve requested in HelloRetryRequest")
		}
		publicKey, err := kem.generate(c.config)
		if err != nil {
			return err
		}
		hs.keyShares[group] = kem
		hello.keyShares = []keyShareEntry{{
			group:       group,
			keyExchange: publicKey,
		}}
	}

	if c.config.Bugs.SecondClientHelloMissingKeyShare {
		hello.hasKeyShares = false
	}

	if c.config.Bugs.OmitSecondECHInner {
		hello.echInner = false
	}

	hello.hasEarlyData = c.config.Bugs.SendEarlyDataOnSecondClientHello
	// The first ClientHello may have skipped this due to OnlyCorruptSecondPSKBinder.
	if c.config.Bugs.PSKBinderFirst && c.config.Bugs.OnlyCorruptSecondPSKBinder {
		hello.prefixExtensions = append(hello.prefixExtensions, extensionPreSharedKey)
	}
	// The first ClientHello may have set this due to OnlyCompressSecondClientHelloInner.
	hello.reorderOuterExtensionsWithoutCompressing = false
	if c.config.Bugs.OmitPSKsOnSecondClientHello {
		hello.pskIdentities = nil
		hello.pskBinders = nil
	}
	hello.raw = nil

	if len(hello.pskIdentities) > 0 {
		generatePSKBinders(c.wireVersion, c.isDTLS, hello, hs.session, firstHelloBytes, helloRetryRequest.marshal(), c.config)
	}

	if outerHello != nil {
		outerHello.raw = nil
		// We know the server has accepted ECH, so the ClientHelloOuter's fields
		// are irrelevant. In the general case, the HelloRetryRequest may not
		// even be valid for ClientHelloOuter. However, we copy the key shares
		// from ClientHelloInner so they remain eligible for compression.
		if !c.config.Bugs.MinimalClientHelloOuter {
			outerHello.keyShares = hello.keyShares
		}

		if c.config.Bugs.OmitSecondEncryptedClientHello {
			outerHello.echOuter = nil
		} else {
			configID := c.config.ClientECHConfig.ConfigID
			if c.config.Bugs.CorruptSecondEncryptedClientHelloConfigID {
				configID ^= 1
			}
			if err := hs.encryptClientHello(outerHello, hello, configID, nil); err != nil {
				return err
			}
			if c.config.Bugs.CorruptSecondEncryptedClientHello {
				if c.config.Bugs.NullAllCiphers {
					outerHello.echOuter.payload = []byte{echBadPayloadByte}
				} else {
					outerHello.echOuter.payload[0] ^= 1
				}
			}
		}
	}

	return nil
}

func (hs *clientHandshakeState) doFullHandshake() error {
	c := hs.c

	var leaf *x509.Certificate
	if hs.suite.flags&suitePSK == 0 {
		certMsg, err := readHandshakeType[certificateMsg](c)
		if err != nil {
			return err
		}
		hs.writeServerHash(certMsg.marshal())

		if err := hs.verifyCertificates(certMsg); err != nil {
			return err
		}
		leaf = c.peerCertificates[0]
	}

	if hs.serverHello.extensions.ocspStapling {
		cs, err := readHandshakeType[certificateStatusMsg](c)
		if err != nil {
			return err
		}
		hs.writeServerHash(cs.marshal())

		if cs.statusType == statusTypeOCSP {
			c.ocspResponse = cs.response
		}
	}

	msg, err := c.readHandshake()
	if err != nil {
		return err
	}

	keyAgreement := hs.suite.ka(c.vers)

	skx, ok := msg.(*serverKeyExchangeMsg)
	if ok {
		hs.writeServerHash(skx.marshal())
		err = keyAgreement.processServerKeyExchange(c.config, hs.hello, hs.serverHello, hs.peerPublicKey, skx)
		if err != nil {
			c.sendAlert(alertUnexpectedMessage)
			return err
		}
		if ecdhe, ok := keyAgreement.(*ecdheKeyAgreement); ok {
			c.curveID = ecdhe.curveID
		}

		c.peerSignatureAlgorithm = keyAgreement.peerSignatureAlgorithm()

		msg, err = c.readHandshake()
		if err != nil {
			return err
		}
	}

	var credential *Credential
	var certRequested bool
	certReq, ok := msg.(*certificateRequestMsg)
	if ok {
		certRequested = true
		hs.writeServerHash(certReq.marshal())

		credential = c.config.Credential
		if credential != nil && c.config.Bugs.IgnorePeerSignatureAlgorithmPreferences {
			certReq.signatureAlgorithms = credential.signatureAlgorithms()
		}

		msg, err = c.readHandshake()
		if err != nil {
			return err
		}
	}

	shd, ok := msg.(*serverHelloDoneMsg)
	if !ok {
		c.sendAlert(alertUnexpectedMessage)
		return unexpectedMessageError(shd, msg)
	}
	hs.writeServerHash(shd.marshal())

	// If the server requested a certificate then we have to send a
	// Certificate message in TLS, even if it's empty because we don't have
	// a certificate to send.
	if certRequested && !c.config.Bugs.SkipClientCertificate {
		certMsg := new(certificateMsg)
		if credential != nil {
			for _, certData := range credential.Certificate {
				certMsg.certificates = append(certMsg.certificates, certificateEntry{
					data: certData,
				})
			}
		}
		hs.writeClientHash(certMsg.marshal())
		c.writeRecord(recordTypeHandshake, certMsg.marshal())
	}

	preMasterSecret, ckx, err := keyAgreement.generateClientKeyExchange(c.config, hs.hello, leaf)
	if err != nil {
		c.sendAlert(alertInternalError)
		return err
	}
	if ckx != nil {
		if c.config.Bugs.EarlyChangeCipherSpec < 2 {
			hs.writeClientHash(ckx.marshal())
		}
		if c.config.Bugs.PartialClientKeyExchangeWithClientHello {
			// The first byte was already written.
			c.writeRecord(recordTypeHandshake, ckx.marshal()[1:])
		} else {
			c.writeRecord(recordTypeHandshake, ckx.marshal())
		}
	}

	if hs.serverHello.extensions.extendedMasterSecret {
		hs.masterSecret = extendedMasterFromPreMasterSecret(c.vers, hs.suite, preMasterSecret, hs.finishedHash)
		c.extendedMasterSecret = true
	} else {
		if c.config.Bugs.RequireExtendedMasterSecret {
			return errors.New("tls: extended master secret required but not supported by peer")
		}
		hs.masterSecret = masterFromPreMasterSecret(c.vers, hs.suite, preMasterSecret, hs.hello.random, hs.serverHello.random)
	}

	if credential != nil {
		certVerify := &certificateVerifyMsg{
			hasSignatureAlgorithm: c.vers >= VersionTLS12,
		}

		// Determine the hash to sign.
		if certVerify.hasSignatureAlgorithm {
			certVerify.signatureAlgorithm, err = selectSignatureAlgorithm(c.isClient, c.vers, credential, c.config, certReq.signatureAlgorithms)
			if err != nil {
				c.sendAlert(alertInternalError)
				return err
			}
		}

		privKey := c.config.Credential.PrivateKey
		certVerify.signature, err = signMessage(c.isClient, c.vers, privKey, c.config, certVerify.signatureAlgorithm, hs.finishedHash.buffer)
		if err == nil && c.config.Bugs.SendSignatureAlgorithm != 0 {
			certVerify.signatureAlgorithm = c.config.Bugs.SendSignatureAlgorithm
		}
		if err != nil {
			c.sendAlert(alertInternalError)
			return errors.New("tls: failed to sign handshake with client certificate: " + err.Error())
		}

		if !c.config.Bugs.SkipCertificateVerify {
			hs.writeClientHash(certVerify.marshal())
			c.writeRecord(recordTypeHandshake, certVerify.marshal())
		}
	}
	// flushHandshake will be called in sendFinished.

	hs.finishedHash.discardHandshakeBuffer()

	return nil
}

// delegatedCredentialSignedMessage returns the bytes that are signed in order
// to authenticate a delegated credential.
func delegatedCredentialSignedMessage(credBytes []byte, algorithm signatureAlgorithm, leafDER []byte) []byte {
	// https://www.rfc-editor.org/rfc/rfc9345.html#section-4
	ret := make([]byte, 64, 128)
	for i := range ret {
		ret[i] = 0x20
	}

	ret = append(ret, []byte("TLS, server delegated credentials\x00")...)
	ret = append(ret, leafDER...)
	ret = append(ret, byte(algorithm>>8), byte(algorithm))
	ret = append(ret, credBytes...)

	return ret
}

func (hs *clientHandshakeState) verifyCertificates(certMsg *certificateMsg) error {
	c := hs.c

	if len(certMsg.certificates) == 0 {
		c.sendAlert(alertIllegalParameter)
		return errors.New("tls: no certificates sent")
	}

	var dc *delegatedCredential
	certs := make([]*x509.Certificate, len(certMsg.certificates))
	for i, certEntry := range certMsg.certificates {
		cert, err := x509.ParseCertificate(certEntry.data)
		if err != nil {
			c.sendAlert(alertBadCertificate)
			return errors.New("tls: failed to parse certificate from server: " + err.Error())
		}
		certs[i] = cert

		if certEntry.delegatedCredential != nil {
			if i != 0 {
				c.sendAlert(alertIllegalParameter)
				return errors.New("tls: non-leaf certificate has a delegated credential")
			}
			if len(c.config.DelegatedCredentialAlgorithms) == 0 {
				c.sendAlert(alertIllegalParameter)
				return errors.New("tls: server sent delegated credential without it being requested")
			}
			dc = certEntry.delegatedCredential
		}
	}

	if !c.config.InsecureSkipVerify {
		opts := x509.VerifyOptions{
			Roots:         c.config.RootCAs,
			CurrentTime:   c.config.time(),
			DNSName:       c.config.ServerName,
			Intermediates: x509.NewCertPool(),
		}

		for i, cert := range certs {
			if i == 0 {
				continue
			}
			opts.Intermediates.AddCert(cert)
		}
		var err error
		c.verifiedChains, err = certs[0].Verify(opts)
		if err != nil {
			c.sendAlert(alertBadCertificate)
			return err
		}
	}

	leafPublicKey := certs[0].PublicKey
	switch leafPublicKey.(type) {
	case *rsa.PublicKey, *ecdsa.PublicKey, ed25519.PublicKey:
		break
	default:
		c.sendAlert(alertUnsupportedCertificate)
		return fmt.Errorf("tls: server's certificate contains an unsupported type of public key: %T", leafPublicKey)
	}

	c.peerCertificates = certs

	if dc != nil {
		// Note that this doesn't check a) the delegated credential temporal
		// validity nor b) that the certificate has the special OID asserted.
		var err error
		if hs.peerPublicKey, err = x509.ParsePKIXPublicKey(dc.pkixPublicKey); err != nil {
			c.sendAlert(alertBadCertificate)
			return errors.New("tls: failed to parse public key from delegated credential: " + err.Error())
		}

		signedMsg := delegatedCredentialSignedMessage(dc.signedBytes, dc.algorithm, certs[0].Raw)
		if err := verifyMessage(c.isClient, c.vers, leafPublicKey, c.config, dc.algorithm, signedMsg, dc.signature); err != nil {
			c.sendAlert(alertBadCertificate)
			return errors.New("tls: failed to verify delegated credential: " + err.Error())
		}
		c.peerDelegatedCredential = dc.raw
	} else {
		hs.peerPublicKey = leafPublicKey
	}

	return nil
}

func (hs *clientHandshakeState) establishKeys() error {
	c := hs.c

	clientMAC, serverMAC, clientKey, serverKey, clientIV, serverIV := keysFromMasterSecret(c.vers, hs.suite, hs.masterSecret, hs.hello.random, hs.serverHello.random, hs.suite.macLen, hs.suite.keyLen, hs.suite.ivLen(c.vers))
	var clientCipher, serverCipher any
	var clientHash, serverHash macFunction
	if hs.suite.cipher != nil {
		clientCipher = hs.suite.cipher(clientKey, clientIV, false /* not for reading */)
		clientHash = hs.suite.mac(c.vers, clientMAC)
		serverCipher = hs.suite.cipher(serverKey, serverIV, true /* for reading */)
		serverHash = hs.suite.mac(c.vers, serverMAC)
	} else {
		clientCipher = hs.suite.aead(c.vers, clientKey, clientIV)
		serverCipher = hs.suite.aead(c.vers, serverKey, serverIV)
	}

	c.in.prepareCipherSpec(c.wireVersion, serverCipher, serverHash)
	c.out.prepareCipherSpec(c.wireVersion, clientCipher, clientHash)
	return nil
}

func (hs *clientHandshakeState) processServerExtensions(serverExtensions *serverExtensions) error {
	c := hs.c

	if c.vers < VersionTLS13 {
		if c.config.Bugs.RequireRenegotiationInfo && serverExtensions.secureRenegotiation == nil {
			return errors.New("tls: renegotiation extension missing")
		}

		if len(c.clientVerify) > 0 && !c.noRenegotiationInfo() {
			var expectedRenegInfo []byte
			expectedRenegInfo = append(expectedRenegInfo, c.clientVerify...)
			expectedRenegInfo = append(expectedRenegInfo, c.serverVerify...)
			if !bytes.Equal(serverExtensions.secureRenegotiation, expectedRenegInfo) {
				c.sendAlert(alertHandshakeFailure)
				return fmt.Errorf("tls: renegotiation mismatch")
			}
		}
	} else if serverExtensions.secureRenegotiation != nil {
		return errors.New("tls: renegotiation info sent in TLS 1.3")
	}

	if expected := c.config.Bugs.ExpectedCustomExtension; expected != nil {
		if serverExtensions.customExtension != *expected {
			return fmt.Errorf("tls: bad custom extension contents %q", serverExtensions.customExtension)
		}
	}

	clientDidNPN := hs.hello.nextProtoNeg
	clientDidALPN := len(hs.hello.alpnProtocols) > 0
	serverHasNPN := serverExtensions.nextProtoNeg
	serverHasALPN := len(serverExtensions.alpnProtocol) > 0

	if !clientDidNPN && serverHasNPN {
		c.sendAlert(alertHandshakeFailure)
		return errors.New("server advertised unrequested NPN extension")
	}

	if !clientDidALPN && serverHasALPN {
		c.sendAlert(alertHandshakeFailure)
		return errors.New("server advertised unrequested ALPN extension")
	}

	if serverHasNPN && serverHasALPN {
		c.sendAlert(alertHandshakeFailure)
		return errors.New("server advertised both NPN and ALPN extensions")
	}

	if serverHasALPN {
		c.clientProtocol = serverExtensions.alpnProtocol
		c.clientProtocolFallback = false
		c.usedALPN = true
	}

	if serverHasNPN && c.vers >= VersionTLS13 {
		c.sendAlert(alertHandshakeFailure)
		return errors.New("server advertised NPN over TLS 1.3")
	}

	if !hs.hello.channelIDSupported && serverExtensions.channelIDRequested {
		c.sendAlert(alertHandshakeFailure)
		return errors.New("server advertised unrequested Channel ID extension")
	}

	if serverExtensions.extendedMasterSecret && c.vers >= VersionTLS13 {
		return errors.New("tls: server advertised extended master secret over TLS 1.3")
	}

	if serverExtensions.ticketSupported && c.vers >= VersionTLS13 {
		return errors.New("tls: server advertised ticket extension over TLS 1.3")
	}

	if serverExtensions.ocspStapling && c.vers >= VersionTLS13 {
		return errors.New("tls: server advertised OCSP in ServerHello over TLS 1.3")
	}

	if serverExtensions.ocspStapling && c.config.Bugs.NoOCSPStapling {
		return errors.New("tls: server advertised unrequested OCSP extension")
	}

	if len(serverExtensions.sctList) > 0 && c.vers >= VersionTLS13 {
		return errors.New("tls: server advertised SCTs in ServerHello over TLS 1.3")
	}

	if len(serverExtensions.sctList) > 0 && c.config.Bugs.NoSignedCertificateTimestamps {
		return errors.New("tls: server advertised unrequested SCTs")
	}

	if len(serverExtensions.trustAnchors) > 0 && c.config.RequestTrustAnchors == nil {
		return errors.New("tls: server advertised unrequested trust anchor IDs")
	}
	if expected := c.config.Bugs.ExpectPeerAvailableTrustAnchors; expected != nil && !slices.EqualFunc(expected, serverExtensions.trustAnchors, slices.Equal) {
		return errors.New("tls: server advertised trust anchor IDs that did not match expectations")
	}

	if serverExtensions.serverNameAck {
		if len(hs.hello.serverName) == 0 {
			return errors.New("tls: server acknowledged server_name, but client did not send it")
		}
		if c.didResume {
			return errors.New("tls: server acknowledged server_name when resuming")
		}
		c.serverNameAck = serverExtensions.serverNameAck
	}

	if serverExtensions.srtpProtectionProfile != 0 {
		if serverExtensions.srtpMasterKeyIdentifier != "" {
			return errors.New("tls: server selected SRTP MKI value")
		}

		found := false
		for _, p := range c.config.SRTPProtectionProfiles {
			if p == serverExtensions.srtpProtectionProfile {
				found = true
				break
			}
		}
		if !found {
			return errors.New("tls: server advertised unsupported SRTP profile")
		}

		c.srtpProtectionProfile = serverExtensions.srtpProtectionProfile
	}

	if c.vers >= VersionTLS13 && c.didResume {
		if c.config.Bugs.ExpectEarlyDataAccepted && !serverExtensions.hasEarlyData {
			c.sendAlert(alertHandshakeFailure)
			return errors.New("tls: server did not accept early data when expected")
		}

		if !c.config.Bugs.ExpectEarlyDataAccepted && serverExtensions.hasEarlyData {
			c.sendAlert(alertHandshakeFailure)
			return errors.New("tls: server accepted early data when not expected")
		}
	} else if serverExtensions.hasEarlyData {
		return errors.New("tls: server accepted early data when not resuming")
	}

	if len(serverExtensions.quicTransportParams) > 0 {
		if c.vers < VersionTLS13 {
			c.sendAlert(alertHandshakeFailure)
			return errors.New("tls: server sent QUIC transport params for TLS version less than 1.3")
		}
		c.quicTransportParams = serverExtensions.quicTransportParams
	}

	if len(serverExtensions.quicTransportParamsLegacy) > 0 {
		if c.vers < VersionTLS13 {
			c.sendAlert(alertHandshakeFailure)
			return errors.New("tls: server sent QUIC transport params for TLS version less than 1.3")
		}
		c.quicTransportParamsLegacy = serverExtensions.quicTransportParamsLegacy
	}

	if serverExtensions.hasApplicationSettings && serverExtensions.hasApplicationSettingsOld {
		return errors.New("tls: server negotiated both old and new application settings together")
	}

	if serverExtensions.hasApplicationSettings || serverExtensions.hasApplicationSettingsOld {
		if c.vers < VersionTLS13 {
			return errors.New("tls: server sent application settings at invalid version")
		}
		if serverExtensions.hasEarlyData {
			return errors.New("tls: server sent application settings with 0-RTT")
		}
		if !serverHasALPN {
			return errors.New("tls: server sent application settings without ALPN")
		}
		settings, ok := c.config.ApplicationSettings[serverExtensions.alpnProtocol]
		if !ok {
			return errors.New("tls: server sent application settings for invalid protocol")
		}

		if serverExtensions.hasApplicationSettings {
			c.hasApplicationSettings = true
			c.localApplicationSettings = settings
			c.peerApplicationSettings = serverExtensions.applicationSettings
		}

		if serverExtensions.hasApplicationSettingsOld {
			c.hasApplicationSettingsOld = true
			c.localApplicationSettingsOld = settings
			c.peerApplicationSettingsOld = serverExtensions.applicationSettingsOld
		}
	} else if serverExtensions.hasEarlyData {
		// 0-RTT connections inherit application settings from the session.
		c.hasApplicationSettings = hs.session.hasApplicationSettings
		c.localApplicationSettings = hs.session.localApplicationSettings
		c.peerApplicationSettings = hs.session.peerApplicationSettings
		c.hasApplicationSettingsOld = hs.session.hasApplicationSettingsOld
		c.localApplicationSettingsOld = hs.session.localApplicationSettingsOld
		c.peerApplicationSettingsOld = hs.session.peerApplicationSettingsOld
	}

	return nil
}

func (hs *clientHandshakeState) serverResumedSession() bool {
	// If the server responded with the same sessionID then it means the
	// sessionTicket is being used to resume a TLS session.
	//
	// Note that, if hs.hello.sessionID is a non-nil empty array, this will
	// accept an empty session ID from the server as resumption. See
	// EmptyTicketSessionID.
	return hs.session != nil && hs.hello.sessionID != nil &&
		bytes.Equal(hs.serverHello.sessionID, hs.hello.sessionID)
}

func (hs *clientHandshakeState) processServerHello() (bool, error) {
	c := hs.c

	// Check for downgrade signals in the server random, per RFC 8446, section 4.1.3.
	gotDowngrade := hs.serverHello.random[len(hs.serverHello.random)-8:]
	if !c.config.Bugs.IgnoreTLS13DowngradeRandom {
		if c.config.maxVersion(c.isDTLS) >= VersionTLS13 {
			if bytes.Equal(gotDowngrade, downgradeTLS13) {
				c.sendAlert(alertProtocolVersion)
				return false, errors.New("tls: downgrade from TLS 1.3 detected")
			}
		}
		if c.vers <= VersionTLS11 && c.config.maxVersion(c.isDTLS) >= VersionTLS12 {
			if bytes.Equal(gotDowngrade, downgradeTLS12) {
				c.sendAlert(alertProtocolVersion)
				return false, errors.New("tls: downgrade from TLS 1.2 detected")
			}
		}
	}

	if bytes.Equal(gotDowngrade, downgradeJDK11) != c.config.Bugs.ExpectJDK11DowngradeRandom {
		c.sendAlert(alertProtocolVersion)
		if c.config.Bugs.ExpectJDK11DowngradeRandom {
			return false, errors.New("tls: server did not send a JDK 11 downgrade signal")
		}
		return false, errors.New("tls: server sent an unexpected JDK 11 downgrade signal")
	}

	if c.config.Bugs.ExpectOmitExtensions && !hs.serverHello.omitExtensions {
		return false, errors.New("tls: ServerHello did not omit extensions")
	}

	if hs.serverResumedSession() {
		// For test purposes, assert that the server never accepts the
		// resumption offer on renegotiation.
		if c.cipherSuite != nil && c.config.Bugs.FailIfResumeOnRenego {
			return false, errors.New("tls: server resumed session on renegotiation")
		}

		if hs.serverHello.extensions.sctList != nil {
			return false, errors.New("tls: server sent SCT extension on session resumption")
		}

		if hs.serverHello.extensions.ocspStapling {
			return false, errors.New("tls: server sent OCSP extension on session resumption")
		}

		// Restore masterSecret and peerCerts from previous state
		hs.masterSecret = hs.session.secret
		c.peerCertificates = hs.session.serverCertificates
		c.peerDelegatedCredential = hs.session.serverDelegatedCredential
		c.extendedMasterSecret = hs.session.extendedMasterSecret
		c.sctList = hs.session.sctList
		c.ocspResponse = hs.session.ocspResponse
		hs.finishedHash.discardHandshakeBuffer()
		return true, nil
	}

	if hs.serverHello.extensions.sctList != nil {
		c.sctList = hs.serverHello.extensions.sctList
	}

	return false, nil
}

func (hs *clientHandshakeState) readFinished(out []byte) error {
	c := hs.c

	c.readRecord(recordTypeChangeCipherSpec)
	if err := c.in.error(); err != nil {
		return err
	}

	serverFinished, err := readHandshakeType[finishedMsg](c)
	if err != nil {
		return err
	}

	if c.config.Bugs.EarlyChangeCipherSpec == 0 {
		verify := hs.finishedHash.serverSum(hs.masterSecret)
		if len(verify) != len(serverFinished.verifyData) ||
			subtle.ConstantTimeCompare(verify, serverFinished.verifyData) != 1 {
			c.sendAlert(alertHandshakeFailure)
			return errors.New("tls: server's Finished message was incorrect")
		}
	}
	c.serverVerify = append(c.serverVerify[:0], serverFinished.verifyData...)
	copy(out, serverFinished.verifyData)
	hs.writeServerHash(serverFinished.marshal())
	return nil
}

func (hs *clientHandshakeState) readSessionTicket() error {
	c := hs.c

	// Create a session with no server identifier. Either a
	// session ID or session ticket will be attached.
	session := &ClientSessionState{
		vers:                      c.vers,
		wireVersion:               c.wireVersion,
		cipherSuite:               hs.suite,
		secret:                    hs.masterSecret,
		handshakeHash:             hs.finishedHash.Sum(),
		serverCertificates:        c.peerCertificates,
		serverDelegatedCredential: c.peerDelegatedCredential,
		sctList:                   c.sctList,
		ocspResponse:              c.ocspResponse,
		ticketExpiration:          c.config.time().Add(time.Duration(7 * 24 * time.Hour)),
	}

	if !hs.serverHello.extensions.ticketSupported {
		if c.config.Bugs.ExpectNewTicket {
			return errors.New("tls: expected new ticket")
		}
		if hs.session == nil && len(hs.serverHello.sessionID) > 0 {
			session.sessionID = hs.serverHello.sessionID
			hs.session = session
		}
		return nil
	}

	if c.config.Bugs.ExpectNoNewSessionTicket {
		return errors.New("tls: received unexpected NewSessionTicket")
	}

	sessionTicketMsg, err := readHandshakeType[newSessionTicketMsg](c)
	if err != nil {
		return err
	}

	if c.config.Bugs.ExpectNoNonEmptyNewSessionTicket && len(sessionTicketMsg.ticket) != 0 {
		return errors.New("tls: received unexpected non-empty NewSessionTicket")
	}

	session.sessionTicket = sessionTicketMsg.ticket
	hs.session = session

	hs.writeServerHash(sessionTicketMsg.marshal())

	return nil
}

func (hs *clientHandshakeState) sendFinished(out []byte, isResume bool) error {
	c := hs.c

	var postCCSMsgs [][]byte
	seqno := hs.c.sendHandshakeSeq
	if hs.serverHello.extensions.nextProtoNeg {
		nextProto := new(nextProtoMsg)
		proto, fallback := mutualProtocol(c.config.NextProtos, hs.serverHello.extensions.nextProtos)
		if fallback && c.config.NoFallbackNextProto {
			proto = ""
			fallback = false
		}
		nextProto.proto = proto
		c.clientProtocol = proto
		c.clientProtocolFallback = fallback

		nextProtoBytes := nextProto.marshal()
		hs.finishedHash.WriteHandshake(nextProtoBytes, seqno)
		seqno++
		postCCSMsgs = append(postCCSMsgs, nextProtoBytes)
	}

	if hs.serverHello.extensions.channelIDRequested {
		var resumeHash []byte
		if isResume {
			resumeHash = hs.session.handshakeHash
		}
		channelIDMsgBytes, err := hs.writeChannelIDMessage(hs.finishedHash.hashForChannelID(resumeHash))
		if err != nil {
			return err
		}
		hs.finishedHash.WriteHandshake(channelIDMsgBytes, seqno)
		seqno++
		postCCSMsgs = append(postCCSMsgs, channelIDMsgBytes)
	}

	finished := new(finishedMsg)
	if c.config.Bugs.EarlyChangeCipherSpec == 2 {
		finished.verifyData = hs.finishedHash.clientSum(nil)
	} else {
		finished.verifyData = hs.finishedHash.clientSum(hs.masterSecret)
	}
	copy(out, finished.verifyData)
	if c.config.Bugs.BadFinished {
		finished.verifyData[0]++
	}
	c.clientVerify = append(c.clientVerify[:0], finished.verifyData...)
	hs.finishedBytes = finished.marshal()
	hs.finishedHash.WriteHandshake(hs.finishedBytes, seqno)
	if c.config.Bugs.PartialClientFinishedWithClientHello {
		// The first byte has already been written.
		postCCSMsgs = append(postCCSMsgs, hs.finishedBytes[1:])
	} else {
		postCCSMsgs = append(postCCSMsgs, hs.finishedBytes)
	}

	if c.config.Bugs.FragmentAcrossChangeCipherSpec {
		c.writeRecord(recordTypeHandshake, postCCSMsgs[0][:5])
		postCCSMsgs[0] = postCCSMsgs[0][5:]
	}

	if !c.config.Bugs.SkipChangeCipherSpec &&
		c.config.Bugs.EarlyChangeCipherSpec == 0 {
		ccs := []byte{1}
		if c.config.Bugs.BadChangeCipherSpec != nil {
			ccs = c.config.Bugs.BadChangeCipherSpec
		}
		c.writeRecord(recordTypeChangeCipherSpec, ccs)
	}

	if c.config.Bugs.AppDataAfterChangeCipherSpec != nil {
		c.writeRecord(recordTypeApplicationData, c.config.Bugs.AppDataAfterChangeCipherSpec)
	}
	if c.config.Bugs.AlertAfterChangeCipherSpec != 0 {
		c.sendAlert(c.config.Bugs.AlertAfterChangeCipherSpec)
		return errors.New("tls: simulating post-CCS alert")
	}

	if !c.config.Bugs.SkipFinished {
		for _, msg := range postCCSMsgs {
			c.writeRecord(recordTypeHandshake, msg)
		}

		if c.config.Bugs.SendExtraFinished {
			c.writeRecord(recordTypeHandshake, finished.marshal())
		}
	}

	if !isResume || !c.config.Bugs.PackAppDataWithHandshake {
		return c.flushHandshake()
	}
	return nil
}

func (hs *clientHandshakeState) writeChannelIDMessage(channelIDHash []byte) ([]byte, error) {
	c := hs.c
	channelIDMsg := new(channelIDMsg)
	if c.config.ChannelID.Curve != elliptic.P256() {
		return nil, fmt.Errorf("tls: Channel ID is not on P-256.")
	}
	r, s, err := ecdsa.Sign(c.config.rand(), c.config.ChannelID, channelIDHash)
	if err != nil {
		return nil, err
	}
	channelID := make([]byte, 128)
	writeIntPadded(channelID[0:32], c.config.ChannelID.X)
	writeIntPadded(channelID[32:64], c.config.ChannelID.Y)
	writeIntPadded(channelID[64:96], r)
	writeIntPadded(channelID[96:128], s)
	if c.config.Bugs.InvalidChannelIDSignature {
		channelID[64] ^= 1
	}
	channelIDMsg.channelID = channelID

	c.channelID = &c.config.ChannelID.PublicKey

	return channelIDMsg.marshal(), nil
}

func (hs *clientHandshakeState) writeClientHash(msg []byte) {
	// writeClientHash is called before writeRecord.
	hs.finishedHash.WriteHandshake(msg, hs.c.sendHandshakeSeq)
}

func (hs *clientHandshakeState) writeServerHash(msg []byte) {
	// writeServerHash is called after readHandshake.
	hs.finishedHash.WriteHandshake(msg, hs.c.recvHandshakeSeq-1)
}

// clientSessionCacheKey returns a key used to cache sessionTickets that could
// be used to resume previously negotiated TLS sessions with a server.
func clientSessionCacheKey(serverAddr net.Addr, config *Config) string {
	if len(config.ServerName) > 0 {
		return config.ServerName
	}
	return serverAddr.String()
}

// mutualProtocol finds the mutual Next Protocol Negotiation or ALPN protocol
// given list of possible protocols and a list of the preference order. The
// first list must not be empty. It returns the resulting protocol and flag
// indicating if the fallback case was reached.
func mutualProtocol(protos, preferenceProtos []string) (string, bool) {
	for _, s := range preferenceProtos {
		if slices.Contains(protos, s) {
			return s, false
		}
	}

	return protos[0], true
}

// writeIntPadded writes x into b, padded up with leading zeros as
// needed.
func writeIntPadded(b []byte, x *big.Int) {
	clear(b)
	xb := x.Bytes()
	copy(b[len(b)-len(xb):], xb)
}

func generatePSKBinders(version uint16, isDTLS bool, hello *clientHelloMsg, session *ClientSessionState, firstClientHello, helloRetryRequest []byte, config *Config) {
	maybeCorruptBinder := !config.Bugs.OnlyCorruptSecondPSKBinder || len(firstClientHello) > 0
	binderLen := session.cipherSuite.hash().Size()
	numBinders := 1
	if maybeCorruptBinder {
		if config.Bugs.SendNoPSKBinder {
			// The binders may have been set from the previous
			// ClientHello.
			hello.pskBinders = nil
			return
		}

		if config.Bugs.SendShortPSKBinder {
			binderLen--
		}

		if config.Bugs.SendExtraPSKBinder {
			numBinders++
		}
	}

	// Fill hello.pskBinders with appropriate length arrays of zeros so the
	// length prefixes are correct when computing the binder over the truncated
	// ClientHello message.
	hello.pskBinders = make([][]byte, numBinders)
	for i := range hello.pskBinders {
		hello.pskBinders[i] = make([]byte, binderLen)
	}

	helloBytes := hello.marshal()
	binderSize := len(hello.pskBinders)*(binderLen+1) + 2
	truncatedHello := helloBytes[:len(helloBytes)-binderSize]
	binder := computePSKBinder(session.secret, version, isDTLS, resumptionPSKBinderLabel, session.cipherSuite, firstClientHello, helloRetryRequest, truncatedHello)
	if maybeCorruptBinder {
		if config.Bugs.SendShortPSKBinder {
			binder = binder[:binderLen]
		}
		if config.Bugs.SendInvalidPSKBinder {
			binder[0] ^= 1
		}
	}

	for i := range hello.pskBinders {
		hello.pskBinders[i] = binder
	}

	hello.raw = nil
}
