# Vitrine estática MARAVI

Esta pasta gera uma vitrine informativa servida como arquivos estáticos. A página não chama a API, não autentica usuários, não registra pedidos e não consulta estoque em tempo real. O snapshot `src/catalog.json` contém apenas nome, categoria, descrição, preço público e caminho de foto; não incluir custo de compra, quantidade de estoque, SKU interno ou dados de clientes.

As fotos e a logo são copiadas de `web/public` durante o build. As atribuições das fotografias são publicadas em `CREDITS.md`.

Para gerar a saída localmente, execute na raiz do repositório:

```sh
node static-site/build.mjs
```

O diretório publicado é `static-site/dist`. Para atualizar o catálogo, regenere o snapshot a partir dos dados públicos da loja e publique um novo deploy. Preços e disponibilidade na vitrine são apenas uma referência e precisam ser confirmados com a equipe.
