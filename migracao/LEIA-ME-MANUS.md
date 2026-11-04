# MARAVI Pedidos – pacote de migração para o Manus

Tudo o que foi construído até 04/11/2026 para a **MARAVI – Achadinhos e Variedades** (Av. do São Raimundo, São Luís–MA, WhatsApp (98) 98506-6724).

## 1. O que há neste pacote

| Item | O que é |
|---|---|
| `vitrine-maravi.html` | Vitrine estática de uma página só (funciona abrindo no navegador). 17 produtos, sacola, total, PDF do pedido e envio pelo WhatsApp. Sem login nem banco. |
| `projeto-maravi-pedidos/` | Sistema completo: loja PWA + painel de equipe + banco PostgreSQL. |
| `projeto-maravi-pedidos/database/banco-maravi.sql` | Banco inteiro em um arquivo (25 tabelas). |
| `projeto-maravi-pedidos/server/data/produtos-maravi.json` | Os 17 produtos (nome, categoria, custo e preço em centavos, estoque 400). |
| `projeto-maravi-pedidos/web/public/logo-*.png` | Logo oficial. |
| `projeto-maravi-pedidos/README.md` e `docs/HOMOLOGACAO.md` | Instruções de execução e checklist do Pix real. |
| `PROMPT-PARA-O-MANUS.txt` | Texto pronto para colar no Manus. |

Repositório no GitHub: https://github.com/ezequielmorais20-create/maravi-pedidos (público no momento; os custos dos produtos foram zerados na versão atual, mas o primeiro commit ainda os contém. Torne o repositório privado em Settings → Danger Zone).

## 2. Identidade visual e regras de negócio
- Idioma pt-BR. Dinheiro em **centavos inteiros**. Fuso **America/Fortaleza**.
- Cores: rosa-claro `#FCE8EF`, rosa `#E58BA4`, vinho `#741039`. Botões vinho, fundo rosa-claro. Logo oficial redonda no canto, cabeçalho compacto.
- Perfis: **cliente**, **administrador** (tudo), **atendimento** (pedidos e confirmar pagamento, sem caixa), **estoque** (produtos e estoque, sem valores).
- **Pagamento por enquanto:** sem Pix automático. A cliente faz o pedido, paga na retirada/entrega combinada com a loja, **envia o comprovante pelo WhatsApp (98) 98506-6724**, e a equipe confirma no painel (dinheiro, cartão, Pix direto na conta da loja, outro).
- Pedido com pagamento na loja reserva estoque por 24 h. Confirmar pagamento baixa o estoque e lança no caixa em uma transação.
- Fila de separação ordenada pelo horário de pagamento confirmado.
- O painel tem a tela **Todos os pedidos**, agrupada por dia com dia/mês/ano e hora.
- Estoque com quatro números (físico, reservado, disponível, mínimo), entradas e baixas registradas, caixa, estornos e auditoria (tabelas de histórico não podem ser alteradas).
- Vitrine: cada card mostra foto (quando houver), preço, disponibilidade e botão Adicionar; aviso de pagamento dentro da sacola, antes de enviar o pedido.

## 3. Os 17 produtos
Estão em `server/data/produtos-maravi.json` (SKU MAR-001 a MAR-017). Preço de venda R$ 10,00 nos itens vistos; categorias inferidas: Acessórios, Maquiagem, Cuidados com a pele, Óculos. Todos com 400 unidades. Fotos ainda não foram fornecidas.

## 4. Tecnologia
- Backend: Node 22, TypeScript, Fastify 5, `pg`, zod. Autenticação própria: senha com scrypt, sessões no banco (cookie httpOnly), proteção CSRF por Origin, limite de tentativas.
- Frontend: React 18 + Vite + react-router, PWA (manifest + service worker que nunca guarda `/api`).
- Banco: PostgreSQL 16. Migrações em `server/migrations/` (001 a 004).
- Testes: unitários (`node:test`) e de integração (`vitest`, em `server/test/`). **Nunca puderam ser executados no ambiente anterior** (npm bloqueado); só passaram migrações, 7 grupos de invariantes SQL, 166 consultas SQL, 21 testes unitários e checagem de tipos (com tipos simulados). Rode `npm install && npm test` primeiro e corrija o que aparecer.
- Deploy previsto: Render (`render.yaml`: web + PostgreSQL + disco de fotos). O Manus pode usar outro host.

## 5. Como rodar
```
npm install
cp .env.example .env     # preencher DATABASE_URL, APP_URL
npm run db:migrate
npm run import-products -w server      # 17 produtos, 400 un.
read -rsp 'Senha inicial: ' USER_PASSWORD
printf '\n'
export USER_PASSWORD
USER_NAME="Admin" USER_EMAIL=voce@dominio.com USER_ROLE=administrador npm run create-user -w server
unset USER_PASSWORD
npm run build && npm start
```
Variáveis importantes: `DATABASE_URL`, `APP_URL`, `APP_ENV=producao`, `PIX_MODE=desabilitado`, `TRUST_PROXY=true`, `UPLOAD_DIR`.

## 6. Estado do trabalho
**Pronto e conferido localmente:** esquema do banco, regras de estoque e caixa, rotas da API, telas da loja e do painel, pagamento na loja com confirmação, PDF e WhatsApp na vitrine, tela Todos os pedidos, scripts de importação e criação de usuários.

**Nunca executado de ponta a ponta:** o servidor rodando com o frontend, os testes de integração e qualquer deploy real. Espere encontrar erros na primeira execução.

**Pendências:**
1. Colocar o sistema completo no ar (o Render exigiu cartão; o usuário não quis cadastrar cartão agora).
2. Escolher o provedor de Pix (recomendado: Asaas) e escrever o adaptador real; hoje há simulador. O checklist está em `docs/HOMOLOGACAO.md`.
3. Fotos dos produtos e custos reais; conferir categorias.
4. Envio de e-mail (SMTP) para recuperação de senha.
5. Tornar o repositório do GitHub privado.
6. Decidir onde guardar as fotos (disco persistente) no novo host.

## 7. Logins
Os logins de teste e as senhas foram entregues no chat anterior e **não** estão neste pacote. Crie novos com `npm run create-user` e senhas fortes.

## 8. Limites que o usuário já aceitou
- A vitrine do Claude é só uma página: sem login, sem banco, sem pedidos salvos. Os pedidos chegam só pelo WhatsApp.
- Sem cartão de crédito por enquanto (não usar planos pagos sem avisar o usuário).
