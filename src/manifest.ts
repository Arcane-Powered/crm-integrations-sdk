import { z } from 'zod';
import { auth as authHelpers, type AuthResult } from './auth.js';
import { defineIntegration, IntegrationDefinitionError, type CallContext, type CheckResult, type Connection, type FieldShape, type Integration, type OperationSpec } from './define.js';
import { field, secret, template, type FieldMeta, type FieldWidget, type TemplateSegment } from './fields.js';
import type { HttpMethod } from './net-guard.js';
import { shape, type OutputShape, type ScalarType } from './shape.js';

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
const EXACT_PLACEHOLDER_RE = /^\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const OUTPUT_PATH_RE = /^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/;

const scalarValue = z.union([z.string(), z.number(), z.boolean()]);
const showIfSchema = z.record(z.string().regex(NAME_RE), z.union([scalarValue, z.array(scalarValue).min(1)]));
const optionsSchema = z.union([z.record(z.string(), z.string()), z.array(z.union([z.string(), z.number()])).min(1)]);

const connectionFieldSchema = z.strictObject({
  label: z.string().min(1),
  help: z.string().optional(),
  placeholder: z.string().optional(),
  type: z.enum(['text', 'url', 'email']).default('text'),
  secret: z.boolean().default(false),
  private: z.boolean().default(false),
  required: z.boolean().default(true),
  trim: z.boolean().default(true),
  pattern: z.string().optional(),
  max_length: z.number().int().positive().optional(),
  error: z.string().optional(),
  validate: z.string().regex(NAME_RE).optional(),
});

const paramSchema = z.strictObject({
  label: z.string().min(1),
  help: z.string().optional(),
  placeholder: z.string().optional(),
  type: z.enum(['text', 'textarea', 'code', 'number', 'boolean', 'date', 'select', 'multiselect']).default('text'),
  language: z.string().optional(),
  template: z.boolean().default(false),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  integer: z.boolean().default(true),
  pattern: z.string().optional(),
  max_length: z.number().int().positive().optional(),
  max_items: z.number().int().positive().optional(),
  options: optionsSchema.optional(),
  show_if: showIfSchema.optional(),
  advanced: z.boolean().default(false),
  error: z.string().optional(),
  render: z.string().regex(NAME_RE).optional(),
});

const outputTypeSchema = z.enum(['text', 'number', 'boolean', 'date', 'datetime', 'object', 'list', 'any']);

const outputFieldSchema = z.strictObject({
  path: z.string().regex(OUTPUT_PATH_RE).optional(),
  type: outputTypeSchema.default('any'),
  label: z.string().optional(),
  item: z.union([outputTypeSchema, z.record(z.string(), outputTypeSchema)]).optional(),
  show_if: showIfSchema.optional(),
});

const requestSchema = z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  path: z.string().startsWith('/'),
  query: z.record(z.string(), scalarValue).optional(),
  body: z.record(z.string(), z.unknown()).optional(),
});

const ruleSchema = z.strictObject({
  exactly_one_of: z.array(z.string().regex(NAME_RE)).min(2),
  error: z.string(),
});

const operationSchema = z
  .strictObject({
    label: z.string().min(1),
    description: z.string().min(1),
    kind: z.enum(['read', 'write']).default('read'),
    params: z.record(z.string().regex(NAME_RE), paramSchema).default({}),
    rules: z.array(ruleSchema).default([]),
    request: requestSchema.optional(),
    handler: z.string().regex(NAME_RE).optional(),
    output: z.record(z.string().regex(NAME_RE), outputFieldSchema),
    output_doc: z.string().min(1),
    timeout_ms: z.number().int().positive().optional(),
  })
  .refine((o) => (o.request === undefined) !== (o.handler === undefined), { message: 'declare either "request" or "handler"' });

const authSchema = z.union([
  z.strictObject({ basic: z.strictObject({ username: z.string(), password: z.string() }) }),
  z.strictObject({ bearer: z.string() }),
  z.strictObject({ header: z.strictObject({ name: z.string(), value: z.string() }) }),
]);

