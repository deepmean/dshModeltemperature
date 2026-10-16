#!/usr/bin/env node
/**
 * modelConfig / scripts/probe-live-record.mjs
 *
 * 端到端证明：**磁盘上那条真实记录**会不会变成发出去的 temperature。
 *
 * 和 probe-apply-temperature.mjs 的分工：
 *   - 那个探针证明 `applyTemperature()` 这个函数对不对（喂进去的记录是命令行给的）；
 *   - 这个探针证明 **记录本身活着** —— 从真实的 settings-legacy.yaml 读起，
 *     走 harness 真实的解析/校验路径，最后落到 agent/request 的 listener 上。
 *
 * 真实链路（逐行对着 dsh-settings/lib/index.js 抄的，不是猜的）：
 *
 *   ensureLegacyDocument()            L418-438
 *     path = join(profile.home, 'settings-legacy.yaml')
 *     doc  = parse(readFileSync(path, 'utf8'))
 *
 *   register(ns, schema, options)     L371-390
 *     stored   = doc[ns]
 *     user     = isPlainObject(stored) ? stored : undefined
 *     resolved = plainConfig(schema(mergeLayers(options?.base ?? {}, user ?? {})))
 *     return { get: () => resolved }        <-- scope.get()
 *
 *   插件 listener                      dsh-per-model-temperature/index.js L94-97
 *     applyTemperature(scope.get().entries, config)
 *
 * 唯一没有原样 import 的是 `mergeLayers`（模块私有）。这里按 L281-291 原样抄了一份，
 * 并断言 `mergeLayers({}, stored)` 与 `stored` 深等 —— 对 `base === undefined`
 * 这个真实输入，抄件与被抄件等价，所以结论不依赖抄得准不准。
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
/**
 * 注意：harness 的 `DSH_PROFILE` 是 profile 的**名字**（例如 `web`），不是路径；
 * 绝对路径在 `DSH_PROFILE_DIR`。两个都接受，裸名字按 $DSH_HOME/profiles/<name> 展开。
 */
function resolveProfileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  const name = process.env.DSH_PROFILE
  if (name) return path.isAbsolute(name) ? name : path.join(HOME, 'profiles', name)
  return path.join(HOME, 'profiles', 'web')
}
const PROFILE = resolveProfileDir()
const SETTINGS = path.join(HOME, 'settings-legacy.yaml')
const NS = 'per-model-temperature'
const INSTALLED = path.join(PROFILE, 'node_modules', 'dsh-per-model-temperature', 'index.js')
const SOURCE = path.join(here, '..', 'index.js')

/**
 * `yaml` 要拿 dsh 自己依赖树里的那一份（同一个解析器，语义才对得上）。
 * 依次尝试：DSH_PACKAGE 环境变量 → profile → 全局 dsh → 本进程解析器。
 */
function resolveDshPackage() {
  const bases = []
  if (process.env.DSH_PACKAGE) bases.push(process.env.DSH_PACKAGE)
  bases.push(path.join(PROFILE, 'package.json'), process.execPath)
  for (const base of bases) {
    if (base !== process.execPath && !fs.existsSync(base)) continue
    try {
      return createRequire(base).resolve('@deepseek-ai/dsh/package.json')
    } catch { /* 试下一个 */ }
  }
  return null
}

