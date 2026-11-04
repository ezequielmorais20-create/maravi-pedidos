import { z, ZodError, type ZodIssueCode } from 'zod';
import { badRequest } from './errors';

const ptMap: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code as ZodIssueCode) {
    case 'invalid_type':
      return { message: ctx.data === undefined ? 'Campo obrigatório.' : 'Tipo de valor inválido.' };
    case 'too_small': {
      const i = issue as z.ZodTooSmallIssue;
      if (i.type === 'string') return { message: i.minimum === 1 ? 'Campo obrigatório.' : `Mínimo de ${i.minimum} caracteres.` };
      if (i.type === 'array') return { message: `Informe ao menos ${i.minimum} item(ns).` };
      return { message: `O valor mínimo é ${i.minimum}.` };
    }
    case 'too_big': {
      const i = issue as z.ZodTooBigIssue;
      if (i.type === 'string') return { message: `Máximo de ${i.maximum} caracteres.` };
      if (i.type === 'array') return { message: `No máximo ${i.maximum} item(ns).` };
      return { message: `O valor máximo é ${i.maximum}.` };
    }
    case 'invalid_string': {
      const i = issue as z.ZodInvalidStringIssue;
      if (i.validation === 'email') return { message: 'E-mail inválido.' };
      if (i.validation === 'uuid') return { message: 'Identificador inválido.' };
      return { message: 'Formato inválido.' };
    }
    case 'invalid_enum_value':
      return { message: 'Valor não permitido.' };
    default:
      return { message: ctx.defaultError };
  }
};
z.setErrorMap(ptMap);

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
