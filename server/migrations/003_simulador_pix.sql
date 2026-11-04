-- Estado do provedor Pix SIMULADO (usado apenas em desenvolvimento e homologação).
-- Representa "o lado do banco/PSP": o app nunca lê esta tabela fora do adaptador simulado.
CREATE TABLE pix_simulator_charges (
  provider_charge_id text PRIMARY KEY,
  amount_cents       int NOT NULL,
  status             text NOT NULL DEFAULT 'ATIVA' CHECK (status IN ('ATIVA','CONCLUIDA','EXPIRADA','CANCELADA')),
  expires_at         timestamptz NOT NULL,
  settled_at         timestamptz,
  fee_cents          int NOT NULL DEFAULT 0,
  refunded_cents     int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now()
);
