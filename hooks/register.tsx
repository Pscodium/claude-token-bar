import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheInfo, Stats, ToolOut, TurnInfo } from '../types'

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
  const trim = (x: number) => (x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, ''))
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`
  if (n >= 1000) return `${trim(n / 1000)}k`
  return String(n)
}

// Linha estendida: blocos (valor em cima, rótulo embaixo) em grade de largura fixa, quebrando em linhas iguais.
type Tile = { value: string; label: string; color?: string }
function tilesSvg(tiles: Tile[], width: number): string {
  const minTile = 92
  const perRow = Math.max(1, Math.min(tiles.length, Math.floor(width / minTile)))
  const rows = Math.ceil(tiles.length / perRow)
  const tw = width / perRow
  const rh = 38
  const h = rows * rh
  const body = tiles
    .map((t, i) => {
      const col = i % perRow
      const row = Math.floor(i / perRow)
      const x = col * tw
      const y = row * rh
      const sep =
        col > 0 ? `<line x1="${x.toFixed(1)}" y1="${y + 8}" x2="${x.toFixed(1)}" y2="${y + 30}" stroke="#3a3a3a"/>` : ''
      const val = t.value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
      return (
        sep +
        `<text x="${(x + 12).toFixed(1)}" y="${y + 18}" font-size="13" font-weight="700" fill="${t.color ?? '#ededed'}">${val}</text>` +
        `<text x="${(x + 12).toFixed(1)}" y="${y + 32}" font-size="10" fill="#8d8d8d">${t.label}</text>`
      )
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h}" font-family="ui-sans-serif,system-ui,sans-serif">` +
    body +
    '</svg>'
  )
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

const PANE = 'token-optimizer'
let W = 340 // largura do painel em px; recalculada a cada desenho (responsivo)
const CARD = '#1f1f1f'
const TRACK = '#2e2e2e'
const MUTED = '#9a9a9a'
const FONT = 'font-family="ui-sans-serif,system-ui,sans-serif"'

