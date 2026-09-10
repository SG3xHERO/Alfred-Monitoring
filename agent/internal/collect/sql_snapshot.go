package collect

// SqlSnapshot is a one-off SQL Server diagnostic capture — top CPU queries,
// current blocking chains, and SQL Agent job status. Requested by the backend
// (rule fire or "Snapshot now"), never collected on the periodic tick.
type SqlSnapshot struct {
	TopQueries []SqlQueryStat `json:"top_queries"`
	Blocking   []SqlBlockRow  `json:"blocking"`
	Jobs       []SqlJobRow    `json:"jobs"`
}

type SqlQueryStat struct {
	DatabaseName      string  `json:"DatabaseName"`
	QueryText         string  `json:"QueryText"`
	TotalCpuMs        float64 `json:"TotalCpuMs"`
	AvgCpuMs          float64 `json:"AvgCpuMs"`
	ExecutionCount    int64   `json:"ExecutionCount"`
	LastExecutionTime string  `json:"LastExecutionTime"`
}

type SqlBlockRow struct {
	BlockingSessionID int    `json:"BlockingSessionID"`
	BlockedSessionID  int    `json:"BlockedSessionID"`
	WaitType          string `json:"WaitType"`
	WaitTimeMs        int64  `json:"WaitTimeMs"`
	BlockedQueryText  string `json:"BlockedQueryText"`
}

type SqlJobRow struct {
	JobName        string `json:"JobName"`
	Status         string `json:"Status"`
	LastRunOutcome string `json:"LastRunOutcome"`
	LastRunDate    string `json:"LastRunDate"`
}
