# claude-runner

A sidecar daemon that spawns and manages detached `claude.exe` processes for the claude-topic-router.

## Problem

When the bun router process dies, its stdio pipes close, which kills all child `claude.exe` processes (EPIPE). We need a separate daemon that owns and survives the router.

## Solution

The runner:
1. Accepts job submissions via HTTP POST
2. Spawns `claude.exe` DETACHED with file-based stdio (not pipes)
3. Tails output files and parses stream-json events
4. Serves events to router via SSE with Last-Event-ID support for reconnection
5. Persists job state to disk (survives its own restarts)
6. Handles idle timeouts (kills stuck processes after 5 minutes by default)
7. Enforces maxConcurrent limits (default 15)

## Architecture

```
[Telegram] → [bun router] ←HTTP/SSE→ [claude-runner :7878] → [claude.exe x N]
                                              |
                                        data/jobs/<id>/ (on disk)
```

Each job spawns a wrapper process (`bun run.mjs`) which is completely detached and survives the runner's death. That wrapper spawns the actual `claude.exe` with proper stdio redirection to files.

## Running

```bash
cd runner
bun run src/index.ts

# Or with custom port/concurrency:
CLAUDE_RUNNER_PORT=8000 CLAUDE_RUNNER_MAX_CONCURRENT=20 bun run src/index.ts
```

## API

### POST /jobs

Create a new job.

```bash
curl -X POST http://localhost:7878/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "topicKey": "123456789:123",
    "projectPath": "/path/to/project",
    "message": "user prompt",
    "claudePath": "C:\\path\\to\\claude.exe",
    "model": "opus",
    "sessionId": "optional-uuid",
    "appendSystemPrompt": "system prompt text",
    "idleTimeoutMinutes": 5,
    "flags": ["--extra-flag"],
    "env": {"EXTRA_VAR": "value"}
  }'
```

Response: `201 Created`
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "pid": 12345
}
```

### GET /jobs/:id

Get job status.

```bash
curl http://localhost:7878/jobs/550e8400-e29b-41d4-a716-446655440000
```

Response: `200 OK`
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "topicKey": "123456789:123",
  "state": "running",
  "pid": 12345,
  "startedAt": 1712345678000,
  "lastEventAt": 1712345679000,
  "stepCount": 5,
  "currentTool": "web_search",
  "toolDetail": "Searching for...",
  "sessionId": "sess-123",
  "exitCode": null
}
```

### GET /jobs/:id/events

Stream events via SSE.

```bash
curl http://localhost:7878/jobs/550e8400-e29b-41d4-a716-446655440000/events
```

Streams events:
```
event: stream-json
id: 0
data: {"type":"message_start","message":{"id":"msg-123",...}}

event: stream-json
id: 1
data: {"type":"content_block_start",...}

...

event: completed
data: {"exitCode":0,"sessionId":"sess-123"}
```

### GET /jobs

List jobs (with optional filtering).

```bash
curl 'http://localhost:7878/jobs?active=true&topicKey=123456789:123'
```

Response: `200 OK`
```json
{
  "jobs": [
    { "jobId": "...", "state": "running", ... },
    { "jobId": "...", "state": "running", ... }
  ]
}
```

### DELETE /jobs/:id

Cancel a job.

```bash
curl -X DELETE http://localhost:7878/jobs/550e8400-e29b-41d4-a716-446655440000
```

Response: `200 OK`
```json
{
  "killed": true
}
```

### GET /health

Health check.

```bash
curl http://localhost:7878/health
```

Response: `200 OK`
```json
{
  "ok": true,
  "activeJobs": 3,
  "uptime": 123456
}
```

## Job States

- `spawning`: Process is being started
- `running`: Process is active
- `completed`: Process exited with code 0
- `failed`: Process exited with non-zero code
- `cancelled`: Job was manually cancelled
- `timeout`: Job exceeded idle timeout

## Job Lifecycle

1. POST /jobs creates a job directory at `data/jobs/<jobId>/`
2. Runner spawns a wrapper process (bun run.mjs) DETACHED
3. Wrapper spawns `claude.exe` with pipes to stdout.jsonl, stderr.log
4. FileTailer polls stdout.jsonl and emits events to SSE subscribers
5. SessionID, tool name, step count extracted and tracked
6. If no new events for `idleTimeoutMinutes`, job is killed
7. When claude.exe exits, completion event is emitted
8. Job state is persisted to `data/jobs/<jobId>/meta.json`

## On Runner Restart

1. Scan `data/jobs/` for all job directories
2. For each job with meta.json in `running` state:
   - Check if wrapper PID is still alive
   - If dead: read final state from stdout.jsonl, mark completed/failed
   - If alive: reattach file tailer and resume streaming
3. Clean up old completed jobs (>1 hour old)

## Implementation Details

### Detached Spawning (Windows)

The key to surviving runner death is spawning detached:

```typescript
const proc = spawn("bun", ["run", jobDir/worker.mjs], {
  stdio: "ignore",
  detached: true,
  windowsHide: true,
});
proc.unref();
```

This creates a process tree that's completely independent of the runner. Even if runner crashes, the bun process lives on, which spawns and manages claude.exe.

### File-Based Stdio

Instead of piping, we use file redirects:

```javascript
// In worker.mjs
const msgStream = createReadStream(jobDir/msg.txt);
const outStream = createWriteStream(jobDir/stdout.jsonl);
const errStream = createWriteStream(jobDir/stderr.log);

proc.stdin.pipe(msgStream);
proc.stdout.pipe(outStream);
proc.stderr.pipe(errStream);
```

This avoids EPIPE errors completely.

### SSE With Reconnection

Clients can reconnect with Last-Event-ID header to resume from where they left off:

```bash
# First connection
curl http://localhost:7878/jobs/job-123/events

# Connection drops... reconnect with Last-Event-ID
curl -H "Last-Event-ID: 42" http://localhost:7878/jobs/job-123/events
```

Runner reads from beginning of stdout.jsonl, skips events 0-42, then streams live events.

### Session ID Detection

When claude emits stream-json with a valid session_id, runner captures it:

```json
{"session_id": "550e8400-e29b-41d4-a716-446655440000"}
```

The ID is stored in job metadata and returned to clients.

### Idle Watchdog

Every 15 seconds, runner checks `Date.now() - lastEventAt > idleTimeoutMinutes * 60000`.

If exceeded:
```bash
taskkill /F /T /PID <wrapperPid>
```

This kills the entire process tree (wrapper + claude).

## Deployment Notes

- **Single instance**: Runner enforces single-instance via `.runner.pid` file
- **Data persistence**: All job metadata in `data/jobs/<jobId>/meta.json`
- **Cleanup**: Old completed jobs (>1h) are cleaned on next restart
- **Graceful shutdown**: SIGTERM/SIGINT stops accepting new jobs but lets running jobs finish
- **Port**: Default 7878, configurable via `CLAUDE_RUNNER_PORT` env var
- **Max concurrent**: Default 15, configurable via `CLAUDE_RUNNER_MAX_CONCURRENT` env var

## Integration with Router

The router should:

1. POST /jobs with user prompt and config
2. Poll GET /jobs/:id/events in a long-lived connection
3. Extract events and stream to Telegram
4. On disconnect: POST with Last-Event-ID to resume
5. When done: DELETE /jobs/:id to cleanup

See `../../src/router.ts` for router integration.
