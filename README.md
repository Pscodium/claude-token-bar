# Token Bar (Token Optimizer para Claude Code)

Mod para o Claude Code que coloca uma barra acima do campo de mensagem com a saúde da sessão:
nota de qualidade, % do contexto usado, tempo até o prompt cache expirar e % do uso semanal.
Também traz ferramentas para gastar menos tokens.

```
[mascote]  Token Optimizer ✓ Tudo certo.            [Compactar] [Relatório]
           [A] 87 qualidade   ◔ 25% contexto   ◕ 4m cache   ◑ 49% semana
```

## O que faz

**Barra**
- **Nota A–F / 0–100**: cai quando o contexto passa de 20% e quando o acerto do cache fica abaixo de 80%.
- **Contexto**: % da janela usada (verde < 60%, amarelo < 85%, vermelho acima).
- **Cache**: contagem regressiva desde o último pedido ao modelo (TTL de 5 min ou 1 h, detectado), com anel que esvazia.
- **Semana**: % do limite semanal do plano.
- **Mascote pixel animado**: parado, pisca; enquanto o Claude trabalha, digita num tecladinho com "...".
- No app desktop: anéis e mascote em SVG. No terminal e no VS Code: versão em texto colorido.

**Ferramentas**
- `/otimizar`: relatório com contexto, cache, janela de 5 h, semana, custo estimado, os tools que mais
  gastaram tokens, as 5 maiores saídas da sessão e dicas do que fazer.
- **Compactar**: botão que aparece com contexto ≥ 50% e roda o compact da sessão.
- **Aviso de cache**: toast quando faltam 45 s para o cache expirar e você está parado.
- **Aviso semanal**: toast ao passar de 80% e 95% do limite semanal.
- **Saída gigante**: toast quando um tool devolve mais de ~12k tokens, com dica (Read sem `limit`,
  Bash sem filtro/[rtk](https://github.com/rtk-ai/rtk), Grep amplo, MCP verboso).

## Instalação

No prompt de uma sessão do Claude Code no terminal:

```
/plugin install token-bar --marketplace Pscodium/claude-token-bar
```

Responda `y` para adicionar o marketplace e escolha o escopo (usuário = todas as sessões).

Pelo shell:

```
claude plugin install token-bar --marketplace Pscodium/claude-token-bar
```

No app desktop (onde `/plugin` não roda): clique no **+** ao lado do campo de mensagem → **Plugins** →
**Add marketplace** com `Pscodium/claude-token-bar` → **Add plugin**.

## Desenvolvimento

```
claude --plugin-dir ./
claude plugin validate .
```

Código em `hooks/register.tsx`; tipos do estado em `types/index.d.ts`. Limiares no topo do arquivo
(`BIG_OUTPUT_TOKENS`, `CACHE_WARN_MS`, `COMPACT_AT`).

## Licença

MIT
