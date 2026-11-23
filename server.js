// Relay + MCP server for a Roblox executor client. Zero dependencies, Node >= 18.
//
//  Claude --(MCP, JSON-RPC over HTTP)--> /mcp
//  Roblox client --(HTTP long-poll)--> /client/poll, /client/result, /client/autoexec
//
import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.RELAY_TOKEN ?? "";
const AUTOEXEC_FILE = process.env.AUTOEXEC_FILE ?? "./autoexec.lua";

if (TOKEN.length < 24) {
  console.error("Set RELAY_TOKEN to a random string of 24+ characters.");
  process.exit(1);
}

const POLL_HOLD_MS = 25_000;
const CLIENT_ALIVE_MS = 40_000;
const MAX_BODY = 2_000_000;
const MAX_RESULT_CHARS = 200_000;
const DEFAULT_EVAL_TIMEOUT_MS = 10_000;
const MIN_EVAL_TIMEOUT_MS = 1_000;
const MAX_EVAL_TIMEOUT_MS = 60_000;
const MAX_CONSOLE_LINES = 500;
const DEFAULT_CONSOLE_LINES = 50;
const NO_CLIENT_ERROR = "No Roblox client is connected to this channel.";

const pendingJobs = new Map(); // id -> { resolve, timer }
const jobQueue = []; // { id, code } waiting for a poller
const waiters = []; // long-poll requests waiting for a job: { res, timer }
let lastSeenAt = 0;

// ---------- helpers ----------

function tokenOk(candidate) {
  const a = Buffer.from(String(candidate ?? ""));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerOf(req) {
  return (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid JSON");
  }
}

function sendJson(res, status, obj) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function isClientConnected() {
  return waiters.length > 0 || Date.now() - lastSeenAt < CLIENT_ALIVE_MS;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// ---------- job dispatch to the Roblox client ----------

function dispatch() {
  while (jobQueue.length > 0 && waiters.length > 0) {
    const waiter = waiters.pop(); // newest poller wins; older ones may be dead
    clearTimeout(waiter.timer);
    if (waiter.res.destroyed || waiter.res.writableEnded) continue;
    sendJson(waiter.res, 200, { job: jobQueue.shift() });
  }
}

function runOnClient(code, timeoutMs) {
  if (!isClientConnected()) {
    return Promise.resolve({ ok: false, error: NO_CLIENT_ERROR });
  }
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingJobs.delete(id);
      const queued = jobQueue.findIndex((j) => j.id === id);
      if (queued !== -1) jobQueue.splice(queued, 1);
      resolve({ ok: false, error: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    pendingJobs.set(id, { resolve, timer });
    jobQueue.push({ id, code });
    dispatch();
  });
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_EVAL_TIMEOUT_MS;
  return Math.min(Math.max(n, MIN_EVAL_TIMEOUT_MS), MAX_EVAL_TIMEOUT_MS);
}

function limitText(text) {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return text.slice(0, MAX_RESULT_CHARS) + `\n...[truncated, ${text.length - MAX_RESULT_CHARS} more chars]`;
}

// ---------- autoexec storage (the client script runs it on every launch) ----------

async function readAutoexec() {
  try {
    return await readFile(AUTOEXEC_FILE, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// ---------- MCP tools ----------

const TOOLS = [
  {
    name: "Eval",
    description:
      "Run Luau code on the connected Roblox client and return what it returns. Use `return` to get values back.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Luau source to execute." },
        timeoutMs: {
          type: "number",
          description: `Max wait in ms (${MIN_EVAL_TIMEOUT_MS}-${MAX_EVAL_TIMEOUT_MS}, default ${DEFAULT_EVAL_TIMEOUT_MS}).`,
        },
      },
      required: ["code"],
    },
    async run(args) {
      if (typeof args.code !== "string" || args.code.length === 0) {
        return fail("code must be a non-empty string");
      }
      const r = await runOnClient(args.code, clampTimeout(args.timeoutMs));
      if (!r.ok) return fail(r.error ?? "unknown error");
      const returns = Array.isArray(r.result) ? r.result : [];
      return text({ success: true, returnCount: returns.length, returns });
    },
  },
  {
    name: "ReadRblxConsole",
    description: "Read recent lines of the Roblox client's developer console (LogService history).",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: `Number of most recent lines (1-${MAX_CONSOLE_LINES}, default ${DEFAULT_CONSOLE_LINES}).`,
        },
      },
    },
    async run(args) {
      const requested = Number.isInteger(args.limit) ? args.limit : DEFAULT_CONSOLE_LINES;
      const limit = Math.min(Math.max(requested, 1), MAX_CONSOLE_LINES);
      const code = `
        local history = game:GetService("LogService"):GetLogHistory()
        local out = {}
        for i = math.max(1, #history - ${limit} + 1), #history do
          local e = history[i]
          out[#out + 1] = { time = e.timestamp, type = tostring(e.messageType), message = e.message }
        end
        return out
      `;
      const r = await runOnClient(code, DEFAULT_EVAL_TIMEOUT_MS);
      if (!r.ok) return fail(r.error ?? "unknown error");
      const lines = Array.isArray(r.result) && Array.isArray(r.result[0]) ? r.result[0] : [];
      return text({ success: true, lineCount: lines.length, lines });
    },
  },
  {
    name: "SetAutoexec",
    description:
      "Store Luau code on the server. The Roblox client script fetches and runs it every time it starts.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "Luau source to run on every client start." } },
      required: ["code"],
    },
    async run(args) {
      if (typeof args.code !== "string" || args.code.length === 0) {
        return fail("code must be a non-empty string");
      }
      await writeFile(AUTOEXEC_FILE, args.code, "utf8");
      return text({ success: true, bytes: Buffer.byteLength(args.code), sha256: sha256(args.code) });
    },
  },
  {
    name: "CheckAutoexec",
    description: "Report whether autoexec code is stored, with its size, hash and a short preview.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const code = await readAutoexec();
      if (code === null) return text({ exists: false });
      return text({
        exists: true,
        bytes: Buffer.byteLength(code),
        sha256: sha256(code),
        preview: code.slice(0, 300),
      });
    },
  },
  {
    name: "DelAutoexec",
    description: "Delete the stored autoexec code.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const existed = (await readAutoexec()) !== null;
      await rm(AUTOEXEC_FILE, { force: true });
      return text({ success: true, existed });
    },
  },
];

