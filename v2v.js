// 動画→動画（モーション転写）
// 参照動画（例：剣道の稽古映像）の「動き」をそのまま使い、見た目だけをAIで作り変える。
//   1. 参照動画を動画モデルに合ったサイズ・fps・フレーム数（4n+1）に整える
//   2. 長い動画は数秒ずつのチャンクに分割（全チャンク同じシード＝見た目をそろえる）
//   3. 各チャンクを ComfyUI の制御付きワークフロー（Wan VACE + DWPose / 深度 など）で生成
//   4. 各出力を元のフレーム数ぴったりに合わせて結合 → 元動画とタイミングが一致
//   5. 元の音声（気合・打突音など）を戻し、元動画と並べた比較動画も作る

const fs = require("fs");
const path = require("path");
const V = require("./video");

// ---------------- 参照動画のアップロード（ストリーム保存） ----------------
async function probe(file) {
  const out = await V.run("ffprobe", ["-v", "error", "-show_entries",
    "stream=codec_type,width,height,r_frame_rate:format=duration", "-of", "json", file]);
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === "video");
  if (!v) throw new Error("映像が含まれていないファイルです。");
  const [n, d] = String(v.r_frame_rate || "30/1").split("/").map(Number);
  return {
    width: v.width, height: v.height,
    fps: d ? n / d : n,
    duration: parseFloat(j.format?.duration) || 0,
    hasAudio: (j.streams || []).some((s) => s.codec_type === "audio"),
  };
}

function handleUpload(req, res, url, sendJson) {
  const orig = String(url.searchParams.get("name") || "ref.mp4");
  const ext = (path.extname(orig).toLowerCase().match(/^\.(mp4|mov|webm|mkv|avi|m4v)$/) || [".mp4"])[0];
  const dest = path.join(V.DIRS.refs, `ref_${Date.now()}${ext}`);
  const ws = fs.createWriteStream(dest);
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > 2 * 1024 ** 3) { req.destroy(); ws.destroy(); fs.rmSync(dest, { force: true }); }
  });
  req.pipe(ws);
  ws.on("finish", async () => {
    try {
      const info = await probe(dest);
      sendJson(res, 200, { url: V.toUrl(dest), name: orig, ...info });
    } catch (e) {
      fs.rmSync(dest, { force: true });
      sendJson(res, 400, { error: "動画として読み込めません: " + e.message });
    }
  });
  ws.on("error", (e) => sendJson(res, 500, { error: e.message }));
}

