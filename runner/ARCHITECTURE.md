# Architecture: claude-runner

## Problem Statement

The claude-topic-router spawns `claude -p` processes as children. When the router crashes, the OS closes all stdio pipes to child processes, killing them with EPIPE. This breaks active conversations mid-stream.

Solution: A separate sidecar daemon (claude-runner) that owns claude processes and survives router death.

## Design Principles

1. **Process Isolation**: Claude processes are spawned detached, never as children of router
2. **File-Based IO**: No pipes between router and runner (avoid EPIPE)
3. **State Persistence**: All job metadata written to disk, survives restarts
4. **SSE Reconnection**: Clients reconnect via Last-Event-ID to resume from any point
5. **Idle Safety**: Jobs that stall are killed after timeout
6. **Single Instance**: Only one runner per port via PID file lock

## Architecture Diagram

```
┌─────────────────────────────────────────────────┐
│            Telegram Bot (router)                 │
│  - Receives messages from Telegram               │
│  - Submits jobs via HTTP POST /jobs              │
│  - Streams events via HTTP GET /jobs/:id/events  │
│  - Handles reconnection with Last-Event-ID       │
└────────────────────┬────────────────────────────┘
                     │
                     │ HTTP JSON
                     ▼
┌─────────────────────────────────────────────────┐
│         claude-runner (Bun HTTP server)          │
│                                                   │
│  ┌──────────────────────────────────────┐       │
│  │     JobRegistry (in-memory)          │       │
│  │  - Create job (allocates jobId)      │       │
│  │  - Track metadata & state            │       │
│  │  - List/cancel jobs                  │       │
│  │  - Load/save from/to disk            │       │
│  └──────────────────────────────────────┘       │
│                                                   │
│  ┌──────────────────────────────────────┐       │
│  │    claude-spawn module                │       │
│  │  - Build args from JobRequest        │       │
│  │  - Write config to job dir files     │       │
│  │  - Spawn bun worker.mjs detached     │       │
│  │  - Track wrapper PID & claude PID    │       │
│  └──────────────────────────────────────┘       │
│                                                   │
│  ┌──────────────────────────────────────┐       │
│  │      FileTailer (per job)             │       │
│  │  - Poll stdout.jsonl every 200ms     │       │
│  │  - Emit events to SSE subscribers    │       │
│  │  - Track byte offset for recovery    │       │
│  │  - Detect completion (2s of silence) │       │
│  └──────────────────────────────────────┘       │
│                                                   │
│  ┌──────────────────────────────────────┐       │
│  │    stream-parser module               │       │
│  │  - Parse stream-json events          │       │
│  │  - Extract session_id                │       │
│  │  - Extract tool_name & detail        │       │
│  │  - Track step count                  │       │
│  └──────────────────────────────────────┘       │
│                                                   │
│  ┌──────────────────────────────────────┐       │
│  │     RunnerServer (HTTP + SSE)        │       │
│  │  - POST /jobs                         │       │
│  │  - GET /jobs, /jobs/:id, /jobs/:id/… │       │
│  │  - DELETE /jobs/:id                  │       │
│  │  - GET /health                       │       │
│  │  - SSE keep-alive & reconnection     │       │
│  └──────────────────────────────────────┘       │
└────────────────────┬────────────────────────────┘
                     │
                     │ Spawn detached (no pipes)
                     ▼
┌─────────────────────────────────────────────────┐
│      bun run.mjs (per job, detached)            │
│                                                   │
│  - Read args from args.json                      │
│  - Pipe msg.txt → claude stdin                   │
│  - Pipe claude stdout → stdout.jsonl             │
│  - Pipe claude stderr → stderr.log               │
│  - Write exit-code.txt on completion            │
│  - Survives runner crash                        │
└────────────────────┬────────────────────────────┘
                     │
                     │ Spawn with shell:false
                     ▼
┌─────────────────────────────────────────────────┐
│      claude.exe -p (per job)                    │
│  - Reads from stdin (piped from msg.txt)        │
│  - Writes to stdout (piped to stdout.jsonl)     │
│  - Emits stream-json events                     │
│  - Can be resumed with --resume                │
└─────────────────────────────────────────────────┘
```

