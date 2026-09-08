package service

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
	"devdeck/backend/internal/store"
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
	store      port.Store
	authKey    []byte
	require2FA bool
	now        func() time.Time
}

// NewAuthService creates an auth service. authKey must be 32 bytes
// (AES-256) and is used to encrypt TOTP secrets at rest. 2FA is required
// by default; SetTOTPRequired(false) relaxes it (--2fa=false).
func NewAuthService(store port.Store, authKey []byte) *AuthService {
	return &AuthService{store: store, authKey: authKey, require2FA: true, now: time.Now}
}

// SetTOTPRequired toggles the global 2FA requirement (the --2fa flag).
func (a *AuthService) SetTOTPRequired(required bool) { a.require2FA = required }

// TOTPRequired reports whether logins must complete TOTP verification.
func (a *AuthService) TOTPRequired() bool { return a.require2FA }

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
		Issuer:      "DevDeck",
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

const sessionTTL = 30 * 24 * time.Hour

const (
	browserProxyTokenTTL     = 12 * time.Hour
	browserProxyTokenPurpose = "devdeck/browser-proxy/v1"
)

func (a *AuthService) issueSession(userID string) (string, error) {
	token, err := randomToken()
	if err != nil {
		return "", err
	}
	if err := a.store.CreateSession(userID, hashToken(token), a.now().Add(sessionTTL)); err != nil {
		return "", err
	}
	return token, nil
}

// VerifyTotp completes a login started by Login (or the pending state left
// by Register/BeginTotpEnrollment), accepting either a live TOTP code or a
// single-use backup code, and issues a real session on success.
func (a *AuthService) VerifyTotp(pendingToken, code string) (string, domain.User, error) {
	userID, err := a.store.PendingLoginUserID(hashToken(pendingToken), a.now())
	if err != nil {
		return "", domain.User{}, fmt.Errorf("invalid or expired login: %w", ErrUnauthorized)
	}
	user, err := a.store.UserByID(userID)
	if err != nil {
		return "", domain.User{}, err
	}
	secret, err := decryptSecret(a.authKey, user.TotpSecretEnc)
	if err != nil {
		return "", domain.User{}, err
	}

	if totp.Validate(code, secret) {
		return a.completeVerification(pendingToken, userID, user)
	}
	if idx := matchBackupCode(user.BackupCodeHashes, code); idx >= 0 {
		remaining := append(append([]string{}, user.BackupCodeHashes[:idx]...), user.BackupCodeHashes[idx+1:]...)
		if _, err := a.store.UpdateUser(userID, port.UserPatch{BackupCodeHashes: &remaining}); err != nil {
			return "", domain.User{}, err
		}
		return a.completeVerification(pendingToken, userID, user)
	}
	return "", domain.User{}, fmt.Errorf("invalid verification code: %w", ErrValidation)
}

// CompleteLogin exchanges a pending-login token for a real session without a
// TOTP code. It refuses to run while 2FA is required (the default), so it can
// never become a verification bypass — it only exists for --2fa=false.
func (a *AuthService) CompleteLogin(pendingToken string) (string, domain.User, error) {
	if a.require2FA {
		return "", domain.User{}, fmt.Errorf("2fa verification required: %w", ErrUnauthorized)
	}
	userID, err := a.store.PendingLoginUserID(hashToken(pendingToken), a.now())
	if err != nil {
		return "", domain.User{}, fmt.Errorf("invalid or expired login: %w", ErrUnauthorized)
	}
	user, err := a.store.UserByID(userID)
	if err != nil {
		return "", domain.User{}, err
	}
	return a.completeVerification(pendingToken, userID, user)
}

// KeySession issues a session for the desktop operator account, creating it
// on first run. The caller must already have proven possession of the hub's
// static --key, so this deliberately bypasses password and TOTP.
func (a *AuthService) KeySession() (string, domain.User, error) {
	count, err := a.store.UserCount()
	if err != nil {
		return "", domain.User{}, err
	}
	if count == 0 {
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			return "", domain.User{}, err
		}
		// Throwaway password: desktop logins always come through KeySession.
		user, _, err := a.Register(domain.DesktopOperatorEmail, hex.EncodeToString(buf))
		if err != nil {
			return "", domain.User{}, err
		}
		// Nobody has ever seen that password, so UpdateAccount must not ask
		// for it before the operator picks credentials of their own; and the
		// flag, not the placeholder email, is what identifies this account to
		// later KeySession calls once the operator renames it.
		notSet, isOperator := false, true
		user, err = a.store.UpdateUser(user.ID, port.UserPatch{PasswordSet: &notSet, DesktopOperator: &isOperator})
		if err != nil {
			return "", domain.User{}, err
		}
		token, err := a.issueSession(user.ID)
		if err != nil {
			return "", domain.User{}, err
		}
		return token, user, nil
	}
	// Matched on the desktop_operator flag rather than the bootstrap email, so
	// an operator who renamed the account from Settings -> Account does not
	// lock the desktop shell out of its own hub. An account someone registered
	// by hand never carries the flag, so a --key holder still cannot mint a
	// session as them.
	user, err := a.store.DesktopOperatorUser()
	if err != nil {
		return "", domain.User{}, fmt.Errorf("key session requires the desktop operator account: %w", ErrConflict)
	}
	token, err := a.issueSession(user.ID)
	if err != nil {
		return "", domain.User{}, err
	}
	return token, user, nil
}

// AccountUpdate is a partial change to the operator's sign-in credentials. A
// nil field is left alone.
type AccountUpdate struct {
	Email    *string
	Password *string
	// CurrentPassword confirms the change. It is required whenever the account
	// has a password the operator chose (User.PasswordSet), and ignored on the
	// desktop bootstrap account, whose password is a random string that was
	// never shown to anyone.
	CurrentPassword string
}

