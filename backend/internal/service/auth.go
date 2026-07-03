package service

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"

	"loom/backend/internal/domain"
	"loom/backend/internal/port"
	"loom/backend/internal/store"
)

const (
	pendingLoginTTL = 2 * time.Minute
	backupCodeCount = 10

	lockoutThreshold  = 5
	baseLockout       = 5 * time.Minute
	maxLockout        = 24 * time.Hour
	lockoutDecayAfter = 24 * time.Hour
	maxLockoutLevel   = 9 // baseLockout * 2^9 (42.7h) already exceeds maxLockout; caps the shift below
)

// commonPasswords is a small blocklist of well-known weak passwords, checked
// in addition to the minimum-length rule (NIST 800-63B favors length over
// arbitrary character-class complexity rules).
var commonPasswords = map[string]bool{
	"password1234":        true,
	"password123456":      true,
	"letmein123456":       true,
	"qwertyuiop123":       true,
	"123456789012":        true,
	"correcthorsebattery": true,
	"welcometotheteam":    true,
	"iloveyou123456":      true,
	"administrator1":      true,
	"changeme123456":      true,
}

func validatePassword(password string) error {
	if len(password) < 12 {
		return fmt.Errorf("password must be at least 12 characters: %w", ErrValidation)
	}
	if commonPasswords[strings.ToLower(password)] {
		return fmt.Errorf("password is too common: %w", ErrValidation)
	}
	return nil
}

func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// AuthService owns registration, TOTP enrollment/verification, login, and
// session lifecycle. now is overridden by tests to make the lockout
// escalation math deterministic.
type AuthService struct {
	store   port.Store
	authKey []byte
	now     func() time.Time
}

// NewAuthService creates an auth service. authKey must be 32 bytes
// (AES-256) and is used to encrypt TOTP secrets at rest.
func NewAuthService(store port.Store, authKey []byte) *AuthService {
	return &AuthService{store: store, authKey: authKey, now: time.Now}
}

func (a *AuthService) issuePendingLogin(userID string) (string, error) {
	token, err := randomToken()
	if err != nil {
		return "", err
	}
	if err := a.store.CreatePendingLogin(userID, hashToken(token), a.now().Add(pendingLoginTTL)); err != nil {
		return "", err
	}
	return token, nil
}

// PendingUserID resolves a pending-login token to a user ID without
// consuming it — used by the TOTP-setup step, which the user may retry.
func (a *AuthService) PendingUserID(pendingToken string) (string, error) {
	userID, err := a.store.PendingLoginUserID(hashToken(pendingToken), a.now())
	if err != nil {
		return "", fmt.Errorf("invalid or expired login: %w", ErrUnauthorized)
	}
	return userID, nil
}

// Register creates the single operator account. It rejects a second
// registration with ErrConflict. The new account has TotpEnabled=false, so
// it immediately issues a pending-login token (the same mechanism the
// post-password step of Login uses) so the caller can hand off straight
// into TOTP enrollment.
func (a *AuthService) Register(email, password string) (domain.User, string, error) {
	count, err := a.store.UserCount()
	if err != nil {
		return domain.User{}, "", err
	}
	if count > 0 {
		return domain.User{}, "", fmt.Errorf("registration closed: %w", ErrConflict)
	}
	if err := validatePassword(password); err != nil {
		return domain.User{}, "", err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return domain.User{}, "", err
	}
	createdAt := a.now().UTC().Format(time.RFC3339)
	user, err := a.store.CreateUser(email, string(hash), createdAt)
	if err != nil {
		return domain.User{}, "", err
	}
	pendingToken, err := a.issuePendingLogin(user.ID)
	if err != nil {
		return domain.User{}, "", err
	}
	return user, pendingToken, nil
}

// BeginTotpEnrollment generates a new TOTP secret, encrypts it at rest, and
// returns both the raw secret (for tests) and the otpauth:// URI the
// frontend renders as a QR code.
func (a *AuthService) BeginTotpEnrollment(userID string) (secret, otpauthURI string, err error) {
	user, err := a.store.UserByID(userID)
	if err != nil {
		return "", "", err
	}
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      "Loom",
		AccountName: user.Email,
	})
	if err != nil {
		return "", "", err
	}
	encrypted, err := encryptSecret(a.authKey, key.Secret())
	if err != nil {
		return "", "", err
	}
	if _, err := a.store.UpdateUser(userID, port.UserPatch{TotpSecretEnc: &encrypted}); err != nil {
		return "", "", err
	}
	return key.Secret(), key.String(), nil
}

