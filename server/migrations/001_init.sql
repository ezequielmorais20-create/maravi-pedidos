-- MARAVI Pedidos — modelo de dados inicial
-- Valores monetários: sempre em centavos inteiros (integer).
-- Datas: timestamptz (UTC no banco); a exibição usa America/Fortaleza.

-- ---------------------------------------------------------------------------
-- Utilitário: tabelas "append-only" (histórico imutável)
-- ---------------------------------------------------------------------------
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A tabela % é somente de inserção (histórico imutável).', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

-- ---------------------------------------------------------------------------
-- Usuários, sessões e recuperação de senha
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role          text NOT NULL CHECK (role IN ('cliente','administrador','atendimento','estoque')),
  name          text NOT NULL CHECK (length(btrim(name)) > 0),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  phone         text,
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,            -- sha256 do token do cookie
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE password_resets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_emails (
  id         bigserial PRIMARY KEY,
  to_email   text NOT NULL,
  subject    text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);

CREATE TABLE addresses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        text NOT NULL DEFAULT 'Casa',
  recipient    text NOT NULL,
  phone        text,
  cep          text,
  street       text NOT NULL,
  number       text NOT NULL,
  complement   text,
  neighborhood text NOT NULL,
  city         text NOT NULL DEFAULT 'São Luís',
  state        text NOT NULL DEFAULT 'MA',
  reference    text,
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX addresses_user_idx ON addresses(user_id);

-- ---------------------------------------------------------------------------
-- Catálogo
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id         serial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  slug       text NOT NULL UNIQUE,
  sort_order int NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id int NOT NULL REFERENCES categories(id),
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  description text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','publicado','arquivado')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_category_idx ON products(category_id);
CREATE INDEX products_status_idx ON products(status);

CREATE TABLE product_images (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url        text NOT NULL,
  alt        text NOT NULL DEFAULT '',
  sort_order int NOT NULL DEFAULT 0
);
CREATE INDEX product_images_product_idx ON product_images(product_id, sort_order);

-- Estoque por SKU. Disponível para venda = físico - reservado - avariado (quarentena).
-- Pode ficar negativo SOMENTE quando uma avaria atinge unidades reservadas (déficit);
-- nesse caso existe uma exceção aberta em order_exceptions e a venda fica bloqueada.
CREATE TABLE skus (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku            text NOT NULL UNIQUE CHECK (length(btrim(sku)) > 0),
  variant_name   text NOT NULL DEFAULT 'Único',
  cost_cents     int  NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  price_cents    int  NOT NULL CHECK (price_cents > 0),
  min_stock      int  NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  stock_physical int  NOT NULL DEFAULT 0 CHECK (stock_physical >= 0),
  stock_reserved int  NOT NULL DEFAULT 0 CHECK (stock_reserved >= 0),
  stock_damaged  int  NOT NULL DEFAULT 0 CHECK (stock_damaged  >= 0),
  active         boolean NOT NULL DEFAULT true,
  image_url      text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skus_damaged_within_physical CHECK (stock_damaged <= stock_physical)
);
CREATE INDEX skus_product_idx ON skus(product_id);

CREATE TABLE sku_price_history (
  id          bigserial PRIMARY KEY,
  sku_id      uuid NOT NULL REFERENCES skus(id),
  price_cents int NOT NULL,
  cost_cents  int NOT NULL,
  changed_by  uuid REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sku_price_history_sku_idx ON sku_price_history(sku_id, changed_at DESC);

-- ---------------------------------------------------------------------------
-- Configurações e entrega
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);

