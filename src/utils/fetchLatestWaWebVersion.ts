import axios, { AxiosRequestConfig } from 'axios';
import { fetchLatestBaileysVersion, WAVersion } from 'baileys';

type WaWebVersion = {
  version: WAVersion;
  isLatest: boolean;
  error?: unknown;
};

// `GET /` chama isto a cada requisição, e é a rota que o healthcheck bate. Sem cache,
// todo check vira uma ida até web.whatsapp.com; sem timeout, um servidor pendurado
// pendura o healthcheck junto e o container reinicia sem nada de errado com a conexão.
const SUCCESS_TTL_MS = 60 * 60 * 1000;
// Fallback expira rápido para voltar à versão real assim que a WhatsApp responder.
const FALLBACK_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

let cached: { value: WaWebVersion; expiresAt: number } | null = null;
let inFlight: Promise<WaWebVersion> | null = null;

const remember = (value: WaWebVersion, ttlMs: number): WaWebVersion => {
  cached = { value, expiresAt: Date.now() + ttlMs };
  return value;
};

const fallbackVersion = async (error: unknown): Promise<WaWebVersion> =>
  remember(
    {
      version: (await fetchLatestBaileysVersion()).version as WAVersion,
      isLatest: false,
      error,
    },
    FALLBACK_TTL_MS,
  );

const resolveVersion = async (options: AxiosRequestConfig<{}>): Promise<WaWebVersion> => {
  try {
    const { data } = await axios.get('https://web.whatsapp.com/sw.js', {
      timeout: REQUEST_TIMEOUT_MS,
      ...options,
      responseType: 'json',
    });

    const regex = /\\?"client_revision\\?":\s*(\d+)/;
    const match = data.match(regex);

    if (!match?.[1]) {
      return await fallbackVersion({ message: 'Could not find client revision in the fetched content' });
    }

    return remember({ version: [2, 3000, +match[1]] as WAVersion, isLatest: true }, SUCCESS_TTL_MS);
  } catch (error) {
    return await fallbackVersion(error);
  }
};

export const fetchLatestWaWebVersion = async (options: AxiosRequestConfig<{}>): Promise<WaWebVersion> => {
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  // Sem dedupe, uma rajada no healthcheck com o cache frio dispara N buscas idênticas.
  if (!inFlight) {
    inFlight = resolveVersion(options).finally(() => {
      inFlight = null;
    });
  }

  return inFlight;
};
