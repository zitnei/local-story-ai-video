// 動画生成モジュール
//  - ComfyUI 連携：段落ごとの映像クリップ生成（Wan / LTX-Video / Hunyuan など、APIフォーマットのワークフローなら何でも可）
//  - ナレーション：Windows 標準音声合成（Haruka など）で WAV を作成
//  - 書き出し：ffmpeg でクリップ＋ナレーション＋字幕を1本の MP4 に結合

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const OUT_DIR = path.join(__dirname, "output");
const DIRS = {
  clips: path.join(OUT_DIR, "clips"),
  audio: path.join(OUT_DIR, "audio"),
  work: path.join(OUT_DIR, "work"),
  videos: path.join(OUT_DIR, "videos"),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

DIRS.refs = path.join(OUT_DIR, "refs");
fs.mkdirSync(DIRS.refs, { recursive: true });
const safeId = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "x";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toUrl = (abs) => "/output/" + path.relative(OUT_DIR, abs).split(path.sep).join("/");

// ---------------- ジョブ管理 ----------------
const jobs = new Map();
let jobSeq = 0;
function startJob(fn) {
  const id = String(++jobSeq);
  const job = { id, status: "running", progress: "", result: null, error: null };
  jobs.set(id, job);
  fn((p) => (job.progress = p))
    .then((r) => { job.status = "done"; job.result = r; })
    .catch((e) => { job.status = "error"; job.error = e.message; });
  return id;
}

// ---------------- 外部コマンド ----------------
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} 失敗 (${code}): ${err.slice(-800)}`))
    );
  });
}
async function mediaDuration(file) {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return parseFloat(out) || 0;
}

// ---------------- ComfyUI ----------------
function prepareWorkflow(workflow, prompt, negative) {
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow.nodes)) {
    throw new Error("ワークフローは ComfyUI の「Export (API)」形式のJSONを指定してください。");
  }
  const esc = (s) => JSON.stringify(String(s || "")).slice(1, -1);
  let str = JSON.stringify(workflow);
  const hasPlaceholder = str.includes("%PROMPT%");
  str = str.split("%PROMPT%").join(esc(prompt)).split("%NEGATIVE%").join(esc(negative));
  const wf = JSON.parse(str);

  // %PROMPT% が無い場合：ポジティブ側のテキスト入力ノードに差し込む
  if (!hasPlaceholder) {
    const textNodes = Object.values(wf).filter((n) => typeof n?.inputs?.text === "string");
    const pos = textNodes.find((n) => !/neg/i.test(n._meta?.title || "")) || textNodes[0];
    if (!pos) throw new Error("ワークフロー内にプロンプト入力（text）が見つかりません。プロンプト欄に %PROMPT% と書いてから書き出してください。");
    pos.inputs.text = prompt;
    const neg = textNodes.find((n) => /neg/i.test(n._meta?.title || ""));
    if (neg && negative) neg.inputs.text = negative;
  }
  // シードを毎回ランダムに
  for (const n of Object.values(wf)) {
    for (const k of ["seed", "noise_seed"]) {
      if (typeof n?.inputs?.[k] === "number") n.inputs[k] = Math.floor(Math.random() * 2 ** 32);
    }
  }
  return wf;
}

const comfyBase = (u) => String(u || "http://127.0.0.1:8188").replace(/\/+$/, "");

// 生成サイズ（縦・横）をワークフローに当てはめる
function applySize(wf, width, height) {
  if (!width || !height) return wf;
  for (const n of Object.values(wf)) {
    const inp = n?.inputs;
    if (!inp || !/ToVideo|Vace|EmptyHunyuanLatentVideo|EmptyLTXV|EmptyMochi|EmptyCosmos/i.test(String(n.class_type || ""))) continue;
    if (typeof inp.width === "number") inp.width = width;
    if (typeof inp.height === "number") inp.height = height;
  }
  return wf;
}

async function comfyClip({ comfyUrl, workflow, prompt, negative, segId, width, height }, progress) {
  const wf = applySize(prepareWorkflow(workflow, prompt, negative), Number(width) || 0, Number(height) || 0);
  const dest = await comfyRun(comfyBase(comfyUrl), wf, `${safeId(segId)}_${Date.now()}`, DIRS.clips, progress);
  return { url: toUrl(dest) };
}

// ワークフローを実行し、出力ファイル（動画優先）を destDir に保存してパスを返す
async function comfyRun(base, wf, name, destDir, progress) {
  progress("ComfyUI に送信中");
  const r = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: wf, client_id: "story-ai" }),
  }).catch((e) => { throw new Error(`ComfyUI に接続できません (${base}): ${e.message}`); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.prompt_id) throw new Error(`ComfyUI エラー: ${JSON.stringify(j.node_errors || j.error || j).slice(0, 600)}`);
  const pid = j.prompt_id;

  const t0 = Date.now();
  while (true) {
    await sleep(2000);
    const sec = Math.round((Date.now() - t0) / 1000);
    progress(`ComfyUI で生成中… ${sec}秒`);
    if (sec > 60 * 60) throw new Error("ComfyUI の生成が60分を超えたため中止しました。");
    const h = await (await fetch(`${base}/history/${pid}`)).json().catch(() => ({}));
    const entry = h[pid];
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      const msg = (entry.status.messages || []).find((m) => m[0] === "execution_error")?.[1];
      throw new Error(`ComfyUI 実行エラー: ${msg?.exception_message || "不明"}`);
    }
    const files = [];
    for (const out of Object.values(entry.outputs || {})) {
      for (const key of ["videos", "gifs", "images", "animated"]) {
        for (const f of Array.isArray(out[key]) ? out[key] : []) if (f?.filename) files.push(f);
      }
    }
    if (!files.length) {
      if (entry.status?.completed) throw new Error("ComfyUI の出力ファイルが見つかりません（保存ノードがありますか？）");
      continue;
    }
    const isVideo = (f) => /\.(mp4|webm|mov|mkv|gif|webp)$/i.test(f.filename);
    const pick = files.filter((f) => f.type !== "temp").filter(isVideo).pop() || files.filter(isVideo).pop() || files.pop();
    progress("クリップを保存中");
    const q = new URLSearchParams({ filename: pick.filename, subfolder: pick.subfolder || "", type: pick.type || "output" });
    const fr = await fetch(`${base}/view?${q}`);
    if (!fr.ok) throw new Error(`ComfyUI からファイル取得失敗: ${fr.status}`);
    const ext = path.extname(pick.filename).toLowerCase() || ".mp4";
    const dest = path.join(destDir, `${name}${ext}`);
    fs.writeFileSync(dest, Buffer.from(await fr.arrayBuffer()));
    return dest;
  }
}

// テストモード：ffmpeg でダミー映像を作る
async function mockClip({ segId }, progress) {
  progress("テスト用クリップを作成中");
  const dest = path.join(DIRS.clips, `${safeId(segId)}_${Date.now()}.mp4`);
  const hue = Math.floor(Math.random() * 360);
  await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=s=848x480:r=24:d=3",
    "-vf", `hue=h=${hue},format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", dest]);
  return { url: toUrl(dest) };
}

