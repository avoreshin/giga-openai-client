import "dotenv/config";
import { ChatClientFactory } from "./llm-client.ts";

const aiUrl = process.env.GIGACHAT_AI_URL ?? "https://gigachat.devices.sberbank.ru/api/v1/";
const aiToken = process.env.GIGACHAT_AI_TOKEN;
const model = process.env.GIGACHAT_MODEL ?? "GigaChat-2-Max";
const prompt = process.env.GIGACHAT_PROMPT ?? "Привет! Ответь одним словом.";

if (!aiToken) {
  console.error("Missing GIGACHAT_AI_TOKEN. Set it in .env or the environment.");
  console.error("Example: GIGACHAT_AI_TOKEN=... npm test");
  process.exit(1);
}

const client = ChatClientFactory.create({
  baseUrl: aiUrl,
  apiToken: aiToken,
});

const response = await client.postChatCompletions({
  model,
  temperature: 0.3,
  max_tokens: 1000,
  messages: [{ role: "user", content: prompt }],
});

console.log(response.choices[0]?.message?.content ?? "<empty response>");
