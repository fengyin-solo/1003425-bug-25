import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveModules } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 撤回收尾的联动落账：扑火队伍撤回时，往值勤排班（另一个入口的值班处置台账）补一条处置记录。
// key 是「模块:动作」，只登记确实需要跨模块落账的流转。
const DISPOSITION_LEDGER: Record<string, { module: string; post: string }> = {
  'fireteam:撤回队伍': { module: 'duty', post: '值班处置' },
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// 撤回收尾生成的值班处置台账记录：归属沿用源头记录上已落库的盖章。
function buildDispositionRow(
  sourceMeta: ModuleMeta,
  source: EntryRow,
  ledger: { module: string; post: string },
  ticket: string,
  existing: EntryRow[],
): EntryRow {
  const ledgerMeta = moduleMeta(ledger.module)
  const id = nextId(existing)
  const attribution = String(source.异常归属 ?? '')
  const today = new Date()
  return {
    id,
    status: ledgerMeta.statuses[0],
    pending: true,
    abnormal: Boolean(source.abnormal),
    处置单号: ticket,
    排班编号: `DUTY-${String(id).padStart(4, '0')}`,
    值勤日期: today.toISOString().slice(0, 10),
    值勤时段: today.toTimeString().slice(0, 5),
    值勤岗位: ledger.post,
    值勤人员: '值班管理员',
    接班人员: '',
    交接记录: `${sourceMeta.entity}「${source[sourceMeta.fields[1]] ?? source.id}」(${source[sourceMeta.fields[0]] ?? ''})撤回收尾，异常归属：${attribution || '无'}`,
    排班状态: '撤回处置',
    异常归属: attribution,
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const source = rows[index]
  const current = String(source.status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  // 异常归属冲突时以先落库状态为准：已落库的异常标记不被撤回等后续动作冲掉，只能在其上新增。
  const abnormal = Boolean(source.abnormal) || NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))
  const updated: EntryRow = {
    ...source,
    status: target,
    pending: target !== lastStatus,
    abnormal,
  }
  // 首次进入异常态时按归属字段盖章；已盖章的不再改写——调岗（归属字段变更）后仍归原所属林场。
  if (abnormal && meta.ownerField && !updated.异常归属) {
    updated.异常归属 = String(source[meta.ownerField] ?? '')
  }
  const next = [...rows]
  next[index] = updated
  const writes: Record<string, EntryRow[]> = { [key]: next }

  // 联动落账：同一来源单号只落一条待处置记录，再次出动与撤回并发时不会重复登记。
  const ledger = DISPOSITION_LEDGER[`${key}:${action}`]
  if (ledger) {
    const ledgerRows = listRows(ledger.module)
    const ticket = `${key}:${id}:${ledger.post}`
    const ledgerMeta = moduleMeta(ledger.module)
    const open = ledgerRows.some((row) => row.处置单号 === ticket && row.status === ledgerMeta.statuses[0])
    if (!open) {
      writes[ledger.module] = [...ledgerRows, buildDispositionRow(meta, updated, ledger, ticket, ledgerRows)]
    }
  }

  // 原子落库：任一模块写失败，缓存保持原样，收尾页面、工作台和待办同时回退。
  try {
    saveModules(writes)
  } catch {
    return { ok: false, message: `${meta.entity}${action}保存失败，收尾页面、工作台与待办已回退` }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  // 异常归属汇总：只统计登记了归属字段的模块；归属以首次落库的盖章为准，
  // 历史数据没盖章的回退到当前归属字段值，保证汇总不丢归属。
  const exceptions = [...MODULE_BY_KEY.values()].flatMap((meta) => {
    const ownerField = meta.ownerField
    if (!ownerField) {
      return []
    }
    const counts = new Map<string, number>()
    for (const row of rows[meta.key] ?? []) {
      if (!row.abnormal) {
        continue
      }
      const owner = String(row.异常归属 ?? row[ownerField] ?? '') || '未归属'
      counts.set(owner, (counts.get(owner) ?? 0) + 1)
    }
    return [...counts.entries()].map(([owner, count]) => ({ module: meta.name, owner, count }))
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules, exceptions }
}
