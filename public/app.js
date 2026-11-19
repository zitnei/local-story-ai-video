// ローカル ストーリーAI — 画面側ロジック
// しくみ：
//  1. 入力したプロンプトは「待機キュー」に入る
//  2. N秒（既定5秒）ごとにキューから1つ取り出し、物語の続きを生成
//     （前の生成が終わっていなければ待つ＝必ず順番に1段落ずつ）
//  3. 毎回「作品設定」「これまでのあらすじ」「直前の本文」をAIに渡すので話がつながる
//  4. 一定段落ごとに古い段落をあらすじへ要約し、長編でも設定がブレにくい

const $ = (id) => document.getElementById(id);
const STORE_KEY = "local-story-ai-v1";

const SETTING_IDS = [
  "baseUrl", "model", "apiKey", "temperature", "maxTokens", "mock",
  "title", "genre", "world", "characters",
  "interval", "segLen", "autoContinue", "summaryEvery", "recentCount", "summary",
  "videoMode", "comfyUrl", "visualStyle", "negative", "autoVideo", "narration", "ttsRate", "subtitles", "videoSize",
  "v2vStart", "v2vEnd", "v2vPrompt", "v2vTranslate", "v2vNegative", "v2vSize", "v2vFps", "v2vChunk",
  "v2vStrength", "v2vSeed", "v2vAudio", "v2vCompare",
  "tl0", "tl1", "tl2", "tl3", "tl4", "tl5", "tlUseRef",
];
const TL_SLOTS = 6;      // 最大6コマ
const TL_SEC = 5;        // 1コマ5秒 → 最大30秒

// タイムライン入力欄（6コマ）を作る。SETTING_IDS で保存されるよう、読み込み前に生成する
(function buildTimeline() {
  const box = document.getElementById("timeline");
  for (let i = 0; i < TL_SLOTS; i++) {
    const row = document.createElement("div");
    row.className = "tl-slot";
    row.id = "tlRow" + i;
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = `${i * TL_SEC}〜${(i + 1) * TL_SEC}秒`;
    const ta = document.createElement("textarea");
    ta.id = "tl" + i;
    ta.rows = 2;
    ta.placeholder = i === 0 ? "例: 構えて相手と向き合う" : "（空欄＝前のコマを引き継ぐ）";
    row.append(t, ta);
    box.appendChild(row);
  }
})();
const WORKFLOW_KEY = "local-story-ai-workflow";
const V2V_WORKFLOW_KEY = "local-story-ai-workflow-v2v";
const REF_KEY = "local-story-ai-ref";
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let state = {
  segments: [],        // { prompt, text, auto }
  queue: [],           // 未処理のプロンプト
  summarizedUpTo: 0,   // この番号より前の段落は summary に要約済み
};

let running = false;
let busy = false;
let nextTickAt = 0;
let abortCtrl = null;

// ---------------- 保存/読込 ----------------
function readSettings() {
  const s = {};
  for (const id of SETTING_IDS) {
    const el = $(id);
    s[id] = el.type === "checkbox" ? el.checked : el.value;
  }
  return s;
}
function applySettings(s) {
  for (const id of SETTING_IDS) {
    if (s[id] === undefined) continue;
    const el = $(id);
    if (el.type === "checkbox") el.checked = !!s[id];
    else el.value = s[id];
  }
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ settings: readSettings(), state }));
  } catch (_) {}
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.settings) applySettings(d.settings);
    if (d.state) state = { ...state, ...d.state };
  } catch (_) {}
  ensureIds();
}
function ensureIds() {
  for (const s of state.segments) if (!s.id) s.id = newId();
}

// ---------------- 表示 ----------------
function setStatus(kind, text) {
  $("statusDot").className = "dot " + kind;
  $("statusText").textContent = text;
}

function renderStory() {
  const box = $("story");
  box.innerHTML = "";
  state.segments.forEach((seg, i) => box.appendChild(segEl(seg, i)));
  box.scrollTop = box.scrollHeight;
}
function segEl(seg, i, temp = false) {
  const div = document.createElement("div");
  div.className = "seg";
  const tag = document.createElement("span");
  tag.className = "tag" + (seg.auto ? " auto" : "");
  tag.textContent = `#${i + 1} ${seg.auto ? "（自動で続き）" : "▶ " + seg.prompt}`;
  const text = document.createElement("div");
  text.className = "text";
  text.textContent = seg.text;
  div.append(tag, text);
  if (!temp) {
    div.dataset.id = seg.id;
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "削除";
    del.onclick = () => {
      if (busy) return alert("生成中は削除できません。停止してから操作してください。");
      if (videoBusyId === seg.id) return alert("この段落は動画素材を作成中です。");
      state.segments.splice(i, 1);
      state.summarizedUpTo = Math.min(state.summarizedUpTo, state.segments.length);
      save(); renderStory();
    };
    div.append(del, videoBar(seg));
  }
  return div;
}

