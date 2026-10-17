#!/usr/bin/env node
/**
 * modelConfig / dsh-per-model-temperature / scripts/check-compat.mjs
 *
 * 兼容性哨兵：**每次更新 dsh 之后先跑这个**。
 *
 * 为什么需要它：本插件站在一条上游并不保证的缝上 —— 老式 settings API
 * （`ctx.settings.register()`）。dsh 0.2.1-alpha.5 起，上游的 `dsh-settings`
 * 只剩新式表单模型（插件的 volatile Config），**`register()` 是 `dsh-purge`
 * 的 #42 号补丁 `SETTINGS_LEGACY_API` 加回来的**。
 *
 * 于是就有了这个失败模式：`dsh update` 覆盖 `node_modules` 里的文件 →
 * 补丁被冲掉 → 插件的 `apply()` 第一句 `ctx.settings.register(...)` 抛
 * TypeError → 服务端监听器没挂上、设置页也没有数据源，表现为「插件失效」。
 * 而且它**不报错、不崩溃、没有日志**，只看得到功能没了。
 *
 * 这个脚本把那条缝上的每个假设都变成一条断言。任一条红，就是 dsh 又动了。
 *
 * 用法：
 *   node scripts/check-compat.mjs
 *   node scripts/check-compat.mjs --json
 * 退出码：0 全部兼容；1 有断裂（会指出该做什么）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
/** `DSH_PROFILE` 是 profile 名字（如 `web`）；绝对路径在 `DSH_PROFILE_DIR`。 */
function resolveProfileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  const name = process.env.DSH_PROFILE
  if (name) return path.isAbsolute(name) ? name : path.join(HOME, 'profiles', name)
  return path.join(HOME, 'profiles', 'web')
}
const PROFILE = resolveProfileDir()
const JSON_OUT = process.argv.includes('--json')

const rows = []
function check(label, ok, detail = '', fix = '') {
  rows.push({ label, ok: ok === true, detail, fix })
}

/**
 * 定位 dsh 安装根。
 *
 * 注意：`@deepseek-ai/dsh-settings`、`dsh-agent-loop` 这些子包**嵌在 dsh 自己的
 * `node_modules` 里**，从顶层或本进程解析都找不到；必须先拿到
 * `@deepseek-ai/dsh/package.json`，再从它往下解析。
 */
