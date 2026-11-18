// ComfyUI まわりの補助
//  - 標準ワークフロー（workflows/*.json）の一覧と配布
//  - 接続チェック：ComfyUI に届くか、GPU、ワークフローに必要なノードとモデルファイルがそろっているか

const fs = require("fs");
const path = require("path");
const { comfyBase } = require("./video");

const WF_DIR = path.join(__dirname, "workflows");

// 標準ワークフロー（PCに入れた Wan 2.1 VACE 1.3B / umT5 fp8 / Wan 2.1 VAE 用）
const PRESETS = [
  { id: "wan_vace_t2v", kind: "t2v", name: "標準：文章→動画（Wan VACE 1.3B）" },
  { id: "wan_vace_v2v_pose", kind: "v2v", name: "標準：動画→動画・骨格のみ（Wan VACE 1.3B）" },
  { id: "wan_vace_v2v_pose_depth", kind: "v2v", name: "標準：動画→動画・骨格＋深度（剣道おすすめ）" },
];

function loadPreset(id) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return null;
  return { ...p, json: JSON.parse(fs.readFileSync(path.join(WF_DIR, `${p.id}.json`), "utf8")) };
}

// ノードが無いときの案内
const NODE_HINTS = {
  DWPreprocessor: "カスタムノード comfyui_controlnet_aux を入れてください（custom_nodes に git clone → ComfyUI 再起動）",
  DepthAnythingV2Preprocessor: "カスタムノード comfyui_controlnet_aux を入れてください",
  WanVaceToVideo: "ComfyUI が古い可能性があります。更新してください（update フォルダの update_comfyui.bat）",
  TrimVideoLatent: "ComfyUI が古い可能性があります。更新してください",
  LoadVideo: "ComfyUI が古い可能性があります。更新してください",
  GetVideoComponents: "ComfyUI が古い可能性があります。更新してください",
  CreateVideo: "ComfyUI が古い可能性があります。更新してください",
  SaveVideo: "ComfyUI が古い可能性があります。更新してください",
};
// モデルファイルの置き場所
const MODEL_DIRS = {
  UNETLoader: "models/diffusion_models",
  CLIPLoader: "models/text_encoders",
  VAELoader: "models/vae",
  CheckpointLoaderSimple: "models/checkpoints",
};
// 初回実行時にノードが自動でダウンロードするので、一覧に無くても問題ない入力
const AUTO_DOWNLOAD = new Set(["DWPreprocessor", "DepthAnythingV2Preprocessor"]);

// object_info の入力定義から選択肢の一覧を取り出す（旧形式 [[...]] と新形式 ["COMBO", {options}] の両方）
function comboOptions(spec) {
  if (!Array.isArray(spec)) return null;
  if (Array.isArray(spec[0])) return spec[0];
  if (spec[0] === "COMBO" && Array.isArray(spec[1]?.options)) return spec[1].options;
  return null;
}

function checkWorkflow(label, wf, info) {
  const problems = [];
  if (!wf || typeof wf !== "object") return [`${label}：ワークフローが未設定です`];
  for (const [nid, n] of Object.entries(wf)) {
    const ct = n?.class_type;
    if (!ct) continue;
    const def = info[ct];
    if (!def) {
      problems.push(`${label}：ノード「${ct}」がありません。${NODE_HINTS[ct] || "必要なカスタムノードを入れてください"}`);
      continue;
    }
    const specs = { ...(def.input?.required || {}), ...(def.input?.optional || {}) };
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (typeof v !== "string" || /%[A-Z]+%/.test(v)) continue; // 差し込み用の目印は実行時に置き換わる
      const opts = comboOptions(specs[k]);
      if (!opts || opts.includes(v)) continue;
      if (AUTO_DOWNLOAD.has(ct)) continue;
      const dir = MODEL_DIRS[ct];
      problems.push(dir
        ? `${label}：モデル「${v}」が見つかりません → ComfyUI の ${dir} に置いてください`
        : `${label}：ノード${nid}（${ct}）の「${k}」に「${v}」は選べません`);
    }
  }
  return problems;
}

async function check({ comfyUrl, workflows = [] }) {
  const base = comfyBase(comfyUrl);
  const result = { ok: false, url: base, gpu: null, problems: [], notes: [] };
  let stats;
  try {
    const r = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(5000) });
    stats = await r.json();
  } catch (e) {
    result.problems.push(`ComfyUI に接続できません（${base}）。ComfyUI を起動してから、もう一度押してください。`);
    return result;
  }
  const dev = (stats.devices || [])[0];
  if (dev) {
    result.gpu = {
      name: dev.name,
      type: dev.type,
      vramGB: dev.vram_total ? +(dev.vram_total / 1024 ** 3).toFixed(1) : null,
      freeGB: dev.vram_free ? +(dev.vram_free / 1024 ** 3).toFixed(1) : null,
    };
    if (dev.type === "cpu") result.problems.push("ComfyUI が GPU ではなく CPU で動いています。NVIDIA 版（run_nvidia_gpu.bat）で起動してください。");
    else if (result.gpu.freeGB != null && result.gpu.freeGB < 4) {
      result.notes.push(`GPU の空きメモリが ${result.gpu.freeGB}GB です。文章AI（LM Studio など）のモデルをアンロードすると安定します。`);
    }
  }
  if (stats.system?.comfyui_version) result.notes.push(`ComfyUI ${stats.system.comfyui_version}`);

  let info;
  try {
    info = await (await fetch(`${base}/object_info`)).json();
  } catch (e) {
    result.problems.push(`ノード一覧を取得できません: ${e.message}`);
    return result;
  }
  for (const w of workflows) result.problems.push(...checkWorkflow(w.label, w.json, info));
  if (workflows.some((w) => JSON.stringify(w.json || {}).includes("Preprocessor"))) {
    result.notes.push("骨格・深度の検出モデルは、初回の実行時に自動でダウンロードされます（数分かかります）。");
  }
  result.ok = result.problems.length === 0;
  return result;
}

async function handle(req, res, url, readBody, sendJson) {
  if (req.method === "GET" && url.pathname === "/api/comfy/presets") {
    return sendJson(res, 200, { presets: PRESETS });
  }
  if (req.method === "GET" && url.pathname === "/api/comfy/preset") {
    const p = loadPreset(url.searchParams.get("id"));
    return p ? sendJson(res, 200, p) : sendJson(res, 404, { error: "preset not found" });
  }
  if (req.method === "POST" && url.pathname === "/api/comfy/check") {
    return sendJson(res, 200, await check(JSON.parse(await readBody(req))));
  }
  return false;
}

module.exports = { handle, check, checkWorkflow, loadPreset, PRESETS };
