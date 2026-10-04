import type { Connection, FieldShape, Integration, Operation } from './define.js';
import { getFieldMeta, isOptionalField, renderTemplate, type TemplateSegment } from './fields.js';
import { createHttpClient, type HttpClient } from './http.js';
import type { FetchLike, HostResolver } from './net-guard.js';

export interface RuntimeOptions {
  fetch: FetchLike;
  resolveHost: HostResolver;
  signal: AbortSignal;
  maxResponseBytes?: number;
}

export class ParamsError extends Error {
  constructor(
    readonly field: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ParamsError';
  }
}

export class UnknownOperationError extends Error {
  constructor(integrationId: string, operationId: string) {
    super(`Unknown operation "${operationId}" for integration "${integrationId}"`);
    this.name = 'UnknownOperationError';
  }
}

export function httpClientFor(def: Integration, conn: Connection, opts: RuntimeOptions): HttpClient {
  const { headers } = def.auth(conn);
  return createHttpClient({
    fetch: opts.fetch,
    resolveHost: opts.resolveHost,
    baseUrl: def.baseUrl(conn),
    headers,
    sensitiveHeaders: Object.keys(headers),
    signal: opts.signal,
    ...(opts.maxResponseBytes !== undefined ? { maxResponseBytes: opts.maxResponseBytes } : {}),
  });
}

export function getOperation(def: Integration, operationId: string): Operation {
  const op = Object.hasOwn(def.operations, operationId) ? def.operations[operationId] : undefined;
  if (!op) throw new UnknownOperationError(def.id, operationId);
  return op;
}

export function parseParams(op: Operation, raw: Record<string, unknown>): Record<string, unknown> {
  const r = op.schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const field = typeof issue?.path[0] === 'string' ? issue.path[0] : null;
    throw new ParamsError(field, issue?.message ?? 'Invalid parameters');
  }
  const problem = op.check?.(r.data as never);
  if (typeof problem === 'string') throw new ParamsError(null, problem);
  if (problem) throw new ParamsError(problem.param, problem.message);
  return r.data as Record<string, unknown>;
}

export function applyTemplates(op: Operation, params: Record<string, unknown>, segments: Record<string, readonly TemplateSegment[]>): Record<string, unknown> {
  const out = { ...params };
  for (const [key, schema] of Object.entries(op.params as FieldShape)) {
    const meta = getFieldMeta(schema);
    if (!meta?.template || !Object.hasOwn(segments, key)) continue;
    const value = renderTemplate(meta, segments[key] as readonly TemplateSegment[]);
    if (value.trim() === '' && isOptionalField(schema)) delete out[key];
    else out[key] = value;
  }
  return out;
}

export async function callOperation(def: Integration, operationId: string, conn: Connection, params: Record<string, unknown>, opts: RuntimeOptions): Promise<unknown> {
  const op = getOperation(def, operationId);
  const parsed = parseParams(op, params);
  const http = httpClientFor(def, conn, opts);
  return op.run({ ...conn, http, signal: opts.signal }, parsed as never);
}

export type TestConnectionResult = { status: 'ok' } | { status: 'skipped' };

export async function testConnection(def: Integration, conn: Connection, opts: RuntimeOptions): Promise<TestConnectionResult> {
  if (!def.test) return { status: 'skipped' };
  await def.test({ ...conn, http: httpClientFor(def, conn, opts), signal: opts.signal });
  return { status: 'ok' };
}
