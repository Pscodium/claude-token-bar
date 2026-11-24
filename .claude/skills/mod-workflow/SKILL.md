---
name: mod-workflow
description: Como mexer no mod token-bar: editar sempre neste repo, validar, sincronizar o "build" para a pasta de mods do Claude Code para testar, e commitar sem co-autor. Use ao alterar qualquer coisa do mod (barra, painel, ferramentas, README).
---

# Fluxo de trabalho do token-bar

Este repositório é a **fonte** do mod. A pasta de mods do Claude Code é só o "build" para testar.

## 1. Editar aqui

- Código: `hooks/register.tsx`. Estado tipado: `types/index.d.ts` (todo `atom` novo precisa estar
  declarado em `PluginState['token-bar']`).
- Nunca editar direto na pasta de mods (`~/.claude/dev-mods/...`): o que estiver lá é sobrescrito.
- Mudou comportamento visível? Atualizar o `README.md`. Release nova? Subir `version` em
  `.claude-plugin/plugin.json`.

Armadilhas conhecidas da API de mods:
- `Button` só aceita texto: ícone = `label` de um glifo (`'⚙'`), nunca `<Svg>` dentro.
- Hook de `turn.step` é `async function*` com `yield* next(e)`.
- Input de `tool.call` vem achatado em `e` (`e.file_path`, `e.command`), não em `e.input`.
- `$.session.compact()` falha no app desktop/SDK: sempre em `try/catch` com aviso para `/compact`.
- Barra (`AbovePrompt`) deve ficar em **uma linha**; detalhes vão no painel (`/otimizar`).

## 2. Validar

```powershell
claude plugin validate .
npx -y -p typescript@5.6.3 tsc -p .
```

(`tsc` só roda depois que o Claude Code carregou o mod uma vez e gerou `.claude-plugin/types/`.)

## 3. Levar o build para o Claude testar

```powershell
./scripts/sync-dev.ps1 -Dest "<pasta de mods da sessão>\token-bar"
```

A pasta de mods da sessão aparece quando a skill `plugin-authoring` é carregada
(`~/.claude/dev-mods/<id da sessão>/`). O mod recarrega quando o turno termina; erros de hook voltam
como aviso no próximo turno. Alternativa sem hot reload: `claude --plugin-dir .`.

## 4. Commitar

- Autor: só o dono do repo. **Não** adicionar `Co-Authored-By: Claude ...` nem outra atribuição de IA
  em commits ou PRs.
- Mensagens no estilo Conventional Commits (`feat:`, `fix:`, `docs:`), assunto curto.
- Antes de publicar, rodar o scan de segredos se a ferramenta existir; nunca commitar `.claude-plugin/types/`.
