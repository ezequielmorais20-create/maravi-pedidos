export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export async function api<T = any>(method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders };
  let payload: BodyInit | undefined;
  // Só envia Content-Type JSON quando há corpo (o Fastify rejeita JSON vazio).
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'rede', 'Sem conexão com o servidor. Verifique sua internet e tente de novo.');
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const e = (data as any)?.error;
    throw new ApiError(res.status, e?.code ?? 'erro', e?.message ?? 'Algo deu errado. Tente novamente.', e?.details);
  }
  return data as T;
}
function safeJson(t: string): unknown {
  try { return JSON.parse(t); } catch { return null; }
}
export const get = <T = any>(u: string) => api<T>('GET', u);
export const post = <T = any>(u: string, b?: unknown, h?: Record<string, string>) => api<T>('POST', u, b, h);
export const put = <T = any>(u: string, b?: unknown) => api<T>('PUT', u, b);
export const patch = <T = any>(u: string, b?: unknown) => api<T>('PATCH', u, b);
export const del = <T = any>(u: string) => api<T>('DELETE', u);

export const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
