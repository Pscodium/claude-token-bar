# Token Bar (Token Optimizer para Claude Code)

Mod para o Claude Code que coloca uma barra acima do campo de mensagem com a saúde da sessão:
nota de qualidade, % do contexto usado, tempo até o prompt cache expirar e % do uso semanal.
Também traz ferramentas para gastar menos tokens.

```
[mascote] ✓  [A] 87 qualidade   ◔ 25% contexto   ◕ 4m cache   ◑ 49% semana      ▾  ⚙
```

- **▾** abre a linha estendida: janela 5h, tokens no contexto, acerto do cache, último turno
  (duração · tokens gerados), tokens gerados na sessão, custo e o tool que mais gastou.
- **⚙** abre o painel lateral (responsivo) com nota, cartões de contexto/cache/5h/semana, ferramentas,
  gráfico de tokens por tool, maiores saídas e dicas.

## O que faz

**Barra**
- **Nota A–F / 0–100**: cai quando o contexto passa de 20% e quando o acerto do cache fica abaixo de 80%.
- **Contexto**: % da janela usada (verde < 60%, amarelo < 85%, vermelho acima).
- **Cache**: contagem regressiva desde o último pedido ao modelo (TTL de 5 min ou 1 h, detectado), com anel que esvazia.
- **Semana**: % do limite semanal do plano.
- **Mascote pixel animado**: parado, pisca; enquanto o Claude trabalha, digita num tecladinho com "...".
- No app desktop: anéis e mascote em SVG. No terminal e no VS Code: versão em texto colorido.

**Ferramentas**
- **⚙ / `/otimizar`**: abre o painel lateral com botões **Compactar contexto**, **rtk gain**, **rtk discover**
  e **Zerar estatísticas**, mais o relatório (contexto, cache, janela de 5 h, semana, custo estimado, tools que
  mais gastaram tokens, 5 maiores saídas e dicas). Onde não há painel, `/otimizar` imprime o relatório.
- **Compactar** (no painel): roda o compact da sessão. No app desktop o mod ainda não pode compactar sozinho;
  aí ele avisa para digitar `/compact`.
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
claude plugin validate .
claude --plugin-dir ./
```

Ou, com hot reload numa sessão que já carrega uma pasta de mods:

```powershell
./scripts/sync-dev.ps1 -Dest "<pasta de mods>\token-bar"
```

Fluxo completo (para humanos e para o Claude): `.claude/skills/mod-workflow/SKILL.md`.

Código em `hooks/register.tsx`; tipos do estado em `types/index.d.ts`. Limiares no topo do arquivo
(`BIG_OUTPUT_TOKENS`, `CACHE_WARN_MS`, `COMPACT_AT`).

## Licença

MIT
