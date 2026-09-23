import { JobRegistry } from "./job-manager.ts";
import type { JobRequest, JobStatus } from "./types.ts";

export class RunnerServer {
  private registry: JobRegistry;
  private maxConcurrent: number;
  private port: number;
  private startedAt = Date.now();

  constructor(registry: JobRegistry, port = 7878, maxConcurrent = 15) {
    this.registry = registry;
    this.port = port;
    this.maxConcurrent = maxConcurrent;
  }

  async start(): Promise<void> {
    Bun.serve({
      port: this.port,
      // Loopback only: the runner accepts job submissions without auth.
      hostname: process.env.CLAUDE_RUNNER_HOST ?? "127.0.0.1",
      reusePort: true,
      // Disable 10s default idleTimeout. Without this, long SSE streams
      // (claude jobs that emit events sparsely) get cut at 10s and the
      // entire server's request loop floods stderr with timeout warnings,
      // eventually wedging the loop. Job submission then times out from
      // router-side as "Failed to submit job to runner: The operation
      // timed out". 0 = no idle timeout.
      idleTimeout: 0,
      fetch: (req) => this.handleRequest(req),
    });
    this.log(`Listening on http://127.0.0.1:${this.port}`);
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // POST /jobs
      if (path === "/jobs" && req.method === "POST") {
        return await this.handleCreateJob(req);
      }

      // GET /jobs
      if (path === "/jobs" && req.method === "GET") {
        return this.handleListJobs(req);
      }

      // GET /jobs/:id/events — MUST be before GET /jobs/:id
      const eventsMatch = path.match(/^\/jobs\/([^/]+)\/events$/);
      if (eventsMatch && req.method === "GET") {
        return this.handleJobEvents(req, eventsMatch[1]);
      }

      // GET /jobs/:id
      const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
      if (jobMatch && req.method === "GET") {
        return this.handleGetJob(jobMatch[1]);
      }

      // DELETE /jobs/:id
      if (jobMatch && req.method === "DELETE") {
        return await this.handleDeleteJob(path.split("/")[2]);
      }

      // GET /health
      if (path === "/health" && req.method === "GET") {
        return this.handleHealth();
      }

      return this.json(404, { error: "Not found" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Error: ${req.method} ${path}: ${msg}`);
      return this.json(500, { error: msg });
    }
  }

  // ─── POST /jobs ───────────────────────────────────────────────
  private async handleCreateJob(req: Request): Promise<Response> {
    const activeCount = this.registry.getActiveJobCount();
    if (activeCount >= this.maxConcurrent) {
      return this.json(503, {
        error: "max_concurrent",
        active: activeCount,
        limit: this.maxConcurrent,
      });
    }

    let body: JobRequest;
    try {
      body = (await req.json()) as JobRequest;
    } catch {
      return this.json(400, { error: "Invalid JSON" });
    }

    if (!body.topicKey || !body.projectPath || !body.message || !body.claudePath) {
      return this.json(400, { error: "Missing required fields: topicKey, projectPath, message, claudePath" });
    }

    const jobId = await this.registry.createJob(body);
    const meta = this.registry.getJob(jobId);

    return this.json(201, { jobId, pid: meta?.pid });
  }

  // ─── GET /jobs ────────────────────────────────────────────────
  private handleListJobs(req: Request): Response {
    const url = new URL(req.url);
    const active = url.searchParams.get("active") === "true";
    const topicKey = url.searchParams.get("topicKey") || undefined;

    const jobs = this.registry.listJobs({ active, topicKey });
    return this.json(200, {
      jobs: jobs.map((j) => this.registry.getJobStatus(j.jobId)),
    });
  }

  // ─── GET /jobs/:id ────────────────────────────────────────────
  private handleGetJob(jobId: string): Response {
    const status = this.registry.getJobStatus(jobId);
    if (!status) return this.json(404, { error: "Job not found" });
    return this.json(200, status);
  }

  // ─── GET /jobs/:id/events (SSE) ──────────────────────────────
  private handleJobEvents(req: Request, jobId: string): Response {
    const meta = this.registry.getJob(jobId);
    if (!meta) return this.json(404, { error: "Job not found" });

    const tailer = this.registry.getTailer(jobId);
    if (!tailer) {
      // Job exists but tailer gone — job likely completed. Return
      // a one-shot SSE with the completion event.
      const body =
        `event: completed\ndata: ${JSON.stringify({
          exitCode: meta.exitCode,
          sessionId: meta.sessionId,
        })}\n\n`;
      return new Response(body, { headers: sseHeaders() });
    }

    const lastEventId = req.headers.get("Last-Event-ID");
    const lastEventNum = lastEventId ? parseInt(lastEventId, 10) : -1;

    const registry = this.registry;

    const readable = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (text: string) => {
          try { controller.enqueue(encoder.encode(text)); } catch {}
        };

        // 1. Replay past events from tailer history
        tailer.replay(lastEventNum, (event) => {
          const data = JSON.stringify(event.parsed?.raw || {});
          send(`event: stream-json\nid: ${event.eventId}\ndata: ${data}\n\n`);
        });

        // 2. Subscribe to new events
        const unsubscribe = tailer.subscribe((event) => {
          if (event.eventId <= lastEventNum) return;
          const data = JSON.stringify(event.parsed?.raw || {});
          send(`event: stream-json\nid: ${event.eventId}\ndata: ${data}\n\n`);

          // Update job metadata from parsed event
          if (event.parsed) {
            const updates: Record<string, unknown> = {
              lastEventAt: Date.now(),
              stepCount: (meta.stepCount || 0) + 1,
            };
            if (event.parsed.sessionId) updates.sessionId = event.parsed.sessionId;
            if (event.parsed.toolName) {
              updates.currentTool = event.parsed.toolName;
              updates.toolDetail = event.parsed.toolDetail;
            }
            registry.updateJobMetadata(jobId, updates);
          }
        });

        // 3. Keep-alive ping every 15s
        const keepAlive = setInterval(() => {
          send(":ping\n\n");
        }, 15000);

        // 4. Poll for completion
        const completionPoll = setInterval(() => {
          // Re-read meta from registry (may have been updated)
          const current = registry.getJob(jobId);
          if (!current) {
            cleanup();
            return;
          }
          if (
            current.state === "completed" ||
            current.state === "failed" ||
            current.state === "timeout" ||
            current.state === "cancelled"
          ) {
            send(
              `event: completed\ndata: ${JSON.stringify({
                exitCode: current.exitCode,
                sessionId: current.sessionId,
                state: current.state,
              })}\n\n`
            );
            cleanup();
          }
        }, 500);

        function cleanup() {
          clearInterval(keepAlive);
          clearInterval(completionPoll);
          unsubscribe();
          try { controller.close(); } catch {}
        }
      },
    });

    return new Response(readable, { headers: sseHeaders() });
  }

  // ─── DELETE /jobs/:id ─────────────────────────────────────────
  private async handleDeleteJob(jobId: string): Promise<Response> {
    const killed = await this.registry.cancelJob(jobId);
    return this.json(200, { killed });
  }

  // ─── GET /health ──────────────────────────────────────────────
  private handleHealth(): Response {
    return this.json(200, {
      ok: true,
      activeJobs: this.registry.getActiveJobCount(),
      totalJobs: this.registry.listJobs().length,
      uptime: Date.now() - this.startedAt,
      pid: process.pid,
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────
  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  private log(msg: string): void {
    console.log(`[Runner] [${new Date().toISOString()}] ${msg}`);
  }
}

function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  };
}
