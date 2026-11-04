export type Role = 'cliente' | 'administrador' | 'atendimento' | 'estoque';
export const STAFF_ROLES: Role[] = ['administrador', 'atendimento', 'estoque'];

export const PERMISSIONS = [
  'dashboard.view',
  'orders.view', // fila/pedidos (dados pessoais e valores são mascarados conforme as demais permissões)
  'orders.advance', // avançar status de atendimento
  'orders.totals', // ver valores dos pedidos
  'orders.review', // liberar pedido em análise / cancelar pedido não pago
  'orders.refund', // solicitar estorno
  'orders.confirm_payment', // confirmar recebimento de pagamento combinado com a loja
  'customers.pii', // nome completo, telefone, e-mail e endereço
  'products.view',
  'products.edit', // dados do produto, fotos, publicação
  'products.price', // preço de venda
  'products.cost', // custo (informação financeira)
  'stock.view',
  'stock.move', // entradas e ajustes
  'stock.damage', // avaria, descarte, recuperação
  'stock.resolve', // resolver exceções de estoque
  'cash.view',
  'cash.manage', // saídas autorizadas
  'settings.view',
  'settings.edit',
  'staff.manage',
  'audit.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  cliente: new Set<Permission>(),
  administrador: new Set<Permission>(PERMISSIONS),
  atendimento: new Set<Permission>([
    'dashboard.view',
    'orders.view',
    'orders.advance',
    'orders.totals',
    'orders.review',
    'orders.confirm_payment',
    'customers.pii',
    'products.view',
    'stock.view',
  ]),
  estoque: new Set<Permission>([
    'dashboard.view',
    'orders.view',
    'orders.advance',
    'products.view',
    'products.edit',
    'stock.view',
    'stock.move',
    'stock.damage',
    'stock.resolve',
  ]),
};

export function can(role: Role | string | undefined | null, perm: Permission): boolean {
  if (!role || !(role in MATRIX)) return false;
  return MATRIX[role as Role].has(perm);
}
export function permissionsOf(role: Role): Permission[] {
  return [...MATRIX[role]];
}
export function isStaff(role: string | undefined | null): boolean {
  return role === 'administrador' || role === 'atendimento' || role === 'estoque';
}