## Data Flow

### Job Submission

```
1. Router: POST /jobs with JobRequest
   {
     topicKey: "123:456",
     projectPath: "/path/to/project",
     message: "user prompt",
     appendSystemPrompt: "system context",
     ...
   }

2. Runner: JobRegistry.createJob()
   - Generate jobId = UUID
   - Create jobDir = data/jobs/{jobId}
   - Call spawnClaudeDetached()

3. claude-spawn module:
   - Write args.json (claude args array)
   - Write env.json (environment variables)
   - Write cwd.txt (working directory)
   - Write msg.txt (user message)
   - Spawn: bun run.mjs {jobDir} (detached)
   - Return { wrapperPid, claudePidFile }

4. Runner:
   - Wait for claude.pid to appear (up to 1s)
   - Start FileTailer
   - Save meta.json
   - Persist to disk
   - Return jobId + pid to client

5. Client: Receives 201 Created with jobId
```

### Event Streaming

```
1. Router: GET /jobs/{jobId}/events with optional Last-Event-ID

2. Runner: RunnerServer.handleJobEvents()
   - Get FileTailer for job
   - If Last-Event-ID provided:
     * Read entire stdout.jsonl
     * Skip events 0 to Last-Event-ID
     * Send remaining events
   - Subscribe to live events
   - Start keep-alive timer (15s)

3. FileTailer (running in background):
   - Poll stdout.jsonl every 200ms
   - When new bytes detected:
     * Read from byteOffset to EOF
     * Split by newline
     * Parse each line as JSON
     * Emit to all subscribers

4. stream-parser module:
   - Parse each JSON line
   - Extract session_id if present
   - Extract tool_name & detail if present
   - Extract step count if present

5. RunnerServer:
   - For each event:
     * Send: event: stream-json\nid: N\ndata: {...}\n\n
     * Update job metadata (sessionId, currentTool, etc)
     * Update lastEventAt timestamp

6. Claude exits:
   - Run loop detects no new bytes for 2s
   - Emit: event: completed\ndata: {...}\n\n
   - Close SSE connection

7. Client: Receives stream of events, then completion
```

### Job Completion

```
1. claude.exe exits (normally or via timeout)

2. worker.mjs:
   - Reads exit code from proc
   - Writes exit-code.txt
   - Exits with same code

3. FileTailer:
   - Notices no new bytes for 2s
   - Sets isComplete = true
   - Notifies SSE subscribers

4. RunnerServer:
   - Sees isComplete = true
   - Sends completion event with exitCode
   - Closes SSE stream

5. JobRegistry (background):
   - Idle watchdog every 15s
   - Checks all running jobs
   - Removes process if dead
   - Updates state to "completed" or "failed"

6. Router:
   - Receives completion event
   - Stores sessionId for next --resume
   - Optionally: DELETE /jobs/{jobId} for cleanup
```

## File Structure

```
runner/
  src/
    index.ts           # Entry point, startup, PID management
    server.ts          # HTTP server, SSE routing, request handlers
    job-manager.ts     # JobRegistry: CRUD, persistence, idle watchdog
    claude-spawn.ts    # Process spawning, detached launch, PID tracking
    file-tailer.ts     # File polling, event emission, state tracking
    stream-parser.ts   # JSON parsing, session/tool extraction
    types.ts           # TypeScript interfaces
  package.json         # Dependencies, scripts
  tsconfig.json        # TypeScript config
  .gitignore          # Ignore data/, node_modules/
  README.md           # Full API documentation
  QUICKSTART.md       # Getting started
  INTEGRATION.md      # Router integration example
  ARCHITECTURE.md     # This file
  data/               # Runtime directory (git-ignored)
    jobs/
      {jobId}/
        meta.json           # Job metadata (persisted)
        msg.txt            # User input message
        args.json          # Claude CLI arguments
        env.json           # Environment variables
        cwd.txt            # Working directory path
        stdout.jsonl       # Claude output (tailed)
        stderr.log         # Claude stderr (tailed)
        claude.pid         # Claude process ID (written by worker)
        exit-code.txt      # Exit code (written by worker)
        error.log          # Error message (if spawn failed)
        worker.mjs         # Job worker script (from template)
    .runner.pid         # Runner process ID (single-instance lock)
```

