-- Pagamento combinado com a loja (retirada/entrega), confirmado manualmente pela equipe.
-- Enquanto o Pix real não existe, a loja pode vender: o cliente faz o pedido, os itens ficam reservados
-- e a equipe confirma o recebimento (dinheiro, cartão, Pix direto na conta da loja...) no painel.

ALTER TABLE orders
  ADD COLUMN payment_method text NOT NULL DEFAULT 'local' CHECK (payment_method IN ('pix','local'));

-- Pagamento local não tem cobrança Pix do provedor.
ALTER TABLE payments ALTER COLUMN charge_id DROP NOT NULL;
ALTER TABLE payments
  ADD COLUMN method text NOT NULL DEFAULT 'pix' CHECK (method IN ('pix','dinheiro','cartao','pix_loja','outro')),
  ADD COLUMN confirmed_by uuid REFERENCES users(id),
  ADD CONSTRAINT payments_local_has_confirmer CHECK (method = 'pix' OR confirmed_by IS NOT NULL),
  ADD CONSTRAINT payments_pix_has_charge CHECK (method <> 'pix' OR charge_id IS NOT NULL);
-- Um pagamento local por pedido (UNIQUE(charge_id) já protege o Pix).
CREATE UNIQUE INDEX payments_one_local_per_order ON payments(order_id) WHERE method <> 'pix';

INSERT INTO settings (key, value) VALUES ('pagamento_local_ativo', 'true'), ('reserva_local_horas', '24')
  ON CONFLICT (key) DO NOTHING;