type Tip = { level: 'ok' | 'warn' | 'bad'; text: string }
type Limit = { pct: number; resets?: string } | null
type PaneData = {
  score: number
  status: string
  statusColor: string
  isBusy: boolean
  ctxPct: number
  ctxTokens: number
  ctxWindow: number
  cache: CacheInfo | null
  cacheLeft: number
  fiveH: Limit
  week: Limit
  costUsd: number | null
  tools: { name: string; calls: number; tokens: number }[]
  biggest: Stats['biggest']
  tips: Tip[]
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function resetLabel(iso?: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const h = Math.max(0, (t - Date.now()) / 3_600_000)
  return h >= 24 ? `renova em ${Math.round(h / 24)}d` : `renova em ${Math.ceil(h)}h`
}

async function collect($: EngineInterface): Promise<PaneData> {
  const usage = await $.session.usage()
  const c = await read($, cache)
  const st = await read($, stats)
  const isBusy = await read($, busy)
  const ctxPct = Math.round(usage.context.percent ?? 0)
  const left = c ? c.at + c.ttlMs - (await $.clock.now()) : 0
  const w = usage.rateLimits.find(l => l.kind === 'seven_day')
  const f = usage.rateLimits.find(l => l.kind === 'five_hour')
  const score_ = score(ctxPct, c ? c.hitPct : null)

  const tips: Tip[] = []
  if (ctxPct >= 80) tips.push({ level: 'bad', text: 'Contexto acima de 80%: a qualidade cai. Faça /compact ou /clear com um resumo.' })
  else if (ctxPct >= COMPACT_AT) tips.push({ level: 'warn', text: `Contexto em ${ctxPct}%: bom momento para /compact.` })
  if (c && left <= 0) tips.push({ level: 'bad', text: 'Cache expirou: a próxima mensagem paga o contexto inteiro de novo.' })
  else if (c && c.hitPct < 50) tips.push({ level: 'warn', text: 'Pouco acerto de cache: evite trocar modelo/ferramentas no meio da conversa.' })
  if (st.biggest.some(b => b.tool === 'Read' && b.tokens >= BIG_OUTPUT_TOKENS))
    tips.push({ level: 'warn', text: 'Leituras grandes: use offset/limit ou Grep antes do Read.' })
  if ((st.byTool.Bash?.tokens ?? 0) > 20_000)
    tips.push({ level: 'warn', text: 'Bash gastou muito: confira rtk gain e rtk discover.' })
  if (w && w.percentUsed >= 80) tips.push({ level: 'bad', text: 'Semana perto do limite: use modelos menores para tarefas simples.' })
  if (tips.length === 0) tips.push({ level: 'ok', text: 'Sessão saudável. Nada a fazer.' })

  const worst = tips.some(t => t.level === 'bad') ? 'bad' : tips.some(t => t.level === 'warn') ? 'warn' : 'ok'
  return {
    score: score_,
    status: worst === 'ok' ? 'Tudo certo' : worst === 'warn' ? 'Atenção' : 'Precisa de ação',
    statusColor: worst === 'ok' ? GREEN : worst === 'warn' ? YELLOW : RED,
    isBusy,
    ctxPct,
    ctxTokens: usage.context.tokens ?? 0,
    ctxWindow: usage.context.window,
    cache: c,
    cacheLeft: left,
    fiveH: f ? { pct: Math.round(f.percentUsed), resets: f.resetsAt } : null,
    week: w ? { pct: Math.round(w.percentUsed), resets: w.resetsAt } : null,
    costUsd: usage.cost ? usage.cost.usd : null,
    tools: Object.entries(st.byTool)
      .map(([name, t]) => ({ name, ...t }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 6),
    biggest: st.biggest,
    tips,
  }
}

function paneHeader(d: PaneData): string {
  const r = 30
  const circ = 2 * Math.PI * r
  const col = scoreColor(d.score)
  const mascotSvg = mascot(d.isBusy).replace('<svg ', '<svg x="14" y="22" width="69" height="45" ')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 92" ${FONT}>` +
    `<rect width="${W}" height="92" rx="12" fill="${CARD}"/>` +
    mascotSvg +
    `<text x="96" y="36" font-size="15" font-weight="700" fill="#ededed">Token Optimizer</text>` +
    `<circle cx="101" cy="56" r="4" fill="${d.statusColor}"/>` +
    `<text x="111" y="60" font-size="12" fill="${MUTED}">${esc(d.status)}</text>` +
    (d.costUsd !== null
      ? `<text x="96" y="78" font-size="11" fill="${MUTED}">custo ≈ US$ ${d.costUsd.toFixed(2)}</text>`
      : '') +
    `<g transform="translate(${W - 50} 46)">` +
    `<circle r="${r}" fill="none" stroke="${TRACK}" stroke-width="7"/>` +
    `<circle r="${r}" fill="none" stroke="${col}" stroke-width="7" stroke-linecap="round" transform="rotate(-90)" ` +
    `stroke-dasharray="${((d.score / 100) * circ).toFixed(1)} ${circ.toFixed(1)}"/>` +
    `<text y="2" text-anchor="middle" font-size="22" font-weight="800" fill="${col}">${letter(d.score)}</text>` +
    `<text y="17" text-anchor="middle" font-size="10" fill="${MUTED}">${d.score}/100</text>` +
    `</g></svg>`
  )
}

function card(x: number, y: number, w: number, title: string, value: string, sub: string, pct: number | null, color: string): string {
  const bw = w - 24
  const fill = pct === null ? 0 : (Math.max(0, Math.min(100, pct)) / 100) * bw
  return (
    `<g transform="translate(${x} ${y})">` +
    `<rect width="${w}" height="74" rx="10" fill="${CARD}"/>` +
    `<text x="12" y="20" font-size="11" fill="${MUTED}">${esc(title)}</text>` +
    `<text x="12" y="44" font-size="20" font-weight="700" fill="#ededed">${esc(value)}</text>` +
    `<rect x="12" y="52" width="${bw}" height="5" rx="2.5" fill="${TRACK}"/>` +
    (fill > 0 ? `<rect x="12" y="52" width="${fill.toFixed(1)}" height="5" rx="2.5" fill="${color}"/>` : '') +
    `<text x="12" y="68" font-size="10" fill="${MUTED}">${esc(sub)}</text>` +
    `</g>`
  )
}

function metricCards(d: PaneData): string {
  const gap = 8
  const cw = (W - gap) / 2
  const c = d.cache
  const cacheValue = !c ? '—' : d.cacheLeft > 0 ? shortTime(d.cacheLeft) : 'expirado'
  const cachePct = c ? Math.max(0, (d.cacheLeft / c.ttlMs) * 100) : null
  const cacheColor = !c || d.cacheLeft <= 0 ? RED : d.cacheLeft < 60_000 ? YELLOW : GREEN
  const lim = (l: Limit) => (l ? `${l.pct}%` : '—')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${74 * 2 + gap}" ${FONT}>` +
    card(0, 0, cw, 'Contexto', `${d.ctxPct}%`, `${fmtK(d.ctxTokens)} de ${fmtK(d.ctxWindow)} tokens`, d.ctxPct, usedColor(d.ctxPct)) +
    card(
      cw + gap,
      0,
      cw,
      'Cache',
      cacheValue,
      c ? `${c.hitPct}% acerto · TTL ${c.ttlMs >= 3_600_000 ? '1h' : '5m'}` : 'sem pedido ainda',
      cachePct,
      cacheColor,
    ) +
    card(0, 74 + gap, cw, 'Janela 5h', lim(d.fiveH), d.fiveH ? resetLabel(d.fiveH.resets) : 'sem leitura', d.fiveH?.pct ?? null, usedColor(d.fiveH?.pct ?? 0)) +
    card(cw + gap, 74 + gap, cw, 'Semana', lim(d.week), d.week ? resetLabel(d.week.resets) : 'sem leitura', d.week?.pct ?? null, usedColor(d.week?.pct ?? 0)) +
    `</svg>`
  )
}

