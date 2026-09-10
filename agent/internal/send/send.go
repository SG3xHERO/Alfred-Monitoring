package send

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/sg3xhero/alfred/agent/internal/collect"
	"github.com/sg3xhero/alfred/agent/internal/config"
)

type Sender struct {
	mu     sync.Mutex
	cfg    *config.Config
	client *http.Client
}

func New(cfg *config.Config) *Sender {
	return &Sender{cfg: cfg, client: buildClient(cfg)}
}

func buildClient(cfg *config.Config) *http.Client {
	transport := &http.Transport{}
	if cfg.InsecureSkipVerify {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	return &http.Client{Timeout: 15 * time.Second, Transport: transport}
}

func (s *Sender) UpdateConfig(cfg *config.Config) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cfg = cfg
	s.client = buildClient(cfg)
}

// IngestResponse is the /api/ingest response body. PendingSnapshot is set
// when the backend wants this agent to capture a SQL diagnostic snapshot
// (rule fire or "Snapshot now") — the only command channel the agent has,
// since it never listens for anything, only pushes and reads the response.
type IngestResponse struct {
	IntervalSeconds int              `json:"interval_seconds"`
	PendingSnapshot *PendingSnapshot `json:"pending_snapshot"`
	Update          *PendingUpdate   `json:"update"`
	// Config is the admin's desired checks, pushed from the web app's
	// config builder (see servers.desired_config in the backend schema).
	// Applied idempotently — see main.go's tick handling.
	Config *PushedConfig `json:"config"`
}

// PushedConfig mirrors the subset of config.Checks that's editable remotely
// from the app (not the full struct — services/processes stay local-file-only
// for now). Pointer fields distinguish "not sent" from "explicitly false".
type PushedConfig struct {
	LockoutMonitoring  *bool `json:"lockout_monitoring"`
	SqlMonitoring      *bool `json:"sql_monitoring"`
	SignedInUsersPanel *bool `json:"signed_in_users_panel"`
}

type PendingSnapshot struct {
	ID int `json:"id"`
}

// PendingUpdate is set only after an admin explicitly triggers an update for
// this server — never offered on a timer.
type PendingUpdate struct {
	Version string `json:"version"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
}

// Config returns the sender's current config, for callers (the update
// package) that need BackendURL/APIKey outside of a Push/PushX call.
func (s *Sender) Config() *config.Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg
}

func (s *Sender) Push(snap *collect.Snapshot) (*IngestResponse, error) {
	s.mu.Lock()
	cfg, client := s.cfg, s.client
	s.mu.Unlock()

	body, err := json.Marshal(snap)
	if err != nil {
		return nil, err
	}
	url := strings.TrimRight(cfg.BackendURL, "/") + "/api/ingest"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", cfg.APIKey)

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("backend returned %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	var parsed IngestResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, nil // non-fatal: push itself succeeded, just couldn't read the extras
	}
	return &parsed, nil
}

// PushSnapshot posts a captured (or failed) SQL diagnostic snapshot back to
// the backend for the given request id.
func (s *Sender) PushSnapshot(id int, snap *collect.SqlSnapshot, captureErr error) error {
	s.mu.Lock()
	cfg, client := s.cfg, s.client
	s.mu.Unlock()

	payload := map[string]any{"id": id}
	if captureErr != nil {
		payload["error"] = captureErr.Error()
	} else if snap != nil {
		payload["top_queries"] = snap.TopQueries
		payload["blocking"] = snap.Blocking
		payload["jobs"] = snap.Jobs
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	url := strings.TrimRight(cfg.BackendURL, "/") + "/api/agent/snapshot"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", cfg.APIKey)

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("backend returned %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return nil
}

// PushUpdateResult reports the outcome of an admin-triggered binary update
// attempt back to the backend, clearing its pending-update state.
func (s *Sender) PushUpdateResult(ok bool, updateErr error) error {
	s.mu.Lock()
	cfg, client := s.cfg, s.client
	s.mu.Unlock()

	payload := map[string]any{"ok": ok}
	if updateErr != nil {
		payload["error"] = updateErr.Error()
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	url := strings.TrimRight(cfg.BackendURL, "/") + "/api/agent/update-result"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", cfg.APIKey)

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("backend returned %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return nil
}
