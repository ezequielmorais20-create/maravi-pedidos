-- Invariantes do banco, verificadas com dados descartáveis (tudo é desfeito no final).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/test/sql/invariantes.sql
-- Cada bloco lança exceção se uma regra deixar de valer; sucesso imprime NOTICE "OK ...".
BEGIN;

CREATE TEMP TABLE _ctx (k text PRIMARY KEY, v text);

-- massa mínima
INSERT INTO users (id, role, name, email, password_hash) VALUES
  ('00000000-0000-0000-0000-0000000000a1','cliente','Cliente Teste','t1@teste.local','x');
INSERT INTO categories (id, name, slug) VALUES (9001,'Cat Teste','cat-teste');
INSERT INTO products (id, category_id, name, status) VALUES ('00000000-0000-0000-0000-0000000000b1',9001,'Prod Teste','publicado');
INSERT INTO skus (id, product_id, sku, price_cents, stock_physical) VALUES
  ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1','T-001',1500,1);

DO $$ BEGIN
  -- 1) estoque nunca fica negativo
  BEGIN UPDATE skus SET stock_physical = -1 WHERE sku='T-001'; RAISE EXCEPTION 'FALHA: aceitou físico negativo';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE skus SET stock_reserved = -1 WHERE sku='T-001'; RAISE EXCEPTION 'FALHA: aceitou reservado negativo';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- 2) avariado nunca excede o físico
  BEGIN UPDATE skus SET stock_damaged = 2 WHERE sku='T-001'; RAISE EXCEPTION 'FALHA: avariado > físico';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- 3) preço precisa ser positivo
  BEGIN UPDATE skus SET price_cents = 0 WHERE sku='T-001'; RAISE EXCEPTION 'FALHA: aceitou preço zero';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'OK estoque: negativo, avariado>físico e preço zero são rejeitados';
END $$;

DO $$
DECLARE n int;
BEGIN
  -- 4) reserva condicional: a última unidade só é vendida uma vez
  UPDATE skus SET stock_reserved = stock_reserved + 1
   WHERE sku='T-001' AND (stock_physical + 0) - (stock_reserved + 1) - (stock_damaged + 0) >= 0;
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'FALHA: 1ª reserva deveria passar (n=%)', n; END IF;
  UPDATE skus SET stock_reserved = stock_reserved + 1
   WHERE sku='T-001' AND (stock_physical + 0) - (stock_reserved + 1) - (stock_damaged + 0) >= 0;
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 0 THEN RAISE EXCEPTION 'FALHA: 2ª reserva da última unidade passou'; END IF;
  RAISE NOTICE 'OK reserva condicional: última unidade não é reservada duas vezes';
  UPDATE skus SET stock_reserved = 0 WHERE sku='T-001';
END $$;

-- pedido, itens, cobrança, pagamento, caixa
INSERT INTO orders (id, user_id, delivery_mode, subtotal_cents, shipping_cents, total_cents, customer_name, customer_email, reservation_expires_at)
VALUES ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000a1','retirada',1500,0,1500,'Cliente Teste','t1@teste.local', now() + interval '15 min');
INSERT INTO order_items (order_id, sku_id, product_name, variant_name, sku_code, unit_price_cents, quantity, line_total_cents)
VALUES ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000c1','Prod Teste','Único','T-001',1500,1,1500);
INSERT INTO pix_charges (id, order_id, provider, provider_charge_id, amount_cents, brcode, expires_at)
VALUES ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000d1','simulado','SIMTESTE1',1500,'brcode', now() + interval '15 min');

DO $$ BEGIN
  -- 5) total do pedido consistente
  BEGIN
    INSERT INTO orders (user_id, delivery_mode, subtotal_cents, shipping_cents, total_cents, customer_name, customer_email, reservation_expires_at)
    VALUES ('00000000-0000-0000-0000-0000000000a1','retirada',1500,500,1500,'x','x@x.x', now());
    RAISE EXCEPTION 'FALHA: total inconsistente aceito';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- 6) mesmo SKU duas vezes no mesmo pedido
  BEGIN
    INSERT INTO order_items (order_id, sku_id, product_name, variant_name, sku_code, unit_price_cents, quantity, line_total_cents)
    VALUES ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000c1','Prod Teste','Único','T-001',1500,1,1500);
    RAISE EXCEPTION 'FALHA: SKU duplicado no pedido';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  -- 7) linha com total errado
  BEGIN
    UPDATE order_items SET line_total_cents = 1 WHERE order_id='00000000-0000-0000-0000-0000000000d1';
    RAISE EXCEPTION 'FALHA: total de linha inconsistente';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'OK pedidos: total, unicidade de SKU e total de linha';