function toolBars(tools: PaneData['tools']): string {
  const row = 24
  const h = tools.length * row + 12
  const max = Math.max(1, ...tools.map(t => t.tokens))
  const labelW = 96
  const barW = W - labelW - 70
  const rows = tools
    .map((t, i) => {
      const y = 8 + i * row
      const w = Math.max(2, (t.tokens / max) * barW)
      const name = t.name.startsWith('mcp__') ? t.name.split('__').pop() ?? t.name : t.name
      return (
        `<text x="12" y="${y + 13}" font-size="11" fill="#d8d8d8">${esc(name.slice(0, 14))}</text>` +
        `<rect x="${labelW}" y="${y + 3}" width="${barW}" height="12" rx="4" fill="${TRACK}"/>` +
        `<rect x="${labelW}" y="${y + 3}" width="${w.toFixed(1)}" height="12" rx="4" fill="${i === 0 ? ORANGE : '#b8694f'}"/>` +
        `<text x="${W - 12}" y="${y + 13}" text-anchor="end" font-size="11" fill="${MUTED}">${fmtK(t.tokens)} · ${t.calls}×</text>`
      )
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" ${FONT}><rect width="${W}" height="${h}" rx="10" fill="${CARD}"/>${rows}</svg>`
}

const expanded = atom({ plugin: 'token-bar', key: 'expanded' } as const, false)
const turn = atom({ plugin: 'token-bar', key: 'turn' } as const, { startedAt: 0, lastMs: 0, lastIn: 0, lastOut: 0, steps: 0, sessionOut: 0, turns: 0 } as TurnInfo)
const toolOut = atom({ plugin: 'token-bar', key: 'toolOut' } as const, null as ToolOut | null)

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}

async function runTool($: EngineInterface, title: string, argv: string[]): Promise<void> {
  await update($, toolOut, () => ({ title, text: 'rodando...', ok: true }))
  try {
    const r = await $.process.run(argv, { timeoutMs: 60_000 })
    const text = stripAnsi((r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim()).slice(-6000)
    await update($, toolOut, () => ({ title, text: text || '(sem saída)', ok: r.exitCode === 0 }))
  } catch (err) {
    await update($, toolOut, () => ({ title, text: `Não rodou: ${String(err)}`, ok: false }))
  }
}

async function compactNow($: EngineInterface): Promise<void> {
  if (await read($, busy)) {
    $.ui.toast('Espere o turno terminar para compactar.')
    return
  }
  try {
    $.ui.toast('Compactando contexto...')
    await $.session.compact()
  } catch {
    // App desktop/SDK ainda não deixa mod compactar fora de um turno.
    $.ui.toast('Aqui o mod não consegue compactar sozinho: digite /compact no campo de mensagem.')
  }
}

export const register: Register = on => {
  let cacheWarned = 0
  const weekWarned = new Set<number>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'otimizar',
      description: 'Token Optimizer: painel com relatório e ferramentas (compactar, rtk gain/discover)',
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
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Token Optimizer' })
    if (isPlaced) return { text: 'Painel do Token Optimizer aberto.', isTextDisplayOnly: true }
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
    const startedAt = await $.clock.now()
    await update($, turn, t => ({ ...t, startedAt, lastIn: 0, lastOut: 0, steps: 0 }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, busy, () => false)
    const endedAt = await $.clock.now()
    await update($, turn, t => ({ ...t, lastMs: t.startedAt ? endedAt - t.startedAt : 0, turns: t.turns + 1 }))
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
      await update($, turn, t => ({
        ...t,
        lastIn: t.lastIn + total,
        lastOut: t.lastOut + u.output_tokens,
        steps: t.steps + 1,
        sessionOut: t.sessionOut + u.output_tokens,
      }))
    }
    return r
  })

  // Painel lateral: dashboard + ferramentas.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, tick)
    const out = await read($, toolOut)

    if (e.surface === 'terminal' || e.surface === 'vscode') {
      const { Markdown } = $.ui.resolve(e)
      return <Markdown text={await report($)} />
    }

    const { Box, Text, Button, Svg, Markdown } = $.ui.resolve(e)
    // Largura real do painel: colunas do corpo × ~7.6 px por célula, menos o padding.
    W = Math.max(260, Math.min(1000, Math.round((e.props.bodyColumns ?? 44) * 7.6) - 24))
    const d = await collect($)
    const resetStats = async () => {
      await update($, stats, () => ({ byTool: {}, biggest: [] }))
      await update($, toolOut, () => null)
    }

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Svg source={paneHeader(d)} alt={`Nota ${letter(d.score)}, ${d.score} de 100. ${d.status}`} width={W} />
        <Svg source={metricCards(d)} alt="Contexto, cache, janela de 5 horas e semana" width={W} />

        <Text bold>Ferramentas</Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="p-compact" label={'\u{1F5DC} Compactar'} onPress={() => compactNow($)} />
          <Button key="p-gain" label={'\u{1F4C8} rtk gain'} onPress={() => runTool($, 'rtk gain', ['rtk', 'gain'])} />
          <Button
            key="p-discover"
            label={'\u{1F50D} rtk discover'}
            onPress={() => runTool($, 'rtk discover', ['rtk', 'discover'])}
          />
          <Button key="p-reset" label={'↺ Zerar'} onPress={resetStats} />
        </Box>
        {out ? (
          <Box flexDirection="column" borderStyle="round" borderColor={out.ok ? '#2f5f3a' : '#6b2b2b'} paddingX={1}>
            <Text bold color={out.ok ? GREEN : RED}>
              {out.title}
            </Text>
            <Markdown text={'```\n' + out.text + '\n```'} />
          </Box>
        ) : null}

        <Text bold>Onde os tokens foram</Text>
        {d.tools.length ? (
          <Svg source={toolBars(d.tools)} alt="Tokens estimados por tool" width={W} />
        ) : (
          <Text dimColor>Nenhuma chamada de tool ainda.</Text>
        )}

        {d.biggest.length ? (
          <Box flexDirection="column">
            <Text bold>Maiores saídas</Text>
            {d.biggest.map((b, i) => (
              <Box key={`big-${i}`} flexDirection="row" gap={1}>
                <Text bold color={b.tokens >= BIG_OUTPUT_TOKENS ? YELLOW : undefined}>
                  {fmtK(b.tokens).padStart(6)}
                </Text>
                <Text color={ORANGE}>{b.tool}</Text>
                <Text dimColor>{b.label}</Text>
              </Box>
            ))}
          </Box>
        ) : null}

        <Text bold>Dicas</Text>
        {d.tips.map((t, i) => (
          <Box
            key={`tip-${i}`}
            flexDirection="row"
            gap={1}
            borderStyle="round"
            borderColor={t.level === 'ok' ? '#2f5f3a' : t.level === 'warn' ? '#6b5320' : '#6b2b2b'}
            paddingX={1}
          >
            <Text color={t.level === 'ok' ? GREEN : t.level === 'warn' ? YELLOW : RED}>
              {t.level === 'ok' ? '✓' : t.level === 'warn' ? '!' : '✖'}
            </Text>
            <Text>{t.text}</Text>
          </Box>
        ))}
      </Box>
    )
  })

  // Barra acima do input.
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
          <Text dimColor> semana · /otimizar</Text>
        </Box>
      )
    }

    const { Box, Text, Svg, Button } = $.ui.resolve(e)
    const metric = (key: string, icon: string, alt: string, value: string, label: string) => (
      <Box key={key} flexDirection="row" alignItems="center" gap={1}>
        <Svg source={icon} alt={alt} width={16} height={16} />
        <Text bold>{value}</Text>
        <Text dimColor>{label}</Text>
      </Box>
    )

    const isOpen = await read($, expanded)
    const tn = await read($, turn)
    const fiveH = usage.rateLimits.find(l => l.kind === 'five_hour')
    const fivePct = fiveH ? Math.round(fiveH.percentUsed) : null
    const st = await read($, stats)
    const topTool = Object.entries(st.byTool).sort((a, b) => b[1].tokens - a[1].tokens)[0]
    const secs = Math.round(tn.lastMs / 1000)
    const rowW = Math.max(240, Math.round((e.props.bodyColumns ?? 90) * 7.6) - 70)
    const hitColor = c ? (c.hitPct >= 80 ? GREEN : c.hitPct >= 50 ? YELLOW : RED) : undefined
    const tiles: Tile[] = [
      { value: fivePct === null ? '—' : `${fivePct}%`, label: 'janela 5h', color: fivePct === null ? undefined : usedColor(fivePct) },
      { value: `${fmtK(usage.context.tokens ?? 0)} / ${fmtK(usage.context.window)}`, label: 'tokens no contexto' },
      { value: c ? `${c.hitPct}%` : '—', label: 'acerto do cache', color: hitColor },
      { value: tn.turns ? `${secs}s · ${fmtK(tn.lastOut)}` : '—', label: 'último turno' },
      { value: fmtK(tn.sessionOut), label: 'tokens gerados' },
      { value: usage.cost ? `$${usage.cost.usd.toFixed(2)}` : '—', label: 'custo da sessão' },
      ...(topTool
        ? [{ value: `${topTool[0].replace(/^mcp__.*__/, '')} ${fmtK(topTool[1].tokens)}`, label: 'maior gasto', color: ORANGE }]
        : []),
    ]

    return (
      <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row" alignItems="center" gap={2}>
        <Svg
          source={mascot(isBusy)}
          alt={isBusy ? 'Claude digitando' : 'Claude parado'}
          width={31}
          height={20}
          isInteractive
        />
        <Svg source={check(statusColor)} alt={status} width={14} height={14} />
        <Box flexDirection="row" alignItems="center" gap={3} flexGrow={1} flexWrap="wrap">
          {metric('q', badge(letter(s), scoreColor(s)), `nota ${letter(s)}`, String(s), 'qualidade')}
          {metric('ctx', ring(ctxPct, usedColor(ctxPct)), 'contexto', `${ctxPct}%`, 'contexto')}
          {metric('cache', ring(cachePct, cacheColor), 'cache', cacheText, 'cache')}
          {metric(
            'week',
            ring(weekPct ?? 0, weekPct === null ? '#555555' : usedColor(weekPct)),
            'semana',
            weekText,
            'semana',
          )}
          {issues.length ? <Text color={YELLOW}>{status}</Text> : null}
        </Box>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Button
            key="expand"
            label={isOpen ? '▴' : '▾'}
            plain
            onPress={() => update($, expanded, v => !v)}
          />
          <Button
            key="tools"
            label={'⚙'}
            plain
            onPress={async () => {
              await $.ui.open({ id: PANE, title: 'Token Optimizer' })
            }}
          />
        </Box>
      </Box>
      {isOpen ? (
        <Box paddingLeft={6} paddingTop={1}>
          <Svg source={tilesSvg(tiles, rowW)} alt={tiles.map(t => `${t.label} ${t.value}`).join(', ')} width={rowW} />
        </Box>
      ) : null}
      </Box>
    )
  })
}
