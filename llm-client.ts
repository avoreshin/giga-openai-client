/**
 * Клиенты для GigaChat-совместимого API (`/models`, `/chat/completions`).
 *
 * **Реализации:** {@link ChatApiClient} — база; {@link OAuthGigaChatClient} — OAuth (официальный URL + Basic-ключ);
 * {@link BasicAuthChatClient} — `Authorization: Basic` на произвольный URL; {@link MtlsChatClient} — mTLS (см. `buildMtlsFetchExtras`).
 *
 * **TLS:** `GIGACHAT_TLS_CA_FILE`, `GIGACHAT_TLS_INSECURE` — см. {@link tlsFetchInit}.
 */

import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { randomUUID } from "node:crypto";
import { Agent } from "undici";

let _tlsInsecureAgent: Agent | undefined;
let _tlsCaAgent: Agent | undefined;
let _tlsCaResolvedPath: string | undefined;

function envTruthy(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

/**
 * Опции TLS для встроенного `fetch`: дополнительный PEM (`GIGACHAT_TLS_CA_FILE`) или отключение проверки (`GIGACHAT_TLS_INSECURE`).
 * Приоритет у CA-файла.
 */
function tlsFetchInit(): { dispatcher?: Agent } {
  const caRaw = process.env.GIGACHAT_TLS_CA_FILE?.trim();
  if (caRaw) {
    const resolved = path.isAbsolute(caRaw) ? caRaw : path.resolve(process.cwd(), caRaw);
    if (_tlsCaAgent && _tlsCaResolvedPath === resolved) return { dispatcher: _tlsCaAgent };
    const extra = fs.readFileSync(resolved, "utf8");
    _tlsCaAgent = new Agent({
      connect: { ca: [...tls.rootCertificates, extra], rejectUnauthorized: true },
    });
    _tlsCaResolvedPath = resolved;
    return { dispatcher: _tlsCaAgent };
  }
  if (!envTruthy(process.env.GIGACHAT_TLS_INSECURE)) return {};
  if (!_tlsInsecureAgent) {
    _tlsInsecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return { dispatcher: _tlsInsecureAgent };
}

// --- DTO ---

export interface PropertySchema {
  type: string;
  description: string;
}

export interface FunctionParameters {
  type: "object";
  properties: Record<string, PropertySchema>;
  required?: string[];
}

export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: FunctionParameters;
}

/**
 * GigaChat отправляет `arguments` как JSON-объект, OpenAI — как JSON-строку.
 * В TypeScript храним всегда как строку, сериализуем в объект при отправке.
 */
export interface FunctionCall {
  name: string;
  /** JSON-строка аргументов, например '{"path":"/foo"}' */
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "function";
  /** null разрешён — GigaChat требует явное поле в assistant+FC сообщении */
  content: string | null;
  function_call?: FunctionCall;
  /** Имя функции (для role="function") */
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
  /** null → поле не отправляется */
  functions?: FunctionDefinition[];
  /** "auto" | "none" */
  function_call?: string;
}

export interface ResponseChoice {
  message?: ChatMessage;
  index: number;
  finish_reason?: string;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatResponse {
  choices: ResponseChoice[];
  model?: string;
  usage?: Usage;
}

export interface ModelInfo {
  id: string;
  object?: string;
  owned_by?: string;
}

export interface ModelsResponse {
  data: ModelInfo[];
}

export interface TokenResponse {
  access_token: string;
  expires_at: number;
}

// --- Трассировка HTTP ---

export interface HttpCallTrace {
  id: number;
  timestamp: Date;
  url: string;
  requestJson: string;
  responseJson: string;
  statusCode: number;
  durationMs: number;
  error?: string;
}

let _traceSeq = 0;
const _httpTraces: HttpCallTrace[] = [];

export const HttpCallTraceStore = {
  nextTraceId: () => ++_traceSeq,
  record(trace: HttpCallTrace): void {
    _httpTraces.push(trace);
    if (_httpTraces.length > 500) _httpTraces.shift();
  },
  getAll(): readonly HttpCallTrace[] {
    return _httpTraces;
  },
  clear(): void {
    _httpTraces.splice(0);
  },
};

// --- Отмена операций ---

export interface Cancelable {
  isCanceled(): boolean;
  checkCanceled(): void;
}

/** Флаг отмены: вызовите `cancel()`, затем `checkCanceled()` прервёт ожидание. */
export class CancelFlag implements Cancelable {
  private _canceled = false;
  cancel(): void { this._canceled = true; }
  isCanceled(): boolean { return this._canceled; }
  checkCanceled(): void {
    if (this._canceled) throw new Error("Operation was canceled");
  }
}

// --- Базовый клиент ---

/** Нормализация base URL, TLS, трассировка, отмена. */
export abstract class ChatApiClient {
  protected readonly baseUrl: string;
  protected readonly cancelable?: Cancelable;

  constructor(baseUrl: string, cancelable?: Cancelable) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
    this.cancelable = cancelable;
  }

  abstract getModels(): Promise<ModelsResponse>;
  abstract postChatCompletions(request: ChatRequest): Promise<ChatResponse>;

  /** Один HTTP-запрос с JSON-ответом, трассировкой и поддержкой {@link tlsFetchInit}. */
  protected async fetchJson<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    this.cancelable?.checkCanceled();
    const traceId = HttpCallTraceStore.nextTraceId();
    const startedAt = new Date();
    const requestJson = init.body ? formatJsonIfPossible(init.body.toString()) : "";

    try {
      const controller = new AbortController();
      const mergedSignal = signal ?? controller.signal;

      const cancelPoll = setInterval(() => {
        if (this.cancelable?.isCanceled()) controller.abort();
      }, 500);

      let response: Response;
      try {
        response = await fetch(url, { ...tlsFetchInit(), ...init, signal: mergedSignal });
      } finally {
        clearInterval(cancelPoll);
      }

      this.cancelable?.checkCanceled();

      const bodyText = await response.text();
      const durationMs = Date.now() - startedAt.getTime();

      HttpCallTraceStore.record({
        id: traceId,
        timestamp: startedAt,
        url,
        requestJson,
        responseJson: formatJsonIfPossible(bodyText),
        statusCode: response.status,
        durationMs,
      });

      if (response.ok) {
        return JSON.parse(bodyText) as T;
      }

      throw new HttpError(bodyText, response.status, url);
    } catch (err) {
      if (err instanceof HttpError) throw err;

      const durationMs = Date.now() - startedAt.getTime();
      const message = err instanceof Error ? err.message : String(err);
      HttpCallTraceStore.record({
        id: traceId,
        timestamp: startedAt,
        url,
        requestJson,
        responseJson: "",
        statusCode: 0,
        durationMs,
        error: message,
      });
      throw new Error(`HTTP request failed: ${message}`, { cause: err });
    }
  }
}