export const manifestSchema = z.strictObject({
  id: z.string(),
  label: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  base_url: z.string().optional(),
  connection: z.record(z.string().regex(NAME_RE), connectionFieldSchema).default({}),
  auth: authSchema.optional(),
  test: z
    .string()
    .regex(/^(GET|POST) \/\S*$/)
    .optional(),
  operations: z.record(z.string(), operationSchema).default({}),
});

export type IntegrationManifest = z.input<typeof manifestSchema>;
type Manifest = z.output<typeof manifestSchema>;
type ParamDef = z.output<typeof paramSchema>;
type OutputDef = z.output<typeof outputFieldSchema>;
type OperationDef = z.output<typeof operationSchema>;

export type ManifestHandler = (ctx: CallContext, params: Record<string, unknown>) => Promise<unknown>;
export type ManifestRenderer = (segments: readonly TemplateSegment[]) => string;
export type ManifestValidator = (value: string) => string | { error: string };

export interface ManifestHooks {
  handlers?: Record<string, ManifestHandler>;
  renderers?: Record<string, ManifestRenderer>;
  validators?: Record<string, ManifestValidator>;
}

function fail(where: string, message: string): never {
  throw new IntegrationDefinitionError(`${where}: ${message}`);
}

function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1] as string);
}

function checkPlaceholders(where: string, text: string, known: ReadonlySet<string>): void {
  for (const name of placeholders(text)) if (!known.has(name)) fail(where, `unknown placeholder {{${name}}}`);
}

function interpolate(text: string, values: Record<string, unknown>): string {
  return text.replace(PLACEHOLDER_RE, (_m, name: string) => {
    const v = values[name];
    return v === undefined || v === null ? '' : String(v);
  });
}

function hook<T>(where: string, kind: string, map: Record<string, T> | undefined, name: string | undefined): T | undefined {
  if (name === undefined) return undefined;
  const fn = map && Object.hasOwn(map, name) ? map[name] : undefined;
  if (!fn) fail(where, `${kind} "${name}" is not provided`);
  return fn;
}

function regex(where: string, source: string): RegExp {
  try {
    return new RegExp(source);
  } catch {
    return fail(where, `invalid pattern ${source}`);
  }
}

function connectionField(where: string, def: z.output<typeof connectionFieldSchema>, hooks: ManifestHooks): z.ZodType {
  const message = def.error ?? `Invalid ${def.label}`;
  const pattern = def.pattern ? regex(where, def.pattern) : undefined;
  const validator = hook(where, 'validator', hooks.validators, def.validate);
  let base = z.string({ error: message });
  if (def.trim) base = base.trim();
  let schema: z.ZodType = base
    .refine((v) => !CONTROL_RE.test(v), { message })
    .refine((v) => !def.required || v.trim() !== '', { message })
    .refine((v) => def.max_length === undefined || v.length <= def.max_length, { message })
    .refine((v) => !pattern || v === '' || pattern.test(v), { message })
    .transform((v, ctx) => {
      if (!validator || v === '') return v;
      const r = validator(v);
      if (typeof r === 'string') return r;
      ctx.addIssue({ code: 'custom', message: r.error });
      return z.NEVER;
    });
  if (!def.required) schema = schema.optional();
  const meta: FieldMeta = {
    label: def.label,
    ...(def.help ? { help: def.help } : {}),
    ...(def.placeholder ? { placeholder: def.placeholder } : {}),
    ...(def.type !== 'text' ? { inputType: def.type } : {}),
  };
  return def.secret ? secret(schema, meta) : field(schema, meta);
}

function optionsOf(def: ParamDef): Array<{ value: string | number; label: string }> | undefined {
  if (!def.options) return undefined;
  return Array.isArray(def.options) ? def.options.map((v) => ({ value: v, label: String(v) })) : Object.entries(def.options).map(([value, label]) => ({ value, label }));
}

