# MARAVI Pedidos

Loja virtual (PWA) e painel da equipe da **MARAVI — Achadinhos e Variedades** (Av. do São Raimundo, São Luís–MA).
Pedido com pagamento por Pix, reserva de estoque, fila de separação pelo horário real do pagamento, caixa e trilha de auditoria.

- Back-end: Node 22 · TypeScript · Fastify 5 · PostgreSQL 16 (driver `pg`) · zod
- Front-end: React 18 · Vite · React Router · PWA (manifest + service worker)
- Idioma pt-BR · valores em **centavos inteiros** · datas exibidas em **America/Fortaleza**

> **Estado atual: venda com pagamento combinado com a loja.** O padrão é `PIX_MODE=desabilitado` (sem Pix). O cliente faz o pedido e escolhe pagar na retirada ou na entrega; os itens ficam reservados (24 h, configurável) e a equipe confirma o recebimento no painel (dinheiro, cartão ou Pix direto na conta da loja). Só então o pedido entra na fila de separação, o estoque baixa e o caixa recebe o lançamento. Quem confirma fica registrado. Para testar o fluxo de Pix localmente, use `PIX_MODE=simulado` no `.env`.
>
> **O Pix, quando ligado em modo simulado, é FALSO.** Nada aqui cobra dinheiro de verdade. A integração real com um provedor
> ainda não existe e precisa ser feita e homologada (veja `docs/HOMOLOGACAO.md`). O app recusa subir em
> produção com Pix simulado.

## Situação desta entrega (honesta)

O ambiente em que este código foi escrito **não conseguiu instalar pacotes do npm** (acesso ao registro bloqueado).
Por isso **nada que depende de `fastify`, `zod`, `react` etc. foi executado de ponta a ponta** — ver a tabela abaixo.
Instale as dependências e rode os testes no seu computador antes de confiar no sistema.

| Verificado neste ambiente | Como |
|---|---|
| Migrações aplicam em PostgreSQL 16 real | `psql` |
| Invariantes do banco (estoque nunca negativo, avariado ≤ físico, 1 pagamento/1 lançamento por cobrança, tabelas só-de-inserção, estorno ligado ao pedido) | `server/test/sql/invariantes.sql` |
| Disputa pela última unidade (16 conexões × 40 rodadas, 0 violações) | `pgbench` contra a regra SQL atômica |
| 21 testes de unidade (BR Code/CRC16, dinheiro, CSV, permissões, regras de status) | `tsx --test` |
| ~160 comandos SQL do código preparados no banco (nomes de colunas/tabelas) | `server/scripts/sql-smoke.py` |
| Checagem de tipos TypeScript **com tipos "de mentira"** das bibliotecas | `tsc` (não substitui compilar de verdade) |

| **NÃO executado** (pendente na sua máquina) | |
|---|---|
| `npm install`, `npm run build`, `npm run typecheck` de verdade | |
| Testes de integração (`server/test/*.test.ts`: Pix duplicado, pagamento fora de ordem, última unidade, expiração, Pix tardio, avaria, estorno, acesso a pedido de outro cliente, permissões) — escritos, tipados, **nunca rodados** | |
| Rotas HTTP, transações dos serviços e todo o front-end em execução | |
| Instalação do PWA e uso em celular | |

Espere corrigir pequenos erros no primeiro `npm test`/`npm run build`.

## Como rodar

Pré-requisitos: Node ≥ 20.12 (recomendado 22), npm, PostgreSQL 16 (ou Docker).

```bash
cp .env.example .env            # ajuste se necessário (veja variáveis abaixo)
docker compose up -d            # PostgreSQL local (usuário maravi / senha maravi_dev)
# crie também o banco de testes:
docker compose exec db psql -U maravi -c "CREATE DATABASE maravi_test"

npm install
npm run db:migrate              # cria as tabelas
npm run db:seed                 # dados de demonstração (SEED_RESET=1 para recriar)
npm run import-products -w server  # (alternativa ao seed) cadastra os 17 produtos reais da planilha, com custo e preço
npm run dev                     # API em http://localhost:3000
npm run dev:web                 # (outro terminal) front em http://localhost:5173
```

Produção local (um só processo servindo API + PWA):

```bash
npm run build && npm run start   # http://localhost:3000
```

Testes:

```bash
npm test                         # server: vitest (usa TEST_DATABASE_URL; APAGA os dados desse banco)
npm run typecheck
```

### Logins de demonstração (senha: `Maravi@Demo2026`)

| E-mail | Perfil |
|---|---|
| admin@maravi.demo | Administrador (tudo, inclusive caixa e equipe) |
| atendimento@maravi.demo | Atendimento (pedidos; sem caixa) |
| estoque@maravi.demo | Estoque (produtos e estoque; sem valores de pedidos) |
| cliente@maravi.demo / cliente2@maravi.demo | Clientes |

