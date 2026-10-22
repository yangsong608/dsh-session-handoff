/**
 * 提示词组装：与服务端 `composePrompt` 逐字一致。
 *
 * 之所以在浏览器半复制一份：预览卡允许用户取消勾选参考文件后**立即**重建提示词，
 * 不必再往返宿主；一致性由 parity 测试保证（同一 PromptParts 下与服务端输出逐字相等）。
 *
 * @module dsh-session-handoff/client/compose
 */

import type { PromptParts } from './types.ts'

/** 由结构化分段组装提示词；references 为空数组时不渲染「参考文件」小节。 */
export function composePrompt(parts: PromptParts, references: readonly string[] = parts.references): string {
  const lines: string[] = []
  lines.push(`# 会话接力：${parts.title}`)
  lines.push('')
  lines.push(`上一会话（\`${parts.sessionId}\`）已完成一轮工作，下面是它的交接材料。`)
  lines.push('')
  lines.push('## 先读这两份文件')
  lines.push(`- 交接文档（必读）：\`${parts.docPath}\``)
  lines.push(`- 结构化数据：\`${parts.dataPath}\``)
  lines.push('')
  lines.push('## 一句话状态')
  lines.push(parts.summary)
  lines.push('')
  lines.push('## 目标')
  lines.push(parts.goal)
  lines.push('')
  if (parts.completed.length > 0) {
    lines.push('## 已完成')
    for (const item of parts.completed) lines.push(`- ${item}`)
    lines.push('')
  }
  if (parts.nextSteps.length > 0) {
    lines.push('## 下一步')
    parts.nextSteps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step.step}${step.why !== '' ? ` —— ${step.why}` : ''}`)
    })
    lines.push('')
  }
  if (parts.blockers.length > 0) {
    lines.push('## 阻塞与风险')
    for (const blocker of parts.blockers) lines.push(`- ${blocker}`)
    lines.push('')
  }
  if (references.length > 0) {
    lines.push('## 参考文件')
    for (const file of references) lines.push(`- \`${file}\``)
    lines.push('')
  }
  lines.push('## 交接要求')
  parts.requirements.forEach((requirement, index) => lines.push(`${index + 1}. ${requirement}`))
  return lines.join('\n')
}