function showIfMeta(where: string, showIf: Record<string, unknown> | undefined): FieldMeta['showIf'] {
  if (!showIf) return undefined;
  const entries = Object.entries(showIf);
  if (entries.length !== 1) fail(where, 'show_if must name exactly one param');
  const [param, value] = entries[0] as [string, unknown];
  return { param, equals: (Array.isArray(value) ? value : [value]) as Array<string | number | boolean> };
}

const WIDGETS: Record<ParamDef['type'], FieldWidget> = {
  text: 'text',
  textarea: 'textarea',
  code: 'code',
  number: 'number',
  boolean: 'boolean',
  date: 'date',
  select: 'select',
  multiselect: 'multiselect',
};

function paramField(where: string, def: ParamDef, hooks: ManifestHooks): z.ZodType {
  const message = def.error;
  const msg = message ? { message } : {};
  const pattern = def.pattern ? regex(where, def.pattern) : undefined;
  let schema: z.ZodType;
  switch (def.type) {
    case 'number': {
      let n = def.integer ? z.number(msg).int(msg) : z.number(msg);
      if (def.min !== undefined) n = n.min(def.min, msg);
      if (def.max !== undefined) n = n.max(def.max, msg);
      schema = n;
      break;
    }
    case 'boolean':
      schema = z.boolean(msg);
      break;
    case 'date':
      schema = z.string(msg).trim().regex(ISO_DATE_RE, { message: message ?? 'Expected an ISO 8601 date' });
      break;
    case 'select': {
      const values = (optionsOf(def) ?? fail(where, 'select needs options')).map((o) => String(o.value));
      schema = z.enum(values as [string, ...string[]], msg);
      break;
    }
    case 'multiselect': {
      let item = z.string(msg);
      if (pattern) item = item.regex(pattern, msg);
      let list = z.array(item, msg);
      if (def.max_items !== undefined) list = list.max(def.max_items, msg);
      schema = list;
      break;
    }
    default: {
      let s = z.string(msg);
      if (pattern) s = s.regex(pattern, msg);
      if (def.required) s = s.min(1, msg);
      if (!def.template && def.max_length !== undefined) s = s.max(def.max_length, msg);
      schema = s;
    }
  }
  if (def.default !== undefined) schema = schema.default(def.default as never);
  else if (!def.required) schema = schema.optional();
  const options = optionsOf(def);
  const showIf = showIfMeta(where, def.show_if);
  const meta: Omit<FieldMeta, 'secret' | 'template'> = {
    label: def.label,
    widget: WIDGETS[def.type],
    ...(def.help ? { help: def.help } : {}),
    ...(def.placeholder ? { placeholder: def.placeholder } : {}),
    ...(def.language ? { language: def.language } : {}),
    ...(options ? { options } : {}),
    ...(showIf ? { showIf } : {}),
    ...(def.advanced ? { advanced: true } : {}),
  };
  if (!def.template) {
    if (def.render) fail(where, 'render requires template: true');
    return field(schema, meta);
  }
  if (def.type !== 'text' && def.type !== 'textarea' && def.type !== 'code' && def.type !== 'date') fail(where, `template is not supported for type ${def.type}`);
  const render = hook(where, 'renderer', hooks.renderers, def.render);
  return template(schema as z.ZodType<string | undefined>, { ...meta, max: def.max_length ?? 2000, ...(def.required ? { min: 1 } : {}), ...(render ? { render } : {}) });
}

function isVisible(def: { show_if?: Record<string, unknown> | undefined }, params: Record<string, unknown>): boolean {
  if (!def.show_if) return true;
  return Object.entries(def.show_if).every(([param, value]) => (Array.isArray(value) ? value : [value]).includes(params[param] as never));
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function activeParams(op: OperationDef, params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([key]) => !op.params[key] || isVisible(op.params[key] as ParamDef, params)));
}

function checkRules(op: OperationDef): ((params: Record<string, unknown>) => CheckResult) | undefined {
  if (op.rules.length === 0) return undefined;
  return (params) => {
    const active = activeParams(op, params);
    for (const rule of op.rules) {
      if (!rule.exactly_one_of.some((k) => isVisible(op.params[k] as ParamDef, params))) continue;
      const present = rule.exactly_one_of.filter((k) => !isEmpty(active[k]));
      if (present.length !== 1) return { param: rule.exactly_one_of[0] as string, message: rule.error };
    }
    return null;
  };
}

