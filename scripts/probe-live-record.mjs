#!/usr/bin/env node
/**
 * modelConfig / dsh-per-model-temperature / scripts/probe-live-record.mjs
 *
 * 端到端：读**真实的、迁移之后的**配置，逐条验证温度会被注入。
 *
 * 配置位置随架构变过：以前是 `~/.dsh/settings-legacy.yaml`（legacy settings
 * API 的私有文件），现在是 profile 的 `cordis.patch.yml` 里
 * `per-model-temperature` 条目的 config —— 和所有其它插件一样，由 dsh 原生
 * 的 configEditor 管理。
 *
 * 这个脚本直接读那份真实文件，所以能回答"我配的那几条到底生效了吗"。
 *
 * 用法：node scripts/probe-live-record.mjs
 * 退出码：0 全通过；1 有失败。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
function resolveProfileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  const name = process.env.DSH_PROFILE
  if (name) return path.isAbsolute(name) ? name : path.join(HOME, 'profiles', name)
  return path.join(HOME, 'profiles', 'web')
}
const PROFILE = resolveProfileDir()
const PATCH = path.join(PROFILE, 'cordis.patch.yml')
const INSTALLED = path.join(PROFILE, 'node_modules', 'dsh-per-model-temperature', 'index.js')
const SOURCE = path.join(here, '..', 'index.js')
const ENTRY_ID = 'per-model-temperature'

let pass = 0
let fail = 0
function check(label, ok, extra = '') {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${extra === '' ? '' : '  ' + extra}`) }
}

// yaml 用 dsh 自己依赖树里的那份，语义才对得上
function resolveDshRoot() {
  const bases = [process.env.DSH_PACKAGE, path.join(PROFILE, 'package.json'), process.execPath].filter(Boolean)
  for (const base of bases) {
    if (base !== process.execPath && !fs.existsSync(base)) continue
    try { return createRequire(base).resolve('@deepseek-ai/dsh/package.json') } catch { /* 下一个 */ }
  }
  return null
}
const DSH_ROOT = resolveDshRoot()
const { parse } = await import(pathToFileURL(createRequire(DSH_ROOT).resolve('yaml')).href)

const mod = await import(pathToFileURL(fs.existsSync(INSTALLED) ? INSTALLED : SOURCE).href)
check('插件导出 applyTemperature()', typeof mod.applyTemperature === 'function')

// ── 读真实配置 ───────────────────────────────────────────────────
check('profile 补丁存在', fs.existsSync(PATCH), PATCH)
if (!fs.existsSync(PATCH)) process.exit(1)

const document = parse(fs.readFileSync(PATCH, 'utf8'))
/** 补丁是行的数组；找我们这一条。 */
const rows = Array.isArray(document) ? document : []
const row = rows.find((item) => item !== null && typeof item === 'object' && item.id === ENTRY_ID)
check(`补丁里有 ${ENTRY_ID} 条目`, row !== undefined, row === undefined ? '没有这个条目' : '')

const config = row?.config ?? {}
const entries = Array.isArray(config.entries) ? config.entries : []
const routes = Array.isArray(config.routes) ? config.routes : []
const models = Array.isArray(config.models) ? config.models : []

console.log(`\n文件: ${PATCH}`)
console.log(`条目: ${ENTRY_ID}`)
console.log(`记录: ${entries.length} 条 / 路由 ${routes.length} 个 / 模型 ${models.length} 条\n`)
for (const entry of entries) {
  console.log(`  · ${entry.provider} / ${entry.model} / ${entry.temperature ?? '(不下发)'}`)
}
console.log('')

check('配置里有记录', entries.length > 0, `${entries.length} 条`)

// ── 逐条验证注入 ─────────────────────────────────────────────────
for (const entry of entries) {
  const seed = Object.freeze({
    provider: entry.provider,
    model: entry.model,
    reasoningEffort: 'max',
    maxTokens: 4096,
  })
  const out = mod.applyTemperature(entries, seed)
  const expect = typeof entry.temperature === 'number' ? entry.temperature : undefined
  check(
    `${entry.provider} / ${entry.model} → ${JSON.stringify(out.temperature)}`,
    out.temperature === expect,
    `期望 ${JSON.stringify(expect)}`,
  )
}

// 反例：没配的模型不许被污染
{
  const absent = { provider: '__no_such_provider__', model: '__no_such_model__' }
  const out = mod.applyTemperature(entries, absent)
  check('未配置的 provider+model 不被注入', out.temperature === undefined, JSON.stringify(out.temperature))
}

// 反例：同 provider 不同 model
if (entries.length > 0) {
  const first = entries[0]
  const out = mod.applyTemperature(entries, { provider: first.provider, model: `${first.model}-other` })
  check('同 provider 不同 model 不被注入', out.temperature === undefined, JSON.stringify(out.temperature))
}

// 目录发布结果要能支撑下拉
check('已发布运行时路由（页面下拉的数据源）', routes.length > 0, `${routes.length} 个`)
check('已发布模型目录', models.length > 0, `${models.length} 条`)
check(
  '模型条目带 route/model 两个字段',
  models.every((m) => typeof m?.route === 'string' && typeof m?.model === 'string'),
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
