import { z } from 'zod';

export type FieldWidget = 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'multiselect' | 'date' | 'code';

export type FieldInputType = 'text' | 'url' | 'email';

export type TemplateSegment = { text: string } | { data: unknown };

export interface TemplateOptions {
  max: number;
  min?: number;
  render?: (segments: readonly TemplateSegment[]) => string;
}

export interface FieldMeta {
  label: string;
  help?: string;
  placeholder?: string;
  widget?: FieldWidget;
  language?: string;
  inputType?: FieldInputType;
  options?: Array<{ value: string | number; label: string }>;
  showIf?: { param: string; equals: Array<string | number | boolean> };
  advanced?: boolean;
  message?: string;
  secret?: boolean;
  template?: TemplateOptions;
}

export const fieldRegistry = z.registry<FieldMeta>();

export function field<T extends z.ZodType>(schema: T, meta: FieldMeta): T {
  const described = schema.meta({ title: meta.label, ...(meta.help ? { description: meta.help } : {}) });
  fieldRegistry.add(described, meta);
  return described;
}

export function secret<T extends z.ZodType>(schema: T, meta: Omit<FieldMeta, 'secret' | 'template'>): T {
  return field(schema, { ...meta, secret: true });
}

export function template<T extends z.ZodType<string | undefined>>(resolved: T, meta: Omit<FieldMeta, 'secret' | 'template'> & TemplateOptions): T {
  const { max, min, render, ...rest } = meta;
  return field(resolved, { ...rest, template: { max, ...(min !== undefined ? { min } : {}), ...(render ? { render } : {}) } });
}

export function getFieldMeta(schema: z.ZodType): FieldMeta | undefined {
  let current: z.ZodType | undefined = schema;
  for (let i = 0; i < 5 && current; i++) {
    const meta = fieldRegistry.get(current);
    if (meta) return meta;
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable || current instanceof z.ZodDefault) {
      current = current.unwrap() as z.ZodType;
    } else {
      break;
    }
  }
  return undefined;
}

export function isOptionalField(schema: z.ZodType): boolean {
  return schema instanceof z.ZodOptional || schema instanceof z.ZodDefault;
}

export function segmentText(data: unknown): string {
  if (data === undefined || data === null) return '';
  return typeof data === 'string' ? data : JSON.stringify(data);
}

export function renderTemplate(meta: FieldMeta | undefined, segments: readonly TemplateSegment[]): string {
  if (meta?.template?.render) return meta.template.render(segments);
  return segments.map((s) => ('text' in s ? s.text : segmentText(s.data))).join('');
}