// 段落ごとの動画素材の状態表示
function videoBar(seg) {
  const bar = document.createElement("div");
  bar.className = "vbar";
  const add = (txt, cls) => {
    const s = document.createElement("span");
    s.textContent = txt;
    if (cls) s.className = cls;
    bar.appendChild(s);
  };
  if (videoBusyId === seg.id) add("🎬 " + (videoProgress || "作成中…"), "busy");
  else if (videoQueue.includes(seg.id)) add("🎬 順番待ち", "busy");
  else {
    if (seg.ref) {
      add(`🥋 参照: ${seg.ref.name} ${fmtRange(seg.ref)}`, "ok");
      const x = document.createElement("button");
      x.textContent = "参照を外す";
      x.onclick = () => { seg.ref = null; seg.clip = null; save(); refreshVideoBar(seg.id); };
      bar.appendChild(x);
    } else if (loadRef()) {
      const r = document.createElement("button");
      r.textContent = "🥋 参照動画の動きを使う";
      r.title = "動画→動画パネルで選んだ参照動画（範囲つき）をこの段落の映像に使います";
      r.onclick = () => {
        const ref = loadRef(), s = readSettings();
        seg.ref = { url: ref.url, name: ref.name, start: Number(s.v2vStart) || 0, end: Number(s.v2vEnd) || null };
        seg.clip = null;
        save(); refreshVideoBar(seg.id);
      };
      bar.appendChild(r);
    }
    if (seg.clip) add("🎬 映像✓", "ok");
    if (seg.audio) add("🔊 音声✓", "ok");
    if (seg.videoError) add("⚠ " + seg.videoError, "ng");
    const b = document.createElement("button");
    b.textContent = seg.clip || seg.audio ? "素材を作り直す" : "動画素材を作る";
    b.onclick = () => { seg.clip = seg.audio = null; enqueueVideo(seg.id); }; // シーン指示は残して別シードで再生成
    bar.appendChild(b);
    if (seg.clip) {
      const p = document.createElement("button");
      p.textContent = "映像を見る";
      p.onclick = () => {
        const old = bar.parentElement.querySelector("video");
        if (old) return old.remove();
        const v = document.createElement("video");
        v.src = seg.clip; v.controls = true; v.autoplay = true; v.loop = true; v.muted = true;
        bar.after(v);
      };
      bar.appendChild(p);
    }
  }
  if (seg.scenePrompt) bar.title = "シーン指示: " + seg.scenePrompt;
  return bar;
}
function refreshVideoBar(id) {
  const el = document.querySelector(`.seg[data-id="${id}"]`);
  const seg = state.segments.find((s) => s.id === id);
  if (!el || !seg) return;
  el.querySelector(".vbar")?.replaceWith(videoBar(seg));
}

function renderQueue() {
  $("queueCount").textContent = state.queue.length;
  const ol = $("queueList");
  ol.innerHTML = "";
  state.queue.forEach((p, i) => {
    const li = document.createElement("li");
    li.textContent = p;
    const b = document.createElement("button");
    b.textContent = "×";
    b.onclick = () => { state.queue.splice(i, 1); save(); renderQueue(); };
    li.appendChild(b);
    ol.appendChild(li);
  });
}

// ---------------- AI 呼び出し ----------------
// <think>…</think>（推論部分）は物語に含めない
function visibleText(raw) {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "")
    .replace(/^\s+/, "");
}

async function callAI(messages, onDelta, ctrl) {
  const s = readSettings();
  if (!ctrl) ctrl = abortCtrl = new AbortController();
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: ctrl.signal,
    body: JSON.stringify({
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      model: s.model,
      temperature: Number(s.temperature),
      max_tokens: Number(s.maxTokens),
      mock: s.mock,
      messages,
    }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", raw = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        const d = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.text ?? "";
        if (d) { raw += d; onDelta?.(visibleText(raw)); }
      } catch (_) {}
    }
  }
  return visibleText(raw).trim();
}

function storyBible(s) {
  return [
    s.title && `タイトル：${s.title}`,
    s.genre && `ジャンル・文体：${s.genre}`,
    s.world && `世界観：\n${s.world}`,
    s.characters && `登場人物：\n${s.characters}`,
  ].filter(Boolean).join("\n") || "（未設定。これまでの本文から一貫性を保つこと）";
}