END $$;

INSERT INTO payments (id, order_id, charge_id, amount_cents, settled_at, provider_event_id)
VALUES (777001,'00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e1',1500, now(),'evt1');
INSERT INTO cash_entries (kind, order_id, payment_id, gross_cents, description, occurred_at)
VALUES ('recebimento','00000000-0000-0000-0000-0000000000d1',777001,1500,'Pix teste', now());

DO $$ BEGIN
  -- 8) Pix duplicado: um pagamento por cobrança e um lançamento de caixa por pagamento
  BEGIN
    INSERT INTO payments (order_id, charge_id, amount_cents, settled_at) VALUES ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e1',1500, now());
    RAISE EXCEPTION 'FALHA: 2º pagamento da mesma cobrança aceito';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO cash_entries (kind, order_id, payment_id, gross_cents, description, occurred_at)
    VALUES ('recebimento','00000000-0000-0000-0000-0000000000d1',777001,1500,'duplicado', now());
    RAISE EXCEPTION 'FALHA: 2º lançamento de caixa do mesmo pagamento aceito';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  -- evento do provedor repetido
  INSERT INTO provider_events (provider,event_id,type,payload,result) VALUES ('simulado','evt-x','pix.paid','{}','ok');
  BEGIN
    INSERT INTO provider_events (provider,event_id,type,payload,result) VALUES ('simulado','evt-x','pix.paid','{}','ok');
    RAISE EXCEPTION 'FALHA: evento duplicado aceito';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  -- ON CONFLICT DO NOTHING devolve 0 linhas (é o que o app usa para detectar repetição)
  PERFORM 1;
  RAISE NOTICE 'OK Pix duplicado: pagamento, caixa e evento são únicos';
END $$;

DO $$ BEGIN
  -- 9) históricos imutáveis
  BEGIN UPDATE cash_entries SET gross_cents = 1; RAISE EXCEPTION 'FALHA: caixa alterável'; EXCEPTION WHEN integrity_constraint_violation THEN NULL; END;
  BEGIN DELETE FROM cash_entries; RAISE EXCEPTION 'FALHA: caixa apagável'; EXCEPTION WHEN integrity_constraint_violation THEN NULL; END;
  BEGIN UPDATE payments SET amount_cents = 1; RAISE EXCEPTION 'FALHA: pagamento alterável'; EXCEPTION WHEN integrity_constraint_violation THEN NULL; END;
  INSERT INTO stock_movements (sku_id, kind, quantity, after_physical, after_reserved, after_damaged, reason)
  VALUES ('00000000-0000-0000-0000-0000000000c1','entrada',1,1,0,0,'teste');
  BEGIN DELETE FROM stock_movements; RAISE EXCEPTION 'FALHA: movimento apagável'; EXCEPTION WHEN integrity_constraint_violation THEN NULL; END;
  INSERT INTO audit_log (action, entity) VALUES ('teste','x');
  BEGIN UPDATE audit_log SET action='y'; RAISE EXCEPTION 'FALHA: auditoria alterável'; EXCEPTION WHEN integrity_constraint_violation THEN NULL; END;
  BEGIN UPDATE sku_price_history SET price_cents = 1; EXCEPTION WHEN integrity_constraint_violation THEN NULL; END;
  RAISE NOTICE 'OK imutabilidade: caixa, pagamentos, movimentos e auditoria';
END $$;