function text(obj) {
  return { content: [{ type: "text", text: limitText(JSON.stringify(obj, null, 2)) }] };
}

function fail(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

// ---------- MCP JSON-RPC ----------

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleRpc(msg) {
  if (typeof msg !== "object" || msg === null || typeof msg.method !== "string") {
    return rpcError(msg?.id ?? null, -32600, "Invalid Request");
  }
  const { id, method, params } = msg;
  if (id === undefined || method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "relay", version: "1.0.0" },
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        return rpcResult(id, await tool.run(params?.arguments ?? {}));
      } catch (e) {
        return rpcResult(id, fail(`tool failed: ${e.message}`));
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function handleMcp(req, res, pathToken) {
  if (!tokenOk(pathToken ?? bearerOf(req))) return sendJson(res, 401, { error: "unauthorized" });
  if (req.method !== "POST") return sendJson(res, 405, { error: "use POST" });

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendJson(res, 400, rpcError(null, -32700, e.message));
  }

  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map(handleRpc))).filter((r) => r !== null);
    if (responses.length === 0) {
      res.writeHead(202);
      return res.end();
    }
    return sendJson(res, 200, responses);
  }

  const response = await handleRpc(body);
  if (response === null) {
    res.writeHead(202);
    return res.end();
  }
  return sendJson(res, 200, response);
}

// ---------- HTTP server ----------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      return sendJson(res, 200, { ok: true, clientConnected: isClientConnected() });
    }

    // MCP endpoint: /mcp (Authorization header) or /mcp/<token> (secret in the URL)
    if (path === "/mcp" || path.startsWith("/mcp/")) {
      const pathToken = path.startsWith("/mcp/") ? decodeURIComponent(path.slice(5)) : null;
      return handleMcp(req, res, pathToken);
    }

    // Everything below needs the bearer token.
    if (!tokenOk(bearerOf(req))) return sendJson(res, 401, { ok: false, error: "unauthorized" });

    // Plain REST version of Eval, handy with curl.
    if (req.method === "POST" && path === "/eval") {
      const body = await readJson(req);
      if (typeof body.code !== "string" || body.code.length === 0) {
        return sendJson(res, 400, { ok: false, error: "code must be a non-empty string" });
      }
      return sendJson(res, 200, await runOnClient(body.code, clampTimeout(body.timeoutMs)));
    }

    // Roblox client: long-poll for the next job.
    if (req.method === "POST" && path === "/client/poll") {
      lastSeenAt = Date.now();
      const waiter = { res, timer: null };
      waiter.timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i !== -1) waiters.splice(i, 1);
        lastSeenAt = Date.now();
        sendJson(res, 200, {});
      }, POLL_HOLD_MS);
      res.on("close", () => {
        clearTimeout(waiter.timer);
        const i = waiters.indexOf(waiter);
        if (i !== -1) waiters.splice(i, 1);
        lastSeenAt = Date.now();
      });
      waiters.push(waiter);
      dispatch();
      return;
    }

    // Roblox client: deliver a job result.
    if (req.method === "POST" && path === "/client/result") {
      const msg = await readJson(req);
      const entry = pendingJobs.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        pendingJobs.delete(msg.id);
        entry.resolve({ ok: msg.ok === true, result: msg.result, error: msg.error });
      }
      return sendJson(res, 200, { ok: true });
    }

    // Roblox client: fetch the autoexec code on startup.
    if (req.method === "GET" && path === "/client/autoexec") {
      return sendJson(res, 200, { code: await readAutoexec() });
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message });
  }
});

server.listen(PORT, () => console.log(`relay listening on :${PORT}`));
