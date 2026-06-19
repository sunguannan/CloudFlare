// Cloudflare Workers AI · 文生图多模型面板
// 路由：
//   GET  /         → HTML 页面（模型选择 + 角色参考图 + 提示词 + 历史）
//   POST /generate → 接受 JSON { model, prompt, width, height, negative_prompt?, strength?, num_steps?, guidance?, seed?, image_b64?, mask_b64? }
//   GET  /healthz  → 健康检查
//
// 模型来源：CF Workers AI 免费 beta 模型
//   - @cf/stabilityai/stable-diffusion-xl-base-1.0  (高质量文生图 / 也可 img2img，输出 jpeg)
//   - @cf/bytedance/stable-diffusion-xl-lightning   (高速 SDXL，输出 jpeg)
//   - @cf/runwayml/stable-diffusion-v1-5-img2img    (经典 img2img，512 推荐，输出 png)
//   - @cf/runwayml/stable-diffusion-v1-5-inpainting (局部重绘，需要 image+mask，输出 png)

type GenBody = {
	model?: string;
	prompt?: string;
	negative_prompt?: string;
	width?: number;
	height?: number;
	strength?: number;
	num_steps?: number;
	guidance?: number;
	seed?: number;
	image_b64?: string;
	mask_b64?: string;
};

type ModelSpec = {
	id: string;
	name: string;
	tag: string;
	mime: string;
	needs: "none" | "image" | "image+mask";
	hint: string;
};

const MODELS: Record<string, ModelSpec> = {
	"@cf/stabilityai/stable-diffusion-xl-base-1.0": {
		id: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
		name: "SDXL Base 1.0",
		tag: "Stability · 高质量",
		mime: "image/jpeg",
		needs: "none",
		hint: "通用文生图，质量最好；可选传参考图做 img2img。",
	},
	"@cf/bytedance/stable-diffusion-xl-lightning": {
		id: "@cf/bytedance/stable-diffusion-xl-lightning",
		name: "SDXL Lightning",
		tag: "ByteDance · 极速",
		mime: "image/jpeg",
		needs: "none",
		hint: "几秒出图，适合快速试风格。",
	},
	"@cf/runwayml/stable-diffusion-v1-5-img2img": {
		id: "@cf/runwayml/stable-diffusion-v1-5-img2img",
		name: "SD 1.5 img2img",
		tag: "RunwayML · 图生图",
		mime: "image/png",
		needs: "image",
		hint: "传角色参考图后用 strength 控制动作/姿态变化幅度。",
	},
	"@cf/runwayml/stable-diffusion-v1-5-inpainting": {
		id: "@cf/runwayml/stable-diffusion-v1-5-inpainting",
		name: "SD 1.5 inpainting",
		tag: "RunwayML · 局部重绘",
		mime: "image/png",
		needs: "image+mask",
		hint: "需要参考图 + mask，mask 白色区域会被重绘。",
	},
};

const DEFAULT_MODEL = "@cf/stabilityai/stable-diffusion-xl-base-1.0";

// SDXL 系列的硬性限制：宽高 8 的倍数，256-2048
const MIN_DIM = 256;
const MAX_DIM = 2048;
const STEP = 8;

function sanitizeDim(v: unknown, fallback: number): number {
	let n = typeof v === "number" ? v : Number(v);
	if (!Number.isFinite(n)) n = fallback;
	n = Math.round(n);
	n = Math.max(MIN_DIM, Math.min(MAX_DIM, n));
	n = Math.round(n / STEP) * STEP;
	return n;
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}

function getModel(id: unknown): ModelSpec {
	const s = typeof id === "string" ? MODELS[id] : undefined;
	return s ?? MODELS[DEFAULT_MODEL]!;
}