## State Transitions

```
[spawning] → [running] → [completed]  (exit code 0)
         → [running] → [failed]       (exit code != 0)
         → [running] → [timeout]      (idle > idleTimeoutMinutes)
         → [running] → [cancelled]    (DELETE /jobs/:id)
         → [failed]                   (spawn error)
```

## Detached Spawning (Critical)

The key to surviving runner death:

```typescript
const proc = spawn("bun", ["run", workerPath], {
  stdio: "ignore",        // Don't inherit runner's stdio
  detached: true,         // Create new process group (Windows)
  windowsHide: true,      // Hide console window
});
proc.unref();             // Allow parent to exit
```

This creates a process completely independent of the runner. Even if runner crashes, bun and claude survive.

On Windows, `detached: true` creates a new job object. Killing the parent doesn't affect the child.

## File-Based IO (Critical)

Instead of pipes (which close on parent death):

```javascript
// In worker.mjs
const msgStream = createReadStream(jobDir/msg.txt);
const outStream = createWriteStream(jobDir/stdout.jsonl);

msgStream.pipe(proc.stdin);
proc.stdout.pipe(outStream);
```

Files are persistent. Even if reader disconnects, writer continues. No EPIPE possible.

## SSE Reconnection (Critical)

Clients store Last-Event-ID and reconnect:

```bash
# First request
GET /jobs/job-123/events

# Connection drops...

# Reconnect
GET /jobs/job-123/events
Last-Event-ID: 42
```

Runner reads stdout.jsonl from start, counts events, skips to ID 42, then sends remaining + live.

Offset tracking in FileTailer ensures we never lose events even if file is partially written.

## Idle Watchdog

Every 15 seconds, check `Date.now() - lastEventAt > idleTimeoutMinutes * 60000`:

```typescript
if (now - meta.lastEventAt > idleMs) {
  spawn("taskkill", ["/F", "/T", "/PID", String(meta.wrapperPid)]);
  meta.state = "timeout";
}
```

`taskkill /F /T` kills process tree (wrapper + claude) forcefully.

## Persistence & Recovery

On runner startup:

```
1. Scan data/jobs/ directory
2. For each job with meta.json:
   - If state === "running":
     * Check if wrapperPid is alive (process.kill(pid, 0))
     * If dead: check stdout.jsonl for exit code, mark completed/failed
     * If alive: restart FileTailer, resume streaming
3. Clean old jobs (completed >1h ago)
```

This allows seamless recovery without losing job state.

## MaxConcurrent Handling

Default limit: 15 concurrent jobs.

When limit reached:
```
POST /jobs → 503 Service Unavailable
{
  "error": "max_concurrent",
  "active": 15,
  "limit": 15
}
```

Router should:
1. Queue the request locally
2. Poll GET /jobs?active=true
3. Retry POST when active count < limit

## Performance Characteristics

- **Spawning**: ~500ms per job (bun startup overhead)
- **Event latency**: <300ms (200ms poll + buffering)
- **SSE reconnect**: <1s (read + skip to ID)
- **Memory**: ~50MB base + ~5MB per concurrent job
- **Disk**: ~100KB per job (meta + output files)
- **Max throughput**: 15 concurrent * X sequential = depends on job duration

## Security Considerations

1. **No authentication**: Runner assumes trusted network (localhost only)
2. **File permissions**: Job dirs are world-readable (contains prompts)
3. **Process isolation**: Claude runs under same user as runner
4. **Input validation**: Server validates JobRequest fields
5. **Command injection**: CLI args passed as array (shell:false), no escaping needed

For production:
- Bind to localhost only (not 0.0.0.0)
- Run as unprivileged user
- Use iptables/firewall to restrict access
- Rotate logs periodically

## Scalability

For >15 concurrent jobs:

1. **Horizontal scaling**: Run multiple runner instances on different ports
2. **Load balancing**: Router distributes jobs round-robin
3. **Shared storage**: Job dirs on NFS (for multi-machine)
4. **Process pooling**: Warm up claude processes in advance

Current design is single-machine, single-instance.
