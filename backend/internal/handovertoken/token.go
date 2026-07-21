// Package handovertoken implements the hub's short-lived, machine-scoped
// handover token: proof that a browser holding a valid hub session may open
// one specific runtime's UI without re-entering credentials. See
// docs/superpowers/specs/2026-07-19-hub-runtime-catalog-split-design.md,
// "Runtime UI authentication" -> "Token claims".
//
// This is deliberately not a JWT: three fixed claims and one algorithm
// (Ed25519) don't justify a dependency. The wire format is
// base64url(payload-json) + "." + base64url(signature), where the signature
// covers the base64url-encoded payload string exactly as transmitted.
package handovertoken

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// ttl is how long a token is valid from issuance, before skew tolerance.
// A handover token is exchanged for a session cookie within seconds of
// being minted; it is not a session itself, so it stays short.
const ttl = 60 * time.Second

// skewTolerance absorbs clock drift between the hub (which stamps exp) and
// the runtime (which checks it) without weakening the token's core purpose:
// a verifier is never asked to trust a token more than ttl+skewTolerance
// old, and the token still can't be replayed indefinitely.
const skewTolerance = 30 * time.Second

// Claims is the token's entire payload. Minimal by design — see the spec
// section this package implements.
type Claims struct {
	Sub string `json:"sub"` // the hub user id that authenticated
	Aud string `json:"aud"` // the one machine id this token is valid for
	Exp int64  `json:"exp"` // unix seconds
}

var errMalformed = errors.New("malformed handover token")

// Issue mints a token good for ttl from now, scoped to aud.
func Issue(priv ed25519.PrivateKey, sub, aud string, now time.Time) (string, error) {
	payload, err := json.Marshal(Claims{Sub: sub, Aud: aud, Exp: now.Add(ttl).Unix()})
	if err != nil {
		return "", err
	}
	encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
	sig := ed25519.Sign(priv, []byte(encodedPayload))
	return encodedPayload + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// Verify checks the signature, the audience, and the expiry (with
// skewTolerance grace), in that order. wantAud is normally this runtime's
// own hub-assigned machine id.
func Verify(pub ed25519.PublicKey, token, wantAud string, now time.Time) (Claims, error) {
	encodedPayload, encodedSig, ok := strings.Cut(token, ".")
	if !ok || encodedPayload == "" || encodedSig == "" {
		return Claims{}, errMalformed
	}
	sig, err := base64.RawURLEncoding.DecodeString(encodedSig)
	if err != nil {
		return Claims{}, errMalformed
	}
	if !ed25519.Verify(pub, []byte(encodedPayload), sig) {
		return Claims{}, errors.New("invalid signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(encodedPayload)
	if err != nil {
		return Claims{}, errMalformed
	}
	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return Claims{}, errMalformed
	}
	if claims.Aud != wantAud {
		return Claims{}, errors.New("token is not valid for this machine")
	}
	if now.Unix() > claims.Exp+int64(skewTolerance.Seconds()) {
		return Claims{}, errors.New("token expired")
	}
	return claims, nil
}