function resolveValue(raw: unknown, values: Record<string, unknown>): unknown {
  if (typeof raw !== 'string') return raw;
  const exact = EXACT_PLACEHOLDER_RE.exec(raw);
  if (exact) return values[exact[1] as string];
  return placeholders(raw).every((name) => isEmpty(values[name])) && placeholders(raw).length > 0 ? undefined : interpolate(raw, values);
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split('.').slice(1)) {
    if (current === null || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function coerce(value: unknown, def: OutputDef): unknown {
  if (def.type === 'list') {
    const list = Array.isArray(value) ? value : [];
    return def.item === 'object' || isObject(def.item) ? list.filter(isObject) : list;
  }
  if (def.type === 'object') return isObject(value) ? value : {};
  return value ?? null;
}

function scalarShape(type: z.output<typeof outputTypeSchema>, label?: string): OutputShape {
  switch (type) {
    case 'object':
      return shape.object({}, { open: true, ...(label ? { label } : {}) });
    case 'list':
      return shape.array(shape.unknown(), label);
    case 'any':
      return shape.unknown(label);
    default:
      return { kind: 'scalar', type: type as ScalarType, ...(label ? { label } : {}) };
  }
}

function outputShapeOf(def: OutputDef): OutputShape {
  if (def.type !== 'list') return scalarShape(def.type, def.label);
  const item = def.item === undefined ? shape.unknown() : typeof def.item === 'string' ? scalarShape(def.item) : shape.object(Object.fromEntries(Object.entries(def.item).map(([k, t]) => [k, scalarShape(t)])), { open: true });
  return shape.array(item, def.label);
}

function operationOutputShape(op: OperationDef): OperationSpec<FieldShape, unknown, unknown>['output'] {
  const conditional = Object.values(op.output).some((o) => o.show_if);
  const build = (params: Record<string, unknown>) =>
    shape.object(Object.fromEntries(Object.entries(op.output).filter(([, o]) => !conditional || isVisible(o, params)).map(([key, o]) => [key, outputShapeOf(o)])));
  return conditional ? (params) => build(params as Record<string, unknown>) : build({});
}

function requestRunner(op: OperationDef): OperationSpec<FieldShape, unknown, unknown>['run'] {
  const request = op.request as z.output<typeof requestSchema>;
  return async (ctx, params) => {
    const values = activeParams(op, params as Record<string, unknown>);
    const path = request.path.replace(PLACEHOLDER_RE, (_m, name: string) => {
      const v = values[name];
      if (isEmpty(v)) throw new IntegrationDefinitionError(`Missing value for {{${name}}} in the request path`);
      return encodeURIComponent(String(v));
    });
    const query: Record<string, string | number | boolean | Array<string | number | boolean>> = {};
    for (const [key, raw] of Object.entries(request.query ?? {})) {
      const v = resolveValue(raw, values);
      if (isEmpty(v)) continue;
      query[key] = Array.isArray(v) ? (v as Array<string | number | boolean>) : (v as string | number | boolean);
    }
    const body = request.body ? Object.fromEntries(Object.entries(request.body).map(([k, raw]) => [k, resolveValue(raw, values)]).filter(([, v]) => v !== undefined)) : undefined;
    const response = await ctx.http.request(request.method as HttpMethod, path, { query, ...(body !== undefined ? { json: body } : {}) });
    return Object.fromEntries(
      Object.entries(op.output)
        .filter(([, o]) => isVisible(o, values))
        .map(([key, o]) => [key, coerce(o.path ? readPath(response, o.path) : response, o)]),
    );
  };
}

function connectionValues(conn: Connection): Record<string, unknown> {
  return { ...(conn.config as Record<string, unknown>), ...(conn.secrets as Record<string, unknown>) };
}

function authOf(m: Manifest): (conn: Connection) => AuthResult {
  const a = m.auth;
  if (!a) return () => authHelpers.none();
  if ('basic' in a) return (conn) => authHelpers.basic(interpolate(a.basic.username, connectionValues(conn)), interpolate(a.basic.password, connectionValues(conn)));
  if ('bearer' in a) return (conn) => authHelpers.bearer(interpolate(a.bearer, connectionValues(conn)));
  return (conn) => authHelpers.header(interpolate(a.header.name, connectionValues(conn)), interpolate(a.header.value, connectionValues(conn)));
}

export function parseManifest(raw: unknown): Manifest {
  const r = manifestSchema.safeParse(raw);
  if (r.success) return r.data;
  const lines = r.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new IntegrationDefinitionError(`Invalid integration manifest\n${lines.join('\n')}`);
}

export function fromManifest(raw: unknown, hooks: ManifestHooks = {}): Integration {
  const m = parseManifest(raw);
  const where = m.id;
  const connectionNames = new Set(Object.keys(m.connection));
  if (m.base_url) checkPlaceholders(`${where}.base_url`, m.base_url, connectionNames);
  if (m.test) checkPlaceholders(`${where}.test`, m.test, connectionNames);
  if (m.auth) checkPlaceholders(`${where}.auth`, JSON.stringify(m.auth), connectionNames);
  const config: FieldShape = {};
  const secrets: FieldShape = {};
  for (const [key, def] of Object.entries(m.connection)) {
    (def.secret || def.private ? secrets : config)[key] = connectionField(`${where}.connection.${key}`, def, hooks);
  }
  const testDef = m.test?.split(' ') as [HttpMethod, string] | undefined;
  const baseUrl = m.base_url;
  return defineIntegration({
    id: m.id,
    label: m.label,
    ...(m.description ? { description: m.description } : {}),
    ...(m.icon ? { icon: m.icon } : {}),
    connection: { config, secrets },
    ...(baseUrl ? { baseUrl: (conn: Connection) => interpolate(baseUrl, connectionValues(conn)) } : {}),
    auth: authOf(m),
    ...(testDef ? { test: (ctx: CallContext) => ctx.http.request(testDef[0], interpolate(testDef[1], connectionValues(ctx))) } : {}),
    operations: () =>
      Object.fromEntries(
        Object.entries(m.operations).map(([id, op]) => {
          const at = `${where}.operations.${id}`;
          const paramNames = new Set(Object.keys(op.params));
          if (op.request) checkPlaceholders(`${at}.request`, JSON.stringify(op.request), paramNames);
          for (const rule of op.rules) for (const k of rule.exactly_one_of) if (!paramNames.has(k)) fail(`${at}.rules`, `unknown param ${k}`);
          for (const [key, def] of Object.entries(op.params)) for (const p of Object.keys(def.show_if ?? {})) if (!paramNames.has(p)) fail(`${at}.params.${key}.show_if`, `unknown param ${p}`);
          const handler = hook(at, 'handler', hooks.handlers, op.handler);
          const defaults = Object.fromEntries(Object.entries(op.params).filter(([, d]) => d.default !== undefined).map(([k, d]) => [k, d.default]));
          const check = checkRules(op);
          const spec: OperationSpec<FieldShape, unknown, unknown> = {
            label: op.label,
            description: op.description,
            kind: op.kind,
            params: Object.fromEntries(Object.entries(op.params).map(([key, def]) => [key, paramField(`${at}.params.${key}`, def, hooks)])),
            ...(check ? { check: check as never } : {}),
            ...(Object.keys(defaults).length > 0 ? { defaults: defaults as never } : {}),
            output: operationOutputShape(op),
            outputDoc: op.output_doc,
            ...(op.timeout_ms ? { timeoutMs: op.timeout_ms } : {}),
            run: handler ? (ctx, params) => handler(ctx as CallContext, params as Record<string, unknown>) : requestRunner(op),
          };
          return [id, spec];
        }),
      ),
  }) as Integration;
}