export class HttpError extends Error {
  readonly statusCode: number;
  readonly url: string;

  constructor(message: string, statusCode: number, url: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.url = url;
  }
}

function formatJsonIfPossible(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); }
  catch { return text; }
}

// --- OAuth: официальный облачный GigaChat ---

const SBER_OAUTH_TOKEN_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";

/** Basic-ключ → OAuth на `ngw`, затем Bearer к `baseUrl`. */
export class OAuthGigaChatClient extends ChatApiClient {
  private readonly oauthBasicSecret: string;
  private accessToken = "";
  private accessTokenExpiresAtMs = 0;

  constructor(baseUrl: string, oauthBasicSecret: string, cancelable?: Cancelable) {
    super(baseUrl, cancelable);
    this.oauthBasicSecret = oauthBasicSecret;
  }

  private async ensureAccessToken(): Promise<void> {
    if (this.accessTokenExpiresAtMs > Date.now()) return;

    const formBody = new URLSearchParams({ scope: "GIGACHAT_API_PERS" });
    const requestId = randomUUID();
    const response = await fetch(SBER_OAUTH_TOKEN_URL, {
      ...tlsFetchInit(),
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        RqUID: requestId,
        Authorization: `Basic ${this.oauthBasicSecret}`,
      },
      body: formBody.toString(),
    });

    if (!response.ok) {
      throw new HttpError(await response.text(), response.status, SBER_OAUTH_TOKEN_URL);
    }

    const token: TokenResponse = await response.json();
    this.accessToken = token.access_token;
    this.accessTokenExpiresAtMs = token.expires_at;
  }

  override async getModels(): Promise<ModelsResponse> {
    await this.ensureAccessToken();
    return this.fetchJson<ModelsResponse>(
      this.baseUrl + "models",
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
      }
    );
  }

  override async postChatCompletions(request: ChatRequest): Promise<ChatResponse> {
    await this.ensureAccessToken();
    return this.fetchJson<ChatResponse>(
      this.baseUrl + "chat/completions",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: serializeChatRequestBody(request),
      }
    );
  }
}

// --- Basic Auth на произвольный хост ---

/** Тот же токен в `Authorization: Basic` для любого совместимого `baseUrl`. */
export class BasicAuthChatClient extends ChatApiClient {
  private readonly basicAuthToken: string;

  constructor(baseUrl: string, basicAuthToken: string, cancelable?: Cancelable) {
    super(baseUrl, cancelable);
    this.basicAuthToken = basicAuthToken;
  }

