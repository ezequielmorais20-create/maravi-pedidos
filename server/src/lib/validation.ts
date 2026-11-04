import { z, ZodError } from 'zod';
import { badRequest } from './errors';

const ptMap: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'invalid_type':
      return { message: issue.input === undefined ? 'Campo obrigatório.' : 'Tipo de valor inválido.' };
    case 'too_small':
      if (issue.origin === 'string') return { message: issue.minimum === 1 ? 'Campo obrigatório.' : `Mínimo de ${issue.minimum} caracteres.` };
      if (issue.origin === 'array') return { message: `Informe ao menos ${issue.minimum} item(ns).` };
      return { message: `O valor mínimo é ${issue.minimum}.` };
    case 'too_big':
      if (issue.origin === 'string') return { message: `Máximo de ${issue.maximum} caracteres.` };
      if (issue.origin === 'array') return { message: `No máximo ${issue.maximum} item(ns).` };
      return { message: `O valor máximo é ${issue.maximum}.` };
    case 'invalid_format':
      if (issue.format === 'email') return { message: 'E-mail inválido.' };
      if (issue.format === 'uuid') return { message: 'Identificador inválido.' };
      return { message: 'Formato inválido.' };
    case 'invalid_value':
      return { message: 'Valor não permitido.' };
    default:
      return undefined;
  }
};
z.config({ customError: ptMap });

export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw zodToAppError(r.error);
}

export function zodToAppError(err: ZodError) {
  const issues = err.issues.map((i) => ({ campo: i.path.join('.'), mensagem: i.message }));
  const first = issues[0];
  const msg = first ? (first.campo ? `${first.campo}: ${first.mensagem}` : first.mensagem) : 'Dados inválidos.';
  return badRequest(msg, issues);
}

export const uuid = z.string().uuid();
export const centsInt = z.number().int().min(0).max(100_000_00);
export const localDateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use o formato AAAA-MM-DD.');
/** Somente caminhos de arquivos enviados/semente do próprio servidor (evita URLs externas e javascript:). */
export const uploadPath = z
  .string()
  .max(300)
  .regex(/^\/uploads\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, 'Imagem inválida.')
  .refine((s) => !s.includes('..'), 'Imagem inválida.');
