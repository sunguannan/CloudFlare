export default {
	async fetch(_request: Request, env: Env): Promise<Response> {
		// src/index.ts 示例

const inputs = {
  // 把提示词写得尽可能具体（见第二步）
  prompt: "A photorealistic, panoramic portrait of a futuristic city in the rain, neon lights, 16:9 ratio, ultra-detailed, 8k", 
  
  // 🌟 核心修改：手动设置符合 16:9 的分辨率
  width: 1024,   // 宽度
  height: 576    // 高度 (1024 * 9 / 16)
} satisfies AiTextToImageInput;

		const response =
			await env.AI.run<"@cf/stabilityai/stable-diffusion-xl-base-1.0">(
				"@cf/stabilityai/stable-diffusion-xl-base-1.0",
				inputs,
			);

		return new Response(response, {
			headers: {
				"content-type": "image/png",
			},
		});
	},
} satisfies ExportedHandler<Env>;