function buildStoryMessages(instruction, isAuto) {
  const s = readSettings();
  const recent = state.segments.slice(state.summarizedUpTo);
  const recentText = recent.map((x) => x.text).join("\n\n");
  const isFirst = state.segments.length === 0;

  const system =
    "あなたは連載小説を書くプロの作家です。以下を厳守してください。\n" +
    "- 出力は物語の本文のみ。見出し・解説・前置き・「続きです」などは書かない。\n" +
    "- 作品設定とあらすじに矛盾しない（名前・口調・関係・場所・時間・持ち物を一貫させる）。\n" +
    "- 直前の本文の最後の一文の『直後』から自然につなげて書く。既に書かれた内容を繰り返さない。\n" +
    "- 指示された出来事は今回の段落の中で無理なく起こす。物語を勝手に完結させない。\n" +
    "- 日本語で書く。";

  const user =
    `【作品設定】\n${storyBible(s)}\n\n` +
    `【これまでのあらすじ】\n${s.summary || "（まだ無し）"}\n\n` +
    `【直前の本文】\n${isFirst ? "（まだ無し。ここから物語を始める）" : recentText}\n\n` +
    `【今回の展開の指示】\n${isAuto ? "指示なし。これまでの流れを自然に一歩進めてください。" : instruction}\n\n` +
    `上の指示に従い、${isFirst ? "物語の冒頭" : "直前の本文の続き"}を${s.segLen}字程度で書いてください。`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// 古い段落をあらすじに畳み込む
async function maybeSummarize() {
  const s = readSettings();
  const keep = Math.max(1, Number(s.recentCount));
  const every = Math.max(2, Number(s.summaryEvery));
  const unsummarized = state.segments.length - state.summarizedUpTo;
  if (unsummarized < keep + every) return;

  const upTo = state.segments.length - keep;
  const chunk = state.segments.slice(state.summarizedUpTo, upTo).map((x) => x.text).join("\n\n");
  setStatus("gen", "あらすじを更新中…");

  const messages = [
    {
      role: "system",
      content:
        "あなたは小説編集者です。物語の要約を作ります。出力は要約本文のみ。\n" +
        "- 既存のあらすじに新しい本文の出来事を統合し、時系列で簡潔にまとめる。\n" +
        "- 登場人物の現在の状態・居場所・目的・関係の変化、張られた伏線、重要な物を必ず残す。\n" +
        "- 600字以内。",
    },
    {
      role: "user",
      content: `【既存のあらすじ】\n${s.summary || "（無し）"}\n\n【追加する本文】\n${chunk}\n\n更新後のあらすじ：`,
    },
  ];
  const result = await callAI(messages);
  if (result) {
    $("summary").value = result;
    state.summarizedUpTo = upTo;
    save();
  }
}

// 前の段落の末尾を繰り返して書き始めた場合に取り除く
function trimOverlap(prev, next) {
  if (!prev) return next;
  for (let n = Math.min(80, prev.length, next.length); n >= 8; n--) {
    if (next.startsWith(prev.slice(-n))) return next.slice(n).replace(/^\s+/, "");
  }
  return next;
}

async function generateOne() {
  const s = readSettings();
  let prompt = null, isAuto = false;
  if (state.queue.length) prompt = state.queue.shift();
  else if (s.autoContinue && state.segments.length) isAuto = true;
  else return false; // やることなし
  renderQueue(); save();

  await maybeSummarize();

  const seg = { id: newId(), prompt: prompt || "", text: "", auto: isAuto };
  const el = segEl(seg, state.segments.length, true);
  el.classList.add("writing");
  $("story").appendChild(el);
  const textEl = el.querySelector(".text");
  setStatus("gen", "生成中…");

  try {
    const text = await callAI(buildStoryMessages(prompt, isAuto), (t) => {
      textEl.textContent = t;
      const box = $("story");
      box.scrollTop = box.scrollHeight;
    });
    const prev = state.segments[state.segments.length - 1]?.text;
    seg.text = trimOverlap(prev, text);
    if (seg.text) {
      state.segments.push(seg);
      // 文章AIが使えるうちに映像用のシーン指示も作っておく（後で文章AIを止めても動画を作れる）
      if (s.videoMode === "comfy") {
        setStatus("gen", "シーン指示を作成中…");
        seg.scenePrompt = await makeScenePrompt(seg).catch(() => null);
      }
      if (s.autoVideo) enqueueVideo(seg.id);
    } else if (prompt) state.queue.unshift(prompt); // 空なら戻す
  } catch (e) {
    if (prompt) state.queue.unshift(prompt); // 失敗したプロンプトはキューに戻す
    throw e;
  } finally {
    save(); renderStory(); renderQueue();
  }
  return true;
}

// ---------------- 動画素材の作成（物語の生成とは別の順番待ちで処理） ----------------
let videoQueue = [];
let videoBusyId = null;
let videoProgress = "";
let videoWorking = false;
let idleWaiters = [];

function loadWorkflow() {
  try { return JSON.parse(localStorage.getItem(WORKFLOW_KEY) || "null"); } catch (_) { return null; }
}

function enqueueVideo(id) {
  if (!videoQueue.includes(id) && videoBusyId !== id) videoQueue.push(id);
  refreshVideoBar(id);
  videoWorker();
}
function waitVideoIdle() {
  if (!videoWorking && !videoQueue.length) return Promise.resolve();
  return new Promise((r) => idleWaiters.push(r));
}

async function postJob(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok || !j.jobId) throw new Error(j.error || `HTTP ${r.status}`);
  while (true) {
    await new Promise((res) => setTimeout(res, 1200));
    const job = await (await fetch(`/api/jobs/${j.jobId}`)).json();
    if (job.progress) onJobProgress(job.progress);
    if (job.status === "done") return job.result;
    if (job.status === "error") throw new Error(job.error);
  }
}
let onJobProgress = () => {};

