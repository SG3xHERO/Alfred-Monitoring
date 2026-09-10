// Package update implements admin-triggered self-update: download the new
// binary, verify its SHA-256 against what the backend told us to expect, and
// only then swap it into place. Never called on a timer — only in response
// to an explicit "update" field in the /api/ingest response, itself only set
// after an admin clicks "Update" for this specific server.
package update

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sg3xhero/alfred/agent/internal/config"
)

// Apply downloads the binary at url (relative to cfg.BackendURL), verifies
// its SHA-256 against expectedSHA256, and swaps it into place for the
// currently running executable. On success the caller should exit soon after
// so the service manager (Windows SCM / systemd) restarts into the new
// binary — this function does not exit the process itself.
func Apply(cfg *config.Config, url, expectedSHA256 string) error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate running executable: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exePath); err == nil {
		exePath = resolved
	}

	newPath := exePath + ".new"
	if err := download(cfg, url, newPath); err != nil {
		return err
	}

	digest, err := sha256File(newPath)
	if err != nil {
		os.Remove(newPath)
		return err
	}
	if !strings.EqualFold(digest, expectedSHA256) {
		os.Remove(newPath)
		return fmt.Errorf("checksum mismatch: got %s, expected %s", digest, expectedSHA256)
	}

	if err := swapIntoPlace(exePath, newPath); err != nil {
		os.Remove(newPath)
		return err
	}
	return nil
}

func download(cfg *config.Config, url, destPath string) error {
	full := strings.TrimRight(cfg.BackendURL, "/") + url
	client := &http.Client{Timeout: 2 * time.Minute}
	req, err := http.NewRequest(http.MethodGet, full, nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-API-Key", cfg.APIKey)

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("download %s: backend returned %d", full, resp.StatusCode)
	}

	out, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, resp.Body); err != nil {
		return err
	}
	return nil
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// CleanupStale removes a leftover .old binary from a prior update. Safe to
// call unconditionally on every startup.
func CleanupStale() {
	exePath, err := os.Executable()
	if err != nil {
		return
	}
	_ = os.Remove(exePath + ".old")
}
