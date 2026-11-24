import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheInfo, Stats } from '../types'

const cache = atom({ plugin: 'token-bar', key: 'cache' } as const, null as CacheInfo | null)
const tick = atom({ plugin: 'token-bar', key: 'tick' } as const, 0)
const busy = atom({ plugin: 'token-bar', key: 'busy' } as const, false)
const stats = atom({ plugin: 'token-bar', key: 'stats' } as const, { byTool: {}, biggest: [] } as Stats)

const BIG_OUTPUT_TOKENS = 12_000
const CACHE_WARN_MS = 45_000
const COMPACT_AT = 50

function estTokens(text: string): number {
  return Math.round(text.length / 4)
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function describeCall(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const v = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.path ?? ''
  const s = String(v).replace(/\s+/g, ' ')
  return s.length > 60 ? `${s.slice(0, 57)}...` : s || tool
}

function tipFor(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  if (tool === 'Read' && i.limit === undefined) return 'Read sem limit/offset: leia só o trecho necessário.'
  if (tool === 'Bash') return 'Saída de Bash grande: filtre com rtk, head, grep ou tail.'
  if (tool === 'Grep') return 'Grep amplo: use glob/type, head_limit ou output_mode files_with_matches.'
  if (tool.startsWith('mcp__')) return 'Tool MCP com resposta grande: peça menos campos/itens.'
  return 'Saída grande: restrinja o escopo da chamada.'
}

const GREEN = '#3fb950'
const YELLOW = '#d29922'
const RED = '#f85149'
const ORANGE = '#d97757'

function score(ctxPct: number, hitPct: number | null): number {
  let s = 100 - Math.max(0, ctxPct - 20) * 1.1
  if (hitPct !== null) s -= Math.max(0, 80 - hitPct) * 0.4
  return Math.max(0, Math.min(100, Math.round(s)))
}

function letter(s: number): string {
  return s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F'
}

function scoreColor(s: number): string {
  return s >= 70 ? GREEN : s >= 40 ? YELLOW : RED
}

function usedColor(p: number): string {
  return p >= 85 ? RED : p >= 60 ? YELLOW : GREEN
}

function shortTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `${Math.ceil(s / 60)}m` : `${s}s`
}

function rect(x: number, y: number, w: number, h: number, fill: string, inner = ''): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}">${inner}</rect>`
}

// Mascote pixel laranja. busy = digitando (pula, patinhas batendo, teclado piscando, "...").
function mascot(isBusy: boolean): string {
  const bob = isBusy
    ? '<animateTransform attributeName="transform" type="translate" values="0 0;0 -1;0 0" dur="0.35s" repeatCount="indefinite"/>'
    : '<animateTransform attributeName="transform" type="translate" values="0 0;0 0;0 -1;0 0" dur="2.4s" repeatCount="indefinite"/>'
  const blink =
    '<animate attributeName="height" values="2;2;0.3;2" keyTimes="0;0.85;0.92;1" dur="3s" repeatCount="indefinite"/>'
  const legs = [3, 6, 9, 12]
    .map((x, i) =>
      rect(
        x,
        11,
        1,
        2,
        ORANGE,
        isBusy
          ? `<animate attributeName="height" values="2;1;2" dur="0.25s" begin="${(i * 0.06).toFixed(2)}s" repeatCount="indefinite"/>`
          : '',
      ),
    )
    .join('')
  const keyboard = isBusy
    ? rect(1, 13, 15, 1, '#5a5a5a') +
      [0, 1, 2, 3, 4]
        .map(i =>
          rect(
            2 + i * 3,
            13,
            2,
            1,
            '#d0d0d0',
            `<animate attributeName="opacity" values="0;1;0" dur="0.5s" begin="${(i * 0.13).toFixed(2)}s" repeatCount="indefinite"/>`,
          ),
        )
        .join('')
    : ''
  const dots = isBusy
    ? [0, 1, 2]
        .map(i =>
          rect(
            17 + i * 2,
            2,
            1,
            1,
            '#e6e6e6',
            `<animate attributeName="opacity" values="0.15;1;0.15" dur="0.9s" begin="${(i * 0.3).toFixed(1)}s" repeatCount="indefinite"/>`,
          ),
        )
        .join('')
    : ''
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 23 15" shape-rendering="crispEdges">' +
    `<g>${bob}` +
    rect(2, 4, 13, 7, ORANGE) +
    rect(0, 6, 2, 2, ORANGE) +
    rect(15, 6, 2, 2, ORANGE) +
    rect(5, 6, 1, 2, '#1a1a1a', blink) +
    rect(11, 6, 1, 2, '#1a1a1a', blink) +
    legs +
    '</g>' +
    keyboard +
    dots +
    '</svg>'
  )
}