async function makeScenePrompt(seg) {
  const s = readSettings();
  const messages = [
    {
      role: "system",
      content:
        "You write prompts for a text-to-video AI model. Output ONLY the prompt in English, one paragraph, max 70 words. " +
        "Describe ONE continuous shot: main subject (with consistent appearance), action, setting, lighting, mood, camera movement. " +
        "No dialogue, no on-screen text, no explanations.",
    },
    {
      role: "user",
      content:
        `Visual style and character appearance (must follow):\n${s.visualStyle || "(none)"}\n\n` +
        `Story setting:\n${storyBible(s)}\n\nPassage to visualize (Japanese):\n${seg.text}\n\nVideo prompt:`,
    },
  ];
  const p = await callAI(messages, null, new AbortController());
  const cleaned = p.replace(/^["'「]|["'」]$/g, "").trim();
  return [s.visualStyle, cleaned].filter(Boolean).join(", ");
}

async function videoWorker() {
  if (videoWorking) return;
  videoWorking = true;
  try {
    while (videoQueue.length) {
      const id = videoQueue.shift();
      const seg = state.segments.find((x) => x.id === id);
      if (!seg) continue;
      videoBusyId = id;
      videoProgress = "準備中…";
      seg.videoError = null;
      onJobProgress = (p) => { videoProgress = p; refreshVideoBar(id); };
      refreshVideoBar(id);
      const s = readSettings();
      try {
        if (s.videoMode === "comfy" && !seg.clip && seg.ref) {
          // 参照動画の動きを使って、この段落の映像を作る
          if (!seg.scenePrompt) {
            onJobProgress("シーン指示を作成中（AI）");
            seg.scenePrompt = await makeScenePrompt(seg);
          }
          const r = await postJob("/api/v2v/run", {
            ...v2vParams(s), refUrl: seg.ref.url, start: seg.ref.start, end: seg.ref.end,
            prompt: seg.scenePrompt, compare: false, keepAudio: false,
          });
          seg.clip = r.url;
          save();
        }
        if (s.videoMode === "comfy" && !seg.clip) {
          const wf = loadWorkflow();
          if (!wf && !s.mock) throw new Error("ComfyUI のワークフローが未設定です（動画設定→読込）");
          onJobProgress("シーン指示を作成中（AI）");
          if (!seg.scenePrompt) seg.scenePrompt = await makeScenePrompt(seg);
          const r = await postJob("/api/video/clip", {
            mock: s.mock, comfyUrl: s.comfyUrl, workflow: wf?.json,
            prompt: seg.scenePrompt, negative: s.negative, segId: seg.id,
            ...clipSize(s),
          });
          seg.clip = r.url;
          save();
        }
        if (s.narration && !seg.audio) {
          const r = await postJob("/api/video/tts", { text: seg.text, segId: seg.id, rate: s.ttsRate });
          seg.audio = r.url;
          save();
        }
      } catch (e) {
        seg.videoError = e.message.slice(0, 200);
      } finally {
        videoBusyId = null;
        save();
        refreshVideoBar(id);
      }
    }
  } finally {
    videoWorking = false;
    idleWaiters.splice(0).forEach((r) => r());
  }
}

function missingMaterials(seg, s) {
  return (s.videoMode === "comfy" && !seg.clip) || (s.narration && !seg.audio);
}

async function renderVideo() {
  const s = readSettings();
  if (!state.segments.length) return alert("まだ物語がありません。");
  const status = $("videoStatus");
  $("renderBtn").disabled = true;
  try {
    const missing = state.segments.filter((x) => missingMaterials(x, s));
    if (missing.length) {
      status.textContent = `素材を作成中…（${missing.length}段落）`;
      missing.forEach((x) => enqueueVideo(x.id));
      await waitVideoIdle();
    }
    const [w, h] = s.videoSize.split("x").map(Number);
    onJobProgress = (p) => (status.textContent = p);
    status.textContent = "動画を書き出し中…";
    const r = await postJob("/api/video/render", {
      title: s.title || "story",
      width: w, height: h, subtitles: s.subtitles,
      segments: state.segments.map((x) => ({
        text: x.text,
        clip: s.videoMode === "comfy" ? x.clip : null,
        audio: s.narration ? x.audio : null,
      })),
    });
    status.textContent = "完成しました ✓（output/videos フォルダにも保存）";
    showResult("物語動画", r.url, null);
  } catch (e) {
    status.textContent = "エラー: " + e.message;
  } finally {
    $("renderBtn").disabled = false;
  }
}

function showResult(title, url, compareUrl) {
  $("resultTitle").textContent = title;
  $("finalVideo").src = url;
  $("finalLink").href = url;
  $("compareVideo").hidden = $("compareLink").hidden = !compareUrl;
  if (compareUrl) { $("compareVideo").src = compareUrl; $("compareLink").href = compareUrl; }
  else $("compareVideo").removeAttribute("src");
  $("videoResult").hidden = false;
}

// ---------------- 動画→動画（モーション転写） ----------------
const KENDO_PRESET = {
  prompt:
    "kendo practitioner in a traditional wooden dojo, wearing full bogu armor: men helmet with metal face grille and blue cloth, " +
    "kote padded gloves on both hands, black lacquered do chest protector, tare waist guard, dark indigo keikogi jacket and wide hakama, " +
    "holding one straight pale wooden-colored kendo sword (shinai) with both hands, correct grip with left hand at the end of the leather tsuka, sharp precise strikes, " +
    "realistic, natural lighting, high detail, stable camera",
  negative:
    "extra limbs, extra arms, extra hands, missing hands, fused fingers, deformed body, twisted torso, " +
    "bent shinai, broken shinai, green bamboo plant, leaves, two swords, metal katana, sword through body, floating sword, " +
    "distorted face, morphing, flickering, jitter, blurry, low quality, text, watermark",
};

function loadRef() {
  try { return JSON.parse(localStorage.getItem(REF_KEY) || "null"); } catch (_) { return null; }
}
function fmtRange(r) {
  const a = Number(r.start) || 0;
  return r.end ? `(${a}〜${r.end}秒)` : a ? `(${a}秒〜)` : "";
}
function showRef() {
  const ref = loadRef();
  const pv = $("refPreview");
  if (!ref) { $("refName").textContent = "参照動画：未選択"; pv.hidden = true; return; }
  $("refName").textContent =
    `${ref.name}（${ref.width}×${ref.height} / ${ref.fps.toFixed(1)}fps / ${ref.duration.toFixed(1)}秒${ref.hasAudio ? " / 音声あり" : ""}）`;
  if (pv.getAttribute("src") !== ref.url) pv.src = ref.url;
  pv.hidden = false;
}

function v2vSize(s) {
  if (s.v2vSize !== "auto") return s.v2vSize.split("x").map(Number);
  const ref = loadRef();
  if (!ref) return [832, 480];
  const r = ref.width / ref.height;
  return r > 1.15 ? [832, 480] : r < 0.87 ? [480, 832] : [640, 640];
}
function v2vParams(s) {
  const [w, h] = v2vSize(s);
  return {
    mock: s.mock, comfyUrl: s.comfyUrl, workflow: loadJsonKey(V2V_WORKFLOW_KEY)?.json,
    width: w, height: h, fps: Number(s.v2vFps), chunkSec: Number(s.v2vChunk),
    strength: s.v2vStrength, seed: s.v2vSeed, negative: s.v2vNegative,
  };
}
// 物語クリップの生成サイズ（8GB GPU 向けに 480p 級。書き出し時に拡大・切り抜き）
function clipSize(s) {
  const [w, h] = String(s.videoSize || "1280x720").split("x").map(Number);
  return w >= h ? { width: 832, height: 480 } : { width: 480, height: 832 };
}
function loadJsonKey(k) {
  try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (_) { return null; }
}

async function toEnglishPrompt(text) {
  const messages = [
    {
      role: "system",
      content:
        "Translate and expand the user's Japanese description into ONE English prompt for a video-to-video AI model. " +
        "Describe appearance, clothing, equipment, setting, lighting and style precisely. Do NOT describe motion (motion comes from the reference video). " +
        "Output ONLY the prompt, max 90 words.",
    },
    { role: "user", content: text },
  ];
  return (await callAI(messages, null, new AbortController())).replace(/^["'「]|["'」]$/g, "").trim();
}

let v2vRunning = false;
async function runV2VPanel() {
  if (v2vRunning) return;
  const s = readSettings();
  const ref = loadRef();
  const st = $("v2vStatus");
  if (!ref) return alert("参照動画を選んでください。");
  if (!s.mock && !loadJsonKey(V2V_WORKFLOW_KEY)) return alert("動画→動画用のワークフローを読み込んでください（README参照）。テストモードなら不要です。");
  if (!s.v2vPrompt.trim()) return alert("「見た目の指示」を入力してください（剣道プリセットも使えます）。");
  v2vRunning = true;
  $("v2vRunBtn").disabled = true;
  try {
    let prompt = s.v2vPrompt.trim();
    if (s.v2vTranslate && !s.mock && /[぀-ヿ一-龯]/.test(prompt)) {
      st.textContent = "日本語の指示を英語に変換中（文章AI）…";
      prompt = await toEnglishPrompt(prompt);
      st.textContent = "英語の指示: " + prompt;
    }
    onJobProgress = (p) => (st.textContent = p);
    const r = await postJob("/api/v2v/run", {
      ...v2vParams(s), refUrl: ref.url, start: s.v2vStart, end: s.v2vEnd, prompt,
      keepAudio: s.v2vAudio, compare: s.v2vCompare,
    });
    st.textContent =
      `完成 ✓ ${r.width}×${r.height} / ${r.fps}fps / ${r.chunks}分割 / シード ${r.seed}\n` +
      "（同じシードを入れると同じ見た目で作り直せます）";
    if (!s.v2vSeed) $("v2vSeed").placeholder = `前回: ${r.seed}`;
    showResult("動画→動画", r.url, r.compareUrl);
  } catch (e) {
    st.textContent = "エラー: " + e.message;
  } finally {
    v2vRunning = false;
    $("v2vRunBtn").disabled = false;
  }
}

// ---------------- 5秒ごとのプロンプト（タイムライン 最大30秒） ----------------
const KENDO_TIMELINE = [
  "中段の構えで相手と向き合う。剣先が触れ合う距離でじっと攻め合う",
  "すり足で間合いを詰め、剣先で相手の中心を攻める",
  "大きく踏み込んで正面を打つ（面打ち）",
  "打ち抜けて振り返り、残心をとって再び構える",
  "小手から面への連続技を打つ（小手面）",
  "構えを解いて蹲踞（そんきょ）し、立ち上がって一礼する",
];

function timelinePrompts() {
  return Array.from({ length: TL_SLOTS }, (_, i) => $("tl" + i).value.trim());
}
function updateTimelineTotal() {
  const p = timelinePrompts();
  const last = p.reduce((a, x, i) => (x ? i : a), -1);
  const s = readSettings();
  const ref = s.tlUseRef ? loadRef() : null;
  let total = (last + 1) * TL_SEC;
  let note = "";
  if (ref) {
    const avail = Math.max(0, ref.duration - (Number(s.v2vStart) || 0));
    if (avail < total) { total = Math.floor(avail * 10) / 10; note = "（参照動画の長さで打ち切り）"; }
  }
  for (let i = 0; i < TL_SLOTS; i++) {
    const row = $("tlRow" + i);
    row.classList.toggle("off", i > last || (ref && i * TL_SEC >= total));
    row.classList.toggle("inherit", !p[i] && i < last);
  }
  $("timelineTotal").textContent = last < 0
    ? "まだ入力がありません"
    : `合計 約${total}秒・${Math.ceil(total / TL_SEC - 0.01)}コマ ${ref ? "／🥋 参照動画の動きを使用" + note : "／文章から生成"}`;
}

async function translateLines(lines) {
  const out = [];
  for (const line of lines) {
    if (!line || !/[぀-ヿ一-龯]/.test(line)) { out.push(line); continue; }
    const r = await callAI([
      { role: "system", content: "Translate the Japanese into a short, concrete English description for a video AI model (subject, action, camera). Keep kendo terms like men, kote, do, shinai, zanshin, sonkyo. Output ONLY the English, max 40 words." },
      { role: "user", content: line },
    ], null, new AbortController());
    out.push(r.replace(/^["'「]|["'」]$/g, "").trim());
  }
  return out;
}

let tlRunning = false;
async function runTimeline() {
  if (tlRunning) return;
  const s = readSettings();
  const st = $("tlStatus");
  let prompts = timelinePrompts();
  if (!prompts.some(Boolean)) return alert("少なくとも1コマ目にプロンプトを入力してください。");
  const ref = s.tlUseRef ? loadRef() : null;
  const wfKey = ref ? V2V_WORKFLOW_KEY : WORKFLOW_KEY;
  if (!s.mock && !loadJsonKey(wfKey)) {
    return alert(ref
      ? "動画→動画用のワークフローが未設定です（🥋 動画→動画 → 読込）。"
      : "テキスト→動画用のワークフローが未設定です（🎬 動画設定 → 読込）。");
  }
  tlRunning = true;
  $("tlRunBtn").disabled = true;
  try {
    let common = (s.v2vPrompt || "").trim() || (s.visualStyle || "").trim();
    if (s.v2vTranslate && !s.mock) {
      st.textContent = "日本語のプロンプトを英語に変換中（文章AI）…";
      prompts = await translateLines(prompts);
      if (/[぀-ヿ一-龯]/.test(common)) common = await toEnglishPrompt(common);
    }
    onJobProgress = (p) => {
      st.textContent = p;
      const m = /コマ (\d+)\//.exec(p);
      for (let i = 0; i < TL_SLOTS; i++) $("tlRow" + i).classList.toggle("busy", m && Number(m[1]) - 1 === i);
    };
    const r = await postJob("/api/v2v/run", {
      ...v2vParams(s),
      workflow: loadJsonKey(wfKey)?.json,
      chunkSec: TL_SEC,
      refUrl: ref ? ref.url : null,
      start: ref ? s.v2vStart : 0,
      end: null,
      prompt: common,
      prompts,
      keepAudio: s.v2vAudio,
      compare: s.v2vCompare,
    });
    st.textContent = `完成 ✓ ${r.chunks}コマ / ${r.width}×${r.height} / シード ${r.seed}（全コマ同じシードで見た目をそろえています）`;
    showResult("5秒ごとのタイムライン動画", r.url, r.compareUrl);
  } catch (e) {
    st.textContent = "エラー: " + e.message;
  } finally {
    for (let i = 0; i < TL_SLOTS; i++) $("tlRow" + i).classList.remove("busy");
    tlRunning = false;
    $("tlRunBtn").disabled = false;
  }
}

// ---------------- 5秒ループ ----------------
async function tick() {
  if (!running || busy) return;
  busy = true;
  try {
    await generateOne();
    if (running) setStatus("run", "実行中（次のプロンプト待ち）");
  } catch (e) {
    if (e.name === "AbortError") return;
    setStatus("err", "エラー: " + e.message);
    stop(false);
  } finally {
    busy = false;
    nextTickAt = Date.now() + Math.max(1, Number($("interval").value)) * 1000;
  }
}

setInterval(() => {
  if (!running) { $("countdown").textContent = ""; return; }
  if (busy) { $("countdown").textContent = ""; return; }
  const left = Math.max(0, Math.ceil((nextTickAt - Date.now()) / 1000));
  $("countdown").textContent = `次まで ${left} 秒`;
  if (Date.now() >= nextTickAt) tick();
}, 200);

function start() {
  const s = readSettings();
  if (!s.mock && !s.model.trim()) return alert("モデル名を入力してください（または「取得」で一覧から選択）。");
  if (!state.segments.length && !state.queue.length) {
    return alert("最初のプロンプト（物語の始まり）を入力して「追加」してください。");
  }
  running = true;
  nextTickAt = Date.now(); // すぐ1回目を実行
  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;
  setStatus("run", "実行中");
}
function stop(resetStatus = true) {
  running = false;
  abortCtrl?.abort();
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
  if (resetStatus) setStatus("idle", "停止中");
}

// ---------------- イベント ----------------
$("startBtn").onclick = start;
$("stopBtn").onclick = () => stop();

$("promptForm").onsubmit = (e) => {
  e.preventDefault();
  const v = $("promptInput").value.trim();
  if (!v) return;
  state.queue.push(v);
  $("promptInput").value = "";
  save(); renderQueue();
};

$("preset").onchange = () => {
  if ($("preset").value !== "custom") $("baseUrl").value = $("preset").value;
  save();
};

$("loadModels").onclick = async (e) => {
  e.preventDefault();
  const s = readSettings();
  const q = new URLSearchParams({ baseUrl: s.baseUrl, apiKey: s.apiKey });
  try {
    const j = await (await fetch("/api/models?" + q)).json();
    if (j.error) throw new Error(j.error);
    $("modelList").replaceChildren(...j.models.map((m) => Object.assign(document.createElement("option"), { value: m })));
    if (!s.model && j.models[0]) $("model").value = j.models[0];
    const mm = j.models.find((m) => /minimax/i.test(m));
    if (mm && !s.model) $("model").value = mm;
    save();
    alert("モデル一覧:\n" + (j.models.join("\n") || "（なし）"));
  } catch (err) {
    alert(err.message);
  }
};

for (const id of SETTING_IDS) $(id).addEventListener("change", save);

$("exportTxt").onclick = () => {
  const s = readSettings();
  const body = (s.title ? s.title + "\n\n" : "") + state.segments.map((x) => x.text).join("\n\n");
  download(`${s.title || "story"}.txt`, body, "text/plain");
};
$("exportJson").onclick = () => {
  const s = readSettings();
  delete s.apiKey;
  download(`${s.title || "story"}.json`, JSON.stringify({ settings: s, state }, null, 2), "application/json");
};
$("importJson").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.settings) applySettings(d.settings);
    if (d.state) state = { segments: [], queue: [], summarizedUpTo: 0, ...d.state };
    ensureIds();
    save(); renderStory(); renderQueue();
  } catch (err) { alert("読み込み失敗: " + err.message); }
  e.target.value = "";
};
$("clearBtn").onclick = () => {
  if (!confirm("物語・キュー・あらすじを全て消去します。よろしいですか？")) return;
  stop();
  videoQueue = [];
  state = { segments: [], queue: [], summarizedUpTo: 0 };
  $("summary").value = "";
  save(); renderStory(); renderQueue();
};

$("workflowFile").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const json = JSON.parse(await f.text());
    if (Array.isArray(json.nodes)) throw new Error("これは通常の保存形式です。ComfyUI のメニューから「Export (API)」で書き出したJSONを選んでください。");
    const hasPh = JSON.stringify(json).includes("%PROMPT%");
    localStorage.setItem(WORKFLOW_KEY, JSON.stringify({ name: f.name, json }));
    showWorkflowName();
    if (!hasPh) alert("%PROMPT% が見つからないため、最初のプロンプト入力ノードに自動で差し込みます。");
  } catch (err) { alert("ワークフロー読込失敗: " + err.message); }
  e.target.value = "";
};
function showWorkflowName() {
  const wf = loadWorkflow();
  $("workflowName").textContent = wf ? wf.name : "未設定";
}
$("renderBtn").onclick = renderVideo;
$("clipAllBtn").onclick = () => {
  const s = readSettings();
  const missing = state.segments.filter((x) => missingMaterials(x, s));
  if (!missing.length) return alert("全ての段落の素材が揃っています。");
  missing.forEach((x) => enqueueVideo(x.id));
};
$("closeVideo").onclick = () => { $("finalVideo").pause(); $("compareVideo").pause(); $("videoResult").hidden = true; };

// 動画→動画パネル
$("refFile").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const st = $("v2vStatus");
  st.textContent = `アップロード中… (${(f.size / 1024 / 1024).toFixed(1)}MB)`;
  try {
    const r = await fetch("/api/v2v/upload?name=" + encodeURIComponent(f.name), {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    localStorage.setItem(REF_KEY, JSON.stringify(j));
    $("v2vStart").value = 0; $("v2vEnd").value = "";
    save(); showRef(); renderStory(); updateTimelineTotal();
    st.textContent = "参照動画を読み込みました。範囲を決めて「変換開始」を押してください。";
  } catch (err) { st.textContent = "アップロード失敗: " + err.message; }
  e.target.value = "";
};
$("setStartBtn").onclick = () => { $("v2vStart").value = $("refPreview").currentTime.toFixed(1); save(); };
$("setEndBtn").onclick = () => { $("v2vEnd").value = $("refPreview").currentTime.toFixed(1); save(); };
$("presetKendo").onclick = () => {
  $("v2vPrompt").value = KENDO_PRESET.prompt;
  $("v2vNegative").value = KENDO_PRESET.negative;
  $("v2vStrength").value = "1.1";
  $("v2vFps").value = "16";
  save();
};
$("presetClear").onclick = () => { $("v2vPrompt").value = ""; $("v2vNegative").value = ""; save(); };
$("v2vWorkflowFile").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const json = JSON.parse(await f.text());
    if (Array.isArray(json.nodes)) throw new Error("ComfyUI の「Export (API)」で書き出したJSONを選んでください。");
    const str = JSON.stringify(json);
    if (!str.includes("%VIDEO%") && !/LoadVideo/i.test(str)) throw new Error("動画読み込みノード（Load Video）が入っていません。");
    localStorage.setItem(V2V_WORKFLOW_KEY, JSON.stringify({ name: f.name, json }));
    showV2VWorkflowName();
  } catch (err) { alert("ワークフロー読込失敗: " + err.message); }
  e.target.value = "";
};
function showV2VWorkflowName() {
  $("v2vWorkflowName").textContent = loadJsonKey(V2V_WORKFLOW_KEY)?.name || "未設定";
}
$("v2vRunBtn").onclick = runV2VPanel;

// 標準ワークフロー（workflows/ フォルダ）を読み込む
async function usePreset(id, key, quiet) {
  const r = await fetch("/api/comfy/preset?id=" + encodeURIComponent(id));
  const p = await r.json();
  if (!r.ok) throw new Error(p.error || r.status);
  localStorage.setItem(key, JSON.stringify({ name: p.name, json: p.json, preset: p.id }));
  showWorkflowName();
  showV2VWorkflowName();
  if (!quiet) $("comfyCheck").textContent = `「${p.name}」を設定しました。`;
}
const presetBtn = (btn, id, key) => ($(btn).onclick = () => usePreset(id, key).catch((e) => alert("読込失敗: " + e.message)));
presetBtn("wfPresetT2v", "wan_vace_t2v", WORKFLOW_KEY);
presetBtn("wfPresetPose", "wan_vace_v2v_pose", V2V_WORKFLOW_KEY);
presetBtn("wfPresetPoseDepth", "wan_vace_v2v_pose_depth", V2V_WORKFLOW_KEY);

// ComfyUI 接続チェック：GPU・ノード・モデルファイル
$("comfyCheckBtn").onclick = async () => {
  const box = $("comfyCheck");
  const s = readSettings();
  box.textContent = "確認中…";
  const workflows = [
    { label: "文章→動画", json: loadWorkflow()?.json },
    { label: "動画→動画", json: loadJsonKey(V2V_WORKFLOW_KEY)?.json },
  ].filter((w) => w.json);
  try {
    const r = await fetch("/api/comfy/check", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comfyUrl: s.comfyUrl, workflows }),
    });
    const j = await r.json();
    box.innerHTML = "";
    const line = (text, cls) => { const d = document.createElement("div"); d.textContent = text; if (cls) d.className = cls; box.appendChild(d); };
    if (j.gpu) line(`GPU：${j.gpu.name}${j.gpu.vramGB ? `（${j.gpu.vramGB}GB、空き ${j.gpu.freeGB}GB）` : ""}`);
    line(j.ok ? "✅ 準備OK：動画を生成できます" : "⚠ 次の点を直してください", j.ok ? "ok" : "ng");
    j.problems.forEach((p) => line("・" + p, "ng"));
    j.notes.forEach((p) => line("・" + p));
    if (!workflows.length) line("・ワークフローが未設定です。「標準を使う」を押してください。", "ng");
  } catch (e) { box.textContent = "確認に失敗しました: " + e.message; }
};