  override async getModels(): Promise<ModelsResponse> {
    return this.fetchJson<ModelsResponse>(
      this.baseUrl + "models",
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${this.basicAuthToken}`,
        },
      }
    );
  }

  override async postChatCompletions(request: ChatRequest): Promise<ChatResponse> {
    return this.fetchJson<ChatResponse>(
      this.baseUrl + "chat/completions",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Basic ${this.basicAuthToken}`,
        },
        body: serializeChatRequestBody(request),
      }
    );
  }
}

// --- mTLS (клиентский сертификат) ---

export interface MtlsChatClientConfig {
  baseUrl: string;
  /** Путь к PEM сертификата или base64-PEM */
  certificatePath?: string;
  privateKeyPath?: string;
  cancelable?: Cancelable;
}

/**
 * Доступ по клиентскому сертификату.
 * Реализуйте {@link MtlsChatClient.buildMtlsFetchExtras} (например `dispatcher` с `https.Agent`).
 */
export class MtlsChatClient extends ChatApiClient {
  private readonly certificatePath?: string;
  private readonly privateKeyPath?: string;

  constructor(config: MtlsChatClientConfig) {
    super(config.baseUrl, config.cancelable);
    this.certificatePath = config.certificatePath;
    this.privateKeyPath = config.privateKeyPath;
  }

  override async getModels(): Promise<ModelsResponse> {
    return this.fetchJson<ModelsResponse>(
      this.baseUrl + "models",
      {
        method: "GET",
        headers: { Accept: "application/json" },
        ...this.buildMtlsFetchExtras(),
      }
    );
  }

  override async postChatCompletions(request: ChatRequest): Promise<ChatResponse> {
    return this.fetchJson<ChatResponse>(
      this.baseUrl + "chat/completions",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: serializeChatRequestBody(request),
        ...this.buildMtlsFetchExtras(),
      }
    );
  }

  /** Доп. опции `fetch` для mTLS в Node (сейчас пусто). */
  protected buildMtlsFetchExtras(): Record<string, unknown> {
    return {};
  }
}

// --- Тело запроса (GigaChat: `arguments` — объект, `content` может быть `null`) ---

function serializeChatMessageForApi(msg: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: msg.role,
    content: msg.content ?? null,
  };
  if (msg.function_call) {
    out.function_call = {
      name: msg.function_call.name,
      arguments: parseFunctionArgumentsJson(msg.function_call.arguments),
    };
  }
  if (msg.name != null) out.name = msg.name;
  return out;
}

function parseFunctionArgumentsJson(args: string): unknown {
  try { return JSON.parse(args); }
  catch { return {}; }
}

function serializeChatRequestBody(request: ChatRequest): string {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(serializeChatMessageForApi),
    temperature: request.temperature,
    max_tokens: request.max_tokens,
  };
  if (request.functions != null) body.functions = request.functions;
  if (request.function_call != null) body.function_call = request.function_call;
  return JSON.stringify(body);
}

// --- Фабрика ---

const OFFICIAL_GIGACHAT_API_BASE = "https://gigachat.devices.sberbank.ru/api/v1/";

/** Параметры для {@link ChatClientFactory.create}. */
export interface ChatClientFactoryOptions {
  /** Базовый URL API (со слэшем или без). */
  baseUrl: string;
  /**
   * Для официального `…/api/v1/` — секрет для Basic OAuth;
   * для другого URL — значение для `Authorization: Basic`.
   */
  apiToken?: string | null;
  clientCertificatePath?: string | null;
  clientPrivateKeyPath?: string | null;
}

/**
 * Официальный `…/api/v1/` + `apiToken` → {@link OAuthGigaChatClient};
 * иной URL + `apiToken` → {@link BasicAuthChatClient};
 * без токена → {@link MtlsChatClient}.
 */
export class ChatClientFactory {
  static create(options: ChatClientFactoryOptions, cancelable?: Cancelable): ChatApiClient {
    const hasToken = Boolean(options.apiToken);
    const normalizedBase = options.baseUrl.endsWith("/")
      ? options.baseUrl
      : options.baseUrl + "/";

    if (hasToken && normalizedBase === OFFICIAL_GIGACHAT_API_BASE) {
      return new OAuthGigaChatClient(normalizedBase, options.apiToken!, cancelable);
    }
    if (hasToken) {
      return new BasicAuthChatClient(normalizedBase, options.apiToken!, cancelable);
    }
    return new MtlsChatClient({
      baseUrl: normalizedBase,
      certificatePath: options.clientCertificatePath ?? undefined,
      privateKeyPath: options.clientPrivateKeyPath ?? undefined,
      cancelable,
    });
  }
}