function ring(pct: number, color: string): string {
  const r = 6
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(100, pct))
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
    `<circle cx="8" cy="8" r="${r}" fill="none" stroke="#3a3a3a" stroke-width="2.4"/>` +
    `<circle cx="8" cy="8" r="${r}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" ` +
    `stroke-dasharray="${((p / 100) * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 8 8)"/></svg>`
  )
}

function badge(l: string, color: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
    `<rect x="0.5" y="0.5" width="15" height="15" rx="3" fill="${color}"/>` +
    `<text x="8" y="12" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="11" fill="#0d1117">${l}</text></svg>`
  )
}

function check(color: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">' +
    `<circle cx="7" cy="7" r="6" fill="none" stroke="${color}" stroke-width="1.4"/>` +
    `<path d="M4 7.2l2 2 4-4.4" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  )
}

async function report($: EngineInterface): Promise<string> {
  const usage = await $.session.usage()
  const c: CacheInfo | null = await read($, cache)
  const st: Stats = await read($, stats)
  const ctxPct = Math.round(usage.context.percent ?? 0)
  const now = await $.clock.now()
  const left = c ? c.at + c.ttlMs - now : 0
  const s = score(ctxPct, c ? c.hitPct : null)
  const weekly = usage.rateLimits.find(l => l.kind === 'seven_day')
  const fiveH = usage.rateLimits.find(l => l.kind === 'five_hour')

  const lines: string[] = []
  lines.push(`## Token Optimizer: nota ${letter(s)} (${s}/100)`)
  lines.push('')
  lines.push(
    `- Contexto: **${ctxPct}%** (${fmtK(usage.context.tokens ?? 0)} / ${fmtK(usage.context.window)} tokens)`,
  )
  lines.push(
    c
      ? `- Cache: ${left > 0 ? `expira em ${shortTime(left)}` : 'expirado'}, ${c.hitPct}% do último pedido veio do cache (TTL ${c.ttlMs >= 3_600_000 ? '1h' : '5m'})`
      : '- Cache: sem pedido ainda',
  )
  if (fiveH) lines.push(`- Janela de 5h: ${Math.round(fiveH.percentUsed)}%${fiveH.resetsAt ? ` (renova ${fiveH.resetsAt})` : ''}`)
  if (weekly) lines.push(`- Semana: ${Math.round(weekly.percentUsed)}%${weekly.resetsAt ? ` (renova ${weekly.resetsAt})` : ''}`)
  if (usage.cost) lines.push(`- Custo estimado da sessão: US$ ${usage.cost.usd.toFixed(2)}`)

  const tools = Object.entries(st.byTool).sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 6)
  if (tools.length) {
    lines.push('', '### Tools que mais gastaram (saída estimada)')
    for (const [name, t] of tools) lines.push(`- ${name}: ~${fmtK(t.tokens)} tokens em ${t.calls} chamadas`)
  }
  if (st.biggest.length) {
    lines.push('', '### Maiores saídas')
    for (const b of st.biggest) lines.push(`- ~${fmtK(b.tokens)} · ${b.tool} · \`${b.label}\``)
  }

  const tips: string[] = []
  if (ctxPct >= COMPACT_AT) tips.push(`Contexto em ${ctxPct}%: rode \`/compact\` (ou o botão na barra) com um resumo do que importa.`)
  if (ctxPct >= 80) tips.push('Acima de 80% a qualidade cai: considere `/clear` e recomeçar com um resumo.')
  if (c && c.hitPct < 50) tips.push('Pouco acerto de cache: evite trocar modelo/ferramentas no meio e mande mensagens antes do cache expirar.')
  if (c && left <= 0) tips.push('Cache expirou: a próxima mensagem paga o contexto inteiro de novo.')
  if (st.biggest.some(b => b.tool === 'Read')) tips.push('Leituras grandes de arquivo: use offset/limit ou Grep antes de Read.')
  if (st.byTool.Bash && st.byTool.Bash.tokens > 20_000) tips.push('Bash gastou muito: confira `rtk gain` e `rtk discover` para ver o que escapou do rtk.')
  if (weekly && weekly.percentUsed >= 80) tips.push('Semana perto do limite: prefira modelos menores para tarefas simples.')
  if (tips.length === 0) tips.push('Nada a fazer: sessão saudável.')
  lines.push('', '### Dicas')
  for (const t of tips) lines.push(`- ${t}`)
  return lines.join('\n')
}