function resolveDshRoot() {
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
const DSH_ROOT = resolveDshRoot()
const dshRequire = DSH_ROOT === null ? null : createRequire(DSH_ROOT)
/** 从 dsh 根解析一个包（或子路径）。 */
function dshResolve(spec) {
  if (dshRequire === null) return null
  try {
    return dshRequire.resolve(spec)
  } catch {
    return null
  }
}

const FIX_PURGE = '重新打 dsh-purge 补丁（purge_apply / #42 SETTINGS_LEGACY_API），然后重启 dsh。'
const FIX_RESTART = '重启 dsh —— 补丁改了磁盘文件，但运行中的进程还持有旧模块。'

// ─────────────────────────────────────────────────────────────
// 1. dsh 版本
// ─────────────────────────────────────────────────────────────
let dshPkg = null
try {
  if (DSH_ROOT !== null) dshPkg = JSON.parse(fs.readFileSync(DSH_ROOT, 'utf8'))
} catch { /* 下面报 */ }
check('找得到 @deepseek-ai/dsh', dshPkg !== null, dshPkg === null ? '解析失败' : `v${dshPkg.version}`)

// ─────────────────────────────────────────────────────────────
// 2. 老式 settings API —— 本次失效的根因
//    直接 import 真模块看方法在不在，不靠文本匹配
// ─────────────────────────────────────────────────────────────
let settingsMod = null
let settingsFile = null
try {
  settingsFile = dshResolve('@deepseek-ai/dsh-settings')
  if (settingsFile !== null) settingsMod = await import(pathToFileURL(settingsFile).href)
} catch (error) {
  check('载入 dsh-settings', false, error.message)
}
check('载入 dsh-settings', settingsMod !== null, settingsFile ?? '解析失败')

if (settingsMod !== null) {
  const Forms = settingsMod.default ?? settingsMod.SettingsForms
  const proto = Forms?.prototype ?? {}
  check('dsh-settings 导出 SettingsForms', typeof Forms === 'function')
  check(
    'ctx.settings.register() 存在（插件靠它注册命名空间）',
    typeof proto.register === 'function',
    typeof proto.register === 'function' ? '' : '老式 settings API 不见了 —— 上游 0.2.1-alpha.5 起不再自带',
    FIX_PURGE,
  )
  check(
    'describe() 会把 legacy 命名空间喂给客户端表单',
    typeof proto.describe === 'function' && /legacyRegistrations/.test(String(proto.describe)),
    '',
    FIX_PURGE,
  )
  check(
    'mutate() 会把 legacy 命名空间的写入路由到 commitLegacy',
    typeof proto.mutate === 'function' && /legacyRegistrations/.test(String(proto.mutate)),
    '',
    FIX_PURGE,
  )
}

// ─────────────────────────────────────────────────────────────
// 3. 注入缝：agent/request waterfall
// ─────────────────────────────────────────────────────────────
function readDshFile(pkgName) {
  const p = dshResolve(`${pkgName}/package.json`)
  if (p === null) return null
  const lib = path.join(path.dirname(p), 'lib', 'index.js')
  return fs.existsSync(lib) ? fs.readFileSync(lib, 'utf8') : null
}

const agentLoop = readDshFile('@deepseek-ai/dsh-agent-loop')
check('读得到 dsh-agent-loop', agentLoop !== null)
if (agentLoop !== null) {
  check(
    'agent loop 仍然派发 agent/request waterfall',
    agentLoop.includes('"agent/request"'),
    '',
    '上游改了注入缝，插件需要跟着改。',
  )
  check(
    '提案 seed 仍带 provider / model 两个键',
    /structuredClone\(this\.requestHeaderLogged/.test(agentLoop) || /provider:/.test(agentLoop),
  )
}

// ─────────────────────────────────────────────────────────────
// 4. temperature 能否活着走到 adapter
// ─────────────────────────────────────────────────────────────
const llm = readDshFile('@deepseek-ai/dsh-llm')
check('读得到 dsh-llm', llm !== null)
if (llm !== null) {
  check(
    'LlmCallConfig 仍认识 temperature（callConfigEquals 里比较了它）',
    /a\.temperature\s*!==\s*b\.temperature/.test(llm),
    '',
    '上游删了 temperature 字段，插件没有缝可用了。',
  )
  check(
    'resolveCallWithInfo 不会把 temperature 裁掉（用展开而非重建）',
    /resolveCallWithInfo\(config, info\)/.test(llm) && /\{\s*\.\.\.config,/.test(llm),
    '',
    '上游开始重建 config，注入的字段会被丢弃。',
  )
}

const piAi = readDshFile('@deepseek-ai/dsh-llm-pi-ai')
check('读得到 dsh-llm-pi-ai', piAi !== null)
if (piAi !== null) {
  check(
    'pi-ai 转发层仍把 options.temperature 放进请求体',
    /options\.temperature === void 0 \? \{\} : \{ temperature: options\.temperature \}/.test(piAi),
    '',
    '转发层不再透传 temperature，插件注入的值到不了线上。',
  )
}

// ─────────────────────────────────────────────────────────────
// 5. 设置数据还在不在
// ─────────────────────────────────────────────────────────────
const settingsYaml = path.join(HOME, 'settings-legacy.yaml')
let entries = 0
if (fs.existsSync(settingsYaml)) {
  const text = fs.readFileSync(settingsYaml, 'utf8')
  entries = (text.match(/^\s*-\s*provider:/gm) ?? []).length
}
check('settings-legacy.yaml 存在且有条目', entries > 0, `${entries} 条`, '在设置页里重新添加记录。')

// ─────────────────────────────────────────────────────────────
// 6. 插件自身声明与磁盘副本是否一致
// ─────────────────────────────────────────────────────────────
const INSTALLED = path.join(PROFILE, 'node_modules', 'dsh-per-model-temperature')
for (const f of ['index.js', 'client.js', 'package.json', 'cordis.patch.yml']) {
  const src = path.join(here, '..', f)
  const dst = path.join(INSTALLED, f)
  const same = fs.existsSync(src) && fs.existsSync(dst)
    && fs.readFileSync(src).equals(fs.readFileSync(dst))
  check(`已安装副本与源码一致：${f}`, same, same ? '' : '副本是旧的', '把文件复制进 profile 的 node_modules，然后重启 dsh。')
}

// ─────────────────────────────────────────────────────────────
// 7. 运行中的 dsh 是否晚于补丁时间（补丁改了盘，进程要重启才吃得到）
// ─────────────────────────────────────────────────────────────
if (settingsFile !== null) {
  const patchedAt = fs.statSync(settingsFile).mtimeMs
  let startedAt = null
  try {
    const running = path.join(HOME, 'dsh-config-manager', 'running', 'web.json')
    if (fs.existsSync(running)) startedAt = Date.parse(JSON.parse(fs.readFileSync(running, 'utf8')).startedAt)
  } catch { /* 拿不到就算了 */ }
  if (startedAt === null || Number.isNaN(startedAt)) {
    check('读得到运行实例的启动时间', false, '跳过「是否晚于补丁」这一条')
  } else {
    check(
      '运行中的 dsh 启动于补丁之后（否则进程里还是旧模块）',
      startedAt > patchedAt,
      `进程 ${new Date(startedAt).toLocaleString('zh-CN')}  /  补丁 ${new Date(patchedAt).toLocaleString('zh-CN')}`,
      FIX_RESTART,
    )
  }
}

// ─────────────────────────────────────────────────────────────
if (JSON_OUT) {
  console.log(JSON.stringify({ dsh: dshPkg?.version ?? null, rows }, null, 2))
} else {
  console.log(`dsh 版本: ${dshPkg?.version ?? '(未知)'}\n`)
  for (const row of rows) {
    console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.label}${row.detail === '' ? '' : `  [${row.detail}]`}`)
  }
  const failed = rows.filter((r) => !r.ok)
  if (failed.length > 0) {
    console.log('\n要做的：')
    for (const row of failed) console.log(`  · ${row.label}\n    → ${row.fix === '' ? '见上' : row.fix}`)
  }
}
const bad = rows.filter((r) => !r.ok).length
console.log(`\n${rows.length - bad} passed, ${bad} failed`)
process.exit(bad === 0 ? 0 : 1)
