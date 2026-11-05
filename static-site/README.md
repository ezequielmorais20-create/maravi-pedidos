# Vitrine estática MARAVI

Esta pasta gera uma vitrine informativa servida como arquivos estáticos. A página não chama a API, não autentica usuários, não registra pedidos e não consulta estoque em tempo real. O snapshot `src/catalog.json` contém apenas nome, categoria, descrição, preço público e caminho de foto; não incluir custo de compra, quantidade de estoque, SKU interno ou dados de clientes.

As fotos de produção são cópias WebP otimizadas em `src/products/`, padronizadas em uma tela quadrada de 960 × 960 px. Cada produto mantém a proporção original, sem corte ou distorção; fotos que não ocupam o quadrado recebem espaço de fundo suave. Os originais em `web/public/products/` permanecem intactos. O otimizador processa todos os arquivos `MAR-*.webp` existentes, sem exigir uma contagem fixa. Para regenerar as cópias após trocar ou adicionar imagens, com Python e Pillow instalados, execute na raiz do repositório:

```sh
python3 static-site/optimize_images.py
node static-site/build.mjs
```

As atribuições das fotografias são copiadas para a publicação em `CREDITS.md`. O build não instala nem executa um backend.

O diretório publicado é `static-site/dist`. Para atualizar o catálogo, regenere o snapshot a partir dos dados públicos da loja e publique um novo deploy. Preços e disponibilidade na vitrine são apenas uma referência e precisam ser confirmados com a equipe.