CREATE TABLE delivery_zones (
  id               serial PRIMARY KEY,
  name             text NOT NULL,
  neighborhoods    text[] NOT NULL DEFAULT '{}',
  fee_cents        int NOT NULL CHECK (fee_cents >= 0),
  eta_min_minutes  int NOT NULL CHECK (eta_min_minutes >= 0),
  eta_max_minutes  int NOT NULL CHECK (eta_max_minutes >= eta_min_minutes),
  active           boolean NOT NULL DEFAULT true,
  sort_order       int NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Pedidos
-- ---------------------------------------------------------------------------
CREATE SEQUENCE order_number_seq START 1001;

CREATE TABLE orders (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                 bigint NOT NULL UNIQUE DEFAULT nextval('order_number_seq'),
  user_id                uuid NOT NULL REFERENCES users(id),
  idempotency_key        text,
  delivery_mode          text NOT NULL CHECK (delivery_mode IN ('retirada','entrega')),
  -- valores gravados no momento da compra
  subtotal_cents         int NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents         int NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  shipping_cents         int NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  total_cents            int NOT NULL CHECK (total_cents > 0),
  shipping_zone_name     text,
  eta_text               text,
  address                jsonb,
  customer_name          text NOT NULL,
  customer_phone         text,
  customer_email         text NOT NULL,
  -- status financeiro x status de atendimento (separados)
  payment_status         text NOT NULL DEFAULT 'pendente'
                         CHECK (payment_status IN ('pendente','pago','expirado','estornado','cancelado')),
  fulfillment_status     text NOT NULL DEFAULT 'aguardando_pagamento'
                         CHECK (fulfillment_status IN ('aguardando_pagamento','pago','em_separacao',
                                'pronto_retirada','saiu_entrega','concluido','em_analise','cancelado')),
  analysis_reason        text,
  reservation_status     text NOT NULL DEFAULT 'ativa' CHECK (reservation_status IN ('ativa','consumida','liberada')),
  reservation_expires_at timestamptz NOT NULL,
  late_payment           boolean NOT NULL DEFAULT false,
  paid_at                timestamptz,   -- horário efetivo da liquidação informado pelo provedor
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_total_consistent CHECK (total_cents = subtotal_cents - discount_cents + shipping_cents)
);
CREATE UNIQUE INDEX orders_idem_idx ON orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX orders_user_idx ON orders(user_id, created_at DESC);
CREATE INDEX orders_expiry_idx ON orders(reservation_expires_at) WHERE payment_status = 'pendente';
CREATE INDEX orders_queue_idx ON orders(paid_at, number) WHERE payment_status = 'pago';

CREATE TABLE order_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku_id           uuid NOT NULL REFERENCES skus(id),
  product_name     text NOT NULL,
  variant_name     text NOT NULL,
  sku_code         text NOT NULL,
  unit_price_cents int NOT NULL CHECK (unit_price_cents > 0),
  unit_cost_cents  int NOT NULL DEFAULT 0,
  quantity         int NOT NULL CHECK (quantity > 0),
  line_total_cents int NOT NULL,
  CONSTRAINT order_items_line_total CHECK (line_total_cents = unit_price_cents * quantity),
  CONSTRAINT order_items_unique_sku UNIQUE (order_id, sku_id)
);
CREATE INDEX order_items_order_idx ON order_items(order_id);
CREATE INDEX order_items_sku_idx ON order_items(sku_id);

CREATE TABLE order_events (
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  from_status text,
  to_status   text,
  actor_id    uuid REFERENCES users(id),
  actor_name  text,
  note        text,
  public      boolean NOT NULL DEFAULT true,   -- aparece na linha do tempo da cliente
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events(order_id, id);
CREATE TRIGGER order_events_immutable BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Pix, pagamentos e eventos do provedor
-- ---------------------------------------------------------------------------
CREATE TABLE pix_charges (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders(id),
  provider           text NOT NULL,
  provider_charge_id text NOT NULL,
  amount_cents       int  NOT NULL CHECK (amount_cents > 0),
  status             text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','paga','expirada','cancelada')),
  brcode             text NOT NULL,          -- Pix Copia e Cola
  simulated          boolean NOT NULL DEFAULT false,
  expires_at         timestamptz NOT NULL,
  settled_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_charge_id)
);
CREATE INDEX pix_charges_order_idx ON pix_charges(order_id);

