export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown, code = 'dados_invalidos') => new AppError(400, code, message, details);
export const unauthorized = (message = 'Faça login para continuar.') => new AppError(401, 'nao_autenticado', message);
export const forbidden = (message = 'Você não tem permissão para esta ação.') => new AppError(403, 'sem_permissao', message);
export const notFound = (message = 'Registro não encontrado.') => new AppError(404, 'nao_encontrado', message);
export const conflict = (message: string, code = 'conflito', details?: unknown) => new AppError(409, code, message, details);
export const unprocessable = (message: string, code = 'regra_de_negocio', details?: unknown) => new AppError(422, code, message, details);
export const unavailable = (message: string, code = 'indisponivel') => new AppError(503, code, message);

export function pgCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}
export function pgConstraint(err: unknown): string | undefined {
  return (err as { constraint?: string } | null)?.constraint;
}