// UpdateAccount changes the operator's email and/or password. On success it
// returns the updated user and, when the password changed, the caller should
// revoke the account's other sessions (see AuthHandler.PutAccount).
func (a *AuthService) UpdateAccount(userID string, up AccountUpdate) (domain.User, error) {
	user, err := a.store.UserByID(userID)
	if err != nil {
		return domain.User{}, err
	}

	patch := port.UserPatch{}

	if up.Email != nil {
		email := strings.TrimSpace(*up.Email)
		if err := validateEmail(email); err != nil {
			return domain.User{}, err
		}
		if email != user.Email {
			// Single-operator, so this can only collide with the caller's own
			// row; check anyway rather than leak a raw UNIQUE constraint error.
			if existing, err := a.store.UserByEmail(email); err == nil && existing.ID != user.ID {
				return domain.User{}, fmt.Errorf("email already in use: %w", ErrConflict)
			}
			patch.Email = &email
		}
	}

	if up.Password != nil {
		if err := validatePassword(*up.Password); err != nil {
			return domain.User{}, err
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(*up.Password), bcryptCost)
		if err != nil {
			return domain.User{}, err
		}
		hashStr := string(hash)
		set := true
		patch.PasswordHash = &hashStr
		patch.PasswordSet = &set
	}

	if patch.Email == nil && patch.PasswordHash == nil {
		return domain.User{}, fmt.Errorf("nothing to update: %w", ErrValidation)
	}

	// Confirm with the current password, unless there is no current password
	// to know. Deliberately checked after validation so a typo in the new
	// values is reported before the confirmation is demanded again.
	if user.PasswordSet {
		if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(up.CurrentPassword)) != nil {
			return domain.User{}, fmt.Errorf("current password is incorrect: %w", ErrUnauthorized)
		}
	}

	return a.store.UpdateUser(userID, patch)
}

// RevokeOtherSessions invalidates every session for a user except the one the
// caller is holding, identified by its raw token.
func (a *AuthService) RevokeOtherSessions(userID, keepSessionToken string) error {
	return a.store.DeleteUserSessionsExcept(userID, hashToken(keepSessionToken))
}

// validateEmail applies the same shape check the login form does: an address
// is a routing hint here, not an identity the hub verifies, so this only
// rejects values that could never be typed into a sign-in field.
func validateEmail(email string) error {
	if email == "" {
		return fmt.Errorf("email is required: %w", ErrValidation)
	}
	at := strings.IndexByte(email, '@')
	if at <= 0 || at == len(email)-1 || strings.ContainsAny(email, " \t\r\n") {
		return fmt.Errorf("email is not a valid address: %w", ErrValidation)
	}
	return nil
}

func (a *AuthService) completeVerification(pendingToken, userID string, user domain.User) (string, domain.User, error) {
	sessionToken, err := a.issueSession(userID)
	if err != nil {
		return "", domain.User{}, err
	}
	_ = a.store.DeletePendingLogin(hashToken(pendingToken))
	return sessionToken, user, nil
}

// Logout deletes the session row, invalidating the token immediately.
func (a *AuthService) Logout(sessionToken string) error {
	return a.store.DeleteSession(hashToken(sessionToken))
}

// CurrentUser resolves a session token to its user, used by GET /api/auth/me
// and the RequireAuth middleware.
func (a *AuthService) CurrentUser(sessionToken string) (domain.User, error) {
	userID, err := a.store.SessionUserID(hashToken(sessionToken), a.now())
	if err != nil {
		return domain.User{}, fmt.Errorf("unauthorized: %w", ErrUnauthorized)
	}
	return a.store.UserByID(userID)
}

// IssueBrowserProxyToken creates a short-lived bearer token for sandboxed
// browser iframe requests. The iframe cannot safely use the app's session
// cookie because allowing same-origin scripts in the sandbox would let remote
// pages call DevDeck APIs directly.
func (a *AuthService) IssueBrowserProxyToken(sessionToken string) (string, error) {
	if _, err := a.CurrentUser(sessionToken); err != nil {
		return "", err
	}
	sessionHash := hashToken(sessionToken)
	expiresAt := a.now().Add(browserProxyTokenTTL).Unix()
	payload := strconv.FormatInt(expiresAt, 10) + "." + sessionHash
	signature := base64.RawURLEncoding.EncodeToString(a.browserProxySignature(payload))
	return payload + "." + signature, nil
}

// ValidateBrowserProxyToken verifies that a browser proxy request came from an
// authenticated DevDeck session without exposing the full session cookie to the
// sandboxed remote document.
func (a *AuthService) ValidateBrowserProxyToken(token string) error {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return fmt.Errorf("unauthorized: %w", ErrUnauthorized)
	}
	payload := parts[0] + "." + parts[1]
	got, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return fmt.Errorf("unauthorized: %w", ErrUnauthorized)
	}
	if !hmac.Equal(got, a.browserProxySignature(payload)) {
		return fmt.Errorf("unauthorized: %w", ErrUnauthorized)
	}
	expiresAt, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || !a.now().Before(time.Unix(expiresAt, 0)) {
		return fmt.Errorf("unauthorized: %w", ErrUnauthorized)
	}
	if _, err := a.store.SessionUserID(parts[1], a.now()); err != nil {
		return fmt.Errorf("unauthorized: %w", ErrUnauthorized)
	}
	return nil
}

func (a *AuthService) browserProxySignature(payload string) []byte {
	mac := hmac.New(sha256.New, a.authKey)
	_, _ = mac.Write([]byte(browserProxyTokenPurpose))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(payload))
	return mac.Sum(nil)
}