-- Um recebimento por cobrança: a UNIQUE em charge_id garante registro único mesmo
-- que o provedor reenvie o evento com identificadores diferentes.
CREATE TABLE payments (
  id                bigserial PRIMARY KEY,
  order_id          uuid   NOT NULL REFERENCES orders(id),
  charge_id         uuid   NOT NULL UNIQUE REFERENCES pix_charges(id),
  amount_cents      int    NOT NULL CHECK (amount_cents > 0),
  fee_cents         int    NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  settled_at        timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  provider_event_id text,
  late              boolean NOT NULL DEFAULT false
);
CREATE INDEX payments_settled_idx ON payments(settled_at, id);
CREATE INDEX payments_order_idx ON payments(order_id);
CREATE TRIGGER payments_immutable BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE provider_events (
  id                 bigserial PRIMARY KEY,
  provider           text NOT NULL,
  event_id           text NOT NULL,
  type               text NOT NULL,
  provider_charge_id text,
  payload            jsonb NOT NULL,
  result             text NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

CREATE TABLE refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders(id),
  payment_id         bigint NOT NULL REFERENCES payments(id),
  amount_cents       int NOT NULL CHECK (amount_cents > 0),
  reason             text NOT NULL,
  restock            boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'solicitado' CHECK (status IN ('solicitado','confirmado','falhou')),
  provider_refund_id text,
  requested_by       uuid REFERENCES users(id),
  requested_at       timestamptz NOT NULL DEFAULT now(),
  confirmed_at       timestamptz
);
CREATE INDEX refunds_order_idx ON refunds(order_id);
CREATE UNIQUE INDEX refunds_provider_idx ON refunds(provider_refund_id) WHERE provider_refund_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Caixa (somente inserção): entradas, estornos e saídas autorizadas
-- ---------------------------------------------------------------------------
CREATE TABLE cash_entries (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('recebimento','estorno','saida')),
  order_id      uuid REFERENCES orders(id),
  payment_id    bigint REFERENCES payments(id),
  refund_id     uuid REFERENCES refunds(id),
  gross_cents   int NOT NULL CHECK (gross_cents > 0),   -- valor bruto do lançamento
  shipping_cents int NOT NULL DEFAULT 0,                -- parcela de frete (informativo)
  discount_cents int NOT NULL DEFAULT 0,                -- desconto já aplicado ao total (informativo)
  fee_cents     int NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  description   text NOT NULL,
  occurred_at   timestamptz NOT NULL,
  created_by    uuid REFERENCES users(id),
  authorized_by uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_recebimento_has_payment CHECK (kind <> 'recebimento' OR payment_id IS NOT NULL),
  CONSTRAINT cash_estorno_has_refund CHECK (kind <> 'estorno' OR (refund_id IS NOT NULL AND order_id IS NOT NULL)),
  CONSTRAINT cash_saida_authorized CHECK (kind <> 'saida' OR authorized_by IS NOT NULL)
);
CREATE UNIQUE INDEX cash_one_per_payment ON cash_entries(payment_id) WHERE kind = 'recebimento';
CREATE UNIQUE INDEX cash_one_per_refund  ON cash_entries(refund_id)  WHERE kind = 'estorno';
CREATE INDEX cash_occurred_idx ON cash_entries(occurred_at);
CREATE TRIGGER cash_entries_immutable BEFORE UPDATE OR DELETE ON cash_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Movimentos de estoque (somente inserção) e exceções
-- ---------------------------------------------------------------------------
CREATE TABLE stock_movements (
  id              bigserial PRIMARY KEY,
  sku_id          uuid NOT NULL REFERENCES skus(id),
  kind            text NOT NULL CHECK (kind IN ('entrada','reserva','liberacao','venda','devolucao',
                                                'avaria','descarte','recuperacao','ajuste')),
  quantity        int  NOT NULL CHECK (quantity > 0),
  delta_physical  int  NOT NULL DEFAULT 0,
  delta_reserved  int  NOT NULL DEFAULT 0,
  delta_damaged   int  NOT NULL DEFAULT 0,
  after_physical  int  NOT NULL,
  after_reserved  int  NOT NULL,
  after_damaged   int  NOT NULL,
  reason          text NOT NULL,
  user_id         uuid REFERENCES users(id),     -- responsável (nulo = sistema)
  order_id        uuid REFERENCES orders(id),
  exception_id    uuid,
  photo_url       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_sku_idx ON stock_movements(sku_id, id DESC);
CREATE INDEX stock_movements_order_idx ON stock_movements(order_id);
CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Exceção de estoque: unidade já prometida a um pedido foi avariada.
-- Enquanto aberta, o pedido não pode avançar para pronto/saiu/concluído.
CREATE TABLE order_exceptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku_id      uuid NOT NULL REFERENCES skus(id),
  quantity    int  NOT NULL CHECK (quantity > 0),   -- unidades em falta para este pedido
  kind        text NOT NULL CHECK (kind IN ('avaria_reserva','avaria_pedido_pago')),
  status      text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','resolvida','cancelada')),
  note        text,
  resolution  text,
  created_by  uuid REFERENCES users(id),
  resolved_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX order_exceptions_open_idx ON order_exceptions(order_id) WHERE status = 'aberta';
CREATE INDEX order_exceptions_sku_idx ON order_exceptions(sku_id) WHERE status = 'aberta';

-- ---------------------------------------------------------------------------
-- Auditoria (somente inserção)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  actor_id   uuid REFERENCES users(id),
  actor_role text,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log(created_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log(entity, entity_id);
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER sku_price_history_immutable BEFORE UPDATE OR DELETE ON sku_price_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
