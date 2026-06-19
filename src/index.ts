export default {
	async fetch(_request: Request, env: Env): Promise<Response> {
		const inputs = {
			prompt: "Wide 16:9 hand-drawn explainer cartoon, imperfect black marker outlines, flat colors, white circular-headed stick figure protagonist with short messy dark-brown hair, expressive round eyes, small eyebrows and mouth, minimal torso and thin stick limbs, simple high-contrast composition, readable in one to two seconds. No realistic humans, no 3D, no cinematic lighting, no glossy vector art, no decorative detail that does not improve comprehension. Visual type: narrative explainer scene. Sentence meaning: If you did nothing, you assume you should have energy. Composition: protagonist acting out the sentence with one clear prop or visual metaphor. Background: simple scene-appropriate background. The protagonist's emotion is clear, readable emotion matching the sentence. Exact hand-written on-screen text: DID NOTHING. Communicate exactly this sentence and no additional story beat.",
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