// タイムライン
$("tlRunBtn").onclick = runTimeline;
$("tlKendo").onclick = () => {
  KENDO_TIMELINE.forEach((p, i) => ($("tl" + i).value = p));
  if (!$("v2vPrompt").value.trim()) $("presetKendo").click();
  save(); updateTimelineTotal();
};
$("tlClear").onclick = () => {
  for (let i = 0; i < TL_SLOTS; i++) $("tl" + i).value = "";
  save(); updateTimelineTotal();
};
for (let i = 0; i < TL_SLOTS; i++) $("tl" + i).addEventListener("input", updateTimelineTotal);
for (const id of ["tlUseRef", "v2vStart"]) $(id).addEventListener("change", updateTimelineTotal);

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- 初期化 ----------------
$("baseUrl").value = $("preset").value;
load();
const match = [...$("preset").options].find((o) => o.value === $("baseUrl").value);
$("preset").value = match ? match.value : "custom";
showWorkflowName();
showV2VWorkflowName();
// ワークフローが未設定なら、PCに入れたモデル用の標準ワークフローを自動で設定
if (!loadWorkflow()) usePreset("wan_vace_t2v", WORKFLOW_KEY, true).catch(() => {});
if (!loadJsonKey(V2V_WORKFLOW_KEY)) usePreset("wan_vace_v2v_pose_depth", V2V_WORKFLOW_KEY, true).catch(() => {});
showRef();
updateTimelineTotal();
if (!$("v2vNegative").value) $("v2vNegative").value = KENDO_PRESET.negative;
renderStory();
renderQueue();