function jsonError(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

async function handleGenerate(request: Request, env: Env): Promise<Response> {
	let body: GenBody = {};
	try {
		const ct = request.headers.get("content-type") || "";
		if (ct.includes("application/json")) {
			body = (await request.json()) as GenBody;
		} else {
			const fd = await request.formData();
			body = {
				model: String(fd.get("model") || ""),
				prompt: String(fd.get("prompt") || ""),
				negative_prompt: String(fd.get("negative_prompt") || ""),
				width: Number(fd.get("width") || 0),
				height: Number(fd.get("height") || 0),
				strength: fd.has("strength") ? Number(fd.get("strength")) : undefined,
				num_steps: fd.has("num_steps") ? Number(fd.get("num_steps")) : undefined,
				guidance: fd.has("guidance") ? Number(fd.get("guidance")) : undefined,
				seed: fd.has("seed") ? Number(fd.get("seed")) : undefined,
			};
			// 文件字段
			const imageFile = fd.get("image");
			if (imageFile instanceof File && imageFile.size > 0) {
				const buf = await imageFile.arrayBuffer();
				body.image_b64 = bytesToB64(buf);
			}
			const maskFile = fd.get("mask");
			if (maskFile instanceof File && maskFile.size > 0) {
				const buf = await maskFile.arrayBuffer();
				body.mask_b64 = bytesToB64(buf);
			}
		}
	} catch {
		return jsonError(400, "请求体解析失败");
	}

	const prompt = (body.prompt || "").trim();
	if (!prompt) return jsonError(400, "提示词不能为空");

	const spec = getModel(body.model);

	const width = sanitizeDim(body.width, spec.needs === "image+mask" ? 512 : 1024);
	const height = sanitizeDim(body.height, spec.needs === "image+mask" ? 512 : 576);

	const negative_prompt = (body.negative_prompt || "").trim() || undefined;

	// img2img / inpainting 必须有 image_b64
	if ((spec.needs === "image" || spec.needs === "image+mask") && !body.image_b64) {
		return jsonError(400, `${spec.name} 需要上传参考图`);
	}
	if (spec.needs === "image+mask" && !body.mask_b64) {
		return jsonError(400, `${spec.name} 需要上传 mask（白色区域会被重绘）`);
	}

	const inputs: AiTextToImageInput = {
		prompt,
		width,
		height,
		...(negative_prompt ? { negative_prompt } : {}),
		...(body.image_b64 ? { image_b64: body.image_b64 } : {}),
		...(body.mask_b64 ? { mask: b64ToBytes(body.mask_b64) } : {}),
		...(typeof body.strength === "number" && Number.isFinite(body.strength)
			? { strength: clamp(body.strength, 0, 1) }
			: {}),
		...(typeof body.guidance === "number" && Number.isFinite(body.guidance)
			? { guidance: clamp(body.guidance, 0, 30) }
			: {}),
		...(typeof body.num_steps === "number" && Number.isFinite(body.num_steps)
			? { num_steps: clamp(Math.round(body.num_steps), 1, 20) }
			: {}),
		...(typeof body.seed === "number" && Number.isFinite(body.seed)
			? { seed: Math.round(body.seed) }
			: {}),
	};

	try {
		const response = await env.AI.run(spec.id, inputs);
		return new Response(response as unknown as BodyInit, {
			headers: {
				"content-type": spec.mime,
				"cache-control": "no-store",
				"x-model": spec.id,
			},
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return jsonError(500, `生成失败: ${msg}`);
	}
}

function bytesToB64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let bin = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		bin += String.fromCharCode.apply(
			null,
			Array.from(bytes.subarray(i, i + chunk)),
		);
	}
	return btoa(bin);
}

function b64ToBytes(b64: string): number[] {
	const bin = atob(b64);
	const out = new Array<number>(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function pageHTML(): string {
	const modelOptions = Object.values(MODELS)
		.map(
			(m) => `
      <label class="model-card" data-model="${m.id}" data-needs="${m.needs}">
        <input type="radio" name="model" value="${m.id}" ${m.id === DEFAULT_MODEL ? "checked" : ""}/>
        <div class="mc-body">
          <div class="mc-name">${m.name}</div>
          <div class="mc-tag">${m.tag}</div>
          <div class="mc-hint">${m.hint}</div>
        </div>
      </label>`,
		)
		.join("");

	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Text → Image · 模型实验室</title>
<style>
  :root {
    --bg: #0b0d12; --panel: #141821; --panel-2: #1b2030; --border: #262b3a;
    --text: #e6e8ef; --muted: #8a91a4; --accent: #7c5cff; --accent-2: #5b8cff;
    --danger: #ff5c7a; --ok: #4ade80;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC",
      "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  a { color: var(--accent-2); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { background: var(--panel-2); padding: 1px 6px; border-radius: 4px; font-size: 12px; }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 24px 20px 60px; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  header h1 { margin: 0; font-size: 22px; font-weight: 600; }
  header .sub { color: var(--muted); font-size: 13px; }
  .grid { display: grid; grid-template-columns: 1.15fr 1fr; gap: 20px; }
  @media (max-width: 980px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 18px; }
  label.field { display: block; font-size: 13px; color: var(--muted); margin-bottom: 8px; margin-top: 14px; }
  label.field:first-child { margin-top: 0; }
  textarea, input[type="number"], input[type="text"] {
    width: 100%; background: var(--panel-2); color: var(--text);
    border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
    font-size: 14px; outline: none; transition: border-color .15s;
    font-family: inherit;
  }
  textarea:focus, input:focus { border-color: var(--accent); }
  textarea { min-height: 100px; resize: vertical; line-height: 1.5; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  .row > * { flex: 1; min-width: 100px; }
  .presets { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
  .chip {
    background: var(--panel-2); border: 1px solid var(--border);
    color: var(--text); padding: 6px 12px; border-radius: 999px;
    font-size: 12px; cursor: pointer; transition: all .15s; user-select: none;
  }
  .chip:hover { border-color: var(--accent); }
  .chip.active { background: var(--accent); border-color: var(--accent); color: white; }

  /* 模型选择 */
  .model-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  @media (max-width: 600px) { .model-grid { grid-template-columns: 1fr; } }
  .model-card {
    display: block; cursor: pointer; padding: 12px;
    background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 10px; transition: all .15s; position: relative;
  }
  .model-card:hover { border-color: var(--accent); }
  .model-card input { position: absolute; opacity: 0; pointer-events: none; }
  .model-card .mc-name { font-size: 14px; font-weight: 600; }
  .model-card .mc-tag { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .model-card .mc-hint { font-size: 12px; color: var(--muted); margin-top: 6px; line-height: 1.45; }
  .model-card.checked { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(124,92,255,.18); }

  /* 文件上传 */
  .file-drop {
    display: flex; align-items: center; gap: 12px; padding: 10px;
    background: var(--panel-2); border: 1px dashed var(--border); border-radius: 10px;
    cursor: pointer; transition: all .15s;
  }
  .file-drop:hover { border-color: var(--accent); }
  .file-drop.has-file { border-style: solid; }
  .file-drop img { width: 56px; height: 56px; object-fit: cover; border-radius: 8px; }
  .file-drop .fd-meta { flex: 1; min-width: 0; }
  .file-drop .fd-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-drop .fd-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .file-drop .fd-clear { background: transparent; border: none; color: var(--muted); cursor: pointer; padding: 4px 8px; }
  .file-drop .fd-clear:hover { color: var(--danger); }

  .actions { margin-top: 18px; display: flex; gap: 10px; align-items: center; }
  button.primary {
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: white; border: none; padding: 11px 18px; border-radius: 10px;
    font-size: 14px; font-weight: 600; cursor: pointer; transition: transform .08s, opacity .15s;
  }
  button.primary:hover:not(:disabled) { transform: translateY(-1px); }
  button.primary:disabled { opacity: 0.6; cursor: not-allowed; }
  button.ghost {
    background: transparent; color: var(--muted); border: 1px solid var(--border);
    padding: 10px 14px; border-radius: 10px; font-size: 13px; cursor: pointer;
  }
  button.ghost:hover { color: var(--text); border-color: var(--accent); }

  .preview {
    min-height: 360px; display: flex; align-items: center; justify-content: center;
    background:
      linear-gradient(45deg, var(--panel-2) 25%, transparent 25%),
      linear-gradient(-45deg, var(--panel-2) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, var(--panel-2) 75%),
      linear-gradient(-45deg, transparent 75%, var(--panel-2) 75%);
    background-size: 20px 20px;
    background-position: 0 0, 0 10px, 10px -10px, 10px 0;
    background-color: #0f1218;
    border-radius: 10px; overflow: hidden; position: relative;
  }
  .preview img { max-width: 100%; max-height: 540px; display: block; }
  .placeholder { color: var(--muted); font-size: 13px; padding: 24px; text-align: center; }
  .spinner { width: 36px; height: 36px; border-radius: 50%; border: 3px solid var(--border); border-top-color: var(--accent); animation: spin .9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status { font-size: 12px; color: var(--muted); margin-top: 10px; min-height: 16px; }
  .status.err { color: var(--danger); } .status.ok { color: var(--ok); }
  .meta { display: flex; gap: 14px; font-size: 12px; color: var(--muted); margin-top: 10px; flex-wrap: wrap; }
  .meta a { color: var(--accent-2); }

  /* 历史 */
  .history { margin-top: 14px; display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
  .history .h-item { position: relative; aspect-ratio: 1; border-radius: 8px; overflow: hidden; cursor: pointer; border: 1px solid var(--border); }
  .history .h-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .history .h-item .h-del { position: absolute; top: 4px; right: 4px; background: rgba(0,0,0,.55); color: white; border: none; border-radius: 50%; width: 20px; height: 20px; font-size: 12px; line-height: 1; cursor: pointer; display: none; }
  .history .h-item:hover .h-del { display: block; }
  .history-empty { color: var(--muted); font-size: 12px; padding: 10px 0; }

  details summary { cursor: pointer; color: var(--muted); font-size: 13px; user-select: none; }
  .hidden { display: none !important; }
  .strength-row { transition: opacity .15s; }
  .strength-row.dim { opacity: 0.35; pointer-events: none; }
  footer { margin-top: 20px; color: var(--muted); font-size: 12px; text-align: center; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>Text → Image · 模型实验室</h1>
        <div class="sub">Cloudflare Workers AI · 4 个免费模型对比调试</div>
      </div>
      <div class="sub">POST <code>/generate</code></div>
    </header>

    <div class="grid">
      <div class="card">
        <label class="field">模型</label>
        <div class="model-grid" id="modelGrid">${modelOptions}</div>

        <label class="field" for="prompt">提示词 (prompt)</label>
        <textarea id="prompt" placeholder="例：a cyberpunk girl with red hair, dynamic pose, neon city background, cinematic lighting"></textarea>

        <label class="field">角色参考图（用于 img2img / inpainting；存到 localStorage，刷新不丢）</label>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <label class="file-drop" id="refDrop">
            <input type="file" id="refFile" accept="image/*" class="hidden" />
            <div class="placeholder" style="padding: 0; font-size: 12px;">点击上传参考图</div>
          </label>
          <label class="file-drop" id="maskDrop">
            <input type="file" id="maskFile" accept="image/*" class="hidden" />
            <div class="placeholder" style="padding: 0; font-size: 12px;">mask（仅 inpainting）</div>
          </label>
        </div>

        <div class="strength-row" id="strengthRow">
          <label class="field" for="strength">变化强度 strength（仅在传了参考图时生效）<span id="strengthVal" style="color:var(--text);margin-left:6px;">0.65</span></label>
          <input type="range" id="strength" min="0" max="1" step="0.05" value="0.65" style="width:100%;"/>
        </div>

        <label class="field">尺寸</label>
        <div class="presets" id="presets">
          <div class="chip active" data-w="1024" data-h="576">1024 × 576 (16:9)</div>
          <div class="chip" data-w="1920" data-h="1080">1920 × 1080 (16:9)</div>
          <div class="chip" data-w="1280" data-h="720">1280 × 720 (16:9)</div>
          <div class="chip" data-w="768" data-h="1344">768 × 1344 (9:16)</div>
          <div class="chip" data-w="1024" data-h="1024">1024 × 1024 (1:1)</div>
          <div class="chip" data-w="512" data-h="512">512 × 512 (SD 1.5 推荐)</div>
        </div>
        <div class="row" style="margin-top: 10px;">
          <div>
            <label class="field" style="margin-top:0" for="width">宽</label>
            <input type="number" id="width" value="1024" min="256" max="2048" step="8" />
          </div>
          <div>
            <label class="field" style="margin-top:0" for="height">高</label>
            <input type="number" id="height" value="576" min="256" max="2048" step="8" />
          </div>
        </div>

        <details style="margin-top: 14px;">
          <summary>高级 · 反向提示词 / steps / guidance / seed</summary>
          <label class="field" for="negative_prompt">negative_prompt</label>
          <textarea id="negative_prompt" style="min-height: 50px;" placeholder="blurry, low quality, extra fingers, watermark"></textarea>
          <div class="row" style="margin-top: 10px;">
            <div>
              <label class="field" style="margin-top:0" for="num_steps">num_steps (1-20)</label>
              <input type="number" id="num_steps" min="1" max="20" step="1" placeholder="默认 20" />
            </div>
            <div>
              <label class="field" style="margin-top:0" for="guidance">guidance</label>
              <input type="number" id="guidance" min="0" max="30" step="0.5" placeholder="默认 7.5" />
            </div>
            <div>
              <label class="field" style="margin-top:0" for="seed">seed</label>
              <input type="number" id="seed" step="1" placeholder="留空随机" />
            </div>
          </div>
        </details>

        <div class="actions">
          <button class="primary" id="go">生成</button>
          <button class="ghost" id="reset">重置</button>
          <button class="ghost" id="clearHistory">清空历史</button>
        </div>
        <div class="status" id="status"></div>
      </div>

      <div class="card">
        <div class="preview" id="preview">
          <div class="placeholder">填提示词 → 点生成</div>
        </div>
        <div class="meta" id="meta" style="display:none;">
          <span id="metaModel"></span>
          <span id="metaDims"></span>
          <span id="metaParams"></span>
          <a id="openRaw" target="_blank" rel="noopener">查看原图</a>
          <a id="download" download="image">下载</a>
        </div>
        <div class="status" id="historyLabel" style="margin-top: 14px; margin-bottom: 0;">历史 (本会话)</div>
        <div class="history" id="history">
          <div class="history-empty">还没有生成记录</div>
        </div>
      </div>
    </div>

    <footer>
      API：<code>POST /generate</code> · body = <code>{ model, prompt, width, height, negative_prompt?, strength?, num_steps?, guidance?, seed?, image_b64?, mask_b64? }</code> → <code>image/jpeg | image/png</code>
    </footer>
  </div>

<script>
const $ = (id) => document.getElementById(id);
const modelGrid = $("modelGrid");
const promptEl = $("prompt");
const negEl = $("negative_prompt");
const refFile = $("refFile");
const refDrop = $("refDrop");
const maskFile = $("maskFile");
const maskDrop = $("maskDrop");
const strengthRow = $("strengthRow");
const strengthEl = $("strength");
const strengthVal = $("strengthVal");
const wEl = $("width");
const hEl = $("height");
const presets = $("presets");
const preview = $("preview");
const statusEl = $("status");
const goBtn = $("go");
const meta = $("meta");
const metaModel = $("metaModel");
const metaDims = $("metaDims");
const metaParams = $("metaParams");
const openRaw = $("openRaw");
const downloadEl = $("download");
const historyEl = $("history");
const numStepsEl = $("num_steps");
const guidanceEl = $("guidance");
const seedEl = $("seed");

// 角色参考图持久化（localStorage）
const LS_REF = "t2i_ref_b64";
const LS_REF_NAME = "t2i_ref_name";
const LS_HISTORY = "t2i_history_v1";
const HISTORY_MAX = 24;

let currentBlobUrl = null;
let refDataUrl = null;
let maskDataUrl = null;

// 工具：File → DataURL
function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
function dataURLToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(",");
  const mime = (head.match(/data:([^;]+);/) || [, "application/octet-stream"])[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// 模型选择
function refreshModelChecked() {
  const checked = modelGrid.querySelector("input:checked");
  modelGrid.querySelectorAll(".model-card").forEach((c) => {
    c.classList.toggle("checked", c.querySelector("input") === checked);
  });
  if (checked) {
    const needs = checked.closest(".model-card").dataset.needs;
    strengthRow.classList.toggle("dim", !(refDataUrl && (needs === "image" || needs === "image+mask")));
    // 模型切换时给个尺寸提示
    if (needs === "image+mask" && (wEl.value === "1024" || wEl.value === "1920")) {
      // 留作提示，不强制
    }
  }
}
modelGrid.addEventListener("change", refreshModelChecked);
refreshModelChecked();

// 尺寸预设
presets.addEventListener("click", (e) => {
  const t = e.target.closest(".chip");
  if (!t) return;
  [...presets.children].forEach((c) => c.classList.remove("active"));
  t.classList.add("active");
  wEl.value = t.dataset.w;
  hEl.value = t.dataset.h;
});

strengthEl.addEventListener("input", () => { strengthVal.textContent = strengthEl.value; });

// 角色参考图
refDrop.addEventListener("click", (e) => { if (e.target.tagName !== "BUTTON") refFile.click(); });
refFile.addEventListener("change", async () => {
  const f = refFile.files?.[0];
  if (!f) return;
  refDataUrl = await fileToDataURL(f);
  try { localStorage.setItem(LS_REF, refDataUrl); localStorage.setItem(LS_REF_NAME, f.name); } catch {}
  renderRef();
  refreshModelChecked();
});
maskDrop.addEventListener("click", (e) => { if (e.target.tagName !== "BUTTON") maskFile.click(); });
maskFile.addEventListener("change", async () => {
  const f = maskFile.files?.[0];
  if (!f) return;
  maskDataUrl = await fileToDataURL(f);
  renderMask();
});

function clearRef() {
  refDataUrl = null;
  localStorage.removeItem(LS_REF); localStorage.removeItem(LS_REF_NAME);
  refFile.value = "";
  renderRef();
  refreshModelChecked();
}
function clearMask() {
  maskDataUrl = null;
  maskFile.value = "";
  renderMask();
}

function renderRef() {
  if (refDataUrl) {
    const name = localStorage.getItem(LS_REF_NAME) || "reference";
    refDrop.innerHTML = "";
    refDrop.classList.add("has-file");
    const img = new Image(); img.src = refDataUrl;
    const meta = document.createElement("div"); meta.className = "fd-meta";
    const n = document.createElement("div"); n.className = "fd-name"; n.textContent = name;
    const s = document.createElement("div"); s.className = "fd-sub"; s.textContent = "参考图 · 点此更换";
    const btn = document.createElement("button"); btn.className = "fd-clear"; btn.textContent = "✕";
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); clearRef(); });
    meta.appendChild(n); meta.appendChild(s);
    refDrop.appendChild(img); refDrop.appendChild(meta); refDrop.appendChild(btn);
    // 保留隐藏 input
    const hidden = document.createElement("input");
    hidden.type = "file"; hidden.id = "refFile"; hidden.accept = "image/*"; hidden.className = "hidden";
    refDrop.appendChild(hidden);
    hidden.addEventListener("change", async () => {
      const f = hidden.files?.[0]; if (!f) return;
      refDataUrl = await fileToDataURL(f);
      try { localStorage.setItem(LS_REF, refDataUrl); localStorage.setItem(LS_REF_NAME, f.name); } catch {}
      renderRef(); refreshModelChecked();
    });
  } else {
    refDrop.classList.remove("has-file");
    refDrop.innerHTML = '<input type="file" id="refFile" accept="image/*" class="hidden" /><div class="placeholder" style="padding: 0; font-size: 12px;">点击上传参考图</div>';
    document.getElementById("refFile").addEventListener("change", refFile.onchange ? (e) => refFile.dispatchEvent(e) : null);
    // 重新绑定
    rebindFileInput("refFile", async (file) => {
      refDataUrl = await fileToDataURL(file);
      try { localStorage.setItem(LS_REF, refDataUrl); localStorage.setItem(LS_REF_NAME, file.name); } catch {}
      renderRef(); refreshModelChecked();
    });
  }
}
function renderMask() {
  if (maskDataUrl) {
    maskDrop.classList.add("has-file");
    maskDrop.innerHTML = "";
    const img = new Image(); img.src = maskDataUrl;
    const meta = document.createElement("div"); meta.className = "fd-meta";
    const n = document.createElement("div"); n.className = "fd-name"; n.textContent = "mask";
    const s = document.createElement("div"); s.className = "fd-sub"; s.textContent = "白色区域将被重绘 · 点击更换";
    const btn = document.createElement("button"); btn.className = "fd-clear"; btn.textContent = "✕";
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); clearMask(); });
    meta.appendChild(n); meta.appendChild(s);
    maskDrop.appendChild(img); maskDrop.appendChild(meta); maskDrop.appendChild(btn);
  } else {
    maskDrop.classList.remove("has-file");
    maskDrop.innerHTML = '<input type="file" id="maskFile" accept="image/*" class="hidden" /><div class="placeholder" style="padding: 0; font-size: 12px;">mask（仅 inpainting）</div>';
    rebindFileInput("maskFile", async (file) => { maskDataUrl = await fileToDataURL(file); renderMask(); });
  }
}
function rebindFileInput(id, onFile) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("change", async () => {
    const f = el.files?.[0];
    if (f) await onFile(f);
  });
}

// 启动时恢复参考图
try {
  const saved = localStorage.getItem(LS_REF);
  if (saved) { refDataUrl = saved; renderRef(); refreshModelChecked(); }
} catch {}

// 历史
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(LS_HISTORY) || "[]"); } catch { return []; }
}
function saveHistory(arr) {
  try { localStorage.setItem(LS_HISTORY, JSON.stringify(arr.slice(0, HISTORY_MAX))); } catch {}
}
function pushHistory(item) {
  const arr = loadHistory();
  arr.unshift(item);
  saveHistory(arr);
  renderHistory();
}
function renderHistory() {
  const arr = loadHistory();
  if (!arr.length) { historyEl.innerHTML = '<div class="history-empty">还没有生成记录</div>'; return; }
  historyEl.innerHTML = "";
  arr.forEach((item, idx) => {
    const wrap = document.createElement("div"); wrap.className = "h-item"; wrap.title = item.prompt;
    const img = new Image(); img.src = item.dataUrl;
    const del = document.createElement("button"); del.className = "h-del"; del.textContent = "✕";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      const a = loadHistory(); a.splice(idx, 1); saveHistory(a); renderHistory();
    });
    wrap.appendChild(img); wrap.appendChild(del);
    wrap.addEventListener("click", () => {
      // 恢复为当前预览
      if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = item.dataUrl;
      preview.innerHTML = "";
      const big = new Image(); big.src = item.dataUrl; big.style.maxHeight = "540px";
      preview.appendChild(big);
      metaModel.textContent = item.model;
      metaDims.textContent = item.width + " × " + item.height;
      metaParams.textContent = item.params || "";
      openRaw.href = item.dataUrl;
      downloadEl.href = item.dataUrl;
      downloadEl.download = "image-" + (item.ts || Date.now()) + ".png";
      meta.style.display = "flex";
    });
    historyEl.appendChild(wrap);
  });
}
renderHistory();