export const register: Register = on => {
  let cacheWarned = 0
  const weekWarned = new Set<number>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'otimizar',
      description: 'Token Optimizer: relatório de contexto, cache, limites e tools que mais gastam',
    })
    $.clock.every(5000, () => {
      void (async () => {
        await update($, tick, n => n + 1)
        const c = await read($, cache)
        if (!c || (await read($, busy))) return
        const left = c.at + c.ttlMs - (await $.clock.now())
        if (left > 0 && left < CACHE_WARN_MS && cacheWarned !== c.at) {
          cacheWarned = c.at
          $.ui.toast(`Cache expira em ${Math.round(left / 1000)}s: mande algo agora para não pagar o contexto de novo.`)
        }
      })()
    })
    return next(e)
  })

  on('command.run', { command: 'otimizar' }, async $ => {
    return { text: await report($), isTextDisplayOnly: true }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const text = ran.text ?? (ran.result === undefined ? '' : JSON.stringify(ran.result))
    const tokens = estTokens(text ?? '')
    const label = describeCall(e.tool, e)
    await update($, stats, st => {
      const prev = st.byTool[e.tool] ?? { calls: 0, tokens: 0 }
      const biggest = [...st.biggest, { tool: e.tool, label, tokens }]
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 5)
      return { byTool: { ...st.byTool, [e.tool]: { calls: prev.calls + 1, tokens: prev.tokens + tokens } }, biggest }
    })
    if (tokens >= BIG_OUTPUT_TOKENS) {
      $.ui.toast(`${e.tool} trouxe ~${fmtK(tokens)} tokens. ${tipFor(e.tool, e)}`)
    }
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, busy, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, busy, () => false)
    const usage = await $.session.usage()
    const weekly = usage.rateLimits.find(l => l.kind === 'seven_day')
    for (const mark of [80, 95]) {
      if (weekly && weekly.percentUsed >= mark && !weekWarned.has(mark)) {
        weekWarned.add(mark)
        $.ui.toast(`Uso semanal passou de ${mark}%${weekly.resetsAt ? ` (renova ${weekly.resetsAt})` : ''}.`)
      }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const u = r.usage
    if (u) {
      const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      const info: CacheInfo = {
        at: await $.clock.now(),
        ttlMs: (u.ephemeral_1h_input_tokens ?? 0) > 0 ? 3_600_000 : 300_000,
        hitPct: total > 0 ? Math.round((u.cache_read_input_tokens / total) * 100) : 0,
      }
      await update($, cache, () => info)
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    await read($, tick)
    const c = await read($, cache)
    const isBusy = await read($, busy)
    const usage = await $.session.usage()
    const ctxPct = Math.round(usage.context.percent ?? 0)
    const weekly = usage.rateLimits.find(l => l.kind === 'seven_day')
    const weekPct = weekly ? Math.round(weekly.percentUsed) : null
    const now = await $.clock.now()
    const left = c ? c.at + c.ttlMs - now : 0
    const cachePct = c ? Math.max(0, (left / c.ttlMs) * 100) : 0
    const cacheColor = !c || left <= 0 ? RED : left < 60_000 ? YELLOW : GREEN
    const s = score(ctxPct, c ? c.hitPct : null)

    const issues: string[] = []
    if (ctxPct >= 60) issues.push('contexto alto')
    if (c && left <= 0) issues.push('cache expirou')
    else if (c && left < 60_000) issues.push('cache expirando')
    if (weekPct !== null && weekPct >= 80) issues.push('semana quase no limite')
    const status = issues.length === 0 ? 'Tudo certo.' : issues.join(' · ')
    const statusColor = issues.length === 0 ? GREEN : YELLOW

    const cacheText = c === null ? '—' : left > 0 ? shortTime(left) : 'expirado'
    const weekText = weekPct === null ? '—' : `${weekPct}%`

    if (e.surface === 'terminal' || e.surface === 'vscode') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box>
          <Text bold color={scoreColor(s)}>
            {letter(s)} {s}
          </Text>
          <Text dimColor> qualidade · </Text>
          <Text color={usedColor(ctxPct)}>{ctxPct}%</Text>
          <Text dimColor> contexto · </Text>
          <Text color={cacheColor}>{cacheText}</Text>
          <Text dimColor> cache · </Text>
          <Text>{weekText}</Text>
          <Text dimColor> semana</Text>
        </Box>
      )
    }

    const { Box, Text, Svg, Button } = $.ui.resolve(e)
    const canCompact = ctxPct >= COMPACT_AT && !isBusy

    return (
      <Box flexDirection="row" alignItems="center" gap={1} padding={1}>
        <Svg
          source={mascot(isBusy)}
          alt={isBusy ? 'Claude digitando' : 'Claude parado'}
          width={46}
          height={30}
          isInteractive
        />
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text bold>Token Optimizer</Text>
            <Svg source={check(statusColor)} alt="status" width={14} height={14} />
            <Text dimColor>{status}</Text>
            {canCompact ? (
              <Button
                key="compact"
                label="Compactar"
                onPress={async () => {
                  $.ui.toast('Compactando contexto...')
                  await $.session.compact()
                }}
              />
            ) : null}
            <Button
              key="report"
              label="Relatório"
              onPress={async () => {
                const st = await read($, stats)
                const top = Object.entries(st.byTool).sort((a, b) => b[1].tokens - a[1].tokens)[0]
                $.ui.toast(
                  (top ? `Maior gasto: ${top[0]} (~${fmtK(top[1].tokens)} tokens). ` : '') +
                    'Relatório completo: /otimizar',
                )
              }}
            />
          </Box>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg source={badge(letter(s), scoreColor(s))} alt={`nota ${letter(s)}`} width={16} height={16} />
            <Text bold>{s}</Text>
            <Text dimColor>qualidade </Text>
            <Svg source={ring(ctxPct, usedColor(ctxPct))} alt="contexto" width={16} height={16} />
            <Text bold>{ctxPct}%</Text>
            <Text dimColor>contexto </Text>
            <Svg source={ring(cachePct, cacheColor)} alt="cache" width={16} height={16} />
            <Text bold>{cacheText}</Text>
            <Text dimColor>cache </Text>
            <Svg
              source={ring(weekPct ?? 0, weekPct === null ? '#555555' : usedColor(weekPct))}
              alt="semana"
              width={16}
              height={16}
            />
            <Text bold>{weekText}</Text>
            <Text dimColor>semana</Text>
          </Box>
        </Box>
      </Box>
    )
  })
}
