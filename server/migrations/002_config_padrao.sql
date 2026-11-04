-- Configurações padrão da loja (editáveis em Painel > Configurações)
INSERT INTO settings (key, value) VALUES
  ('loja',                '{"nome":"MARAVI — Achadinhos e Variedades","endereco":"Avenida do São Raimundo, São Luís – MA","whatsapp":""}'::jsonb),
  ('retirada_ativa',      'true'::jsonb),
  ('entrega_ativa',       'true'::jsonb),
  ('retirada_prazo',      '"Pronto para retirada em até 30 minutos após a confirmação do Pix."'::jsonb),
  ('reserva_minutos',     '15'::jsonb),
  ('desconto_pix_percent','0'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO delivery_zones (name, neighborhoods, fee_cents, eta_min_minutes, eta_max_minutes, sort_order) VALUES
  ('São Raimundo e entorno', ARRAY['São Raimundo','Anjo da Guarda','Vila Embratel'], 500, 30, 60, 1),
  ('Centro e bairros próximos', ARRAY['Centro','Monte Castelo','Coroadinho','Liberdade'], 800, 45, 90, 2);