// ---------------- ナレーション（Windows 音声合成） ----------------
async function tts({ text, segId, rate = 0, voice = "" }, progress) {
  progress("ナレーション音声を作成中");
  const id = `${safeId(segId)}_${Date.now()}`;
  const txt = path.join(DIRS.work, `${id}.txt`);
  const wav = path.join(DIRS.audio, `${id}.wav`);
  fs.writeFileSync(txt, String(text), "utf8");
  const ps = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$v = $s.GetInstalledVoices() | % { $_.VoiceInfo } | ? { $_.Culture.Name -eq 'ja-JP' } | Select-Object -First 1",
    voice ? `try { $s.SelectVoice('${String(voice).replace(/'/g, "''")}') } catch { if ($v) { $s.SelectVoice($v.Name) } }`
          : "if ($v) { $s.SelectVoice($v.Name) }",
    `$s.Rate = ${Math.max(-10, Math.min(10, Number(rate) || 0))}`,
    `$s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}')`,
    `$s.Speak([IO.File]::ReadAllText('${txt.replace(/'/g, "''")}', [Text.Encoding]::UTF8))`,
    "$s.Dispose()",
  ].join("; ");
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  fs.rmSync(txt, { force: true });
  return { url: toUrl(wav), duration: await mediaDuration(wav) };
}