let pass = 0
let fail = 0
function check(label, ok, extra = '') {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${extra === '' ? '' : '  ' + extra}`) }
}

// ---------------------------------------------------------------- 真实 yaml
const dshPkg = resolveDshPackage()
if (dshPkg === null) {
  console.log('FAIL  找不到 @deepseek-ai/dsh；可用 DSH_PACKAGE 指定它的 package.json')
  process.exit(1)
}
const dshRequire = createRequire(dshPkg)
let parse = null
try {
  const yamlEntry = dshRequire.resolve('yaml')
  ;({ parse } = await import(pathToFileURL(yamlEntry).href))
} catch (error) {
  console.log(`FAIL  从 dsh 安装目录解析 yaml: ${error.message}`)
  process.exit(1)
}
check('拿到 harness 自己用的 yaml 解析器', typeof parse === 'function')

// ---------------------------------------------------------------- 真实插件模块
const target = fs.existsSync(INSTALLED) ? INSTALLED : SOURCE
const origin = target === INSTALLED ? '已安装副本' : '源码目录'
const raw = fs.readFileSync(target, 'utf8')
let entry = target
let scratch = null
if (!fs.existsSync(path.join(path.dirname(target), 'node_modules')) && /@deepseek-ai\/schemastery/.test(raw)) {
  const profileRequire = createRequire(path.join(PROFILE, 'package.json'))
  const resolved = profileRequire.resolve('@deepseek-ai/schemastery')
  scratch = path.join(os.tmpdir(), `pmt-live-${process.pid}.mjs`)
  fs.writeFileSync(
    scratch,
    raw.replace(/(['"])@deepseek-ai\/schemastery\1/, JSON.stringify(pathToFileURL(resolved).href)),
    'utf8',
  )
  entry = scratch
}

let mod = null
try {
  mod = await import(pathToFileURL(entry).href)
} catch (error) {
  console.log(`FAIL  载入 ${target}: ${error.message}`)
  if (scratch !== null) fs.rmSync(scratch, { force: true })
  process.exit(1)
}
check('插件导出 applyTemperature()', typeof mod.applyTemperature === 'function')
check('插件导出 settingsSchema（真实 schema，不是复刻）', typeof mod.settingsSchema === 'function')

// ---------------------------------------------------------------- 第 1 步：读盘
check('settings-legacy.yaml 存在', fs.existsSync(SETTINGS), SETTINGS)
if (!fs.existsSync(SETTINGS)) process.exit(1)
const fileStat = fs.statSync(SETTINGS)
const doc = parse(fs.readFileSync(SETTINGS, 'utf8'))
console.log(`\n文件: ${SETTINGS}`)
console.log(`mtime: ${fileStat.mtime.toISOString()}   bytes: ${fileStat.size}`)
console.log(`文档顶层键: ${Object.keys(doc ?? {}).join(', ') || '(空)'}\n`)

check(`文档里有 ${NS} 这一段`, doc !== null && typeof doc === 'object' && doc[NS] !== undefined)

// ---------------------------------------------------------------- 第 2 步：抄 mergeLayers + 校验
/** dsh-settings/lib/index.js L281-291 原样抄写。 */
function mergeLayers(under, over) {
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged = { ...under }
  for (const [key, value] of Object.entries(over)) {
    Object.defineProperty(merged, key, {
      value: Object.hasOwn(merged, key) ? mergeLayers(merged[key], value) : value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return merged
}
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const stored = doc[NS]
const user = isPlainObject(stored) ? stored : undefined
check('这一段是 plain object（否则 harness 会当成没配置）', user !== undefined)

// base 未声明 -> options?.base ?? {} -> {}；此时 mergeLayers 只是浅拷贝
const merged = mergeLayers({}, user ?? {})
check(
  'mergeLayers({}, user) 与 user 深等（抄件对真实输入等价）',
  JSON.stringify(merged) === JSON.stringify(user),
  `${JSON.stringify(merged)} vs ${JSON.stringify(user)}`,
)

let resolved = null
try {
  resolved = mod.settingsSchema(merged)
} catch (error) {
  console.log(`FAIL  settingsSchema 拒绝了盘上的记录: ${error.message}`)
  process.exit(1)
}
const resolvedEntries = Array.isArray(resolved?.entries) ? resolved.entries : []
console.log(`校验后 scope.get().entries = ${JSON.stringify(resolvedEntries)}\n`)
check('校验后 entries 不为空（记录没被丢掉）', resolvedEntries.length > 0, JSON.stringify(resolvedEntries))

// schema 真的在起作用吗？越界值必须过不去，否则上面那条断言是空的。
let rejected = false
try {
  const bad = mod.settingsSchema({ entries: [{ provider: 'p', model: 'm', temperature: 3 }] })
  rejected = !(Array.isArray(bad?.entries) && bad.entries.some((e) => e?.temperature === 3))
} catch { rejected = true }
check('对照：temperature=3 被 schema 拦下（证明校验不是空转）', rejected)

// ---------------------------------------------------------------- 第 3 步：真实 listener
let storedEntries = []
let listener = null
const ctx = {
  settings: { register: () => ({ get: () => ({ entries: storedEntries }), watch: () => () => {} }) },
  on: (event, fn) => { if (event === 'agent/request') listener = fn; return () => {} },
  effect: (fn) => { if (typeof fn === 'function') fn() },
  logger: { warn: () => {}, info: () => {} },
}
mod.apply(ctx)
check('apply() 挂上了 agent/request 监听', typeof listener === 'function')

async function run(entries, config) {
  storedEntries = entries
  const frozen = Object.freeze({ ...config })
  return await listener({ turn: 1, step: 1, signal: undefined }, async () => frozen)
}

// ---------------------------------------------------------------- 第 4 步：断言线上行为
const record = resolvedEntries[0]
check('盘上那条记录就是 wbproxy-intl / deepseek-v4.1-flash', record?.provider === 'wbproxy-intl' && record?.model === 'deepseek-v4.1-flash', JSON.stringify(record))

const seed = { provider: 'wbproxy-intl', model: 'deepseek-v4.1-flash', reasoningEffort: 'max', maxTokens: 4096 }
const out = await run(resolvedEntries, seed)
check(
  '端到端：真实记录的 temperature 出现在 proposal 上',
  out.temperature === record.temperature,
  `proposal.temperature=${JSON.stringify(out.temperature)}  配置=${JSON.stringify(record.temperature)}`,
)
check('端到端：其余字段原样保留', out.provider === seed.provider && out.model === seed.model && out.reasoningEffort === 'max')
check('端到端：配置值 ≠ 上游默认 1', out.temperature !== 1, `实际 ${JSON.stringify(out.temperature)}`)

const other = await run(resolvedEntries, { provider: 'wbproxy-intl', model: 'hy3' })
check('端到端：同路由其它模型不受影响', other.temperature === undefined, JSON.stringify(other.temperature))

if (scratch !== null) fs.rmSync(scratch, { force: true })
console.log(`\n来源: ${origin}\n文件: ${target}`)
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
