/**
 * Playwright MCP SSE Keepalive Client
 *
 * Держит постоянное SSE-подключение к Playwright MCP демону,
 * чтобы тот не закрывал shared browser context при отключении
 * последнего "рабочего" клиента (claude -p).
 *
 * Без этого: claude -p подключается → открывает страницу →
 * claude -p выходит → демон видит 0 клиентов → закрывает браузер.
 *
 * С этим: keepalive всегда подключён (1 клиент) → claude -p
 * подключается (2 клиента) → claude -p выходит (1 клиент) →
 * демон видит 1 клиент → браузер живёт.
 *
 * Запуск: node playwright-keepalive.mjs
 * Или через playwright-mcp-daemon.ps1 (автозапуск).
 */

const SSE_URL = 'http://localhost:8931/sse';
const RECONNECT_DELAY_MS = 5000;

function connect() {
  console.log(`[keepalive] Connecting to ${SSE_URL}...`);

  fetch(SSE_URL, {
    headers: { 'Accept': 'text/event-stream' },
    // no signal/timeout — SSE stream lives forever
  }).then(async (res) => {
    if (!res.ok) {
      console.error(`[keepalive] HTTP ${res.status}, retrying in ${RECONNECT_DELAY_MS}ms`);
      setTimeout(connect, RECONNECT_DELAY_MS);
      return;
    }
    console.log(`[keepalive] Connected (status=${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // SSE data — just consume, don't act on it
        const text = decoder.decode(value, { stream: true });
        if (text.includes('endpoint')) {
          // MCP init message — log once for debugging
          console.log(`[keepalive] Got MCP endpoint message, session alive`);
        }
      }
    } catch (err) {
      console.error(`[keepalive] Stream error: ${err.message}`);
    }

    console.log(`[keepalive] Disconnected, reconnecting in ${RECONNECT_DELAY_MS}ms...`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  }).catch((err) => {
    console.error(`[keepalive] Fetch error: ${err.message}, retrying in ${RECONNECT_DELAY_MS}ms`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  });
}

// Handle graceful shutdown
process.on('SIGINT', () => { console.log('[keepalive] SIGINT, exiting'); process.exit(0); });
process.on('SIGTERM', () => { console.log('[keepalive] SIGTERM, exiting'); process.exit(0); });

connect();