// ---------------- 字幕（ASS） ----------------
function splitSubtitle(text, maxLine = 24) {
  const sentences = String(text).replace(/\r/g, "").split(/(?<=[。！？!?」\n])/).map((s) => s.trim()).filter(Boolean);
  const cues = [];
  for (const s of sentences) {
    for (let i = 0; i < s.length; i += maxLine * 2) {
      const part = s.slice(i, i + maxLine * 2);
      cues.push(part.length > maxLine ? part.slice(0, maxLine) + "\\N" + part.slice(maxLine) : part);
    }
  }
  return cues;
}
function assTime(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = (t % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${s}`;
}
function buildAss(text, duration, w, h) {
  const cues = splitSubtitle(text);
  const total = cues.reduce((a, c) => a + c.length, 0) || 1;
  const fontSize = Math.round(Math.min(w, h) * 0.055);
  let t = 0;
  const events = cues.map((c) => {
    const d = (c.length / total) * duration;
    const line = `Dialogue: 0,${assTime(t)},${assTime(t + d)},Default,,0,0,0,,${c.replace(/[{}]/g, "")}`;
    t += d;
    return line;
  });
  return [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${w}`, `PlayResY: ${h}`, "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,Yu Gothic UI,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,1,2,40,40,${Math.round(h * 0.06)},1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events, "",
  ].join("\n");
}

// ---------------- 書き出し ----------------
const urlToPath = (u) => {
  if (!u || !u.startsWith("/output/")) return null;
  const p = path.normalize(path.join(OUT_DIR, decodeURIComponent(u.slice("/output/".length))));
  return p.startsWith(OUT_DIR) && fs.existsSync(p) ? p : null;
};

async function render({ segments, width = 1280, height = 720, subtitles = true, title = "story" }, progress) {
  if (!Array.isArray(segments) || !segments.length) throw new Error("書き出す段落がありません。");
  const W = Math.round(width / 2) * 2, H = Math.round(height / 2) * 2;
  const jobDir = path.join(DIRS.work, `render_${Date.now()}`);
  fs.mkdirSync(jobDir, { recursive: true });
  const parts = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    progress(`パート ${i + 1}/${segments.length} を作成中`);
    const clip = urlToPath(seg.clip);
    const audio = urlToPath(seg.audio);
    const duration = audio
      ? (await mediaDuration(audio)) + 0.6
      : Math.max(4, String(seg.text || "").length / 8); // 音声なし：1秒8文字で読める長さ

    const args = ["-y"];
    if (clip && /\.(png|jpe?g)$/i.test(clip)) args.push("-loop", "1", "-i", clip); // 静止画

    else if (clip) args.push("-stream_loop", "-1", "-i", clip);
    else args.push("-f", "lavfi", "-i", `color=c=0x141824:s=${W}x${H}:r=24`);
    if (audio) args.push("-i", audio);
    else args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");

    let vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=24,format=yuv420p`;
    if (subtitles && seg.text) {
      fs.writeFileSync(path.join(jobDir, `sub${i}.ass`), buildAss(seg.text, duration, W, H), "utf8");
      vf += `,subtitles=sub${i}.ass`; // cwd を jobDir にして相対パスで指定（Windowsのパス問題回避）
    }
    const part = `part${String(i).padStart(4, "0")}.mp4`;
    args.push("-filter_complex", `[0:v]${vf}[v]`, "-map", "[v]", "-map", "1:a",
      "-t", duration.toFixed(2), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-ar", "44100", "-ac", "2", part);
    await run("ffmpeg", args, { cwd: jobDir });
    parts.push(part);
  }

  progress("1本の動画に結合中");
  fs.writeFileSync(path.join(jobDir, "list.txt"), parts.map((p) => `file '${p}'`).join("\n"));
  const name = `${String(title).replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) || "story"}_${Date.now()}.mp4`;
  const dest = path.join(DIRS.videos, name);
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-movflags", "+faststart", dest], { cwd: jobDir });
  fs.rmSync(jobDir, { recursive: true, force: true });
  return { url: toUrl(dest) };
}

// ---------------- ルーティング ----------------
async function handle(req, res, url, readBody, sendJson) {
  if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
    const job = jobs.get(url.pathname.split("/").pop());
    return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: "job not found" });
  }
  if (req.method !== "POST") return false;
  const routes = {
    "/api/video/clip": (b) => (b.mock ? mockClip : comfyClip).bind(null, b),
    "/api/video/tts": (b) => tts.bind(null, b),
    "/api/video/render": (b) => render.bind(null, b),
  };
  const make = routes[url.pathname];
  if (!make) return false;
  const body = JSON.parse(await readBody(req));
  return sendJson(res, 200, { jobId: startJob(make(body)) });
}

module.exports = {
  handle, OUT_DIR, DIRS, run, mediaDuration, startJob, toUrl, urlToPath, safeId, sleep,
  prepareWorkflow, comfyRun, comfyBase,
};
