// ローカルAI ストーリー自動制作サーバー（依存パッケージなし / Node.js 18+）
// - public/ の画面を配信
// - /api/chat   : OpenAI互換API（LM Studio / Ollama / llama.cpp / vLLM など）へ中継（ストリーミング）
// - /api/models : 利用可能なモデル一覧を中継
// - テストモード : モデルが無くても画面の動作確認ができるダミー生成

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const HOST = "127.0.0.1"; // 自分のPCからのみアクセス可
const PUBLIC_DIR = path.join(__dirname, "public");
const video = require("./video");
const v2v = require("./v2v");
const comfy = require("./comfy");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".wav": "audio/wav",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 5_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": MIME[".json"] });
  res.end(JSON.stringify(obj));
}

function normalizeBase(url) {
  return String(url || "http://127.0.0.1:1234/v1").replace(/\/+$/, "");
}

function authHeaders(apiKey) {
  const h = { "Content-Type": "application/json" };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

// ---- テストモード用ダミー生成 ----
const MOCK_LINES = [
  "風が止み、遠くで鐘の音が三度鳴った。",
  "彼女は振り返らずに、握りしめた地図をもう一度確かめた。",
  "その瞬間、足元の石畳がかすかに光を帯びはじめた。",
  "「ここで引き返すわけにはいかない」と彼は小さくつぶやいた。",
  "路地の奥から、見覚えのある影がゆっくりと近づいてくる。",
];
async function mockStream(res, messages) {
  const last = messages[messages.length - 1]?.content || "";
  const isSummary = /要約/.test(messages[0]?.content || "");
  const text = isSummary
    ? "【要約(テスト)】主人公は地図を頼りに旧市街を進み、謎の影と遭遇した。"
    : `（テストモード）指示「${last.split("\n").pop().slice(0, 40)}」を受けて――` +
      MOCK_LINES.sort(() => Math.random() - 0.5).slice(0, 3).join("");
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const ch of text) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
    await new Promise((r) => setTimeout(r, 15));
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

async function handleChat(req, res) {
  const body = JSON.parse(await readBody(req));
  const { baseUrl, apiKey, model, messages, temperature, max_tokens, mock } = body;
  if (mock) return mockStream(res, messages || []);

  const controller = new AbortController();
  res.on("close", () => controller.abort()); // 画面側で停止したら上流も止める

  let upstream;
  try {
    upstream = await fetch(`${normalizeBase(baseUrl)}/chat/completions`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        model,
        messages,
        temperature: temperature ?? 0.8,
        max_tokens: max_tokens ?? 800,
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    return sendJson(res, 502, { error: `ローカルAIに接続できません: ${e.message}` });
  }
  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text().catch(() => "");
    return sendJson(res, upstream.status || 502, { error: `AIサーバーエラー ${upstream.status}: ${t.slice(0, 500)}` });
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch (_) {
    /* 中断 */
  }
  res.end();
}

async function handleModels(req, res, url) {
  const baseUrl = url.searchParams.get("baseUrl");
  const apiKey = url.searchParams.get("apiKey") || "";
  try {
    const r = await fetch(`${normalizeBase(baseUrl)}/models`, { headers: authHeaders(apiKey) });
    const j = await r.json();
    sendJson(res, 200, { models: (j.data || []).map((m) => m.id) });
  } catch (e) {
    sendJson(res, 502, { error: `モデル一覧を取得できません: ${e.message}` });
  }
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  let root = PUBLIC_DIR;
  if (p.startsWith("/output/")) { root = video.OUT_DIR; p = p.slice("/output".length); }
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root + path.sep)) return sendJson(res, 403, { error: "forbidden" });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: "not found" });
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    // 動画のシーク用に Range に対応
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      res.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (req.method === "POST" && url.pathname === "/api/chat") return await handleChat(req, res);
      if (req.method === "GET" && url.pathname === "/api/models") return await handleModels(req, res, url);
      if (url.pathname.startsWith("/api/comfy/")) {
        if ((await comfy.handle(req, res, url, readBody, sendJson)) !== false) return;
      }
      if (url.pathname.startsWith("/api/v2v/")) {
        if ((await v2v.handle(req, res, url, readBody, sendJson)) !== false) return;
      }
      if (url.pathname.startsWith("/api/video/") || url.pathname.startsWith("/api/jobs/")) {
        if ((await video.handle(req, res, url, readBody, sendJson)) !== false) return;
      }
      if (req.method === "GET") return serveStatic(req, res, url);
      sendJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
      else res.end();
    }
  })
  .listen(PORT, HOST, () => {
    console.log(`ストーリーAI 起動: http://localhost:${PORT}`);
  });
