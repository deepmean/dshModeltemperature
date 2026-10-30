#!/usr/bin/env node
/**
 * 一次性修复脚本：补上 0.2.2-alpha.2 里 dsh-purge #42 漏掉的两个钩子。
 *
 * 背景：legacy settings API（ctx.settings.register）是 dsh-purge 加的，
 * 不是上游代码。0.2.2 的补丁只加了 register/get/commitLegacy/persistLegacy，
 * 却漏了让客户端表单能读到、写到这个命名空间的两处接线：
 *
 *   1. describe() 不返回 legacy 命名空间  → 设置页拿不到 value/revision
 *   2. mutate()  不路由到 commitLegacy    → 设置页的写入落进 write()，
 *                                            而 write() 只认 configEditor 里的
 *                                            可配置条目，直接抛
 *                                            "No configurable plugin entry"
 *
 * alpha.5 时代这两处是有的，这次补丁退化了。
 *
 * 脚本是幂等的：已经补过就什么都不做。
 */
import fs from 'node:fs'

const FILE = process.argv[2]
if (!FILE) {
  console.error('用法: node patch-legacy-hooks.mjs <dsh-settings/lib/index.js>')
  process.exit(2)
}

let text = fs.readFileSync(FILE, 'utf8')
const T = (s) => s.replace(/ {2}/g, '\t') // 用制表符拼锚点，匹配源文件缩进

if (text.includes('legacyDescriptors()')) {
  console.log('已经补过，跳过')
  process.exit(0)
}

// ── 1. describe() 之前插入 legacyDescriptors()，并把 return 改成合并 ──
const DESCRIBE_ANCHOR = T('  describe(options) {')
if (!text.includes(DESCRIBE_ANCHOR)) {
  console.error('锚点未命中: describe(options)')
  process.exit(1)
}

const METHOD = [
  T('  /** Descriptors for namespaces registered through the legacy settings API. */'),
  T('  legacyDescriptors() {'),
  T('    const rows = [];'),
  T('    for (const registration of this.legacyRegistrations?.values() ?? []) {'),
  T('      const schema = registration.schema;'),
  T('      const form = typeof schema?.toJSON === "function" ? schema.toJSON() : {};'),
  T('      rows.push({'),
  T('        autoGenerate: false,'),
  T('        ns: registration.ns,'),
  T('        schema: form,'),
  T('        revision: registration.revision,'),
  T('        applies: registration.applies ?? "live",'),
  T('        value: registration.resolved,'),
  T('        base: {},'),
  T('        user: registration.user ?? {}'),
  T('      });'),
  T('    }'),
  T('    return rows;'),
  T('  }'),
  '',
].join('\n')

text = text.replace(DESCRIBE_ANCHOR, METHOD + DESCRIBE_ANCHOR)

// return descriptors; → 合并 legacy
const RET = T('    return descriptors;')
if (!text.includes(RET)) {
  console.error('锚点未命中: return descriptors;')
  process.exit(1)
}
text = text.replace(RET, T('    return [...descriptors, ...this.legacyDescriptors(options)];'))

// ── 2. mutate() 路由到 commitLegacy ──
const MUTATE_ANCHOR = T('  async mutate(ns, ops, expectedRevision) {')
if (!text.includes(MUTATE_ANCHOR)) {
  console.error('锚点未命中: async mutate(ns, ops, expectedRevision)')
  process.exit(1)
}

const ROUTE = [
  MUTATE_ANCHOR,
  T('    if (this.legacyRegistrations?.has(ns)) return this.commitLegacy(ns, (user) => (ops ?? []).reduce((value, op) => applyPathOp(value, op), user ?? {}), expectedRevision);'),
].join('\n')

text = text.replace(MUTATE_ANCHOR, ROUTE)

fs.writeFileSync(FILE, text, 'utf8')
console.log('已补上 legacyDescriptors() 与 mutate() 路由')
