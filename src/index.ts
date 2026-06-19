// Cloudflare Workers AI · 文生图（SDXL）—— 自带 UI
// 路由：
//   GET  /        → 渲染 HTML 表单页面
//   POST /generate → 接收 JSON { prompt, width, height, negative_prompt? }，返回 image/png
//   POST /        → 同上（兼容直接 form POST）

type GenBody = {
	prompt?: string;
	negative_prompt?: string;
	width?: number;
	height?: number;
};

const MODEL = "@cf/stabilityai/stable-diffusion-xl-base-1.0" as const;

// SDXL base 1.0 限制：宽高必须是 8 的倍数，256 ~ 2048
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

async function handleGenerate(request: Request, env: Env): Promise<Response> {
	let body: GenBody = {};
	try {
		// 支持 application/json 和 application/x-www-form-urlencoded
		const ct = request.headers.get("content-type") || "";
		if (ct.includes("application/json")) {
			body = (await request.json()) as GenBody;
		} else {
			const fd = await request.formData();
			body = {
				prompt: String(fd.get("prompt") || ""),
				negative_prompt: String(fd.get("negative_prompt") || ""),
				width: Number(fd.get("width") || 0),
				height: Number(fd.get("height") || 0),
			};
		}
	} catch {
		return jsonError(400, "请求体解析失败");
	}

	const prompt = (body.prompt || "").trim();
	if (!prompt) return jsonError(400, "提示词不能为空");

	const width = sanitizeDim(body.width, 1024);
	const height = sanitizeDim(body.height, 576);
	const negative_prompt = (body.negative_prompt || "").trim() || undefined;

	const inputs: AiTextToImageInput = {
		prompt,
		width,
		height,
		...(negative_prompt ? { negative_prompt } : {}),
	};

	try {
		const response = await env.AI.run<typeof MODEL>(MODEL, inputs);
		// SDXL 输出是 ReadableStream<Uint8Array>（PNG）
		return new Response(response, {
			headers: {
				"content-type": "image/png",
				"cache-control": "no-store",
			},
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return jsonError(500, `生成失败: ${msg}`);
	}
}

function jsonError(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function pageHTML(): string {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Text → Image · Cloudflare Workers AI</title>
<style>
  :root {
    --bg: #0b0d12;
    --panel: #141821;
    --panel-2: #1b2030;
    --border: #262b3a;
    --text: #e6e8ef;
    --muted: #8a91a4;
    --accent: #7c5cff;
    --accent-2: #5b8cff;
    --danger: #ff5c7a;
    --ok: #4ade80;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC",
      "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  a { color: var(--accent-2); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 80px; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
  header h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: 0.2px; }
  header .sub { color: var(--muted); font-size: 13px; }
  .grid { display: grid; grid-template-columns: 1fr 1.2fr; gap: 20px; }
  @media (max-width: 880px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 18px; }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 8px; }
  textarea, input[type="number"], input[type="text"] {
    width: 100%; background: var(--panel-2); color: var(--text);
    border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
    font-size: 14px; outline: none; transition: border-color .15s;
    font-family: inherit;
  }
  textarea:focus, input:focus { border-color: var(--accent); }
  textarea { min-height: 120px; resize: vertical; line-height: 1.5; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  .row > * { flex: 1; min-width: 110px; }
  .presets { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .chip {
    background: var(--panel-2); border: 1px solid var(--border);
    color: var(--text); padding: 6px 12px; border-radius: 999px;
    font-size: 12px; cursor: pointer; transition: all .15s; user-select: none;
  }
  .chip:hover { border-color: var(--accent); }
  .chip.active { background: var(--accent); border-color: var(--accent); color: white; }
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
  .details { margin-top: 16px; }
  .details summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  .preview {
    min-height: 320px; display: flex; align-items: center; justify-content: center;
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
  .spinner {
    width: 36px; height: 36px; border-radius: 50%;
    border: 3px solid var(--border); border-top-color: var(--accent);
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status { font-size: 12px; color: var(--muted); margin-top: 10px; min-height: 16px; }
  .status.err { color: var(--danger); }
  .status.ok { color: var(--ok); }
  .meta { display: flex; gap: 14px; font-size: 12px; color: var(--muted); margin-top: 10px; flex-wrap: wrap; }
  .meta a { color: var(--accent-2); }
  footer { margin-top: 24px; color: var(--muted); font-size: 12px; text-align: center; }
  code { background: var(--panel-2); padding: 1px 6px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>Text → Image</h1>
        <div class="sub">Cloudflare Workers AI · SDXL base 1.0</div>
      </div>
      <div class="sub">POST <code>/generate</code> · JSON / form</div>
    </header>

    <div class="grid">
      <div class="card">
        <label for="prompt">提示词 (prompt)</label>
        <textarea id="prompt" placeholder="例如：A cinematic photo of a futuristic city in the rain, neon lights, ultra-detailed, 8k"></textarea>

        <div style="margin-top: 16px;">
          <label>尺寸预设</label>
          <div class="presets" id="presets">
            <div class="chip active" data-w="1024" data-h="576">1024 × 576 (16:9)</div>
            <div class="chip" data-w="1920" data-h="1080">1920 × 1080 (16:9)</div>
            <div class="chip" data-w="1280" data-h="720">1280 × 720 (16:9)</div>
            <div class="chip" data-w="768" data-h="1344">768 × 1344 (9:16)</div>
            <div class="chip" data-w="1024" data-h="1024">1024 × 1024 (1:1)</div>
            <div class="chip" data-w="1536" data-h="640">1536 × 640 (宽屏)</div>
          </div>
        </div>

        <div class="row" style="margin-top: 16px;">
          <div>
            <label for="width">宽 (px)</label>
            <input type="number" id="width" value="1024" min="256" max="2048" step="8" />
          </div>
          <div>
            <label for="height">高 (px)</label>
            <input type="number" id="height" value="576" min="256" max="2048" step="8" />
          </div>
        </div>

        <details class="details">
          <summary>高级 · 反向提示词 (negative_prompt)</summary>
          <textarea id="negative_prompt" style="margin-top: 10px; min-height: 60px;"
            placeholder="例如：blurry, low quality, extra fingers, watermark"></textarea>
        </details>

        <div class="actions">
          <button class="primary" id="go">生成图片</button>
          <button class="ghost" id="reset">重置</button>
        </div>
        <div class="status" id="status"></div>
      </div>

      <div class="card">
        <div class="preview" id="preview">
          <div class="placeholder">点左侧「生成图片」开始</div>
        </div>
        <div class="meta" id="meta" style="display:none;">
          <span id="metaDims"></span>
          <a id="openRaw" target="_blank" rel="noopener">查看原图</a>
          <a id="download" download="image.png">下载</a>
        </div>
      </div>
    </div>

    <footer>
      API：<code>POST /generate</code> body = <code>{ prompt, width, height, negative_prompt? }</code> → <code>image/png</code>
    </footer>
  </div>

<script>
const $ = (id) => document.getElementById(id);
const promptEl = $("prompt");
const negEl = $("negative_prompt");
const wEl = $("width");
const hEl = $("height");
const presets = $("presets");
const preview = $("preview");
const statusEl = $("status");
const goBtn = $("go");
const meta = $("meta");
const metaDims = $("metaDims");
const openRaw = $("openRaw");
const download = $("download");

let currentBlobUrl = null;

presets.addEventListener("click", (e) => {
  const t = e.target.closest(".chip");
  if (!t) return;
  [...presets.children].forEach((c) => c.classList.remove("active"));
  t.classList.add("active");
  wEl.value = t.dataset.w;
  hEl.value = t.dataset.h;
});

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
  if (!prompt) {
    setStatus("提示词不能为空", "err");
    promptEl.focus();
    return;
  }
  const width = parseInt(wEl.value, 10) || 1024;
  const height = parseInt(hEl.value, 10) || 576;
  const negative_prompt = negEl.value.trim();

  setStatus("正在生成…");
  goBtn.disabled = true;
  showLoading();

  try {
    const res = await fetch("/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, width, height, negative_prompt }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || ("HTTP " + res.status));
    }
    const blob = await res.blob();
    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = URL.createObjectURL(blob);

    const img = new Image();
    img.src = currentBlobUrl;
    img.alt = prompt;
    preview.innerHTML = "";
    preview.appendChild(img);

    metaDims.textContent = width + " × " + height + " · PNG";
    openRaw.href = currentBlobUrl;
    download.href = currentBlobUrl;
    meta.style.display = "flex";

    setStatus("完成 ✓", "ok");
  } catch (err) {
    preview.innerHTML = '<div class="placeholder">生成失败</div>';
    setStatus("失败：" + (err.message || err), "err");
  } finally {
    goBtn.disabled = false;
  }
}

goBtn.addEventListener("click", generate);
$("reset").addEventListener("click", () => {
  promptEl.value = "";
  negEl.value = "";
  wEl.value = 1024; hEl.value = 576;
  [...presets.children].forEach((c, i) => c.classList.toggle("active", i === 0));
  preview.innerHTML = '<div class="placeholder">点左侧「生成图片」开始</div>';
  meta.style.display = "none";
  setStatus("");
});

// ⌘/Ctrl + Enter 提交
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

		// 页面
		if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
			return new Response(pageHTML(), {
				headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
			});
		}

		// 生成接口（JSON 优先，也兼容 form POST）
		if (method === "POST" && (url.pathname === "/generate" || url.pathname === "/")) {
			return handleGenerate(request, env);
		}

		// 简单健康检查 / 探测
		if (method === "GET" && url.pathname === "/healthz") {
			return new Response(JSON.stringify({ ok: true, model: MODEL }), {
				headers: { "content-type": "application/json; charset=utf-8" },
			});
		}

		return new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
