import { countTokens, Encoding } from "@oh-my-pi/pi-natives";
import { isEnoent, prompt, withFileLock } from "@oh-my-pi/pi-utils";
import { complete } from "@oh-my-pi/pi-ai";
import { rename } from "node:fs/promises";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createProjectMemory } from "./core";

export default function projectMemory(pi: ExtensionAPI): void {
	createProjectMemory(pi, text => countTokens(text, Encoding.Cl100kBase), (template, context) => prompt.render(template, context), isEnoent, withFileLock, rename, async (ctx, systemPrompt, inputText) => {
		const model = ctx.model;
		if (!model) throw new Error("No active model on session");
		const sessionId = ctx.sessionManager.getSessionId();
		const apiKey = await ctx.modelRegistry.getApiKey(model, sessionId);
		const headers = typeof ctx.modelRegistry.resolveModelHeaders === "function"
			? await ctx.modelRegistry.resolveModelHeaders(model)
			: model.headers;
		const response = await complete(model, { systemPrompt: [systemPrompt], messages: [{ role: "user", content: inputText, timestamp: Date.now() }] }, {
			apiKey,
			headers,
		});
		return {
			text: response.content.map(block => block.type === "text" ? block.text : "").filter(Boolean).join("\n"),
			stopReason: response.stopReason,
			contentTypes: response.content.map(block => block.type),
			errorMessage: response.errorMessage ? redactMemorySecrets(response.errorMessage) : undefined,
			errorClassificationMessage: response.errorClassificationMessage ? redactMemorySecrets(response.errorClassificationMessage) : undefined,
			errorStatus: response.errorStatus,
		};
	});
}