// ConfirmTotpEnrollment verifies the enrollment code, enables 2FA, and
// returns a fresh set of one-time backup codes (shown to the user exactly
// once; only their bcrypt hashes are persisted).
func (a *AuthService) ConfirmTotpEnrollment(userID, code string) ([]string, error) {
	user, err := a.store.UserByID(userID)
	if err != nil {
		return nil, err
	}
	secret, err := decryptSecret(a.authKey, user.TotpSecretEnc)
	if err != nil {
		return nil, err
	}
	if !totp.Validate(code, secret) {
		return nil, fmt.Errorf("invalid verification code: %w", ErrValidation)
	}
	codes, err := generateBackupCodes(backupCodeCount)
	if err != nil {
		return nil, err
	}
	hashes := make([]string, len(codes))
	for i, c := range codes {
		h, err := hashBackupCode(c)
		if err != nil {
			return nil, err
		}
		hashes[i] = h
	}
	enabled := true
	if _, err := a.store.UpdateUser(userID, port.UserPatch{TotpEnabled: &enabled, BackupCodeHashes: &hashes}); err != nil {
		return nil, err
	}
	return codes, nil
}

func (a *AuthService) isLocked(user domain.User) (bool, time.Time) {
	if user.LockedUntil == nil {
		return false, time.Time{}
	}
	lockedUntil, err := time.Parse(time.RFC3339, *user.LockedUntil)
	if err != nil {
		return false, time.Time{}
	}
	if a.now().Before(lockedUntil) {
		return true, lockedUntil
	}
	return false, time.Time{}
}

// recordFailedAttempt applies the escalating-lockout algorithm: 5 failures
// locks the account for 5min × 2^lockoutLevel (capped at 24h); a clean 24h
// since the last failure decays lockoutLevel back to 0 first.
func (a *AuthService) recordFailedAttempt(user domain.User) error {
	now := a.now()
	failedAttempts := user.FailedAttempts + 1
	lockoutLevel := user.LockoutLevel
	if user.LastFailedAt != nil {
		if lastFailed, err := time.Parse(time.RFC3339, *user.LastFailedAt); err == nil {
			if now.Sub(lastFailed) > lockoutDecayAfter {
				lockoutLevel = 0
			}
		}
	}

	patch := port.UserPatch{}
	nowStr := now.UTC().Format(time.RFC3339)
	patch.LastFailedAt = &nowStr

	if failedAttempts >= lockoutThreshold {
		duration := baseLockout * time.Duration(uint64(1)<<uint(lockoutLevel))
		if duration > maxLockout {
			duration = maxLockout
		}
		lockedUntilStr := now.Add(duration).UTC().Format(time.RFC3339)
		patch.LockedUntil = &lockedUntilStr
		patch.HasLockedUntil = true
		nextLevel := lockoutLevel + 1
		if nextLevel > maxLockoutLevel {
			nextLevel = maxLockoutLevel
		}
		patch.LockoutLevel = &nextLevel
		zero := 0
		patch.FailedAttempts = &zero
	} else {
		patch.FailedAttempts = &failedAttempts
		patch.LockoutLevel = &lockoutLevel
	}
	_, err := a.store.UpdateUser(user.ID, patch)
	return err
}

// Login verifies email+password and, on success, issues a pending-login
// token for the caller to complete with VerifyTotp. It never distinguishes
// "no such account" from "wrong password" in its error, to avoid account
// enumeration.
func (a *AuthService) Login(email, password string) (string, error) {
	user, err := a.store.UserByEmail(email)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", fmt.Errorf("invalid email or password: %w", ErrUnauthorized)
		}
		return "", err
	}
	if locked, lockedUntil := a.isLocked(user); locked {
		return "", fmt.Errorf("account locked until %s: %w", lockedUntil.Format(time.RFC3339), ErrLocked)
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		if err := a.recordFailedAttempt(user); err != nil {
			return "", err
		}
		return "", fmt.Errorf("invalid email or password: %w", ErrUnauthorized)
	}
	zero := 0
	if _, err := a.store.UpdateUser(user.ID, port.UserPatch{FailedAttempts: &zero, LockoutLevel: &zero}); err != nil {
		return "", err
	}
	return a.issuePendingLogin(user.ID)
}
