import { z } from 'zod';
import type { Connection, FieldShape, Integration } from './define.js';
import { getFieldMeta, isOptionalField, type FieldInputType } from './fields.js';

export interface ConnectionFormField {
  key: string;
  group: 'config' | 'secrets';
  label: string;
  help?: string;
  placeholder?: string;
  secret: boolean;
  required: boolean;
  type?: FieldInputType;
  options?: Array<{ value: string | number; label: string }>;
}

export interface ParsedConnection extends Connection {
  keyLast4: string;
}

export type ParseConnectionResult = { ok: true; value: ParsedConnection } | { ok: false; field: string; message: string };

export class ConnectionError extends Error {
  constructor() {
    super('Stored connection is unreadable or no longer valid');
    this.name = 'ConnectionError';
  }
}

function shapeOf(schema: z.ZodObject<FieldShape>): FieldShape {
  return schema.shape as FieldShape;
}

export function connectionForm(def: Integration): ConnectionFormField[] {
  const groups = [
    ['config', shapeOf(def.config)],
    ['secrets', shapeOf(def.secrets)],
  ] as const;
  return groups.flatMap(([group, shape]) =>
    Object.entries(shape).map(([key, schema]) => {
      const meta = getFieldMeta(schema);
      return {
        key,
        group,
        label: meta?.label ?? key,
        ...(meta?.help ? { help: meta.help } : {}),
        ...(meta?.placeholder ? { placeholder: meta.placeholder } : {}),
        secret: meta?.secret === true,
        required: !isOptionalField(schema),
        ...(meta?.inputType ? { type: meta.inputType } : {}),
        ...(meta?.options ? { options: meta.options } : {}),
      };
    }),
  );
}

function parseGroup(shape: FieldShape, raw: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; field: string; message: string } {
  const value: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(shape)) {
    const r = schema.safeParse(raw[key]);
    if (!r.success) {
      const meta = getFieldMeta(schema);
      return { ok: false, field: key, message: meta?.message ?? r.error.issues[0]?.message ?? `Invalid value for "${meta?.label ?? key}"` };
    }
    if (r.data !== undefined) value[key] = r.data;
  }
  return { ok: true, value };
}

function firstSecretValue(def: Integration, secrets: Record<string, unknown>): string {
  for (const [key, schema] of Object.entries(shapeOf(def.secrets))) {
    if (getFieldMeta(schema)?.secret && typeof secrets[key] === 'string') return (secrets[key] as string).trim();
  }
  return '';
}

export function parseConnection(def: Integration, raw: Record<string, unknown>): ParseConnectionResult {
  const config = parseGroup(shapeOf(def.config), raw);
  if (!config.ok) return config;
  const secrets = parseGroup(shapeOf(def.secrets), raw);
  if (!secrets.ok) return secrets;
  return { ok: true, value: { config: config.value, secrets: secrets.value, keyLast4: firstSecretValue(def, secrets.value).slice(-4) } };
}

export function openConnection(def: Integration, stored: { config: unknown; secrets: unknown }): Connection {
  const config = def.config.safeParse(stored.config ?? {});
  const secrets = def.secrets.safeParse(stored.secrets ?? {});
  if (!config.success || !secrets.success) throw new ConnectionError();
  return { config: config.data, secrets: secrets.data };
}

export function connectionSecretValues(def: Integration, conn: Connection): string[] {
  const values = new Set<string>();
  for (const [key, schema] of Object.entries(shapeOf(def.secrets))) {
    const v = (conn.secrets as Record<string, unknown>)[key];
    if (getFieldMeta(schema)?.secret && typeof v === 'string') values.add(v);
  }
  const { headers, secretValues } = def.auth(conn);
  for (const v of [...secretValues, ...Object.values(headers)]) values.add(v);
  return [...values].filter((v) => v.length >= 4);
}

export function publicConfig(def: Integration, conn: Connection): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shapeOf(def.config))) {
    const v = (conn.config as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}
