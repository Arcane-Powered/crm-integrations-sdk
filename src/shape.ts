export type ScalarType = 'text' | 'number' | 'boolean' | 'date' | 'datetime';

export type OutputShape =
  | { kind: 'object'; fields: Record<string, OutputShape>; open?: boolean; label?: string }
  | { kind: 'array'; items: OutputShape; label?: string }
  | { kind: 'scalar'; type: ScalarType; label?: string }
  | { kind: 'unknown'; label?: string };

const withLabel = <T extends OutputShape>(s: T, label?: string): T => (label ? { ...s, label } : s);

export const shape = {
  text: (label?: string): OutputShape => withLabel({ kind: 'scalar', type: 'text' }, label),
  number: (label?: string): OutputShape => withLabel({ kind: 'scalar', type: 'number' }, label),
  boolean: (label?: string): OutputShape => withLabel({ kind: 'scalar', type: 'boolean' }, label),
  date: (label?: string): OutputShape => withLabel({ kind: 'scalar', type: 'date' }, label),
  datetime: (label?: string): OutputShape => withLabel({ kind: 'scalar', type: 'datetime' }, label),
  unknown: (label?: string): OutputShape => withLabel({ kind: 'unknown' }, label),
  object: (fields: Record<string, OutputShape>, opts: { open?: boolean; label?: string } = {}): OutputShape =>
    withLabel({ kind: 'object', fields, ...(opts.open ? { open: true } : {}) }, opts.label),
  array: (items: OutputShape, label?: string): OutputShape => withLabel({ kind: 'array', items }, label),
};