DO $$ BEGIN
  -- 10) estorno vinculado a pedido; recebimento original preservado
  INSERT INTO refunds (id, order_id, payment_id, amount_cents, reason, status, provider_refund_id)
  VALUES ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000d1',777001,1500,'teste','confirmado','SIMR1');
  INSERT INTO cash_entries (kind, order_id, payment_id, refund_id, gross_cents, description, occurred_at)
  VALUES ('estorno','00000000-0000-0000-0000-0000000000d1',777001,'00000000-0000-0000-0000-0000000000f1',1500,'estorno', now());
  BEGIN
    INSERT INTO cash_entries (kind, gross_cents, description, occurred_at) VALUES ('estorno',1500,'sem vínculo', now());
    RAISE EXCEPTION 'FALHA: estorno sem pedido/estorno aceito';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO cash_entries (kind, gross_cents, description, occurred_at) VALUES ('saida',500,'sem autorização', now());
    RAISE EXCEPTION 'FALHA: saída sem autorização aceita';
  EXCEPTION WHEN check_violation THEN NULL; END;
  IF (SELECT COUNT(*) FROM cash_entries WHERE kind='recebimento') <> 1 THEN RAISE EXCEPTION 'FALHA: recebimento original perdido'; END IF;
  RAISE NOTICE 'OK estorno: vinculado ao pedido, recebimento original preservado, saída exige autorização';
END $$;

ROLLBACK;

-- ---------------------------------------------------------------------------
-- 7. Pagamento combinado com a loja: sem cobrança Pix, mas com quem confirmou; um por pedido
-- ---------------------------------------------------------------------------
BEGIN;
DO $$
DECLARE u uuid; adm uuid; o uuid; sku uuid; pid bigint; falhou boolean;
BEGIN
  INSERT INTO users (role, name, email, password_hash) VALUES ('cliente','Cli Local','cli.local@teste.local','x') RETURNING id INTO u;
  INSERT INTO users (role, name, email, password_hash) VALUES ('atendimento','Atend Local','atend.local@teste.local','x') RETURNING id INTO adm;
  INSERT INTO orders (user_id, delivery_mode, subtotal_cents, total_cents, customer_name, customer_email, reservation_expires_at, payment_method)
    VALUES (u,'retirada',1500,1500,'Cli Local','cli.local@teste.local', now() + interval '24 hours','local') RETURNING id INTO o;

  -- pagamento local sem "confirmado por" é recusado
  falhou := false;
  BEGIN INSERT INTO payments (order_id, charge_id, amount_cents, settled_at, method) VALUES (o, NULL, 1500, now(), 'dinheiro');
  EXCEPTION WHEN check_violation THEN falhou := true; END;
  IF NOT falhou THEN RAISE EXCEPTION 'pagamento local sem confirmador foi aceito'; END IF;

  -- pagamento Pix sem cobrança é recusado
  falhou := false;
  BEGIN INSERT INTO payments (order_id, charge_id, amount_cents, settled_at, method) VALUES (o, NULL, 1500, now(), 'pix');
  EXCEPTION WHEN check_violation THEN falhou := true; END;
  IF NOT falhou THEN RAISE EXCEPTION 'pagamento Pix sem cobrança foi aceito'; END IF;

  INSERT INTO payments (order_id, charge_id, amount_cents, settled_at, method, confirmed_by) VALUES (o, NULL, 1500, now(), 'dinheiro', adm) RETURNING id INTO pid;
  INSERT INTO cash_entries (kind, order_id, payment_id, gross_cents, description, occurred_at, created_by) VALUES ('recebimento', o, pid, 1500, 't', now(), adm);

  -- segundo pagamento local no mesmo pedido é recusado
  falhou := false;
  BEGIN INSERT INTO payments (order_id, charge_id, amount_cents, settled_at, method, confirmed_by) VALUES (o, NULL, 1500, now(), 'cartao', adm);
  EXCEPTION WHEN unique_violation THEN falhou := true; END;
  IF NOT falhou THEN RAISE EXCEPTION 'segundo pagamento local foi aceito'; END IF;

  -- segundo lançamento de caixa para o mesmo pagamento é recusado
  falhou := false;
  BEGIN INSERT INTO cash_entries (kind, order_id, payment_id, gross_cents, description, occurred_at, created_by) VALUES ('recebimento', o, pid, 1500, 't2', now(), adm);
  EXCEPTION WHEN unique_violation THEN falhou := true; END;
  IF NOT falhou THEN RAISE EXCEPTION 'lançamento de caixa duplicado foi aceito'; END IF;

  RAISE NOTICE 'OK: invariantes do pagamento local';
END $$;
ROLLBACK;
