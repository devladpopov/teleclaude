/**
 * Knowledge Base integration hook.
 * Sends every message to the TG Knowledge Base for semantic indexing.
 * Fire-and-forget — never blocks message processing.
 */

export class KnowledgeBaseHook {
  private baseUrl: string;
  private secret: string;

  constructor(baseUrl: string, secret: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.secret = secret;
  }

  /**
   * Send a message to the knowledge base for indexing.
   * Never throws — errors are logged and swallowed.
   */
  async ingest(payload: {
    msg_id: string;
    chat_id: string;
    thread_id: string;
    sender: string;
    date: string;
    text: string;
    msg_type: string;
  }): Promise<void> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.secret}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        console.error(`[KB] Ingest failed: ${resp.status}`);
      }
    } catch (err) {
      // Swallow — KB is optional, never block message flow
      console.error(`[KB] Ingest error: ${(err as Error).message}`);
    }
  }
}