O seed cria 10 produtos (rímel e esfoliante R$ 15, acessórios R$ 10, óculos R$ 20), endereços e 3 pedidos:
**A** (pago há 5 min), **B** (pago há 12 min — aparece **antes** de A na fila) e **C** (aguardando Pix).
Na tela de pagamento de um pedido, o botão **"Simular pagamento"** (só no modo simulado) dispara o evento assinado do "banco".

## Variáveis principais (`.env.example` tem todas)

| Variável | Para quê |
|---|---|
| `APP_ENV` | `desenvolvimento` / `homologacao` / `producao` |
| `APP_URL` | URL pública. Se for `https://…`, o cookie de sessão vira `Secure` |
| `DATABASE_URL`, `TEST_DATABASE_URL` | Banco do app e banco **descartável** dos testes |
| `PIX_MODE` | `desabilitado` (padrão) · `simulado` (proibido em produção) · `real` (ainda não implementado → erro 503) |
| `PIX_WEBHOOK_SECRET` | Segredo HMAC dos eventos do provedor (≥ 32 caracteres) |
| `TRUST_PROXY`, `CORS_ORIGINS` | Atrás de proxy / origem do Vite em desenvolvimento |

## O que funciona, o que é simulado, o que depende da MARAVI

### Implementado (código escrito; ver "Situação" acima sobre o que foi executado)
- **Pagamento combinado com a loja:** pedido sem Pix, confirmado pela equipe (perfis Administrador e Atendimento), com baixa de estoque, caixa e devolução registrados uma única vez. Sem desconto Pix.
- Cadastro, login, recuperação de senha (hash scrypt, sessão em banco, token de reset de uso único), perfil e endereços; cada cliente só enxerga os próprios dados (pedido alheio → 404).
- Catálogo com fotos, busca, categorias, filtros, variações (SKU), preço e quantidade disponível; esgotado aparece como indisponível.
- Sacola, retirada ou entrega com zonas/taxas/prazos configuráveis **mostrados antes do Pix**, desconto Pix configurável.
- Reserva de estoque ao iniciar o pagamento (prazo configurável); o servidor **revalida preço e disponibilidade** e grava preço e frete aplicados no pedido.
- Tela de pagamento: QR Code dinâmico, Pix Copia e Cola, contagem regressiva, atualização automática do status.
- Confirmação **somente** por evento autenticado (HMAC sobre o corpo bruto), validando cobrança, valor e status; eventos repetidos são seguros (dupla trava: `provider_events` e `payments`). Comprovante enviado pelo cliente nunca confirma.
- Na confirmação, numa única transação: pagamento + baixa de estoque + lançamento no caixa, uma vez só.
- Fila de separação ordenada pelo **horário de liquidação do provedor**, desempate estável pelo número do pedido; aguardando-Pix fica fora da fila.
- Status financeiro separado do de atendimento (Pago → Em separação → Pronto p/ retirada / Saiu p/ entrega → Concluído), com operador e horário.
- Expiração: **concilia com o provedor antes de liberar** a reserva; Pix descoberto depois da liberação registra o recibo e manda o pedido para "Em análise", que só é liberado com estoque garantido.
- Estoque com quatro números (físico, reservado, avariado, disponível), movimentos (entrada, reserva, liberação, venda, devolução, avaria, descarte, recuperação, ajuste) com motivo/usuário/pedido, foto opcional de avaria, sem estoque negativo e sem venda dupla da última unidade; avaria em unidade reservada abre **exceção** e bloqueia a expedição.
- Caixa: entrada automática por Pix, bruto/frete/descontos/taxas/estornos/saídas e **movimento líquido do app** (rotulado como diferente de saldo bancário e lucro), extrato por pedido e data, CSV, conciliação com o provedor, saídas autorizadas.
- Estorno confirmado = saída ligada ao pedido, preservando o recebimento original; reposição ao estoque opcional.
- Perfis Administrador / Atendimento / Estoque com permissões no servidor, mascaramento de dados pessoais e valores, e log de auditoria (somente-inserção).

### Simulado
- **Todo o Pix.** `server/src/pix/simulated.ts` guarda cobranças numa tabela, gera um BR Code com CRC16 e chave **fictícia** (não paga em nenhum banco) e assina os eventos com o mesmo segredo/algoritmo do caminho real.
- Estorno: confirmado na hora pelo mesmo caminho do webhook.

