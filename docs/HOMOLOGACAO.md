# Checklist de homologação do Pix real

Status atual: **Pix 100% simulado.** Marque cada item antes de colocar `PIX_MODE=real` em produção.

## 0. Pré-requisitos
- [ ] `npm install`, `npm run typecheck`, `npm run build` sem erros.
- [ ] `npm test` (integração) **verde** num banco de teste limpo. Hoje esses testes nunca foram executados.
- [ ] Backup automático do PostgreSQL configurado e restauração testada.
- [ ] HTTPS ativo; `APP_URL=https://…`; `APP_ENV=homologacao` e depois `producao`.

## 1. Provedor
- [ ] PSP/banco escolhido, conta PJ da MARAVI aprovada, chave Pix cadastrada.
- [ ] Credenciais de **sandbox** e de **produção** guardadas fora do repositório (variáveis de ambiente).
- [ ] Adaptador `PixProvider` implementado: `createCharge`, `getCharge`, `cancelCharge`, `refund`, `listSettlements`, `verifyWebhook`, `parseWebhook`.
- [ ] Validação de assinatura/autenticação do webhook conforme a documentação **do provedor** (o HMAC atual é o do simulador). Se o provedor usar mTLS/IP allowlist, tratar na borda.
- [ ] URL de webhook cadastrada (`/api/webhooks/pix`) e acessível publicamente.
- [ ] Mapeamento de campos conferido: id da cobrança (txid/e2eid), valor, status, horário **de liquidação** (usado na ordem da fila), taxa.

## 2. Cenários em sandbox (repetir nos testes manuais e conferir no caixa)
- [ ] Pagamento normal: pedido vai a "Pago", entra na fila, estoque baixa 1×, 1 lançamento no caixa.
- [ ] Mesmo evento reenviado várias vezes → nada duplica.
- [ ] Dois pedidos, B criado depois mas pago antes → B aparece antes de A (ordem do horário de liquidação do provedor).
- [ ] Valor pago diferente do cobrado → rejeitado, pedido segue aguardando, evento visível na conciliação.
- [ ] Cobrança expirada **e** paga depois → recibo registrado, pedido em "Em análise", liberado só com estoque.
- [ ] Webhook atrasado + expiração: a rotina concilia antes de liberar a reserva.
- [ ] Provedor fora do ar durante a expiração → reserva **não** é liberada.
- [ ] Estorno total confirmado → saída no caixa ligada ao pedido, recibo original preservado.
- [ ] Estorno recusado pelo provedor → pedido continua "Pago", sem saída no caixa.
- [ ] Conciliação do dia sem divergências (ou divergências explicadas).

## 3. Operação
- [ ] Perfis criados (Administrador, Atendimento, Estoque); senha do admin de demonstração **removida** (nunca rodar o seed em produção — ele é bloqueado, confirme).
- [ ] Bairros, taxas, prazos e tempo de reserva revisados em Painel → Configurações.
- [ ] Produtos, fotos, preços e estoque reais cadastrados; estoque inicial conferido contra o físico.
- [ ] Equipe treinada: fila, avaria/exceção, estorno, fechamento do caixa (movimento líquido ≠ saldo bancário).
- [ ] Política de privacidade e termos publicados (LGPD); canal para pedidos de exclusão de dados.
- [ ] Envio de e-mail (SMTP) configurado para recuperação de senha.

## 4. Liberação gradual
- [ ] Piloto com poucos pedidos reais de baixo valor; conferir cada um no extrato do banco.
- [ ] Só então divulgar o app.
