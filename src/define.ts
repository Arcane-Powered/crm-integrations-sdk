import { z } from 'zod';
import type { AuthResult } from './auth.js';
import { getFieldMeta } from './fields.js';
import type { HttpClient } from './http.js';
import type { OutputShape } from './shape.js';

export type FieldShape = Record<string, z.ZodType>;

export type ShapeOutput<S extends FieldShape> = z.output<z.ZodObject<S>>;
export type ShapeInput<S extends FieldShape> = z.input<z.ZodObject<S>>;

export interface Connection<C = Record<string, unknown>, S = Record<string, unknown>> {
  config: C;
  secrets: S;
}

export interface CallContext<C = Record<string, unknown>, S = Record<string, unknown>> extends Connection<C, S> {
  http: HttpClient;
  signal: AbortSignal;
}

export type OperationKind = 'read' | 'write';

export type CheckResult = string | { param: string; message: string } | null;

export interface OperationSpec<P extends FieldShape, C, S> {
  label: string;
  description: string;
  kind: OperationKind;
  params: P;
  check?: (params: ShapeOutput<P>) => CheckResult;
  defaults?: Partial<ShapeInput<P>>;
  output: OutputShape | ((params: Partial<Record<keyof P, unknown>>) => OutputShape);
  outputDoc: string;
  timeoutMs?: number;
  run: (ctx: CallContext<C, S>, params: ShapeOutput<P>) => Promise<unknown>;
}

export interface Operation<P extends FieldShape = any, C = any, S = any> extends OperationSpec<P, C, S> {
  id: string;
  schema: z.ZodObject<P>;
}

export type OperationBuilder<C, S> = <P extends FieldShape>(spec: OperationSpec<P, C, S>) => OperationSpec<P, C, S>;

export interface IntegrationSpec<CS extends FieldShape, SS extends FieldShape, O extends Record<string, OperationSpec<any, ShapeOutput<CS>, ShapeOutput<SS>>>> {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  connection: { config?: CS; secrets: SS };
  baseUrl?: string | ((conn: Connection<ShapeOutput<CS>, ShapeOutput<SS>>) => string);
  auth: (conn: Connection<ShapeOutput<CS>, ShapeOutput<SS>>) => AuthResult;
  test?: (ctx: CallContext<ShapeOutput<CS>, ShapeOutput<SS>>) => Promise<unknown>;
  operations?: (op: OperationBuilder<ShapeOutput<CS>, ShapeOutput<SS>>) => O;
}

export interface Integration<C = any, S = any> {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  config: z.ZodObject<FieldShape>;
  secrets: z.ZodObject<FieldShape>;
  baseUrl: (conn: Connection<C, S>) => string | undefined;
  auth: (conn: Connection<C, S>) => AuthResult;
  test?: (ctx: CallContext<C, S>) => Promise<unknown>;
  operations: Record<string, Operation<any, C, S>>;
}

export type IntegrationOf<CS extends FieldShape, SS extends FieldShape, O> = Integration<ShapeOutput<CS>, ShapeOutput<SS>> & {
  operations: { [K in keyof O]: O[K] extends OperationSpec<infer P, any, any> ? Operation<P, ShapeOutput<CS>, ShapeOutput<SS>> : never };
};

const ID_RE = /^[a-z][a-z0-9_]{0,31}$/;

export class IntegrationDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationDefinitionError';
  }
}

function checkShape(where: string, shape: FieldShape, opts: { secret: boolean; template: boolean }): void {
  for (const [key, schema] of Object.entries(shape)) {
    const meta = getFieldMeta(schema);
    if (!meta) throw new IntegrationDefinitionError(`${where}.${key}: declare it with field(), secret() or template()`);
    if (meta.secret && !opts.secret) throw new IntegrationDefinitionError(`${where}.${key}: secret() is only allowed in connection.secrets`);
    if (meta.template && !opts.template) throw new IntegrationDefinitionError(`${where}.${key}: template() is only allowed in operation params`);
  }
}

export function defineIntegration<CS extends FieldShape = {}, SS extends FieldShape = {}, O extends Record<string, OperationSpec<any, ShapeOutput<CS>, ShapeOutput<SS>>> = {}>(
  spec: IntegrationSpec<CS, SS, O>,
): IntegrationOf<CS, SS, O> {
  if (!ID_RE.test(spec.id)) throw new IntegrationDefinitionError(`Invalid integration id "${spec.id}": lowercase letters, digits and "_", 32 characters max`);
  const configShape = (spec.connection.config ?? {}) as CS;
  checkShape(`${spec.id}.connection.config`, configShape, { secret: false, template: false });
  checkShape(`${spec.id}.connection.secrets`, spec.connection.secrets, { secret: true, template: false });
  const overlap = Object.keys(configShape).filter((k) => k in spec.connection.secrets);
  if (overlap.length > 0) throw new IntegrationDefinitionError(`${spec.id}: keys both in config and secrets: ${overlap.join(', ')}`);
  const build: OperationBuilder<ShapeOutput<CS>, ShapeOutput<SS>> = (op) => op;
  const specs = spec.operations ? spec.operations(build) : ({} as O);
  const operations: Record<string, Operation<any, ShapeOutput<CS>, ShapeOutput<SS>>> = {};
  for (const [id, op] of Object.entries(specs)) {
    if (!ID_RE.test(id)) throw new IntegrationDefinitionError(`${spec.id}: invalid operation id "${id}"`);
    checkShape(`${spec.id}.operations.${id}.params`, op.params, { secret: false, template: true });
    operations[id] = { ...op, id, schema: z.strictObject(op.params) };
  }
  const baseUrl = spec.baseUrl;
  return {
    id: spec.id,
    label: spec.label,
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.icon ? { icon: spec.icon } : {}),
    config: z.object(configShape) as unknown as z.ZodObject<FieldShape>,
    secrets: z.object(spec.connection.secrets) as unknown as z.ZodObject<FieldShape>,
    baseUrl: (conn) => (typeof baseUrl === 'function' ? baseUrl(conn) : baseUrl),
    auth: spec.auth,
    ...(spec.test ? { test: spec.test } : {}),
    operations,
  } as IntegrationOf<CS, SS, O>;
}

export function operationOutput(op: Operation, params: Record<string, unknown>): OutputShape {
  return typeof op.output === 'function' ? op.output(params as Partial<Record<string, unknown>>) : op.output;
}

export function templateParams(op: Operation): string[] {
  return Object.entries(op.params as FieldShape)
    .filter(([, schema]) => getFieldMeta(schema)?.template)
    .map(([key]) => key);
}
