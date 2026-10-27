import type { CallContext, Connection, Integration } from './define.js';
import { httpClientFor, type RuntimeOptions } from './run.js';

export type SourceMode = 'full' | 'changes';

export type SourceValue = string | number | boolean;

export interface SourceField {
  key: string;
  label: string;
}

export interface SourceItem {
  id: string;
  updatedAt: string | null;
  fields: Record<string, SourceValue>;
}

export interface SourcePage {
  items: SourceItem[];
  next: string | null;
}

export interface SourceReadInput {
  mode: SourceMode;
  cursor?: string | null;
  since?: string | null;
}

export interface SourceSpec<C = Record<string, unknown>, S = Record<string, unknown>> {
  label: string;
  description?: string;
  target?: string;
  fields: SourceField[];
  dynamicFields?: boolean;
  incremental: boolean;
  read: (ctx: CallContext<C, S>, input: SourceReadInput) => Promise<SourcePage>;
}

export interface Source<C = any, S = any> extends SourceSpec<C, S> {
  id: string;
}

export class UnknownSourceError extends Error {
  constructor(integrationId: string, sourceId: string) {
    super(`Unknown source "${sourceId}" for integration "${integrationId}"`);
    this.name = 'UnknownSourceError';
  }
}

export function getSource(def: Integration, sourceId: string): Source {
  const source = Object.hasOwn(def.sources, sourceId) ? def.sources[sourceId] : undefined;
  if (!source) throw new UnknownSourceError(def.id, sourceId);
  return source;
}

export async function readSource(def: Integration, sourceId: string, conn: Connection, input: SourceReadInput, opts: RuntimeOptions): Promise<SourcePage> {
  const source = getSource(def, sourceId);
  if (input.mode === 'changes' && !source.incremental) throw new Error(`Source "${def.id}.${sourceId}" cannot list changes`);
  if (input.mode === 'changes' && !input.since) throw new Error('"since" is required to list changes');
  return source.read({ ...conn, http: httpClientFor(def, conn, opts), signal: opts.signal }, input);
}

export function sourceValue(value: unknown): SourceValue | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const parts = value.map(sourceValue).filter((v): v is SourceValue => v !== undefined);
    return parts.length > 0 && parts.length === value.length ? parts.join(', ') : undefined;
  }
  return undefined;
}
