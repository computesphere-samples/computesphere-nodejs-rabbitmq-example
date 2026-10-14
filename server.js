// A web service that hands jobs to a worker through RabbitMQ. One image, two roles:
//
//   ROLE=web     serves the page; each job is sent to the "jobs" queue and the page
//                waits for the worker's answer (the reply comes back on RabbitMQ's
//                direct reply-to).
//                  GET  /          a form to send a job
//                  POST /jobs      sends the text as a job, shows the worker's answer
//                  GET  /healthz   200 while connected to RabbitMQ
//                  GET  /selftest  200 when a job goes to the worker and comes back
//   ROLE=worker  takes jobs from the "jobs" queue, one at a time, and answers each one
//                (the word count and the text reversed).
//
// Settings (environment variables):
//   AMQP_URL  the queue's connection string, e.g. amqps://<user>:<password>@<host>:5671/%2F
//   CA_DIR    where the queue's CA certificate is found (default /etc/computesphere/db);
//             every *.crt file in it is trusted. Read again on every connection attempt,
//             because it can appear a little after the app starts.
//   PORT      the web role's port (default 3000)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const amqp = require("amqplib");

const ROLE = process.env.ROLE || "web";
const PORT = Number(process.env.PORT || 3000);
const AMQP_URL = process.env.AMQP_URL || "amqp://guest:guest@localhost:5672";
const CA_DIR = process.env.CA_DIR || "/etc/computesphere/db";
const QUEUE = "jobs";
const REPLY_TO = "amq.rabbitmq.reply-to";
const JOB_TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readCAs() {
  try {
    return fs
      .readdirSync(CA_DIR)
      .filter((f) => f.endsWith(".crt"))
      .map((f) => fs.readFileSync(path.join(CA_DIR, f), "utf8"));
  } catch {
    return [];
  }
}

// connect keeps trying until RabbitMQ takes the connection, then calls setup
// with it; when the connection drops, it starts again.
async function connect(setup) {
  const tls = AMQP_URL.startsWith("amqps://");
  for (;;) {
    const ca = tls ? readCAs() : [];
    if (tls && ca.length === 0) {
      console.log(`waiting for a CA certificate in ${CA_DIR}`);
      await sleep(5000);
      continue;
    }
    try {
      const conn = await amqp.connect(AMQP_URL, tls ? { ca } : {});
      conn.on("error", (err) => console.error("rabbitmq:", err.message));
      const closed = new Promise((r) => conn.once("close", r));
      await setup(conn);
      console.log("connected to rabbitmq");
      await closed;
      console.log("rabbitmq connection closed; reconnecting");
    } catch (err) {
      console.error("rabbitmq connect failed:", err.message);
    }
    await sleep(5000);
  }
}

// ── worker ──────────────────────────────────────────────────────────────

function answer(text) {
  const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  return { words, reversed: [...text].reverse().join("") };
}

async function worker() {
  await connect(async (conn) => {
    const ch = await conn.createChannel();
    await ch.assertQueue(QUEUE, { durable: true });
    await ch.prefetch(1);
    await ch.consume(QUEUE, (msg) => {
      if (!msg) return;
      let job = {};
      try {
        job = JSON.parse(msg.content.toString());
      } catch {}
      const result = answer(String(job.text || ""));
      if (msg.properties.replyTo) {
        ch.sendToQueue(msg.properties.replyTo, Buffer.from(JSON.stringify(result)), {
          correlationId: msg.properties.correlationId,
          contentType: "application/json",
        });
      }
      ch.ack(msg);
      console.log(`job ${msg.properties.correlationId || "-"}: ${result.words} words`);
    });
  });
}

// ── web ─────────────────────────────────────────────────────────────────

let channel = null;
const waiting = new Map(); // correlation id -> { resolve, timer }

function send(text) {
  return new Promise((resolve, reject) => {
    if (!channel) return reject(new Error("not connected to rabbitmq"));
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error("no answer from the worker in time"));
    }, JOB_TIMEOUT_MS);
    waiting.set(id, { resolve, timer });
    channel.sendToQueue(QUEUE, Buffer.from(JSON.stringify({ text })), {
      correlationId: id,
      replyTo: REPLY_TO,
      contentType: "application/json",
      persistent: true,
    });
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(body) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jobs over RabbitMQ</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem; color: #0f172a; }
  textarea { width: 100%; min-height: 6rem; font: inherit; }
  button { font: inherit; padding: .4rem 1rem; margin-top: .5rem; }
  p { color: #475569; }
  pre { background: #f1f5f9; padding: 1rem; white-space: pre-wrap; }
</style></head>
<body>
  <h1>Jobs over RabbitMQ</h1>
  <p>The text goes to the worker through the <code>jobs</code> queue, and the worker's answer comes back here.</p>
  <form method="post" action="/jobs">
    <textarea name="text" maxlength="2000" placeholder="Some text for the worker"></textarea>
    <button type="submit">Send job</button>
  </form>
  ${body}
</body></html>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 16384) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function web() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (code, v) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (url.pathname === "/healthz") return json(channel ? 200 : 503, { ok: !!channel });
    if (url.pathname === "/selftest") {
      try {
        const r = await send("ping from the selftest");
        return json(r.words === 4 ? 200 : 500, { ok: r.words === 4, worker: r });
      } catch (err) {
        return json(503, { ok: false, error: err.message });
      }
    }
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(page(""));
    }
    if (url.pathname === "/jobs" && req.method === "POST") {
      const text = new URLSearchParams(await readBody(req)).get("text") || "";
      try {
        const r = await send(text.slice(0, 2000));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(page(`<h2>The worker's answer</h2><pre>${r.words} words\nreversed: ${esc(r.reversed)}</pre>`));
      } catch (err) {
        res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
        return res.end(page(`<p>${esc(err.message)}. Try again in a few seconds.</p>`));
      }
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });
  server.listen(PORT, () => console.log(`listening on ${PORT}`));

  connect(async (conn) => {
    const ch = await conn.createChannel();
    await ch.assertQueue(QUEUE, { durable: true });
    await ch.consume(
      REPLY_TO,
      (msg) => {
        const w = msg && waiting.get(msg.properties.correlationId);
        if (!w) return;
        clearTimeout(w.timer);
        waiting.delete(msg.properties.correlationId);
        w.resolve(JSON.parse(msg.content.toString()));
      },
      { noAck: true },
    );
    conn.once("close", () => {
      channel = null;
    });
    channel = ch;
  });
}

if (ROLE === "worker") worker();
else web();

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => setTimeout(() => process.exit(0), 500).unref());