function setStatus(text, kind = "") {
  statusEl.textContent = text || "";
  statusEl.className = "status" + (kind ? " " + kind : "");
}
function showLoading() {
  preview.innerHTML = '<div class="spinner"></div>';
  meta.style.display = "none";
}

async function generate() {
  const prompt = promptEl.value.trim();
  if (!prompt) { setStatus("提示词不能为空", "err"); promptEl.focus(); return; }
  const model = modelGrid.querySelector("input:checked")?.value;
  const width = parseInt(wEl.value, 10) || 1024;
  const height = parseInt(hEl.value, 10) || 576;
  const negative_prompt = negEl.value.trim();
  const strength = refDataUrl ? parseFloat(strengthEl.value) : undefined;
  const num_steps = numStepsEl.value ? parseInt(numStepsEl.value, 10) : undefined;
  const guidance = guidanceEl.value ? parseFloat(guidanceEl.value) : undefined;
  const seed = seedEl.value ? parseInt(seedEl.value, 10) : undefined;

  const needs = modelGrid.querySelector("input:checked").closest(".model-card").dataset.needs;
  if ((needs === "image" || needs === "image+mask") && !refDataUrl) {
    setStatus("当前模型需要上传参考图", "err"); return;
  }
  if (needs === "image+mask" && !maskDataUrl) {
    setStatus("inpainting 需要 mask（白色区域将被重绘）", "err"); return;
  }

  setStatus("正在生成…");
  goBtn.disabled = true;
  showLoading();

  const payload = {
    model, prompt, width, height, negative_prompt: negative_prompt || undefined,
    strength, num_steps, guidance, seed,
    image_b64: refDataUrl ? refDataUrl.split(",")[1] : undefined,
    mask_b64: maskDataUrl ? maskDataUrl.split(",")[1] : undefined,
  };

  try {
    const res = await fetch("/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let msg = "HTTP " + res.status;
      try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = URL.createObjectURL(blob);
    const dataUrl = await blobToDataURL(blob);
    const img = new Image(); img.src = currentBlobUrl; img.style.maxHeight = "540px";
    preview.innerHTML = ""; preview.appendChild(img);

    const paramsLine = [
      strength != null ? "strength=" + strength : null,
      num_steps != null ? "steps=" + num_steps : null,
      guidance != null ? "guidance=" + guidance : null,
      seed != null ? "seed=" + seed : null,
    ].filter(Boolean).join(" · ");

    metaModel.textContent = (model || "").split("/").pop();
    metaDims.textContent = width + " × " + height;
    metaParams.textContent = paramsLine;
    openRaw.href = currentBlobUrl;
    downloadEl.href = currentBlobUrl;
    const ext = blob.type.includes("jpeg") || blob.type.includes("jpg") ? "jpg" : "png";
    downloadEl.download = "image-" + Date.now() + "." + ext;
    meta.style.display = "flex";

    pushHistory({
      ts: Date.now(),
      prompt, model: (model || "").split("/").pop(), width, height,
      params: paramsLine, dataUrl,
    });

    setStatus("完成 ✓", "ok");
  } catch (err) {
    preview.innerHTML = '<div class="placeholder">生成失败</div>';
    setStatus("失败：" + (err.message || err), "err");
  } finally {
    goBtn.disabled = false;
  }
}
function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

goBtn.addEventListener("click", generate);
$("reset").addEventListener("click", () => {
  promptEl.value = ""; negEl.value = "";
  wEl.value = 1024; hEl.value = 576;
  numStepsEl.value = ""; guidanceEl.value = ""; seedEl.value = "";
  [...presets.children].forEach((c, i) => c.classList.toggle("active", i === 0));
  preview.innerHTML = '<div class="placeholder">填提示词 → 点生成</div>';
  meta.style.display = "none";
  setStatus("");
});
$("clearHistory").addEventListener("click", () => {
  if (confirm("清空所有历史？")) { saveHistory([]); renderHistory(); }
});

promptEl.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") generate();
});
</script>
</body>
</html>`;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const method = request.method.toUpperCase();

		if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
			return new Response(pageHTML(), {
				headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
			});
		}

		if (method === "POST" && (url.pathname === "/generate" || url.pathname === "/")) {
			return handleGenerate(request, env);
		}

		if (method === "GET" && url.pathname === "/healthz") {
			return new Response(
				JSON.stringify({ ok: true, models: Object.keys(MODELS), default: DEFAULT_MODEL }),
				{ headers: { "content-type": "application/json; charset=utf-8" } },
			);
		}

		return new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
