# Controle de estoque — loja de roupas

Sistema web para o dono da loja acompanhar o estoque, registrar entradas e saídas e saber o que precisa repor.

## O que ele faz

- **Acesso protegido**: no primeiro acesso você cria o usuário e a senha do dono. Depois disso, só quem fizer login vê o estoque.
- **Cadastro de peças**: nome, categoria, tamanho, cor, quantidade, preço de custo e preço de venda (com o lucro por peça calculado na hora).
- **Alerta de estoque baixo**: cada peça tem um "avisar quando restar até X". O painel mostra quantas peças precisam de reposição e a lista mostra o nível de cada uma (em estoque, estoque baixo, sem estoque).
- **Entradas, saídas e contagem**: toda mudança de quantidade fica registrada no histórico, com data e observação. O estoque nunca fica negativo.
- **Busca e filtros**: por nome, cor, categoria ou situação.
- **Resumo**: total de peças, valor do estoque a preço de custo e a preço de venda.
- Funciona no computador e no celular.

## Como rodar

Precisa do [Node.js](https://nodejs.org) versão 22.13 ou mais nova. **Não há nada para instalar** (sem `npm install`): o sistema usa só recursos que já vêm com o Node.

```bash
cd estoque-loja
npm start
```

Abra http://localhost:3000 no navegador.

- Porta diferente: `PORT=8080 npm start`
- Local do banco de dados: `DB_PATH=/caminho/estoque.db npm start` (padrão: `data/estoque.db`)

Os dados ficam no arquivo `data/estoque.db`. **Faça cópia desse arquivo de vez em quando** — é o seu backup.

## Colocar na internet

Para acessar de qualquer lugar, rode em um servidor (VPS, Render, Railway etc.) e use sempre **HTTPS** na frente (por exemplo, com Caddy ou Nginx). Sem HTTPS, a senha trafega sem proteção.

## Estrutura

```
server.js        servidor, API e banco de dados (SQLite)
public/          páginas do sistema (index.html, style.css, app.js)
data/estoque.db  criado automaticamente na primeira execução
```

## Segurança, em resumo

Senha guardada com hash (scrypt), sessão por cookie HttpOnly, limite de tentativas de login, consultas SQL parametrizadas e bloqueio de requisições vindas de outros sites.

## Esqueci a senha

Apague as linhas de usuário no banco e crie o acesso de novo:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('data/estoque.db').exec('DELETE FROM usuarios')"
```

As peças e o histórico não são afetados.