### Depende da MARAVI / ainda não existe
1. **Provedor Pix real** (PSP/banco com API Pix): escolher, contratar e escrever o adaptador `PixProvider` (`server/src/pix/provider.ts` define o contrato). Cadastrar a URL de webhook, a chave Pix e o segredo. Enquanto isso, `PIX_MODE=real` retorna 503.
2. **Envio de e-mail** (recuperação de senha): os e-mails ficam na tabela `outbox_emails`; falta um remetente SMTP. Em desenvolvimento o link aparece na resposta/ log.
3. **Hospedagem**, domínio com HTTPS, backup do PostgreSQL, monitoramento.
4. **Dados reais**: produtos, fotos, preços, bairros atendidos e taxas, textos legais (política de privacidade/termos — LGPD), CNPJ/dados da loja.
5. Revisão jurídica/contábil do caixa (o app registra movimento; não emite nota fiscal nem faz contabilidade).

### Limitações conhecidas
- Busca no catálogo não ignora acentos.
- Corrida rara: webhook de estorno chegando antes de `provider_refund_id` ser gravado — o evento fica registrado e pode ser reprocessado pela conciliação.
- A rotina de expiração (a cada 30 s) não faz nada enquanto o Pix está desabilitado.
- Não há notificação por push/WhatsApp; o cliente acompanha pela tela do pedido.

## Estrutura

```
server/migrations/   001_init, 002_config_padrao, 003_simulador_pix, 004_pagamento_local
server/src/          app, config, db, seed, lib/, pix/, services/, routes/
server/test/         unit/ (rápidos), sql/ (invariantes), *.test.ts (integração, vitest)
web/src/             pages/cliente, pages/painel, components, lib
docs/HOMOLOGACAO.md  checklist para ligar o Pix real
```

## Segurança (resumo)
Hash scrypt · sessões com cookie httpOnly/SameSite=Lax (+ verificação de Origin contra CSRF) · limites de tentativas em login/checkout · validação zod em toda entrada · SQL parametrizado · upload validado pelos bytes (PNG/JPG/WEBP, 4 MB) · cabeçalhos via Helmet/CSP · tabelas financeiras e de auditoria imutáveis por gatilho · PII e valores mascarados por permissão · service worker nunca guarda `/api`.

## Publicar online (Render)
1. Suba esta pasta para um repositório no GitHub.
2. No Render: **New → Blueprint** e escolha o repositório (usa `render.yaml`: banco + serviço + disco para fotos).
3. Preencha `APP_URL` com o endereço `https://….onrender.com` que o Render mostrar e faça novo deploy.
4. Crie o primeiro administrador (o seed é bloqueado em produção): no Shell do serviço, `ADMIN_NAME="Seu Nome" ADMIN_EMAIL=voce@dominio.com ADMIN_PASSWORD='uma-senha-forte' npm run create-admin -w server`. Depois entre em `/conta` e abra `/painel`.
5. Em `render.yaml` o `tsx` é dependência de desenvolvimento; o build usa `npm install --include=dev` para isso.


## Produtos reais
`server/data/produtos-maravi.json` vem da planilha de cadastro e precificação (17 produtos, custo e venda). `npm run import-products -w server` cadastra tudo como **publicado**; SKU já existente é ignorado, então pode repetir sem risco. Todos os produtos entram com **400 unidades** em estoque (ajuste pelo Painel → Estoque). As categorias (Maquiagem, Acessórios, Cuidados com a pele, Óculos) foram inferidas pelo nome do produto; ajuste no painel se precisar. O custo é informação financeira e só aparece para quem tem a permissão de ver custos (Administrador).


## Banco de dados em um único arquivo

`database/banco-maravi.sql` cria todas as tabelas, regras e configurações padrão (as 4 migrações juntas) em um banco PostgreSQL vazio, por exemplo Supabase, Neon ou Render. Use esse arquivo apenas em um banco que **não** passou pelo Render Blueprint (o Blueprint já aplica as migrações sozinho). Depois rode `npm run import-products -w server` (17 produtos com 400 unidades) e `npm run create-admin`.

## Usuários e senhas

- **Clientes** criam o próprio login em "Conta" na loja (e-mail e senha, mínimo 8 caracteres com letras e números).
- **Equipe** (Administrador, Atendimento, Estoque): o Administrador cadastra pelo painel; o primeiro é criado com `npm run create-admin`.
- **Qualquer perfil, por linha de comando:** `USER_NAME="Maria" USER_EMAIL=maria@dominio.com USER_ROLE=cliente USER_PASSWORD='Senha1234' npm run create-user` (perfis: administrador, atendimento, estoque, cliente). Se o e-mail já existir, a senha é redefinida.
- **Sem rodar código:** `database/usuarios-iniciais.sql` cria 4 logins de partida (administrador, atendimento, estoque e um cliente de teste), guardando só o hash das senhas. As senhas foram entregues ao dono da loja no chat; troque-as no primeiro acesso.
