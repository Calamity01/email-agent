import { getToken } from './auth.js';

const BASE = 'https://graph.microsoft.com/v1.0';

export async function graph<T = unknown>(
  path: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<T> {
  const res = await fetch(path.startsWith('http') ? path : `${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

  if (res.status === 429 && attempt < 5) {
    const wait = Number(res.headers.get('Retry-After') ?? 2 ** attempt);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return graph<T>(path, init, attempt + 1);
  }
  if (!res.ok) throw new Error(`Graph ${res.status}: ${await res.text()}`);
  return (res.status === 204 ? null : await res.json()) as T;
}