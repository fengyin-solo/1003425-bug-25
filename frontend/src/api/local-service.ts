import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveModules, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 扑火队伍撤回收尾时，要同步登记的值班处置台账所在模块（另一个入口：值勤排班页）。
const DUTY_LEDGER_MODULE = 'duty'
const WITHDRAW_ACTION = '撤回队伍'

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
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const closedStatuses = meta.closedStatuses ?? [meta.statuses[meta.statuses.length - 1]]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: !closedStatuses.includes(target),
    // 异常归属一旦落库就不再被后续动作抹掉：调岗、撤回、休整都只认先落库的状态，
    // 负向动作则继续把记录标成异常。
    abnormal:
      Boolean(rows[index].abnormal) || NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  try {
    if (key === 'fireteam' && action === WITHDRAW_ACTION) {
      // 撤回收尾：队伍状态与值班处置台账一次原子落库，要么都成、要么都回退。
      // 再次出动不写台账，重复撤回被上面的状态守卫拦下，所以一次收尾只落一条。
      const ledgerRows = listRows(DUTY_LEDGER_MODULE)
      const ledger = buildWithdrawalLedger(updated, ledgerRows)
      saveModules({ [key]: next, [DUTY_LEDGER_MODULE]: [...ledgerRows, ledger] })
    } else {
      saveRows(key, next)
    }
  } catch {
    return {
      ok: false,
      message: `${meta.entity}${action}保存失败，收尾页面、工作台和待办已回退到操作前状态`,
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 撤回收尾台账：异常归属随台账保留，所属林场按落库时的快照记，调岗后仍归原所属林场。
function buildWithdrawalLedger(team: EntryRow, ledgerRows: EntryRow[]): EntryRow {
  const id = ledgerRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const now = new Date()
  const hour = now.getHours()
  const shift = hour >= 8 && hour < 20 ? '白班 08:00-20:00' : '夜班 20:00-08:00'
  return {
    id,
    status: '待确认',
    pending: true,
    abnormal: Boolean(team.abnormal),
    排班编号: `DUTY-${String(id).padStart(4, '0')}`,
    值勤日期: now.toISOString().slice(0, 10),
    值勤时段: shift,
    值勤岗位: '扑火队伍撤回处置',
    值勤人员: String(team['队长姓名'] ?? ''),
    接班人员: '待安排',
    交接记录: `${String(team['队伍名称'] ?? '')}（${String(team['队伍编号'] ?? '')}）撤回收尾，异常归属：${String(team['所属林场'] ?? '')}`,
    排班状态: '待确认',
  }
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
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
