import { createHash } from 'node:crypto';

/** JSON canônico: chaves ordenadas recursivamente, sem espaços, `undefined` omitido. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj).sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/** SHA-256 (hex, 64 chars) do JSON canônico. */
export const sha256Canonical = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');