// ---------------- ComfyUI へのファイル送信 ----------------
async function comfyUpload(base, file) {
  const fd = new FormData();
  fd.append("image", new Blob([fs.readFileSync(file)], { type: "video/mp4" }), path.basename(file));
  fd.append("overwrite", "true");
  fd.append("type", "input");
  const r = await fetch(`${base}/upload/image`, { method: "POST", body: fd })
    .catch((e) => { throw new Error(`ComfyUI に接続できません (${base}): ${e.message}`); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.name) throw new Error(`ComfyUI へのアップロード失敗: ${JSON.stringify(j).slice(0, 300)}`);
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

// ワークフローに参照動画・サイズ・フレーム数・強さ・シードを当てはめる
function applyV2V(workflow, o, needVideo = true) {
  const esc = (s) => JSON.stringify(String(s)).slice(1, -1);
  let str = JSON.stringify(workflow);
  const hasVideoPh = needVideo && str.includes("%VIDEO%");
  if (hasVideoPh) str = str.split("%VIDEO%").join(esc(o.file));
  const wf = V.prepareWorkflow(JSON.parse(str), o.prompt, o.negative);

  let loaderFound = hasVideoPh || !needVideo;
  for (const n of Object.values(wf)) {
    const ct = String(n?.class_type || "");
    const inp = n?.inputs;
    if (!inp) continue;
    const isNum = (k) => typeof inp[k] === "number";

    // 動画読み込みノード（ComfyUI標準 LoadVideo / VideoHelperSuite VHS_LoadVideo）
    if (/LoadVideo/i.test(ct) && needVideo) {
      if (!hasVideoPh) {
        if (typeof inp.file === "string") { inp.file = o.file; loaderFound = true; }
        else if (typeof inp.video === "string") { inp.video = o.file; loaderFound = true; }
      }
      if (isNum("frame_load_cap")) inp.frame_load_cap = o.frames;
      if (isNum("skip_first_frames")) inp.skip_first_frames = 0;
      if (isNum("select_every_nth")) inp.select_every_nth = 1;
      if (isNum("force_rate")) inp.force_rate = 0; // 既に fps を揃えてある
    }
    // 生成ノード（WanVaceToVideo / WanFunControlToVideo など）のサイズとフレーム数
    if (/ToVideo|Vace|FunControl|EmptyHunyuanLatentVideo|EmptyLTXV/i.test(ct)) {
      if (isNum("width")) inp.width = o.width;
      if (isNum("height")) inp.height = o.height;
      if (isNum("length")) inp.length = o.frames;
    }
    // 制御の強さ（動きにどれだけ忠実に従うか）
    if (/Vace|Control/i.test(ct) && isNum("strength") && o.strength != null) inp.strength = o.strength;
    // 出力 fps
    if (/CreateVideo|VideoCombine/i.test(ct)) {
      if (isNum("fps")) inp.fps = o.fps;
      if (isNum("frame_rate")) inp.frame_rate = o.fps;
    }
    // シード固定（全チャンクで同じ見た目にする）
    for (const k of ["seed", "noise_seed"]) if (isNum(k)) inp[k] = o.seed;
  }
  if (!loaderFound) {
    throw new Error("ワークフローに動画読み込みノード（Load Video）が見つかりません。参照動画の入力欄に %VIDEO% と書くか、Load Video ノードを使ってください。");
  }
  return wf;
}

// ---------------- 本体 ----------------
// b.prompts（配列）を渡すと「タイムライン」：チャンクごとに別のプロンプト（5秒×最大6＝30秒）
// b.refUrl が無い場合はテキスト→動画（T2V ワークフロー）で各チャンクを生成
async function runV2V(b, progress) {
  const prompts = Array.isArray(b.prompts) ? b.prompts.map((p) => String(p || "").trim()) : null;
  if (prompts && !prompts.some(Boolean)) throw new Error("プロンプトが1つも入力されていません。");
  const ref = b.refUrl ? V.urlToPath(b.refUrl) : null;
  if (!ref && !prompts) throw new Error("参照動画がありません。先にアップロードしてください。");
  if (b.refUrl && !ref) throw new Error("参照動画ファイルが見つかりません。もう一度選び直してください。");
  if (!b.mock && (!b.workflow || typeof b.workflow !== "object")) {
    throw new Error(ref ? "動画→動画用の ComfyUI ワークフローが未設定です。" : "テキスト→動画用の ComfyUI ワークフローが未設定です（🎬 動画設定）。");
  }
  const info = ref ? await probe(ref) : { duration: Infinity, hasAudio: false };
  const fps = Math.max(8, Math.min(30, Number(b.fps) || 16));
  const W = Math.round((Number(b.width) || 832) / 16) * 16;
  const H = Math.round((Number(b.height) || 480) / 16) * 16;

  // チャンク1つあたりのフレーム数（4n+1、Wan系の条件）
  const F = Math.max(5, Math.round(((Number(b.chunkSec) || 5) * fps - 1) / 4) * 4 + 1);
  const step = F / fps;

  const start = ref ? Math.max(0, Number(b.start) || 0) : 0;
  let end = Math.min(info.duration, Number(b.end) > start ? Number(b.end) : info.duration);
  if (prompts) {
    // 最後に入力されたコマまで（途中の空欄は直前のプロンプトを引き継ぐ）
    const lastFilled = prompts.reduce((a, p, i) => (p ? i : a), -1);
    end = Math.min(end, start + (lastFilled + 1) * step);
  }
  const total = end - start;
  if (total < 0.3) throw new Error(ref && start >= info.duration ? "開始位置が動画の長さを超えています。" : "変換する範囲が短すぎます。");
  const count = Math.ceil(total / step - 0.02);
  const promptAt = (i) => {
    if (!prompts) return b.prompt;
    for (let k = Math.min(i, prompts.length - 1); k >= 0; k--) if (prompts[k]) return [b.prompt, prompts[k]].filter(Boolean).join(", ");
    return [b.prompt, prompts.find(Boolean)].filter(Boolean).join(", ");
  };
  if (prompts && count > 6) throw new Error("タイムラインは最大6コマ（30秒）です。");
  if (count > 60) throw new Error(`チャンクが多すぎます（${count}個）。範囲を短くするかチャンク秒数を増やしてください。`);
  const seed = Number.isFinite(Number(b.seed)) && b.seed !== "" ? Number(b.seed) : Math.floor(Math.random() * 2 ** 32);

  const id = `v2v_${Date.now()}`;
  const dir = path.join(V.DIRS.work, id);
  fs.mkdirSync(dir, { recursive: true });
  const base = V.comfyBase(b.comfyUrl);
  const norm = [];

  try {
    for (let i = 0; i < count; i++) {
      const t = start + i * step;
      const sec = `${Math.round((t - start) * 10) / 10}〜${Math.round((t - start + step) * 10) / 10}秒`;
      const tag = prompts ? `コマ ${i + 1}/${count}（${sec}）` : `チャンク ${i + 1}/${count}`;
      const prompt = promptAt(i);
      const opts = {
        prompt, negative: b.negative, width: W, height: H,
        frames: F, fps, strength: b.strength === "" || b.strength == null ? null : Number(b.strength), seed,
      };
      let chunk = null;
      if (ref) {
        progress(`${tag}：参照動画を準備中`);
        chunk = path.join(dir, `in${i}.mp4`);
        await V.run("ffmpeg", ["-y", "-ss", t.toFixed(3), "-i", ref, "-t", (step + 1).toFixed(3),
          "-vf", `fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,tpad=stop_mode=clone:stop_duration=3`,
          "-frames:v", String(F), "-an", "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", chunk]);
      }

      let out;
      if (b.mock) {
        progress(`${tag}：テスト変換中`);
        out = path.join(dir, `mock${i}.mp4`);
        const src = chunk ? ["-i", chunk] : ["-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=${fps}:d=${step.toFixed(3)}`];
        await V.run("ffmpeg", ["-y", ...src, "-vf", `${chunk ? "edgedetect=mode=colormix," : ""}hue=h=${i * 60}:s=3`,
          "-c:v", "libx264", "-preset", "veryfast", out]);
      } else if (ref) {
        progress(`${tag}：ComfyUI へ送信中`);
        const wf = applyV2V(b.workflow, { ...opts, file: await comfyUpload(base, chunk) });
        out = await V.comfyRun(base, wf, `out${i}`, dir, (p) => progress(`${tag}：${p}`));
      } else {
        progress(`${tag}：ComfyUI へ送信中`);
        const wf = applyV2V(b.workflow, { ...opts, file: null }, false);
        out = await V.comfyRun(base, wf, `out${i}`, dir, (p) => progress(`${tag}：${p}`));
      }

      // 出力を元と同じフレーム数・サイズに揃える（タイミングずれ防止）
      progress(`${tag}：整形中`);
      const n = path.join(dir, `norm${String(i).padStart(3, "0")}.mp4`);
      await V.run("ffmpeg", ["-y", "-i", out, "-vf",
        `fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=3`,
        "-frames:v", String(F), "-an", "-c:v", "libx264", "-crf", "16", n]);
      norm.push(path.basename(n));
    }

    progress("結合中");
    fs.writeFileSync(path.join(dir, "list.txt"), norm.map((f) => `file '${f}'`).join("\n"));
    await V.run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "gen.mp4"], { cwd: dir });

    const stamp = Date.now();
    const final = path.join(V.DIRS.videos, `v2v_${stamp}.mp4`);
    const args = ["-y", "-i", path.join(dir, "gen.mp4")];
    const useAudio = b.keepAudio !== false && info.hasAudio;
    if (useAudio) args.push("-ss", start.toFixed(3), "-t", total.toFixed(3), "-i", ref);
    args.push("-t", total.toFixed(3), "-map", "0:v");
    if (useAudio) args.push("-map", "1:a", "-c:a", "aac");
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", final);
    await V.run("ffmpeg", args);

    let compareUrl = null;
    if (b.compare !== false && ref) {
      progress("比較動画（元｜AI）を作成中");
      const cmp = path.join(V.DIRS.videos, `v2v_${stamp}_compare.mp4`);
      const cargs = ["-y", "-ss", start.toFixed(3), "-t", total.toFixed(3), "-i", ref, "-i", final,
        "-filter_complex",
        `[0:v]fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[a];[1:v]setsar=1[b];[a][b]hstack=inputs=2,format=yuv420p[v]`,
        "-map", "[v]"];
      if (useAudio) cargs.push("-map", "0:a", "-c:a", "aac");
      cargs.push("-t", total.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", cmp);
      await V.run("ffmpeg", cargs);
      compareUrl = V.toUrl(cmp);
    }
    return { url: V.toUrl(final), compareUrl, chunks: count, seed, frames: F, fps, width: W, height: H };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function handle(req, res, url, readBody, sendJson) {
  if (req.method !== "POST") return false;
  if (url.pathname === "/api/v2v/upload") return handleUpload(req, res, url, sendJson);
  if (url.pathname === "/api/v2v/run") {
    const body = JSON.parse(await readBody(req));
    return sendJson(res, 200, { jobId: V.startJob((p) => runV2V(body, p)) });
  }
  return false;
}

module.exports = { handle, runV2V };
