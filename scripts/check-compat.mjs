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
// 2. 原生契约 —— 插件不依赖任何 dsh-purge 补丁
//
//    这里原来检查「legacy settings API 在不在」。插件迁到原生 volatile
//    Config 之后，那些断言全部失效：它们测的是我们已经不再使用的东西。
//    现在的契约是下面这些 —— 任何一条红，插件就跑不起来。
// ─────────────────────────────────────────────────────────────
const PLUGIN_ENTRY = path.join(PROFILE, 'node_modules', 'dsh-per-model-temperature', 'index.js')
const pluginSource = fs.existsSync(PLUGIN_ENTRY) ? fs.readFileSync(PLUGIN_ENTRY, 'utf8') : ''
// 注释要剥掉：文件顶部专门解释了「为什么不再用 ctx.settings.register」，
// 裸文本匹配会把那段说明当成调用。
const pluginCode = pluginSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

check(
  '插件不调用 ctx.settings.register（= 不再依赖 dsh-purge 补丁）',
  pluginSource !== '' && !/settings\.register\s*\(/.test(pluginCode),
  pluginSource === '' ? '读不到插件源码' : '',
  '插件必须只用原生能力；再出现 register 就是把非上游 API 又请回来了。',
)
check(
  '插件不 inject settings',
  pluginSource !== '' && !/inject\s*=\s*\[[^\]]*['"]settings['"]/.test(pluginCode),
  '',
  '原生方案不需要 settings 服务。',
)

/**
 * UTF-8 BOM guard.
 *
 * A BOM at the head of package.json makes dsh skip the whole plugin with
 * "SyntaxError: Unexpected token ... is not valid JSON" — and it is easy to
 * introduce: Windows PowerShell `Set-Content -Encoding UTF8` writes one.
 * That failure is loud in the boot log but invisible on the settings page,
 * so it belongs here rather than in a postmortem.
 */
for (const file of ["package.json", "index.js", "client.js", "cordis.patch.yml"]) {
  const full = path.join(PROFILE, "node_modules", "dsh-per-model-temperature", file)
  if (!fs.existsSync(full)) {
    check(`${file} 存在`, false)
    continue
  }
  const head = fs.readFileSync(full).subarray(0, 3)
  const hasBom = head.length === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
  check(
    `${file} 没有 UTF-8 BOM`,
    !hasBom,
    hasBom ? "文件以 BOM 开头，dsh 会把整个插件跳过" : "",
    "用无 BOM 的 UTF-8 重写该文件（[System.IO.File]::WriteAllText 配 UTF8Encoding 的无 BOM 实例）。",
  )
}
// 原生 Config：三个字段都必须 volatile，否则设置页读不到、也写不进。
let pluginMod = null
try {
  pluginMod = await import(pathToFileURL(PLUGIN_ENTRY).href)
} catch (error) {
  check('从安装位 import 插件', false, error.message)
}
if (pluginMod !== null) {
  check('插件导出 Config', typeof pluginMod.Config === 'function')
  const configFields = pluginMod.Config?.dict ?? {}
  for (const field of ['entries', 'routes', 'models']) {
    check(
      `Config.${field} 是 volatile`,
      configFields[field]?.meta?.volatile === true,
      JSON.stringify(configFields[field]?.meta ?? null),
      '非 volatile 字段不会出现在设置页，也写不进去。',
    )
  }
}

// 页面依赖的核心服务：都是 dsh 自带，不是补丁产物。
let settingsMod = null
let settingsFile = null
try {
  settingsFile = dshResolve('@deepseek-ai/dsh-settings')
  if (settingsFile !== null) settingsMod = await import(pathToFileURL(settingsFile).href)
} catch (error) {
  check('载入 dsh-settings', false, error.message)
}
if (settingsMod !== null) {
  const Forms = settingsMod.default ?? settingsMod.SettingsForms
  const proto = Forms?.prototype ?? {}
  check('dsh-settings 导出 SettingsForms', typeof Forms === 'function')
  check('settings.describe 在（页面读值）', typeof proto.describe === 'function')
  check('settings.mutate 在（页面写值）', typeof proto.mutate === 'function')
}
check(
  'configEditor 可用（服务端写回路由目录）',
  dshResolve('@deepseek-ai/dsh-config-editor') !== null,
  '',
  '没有它就无法把运行时路由发布给页面。',
)

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
// 6b. 从「已安装路径」真的 import 一次
//
// 这条是 2026-10-17 那次事故换来的：node_modules 换成指向源码目录的
// **目录联接**之后，Node 会穿透到**真实路径**并在那里往上找 node_modules，
// 而源码目录当时没有自己的 node_modules —— `@deepseek-ai/schemastery`
// 解析不到，插件加载直接失败。前面「逐字节一致」那几条全绿也照样漏掉它，
// 因为文件确实是同一份，坏的是**依赖解析**。
//
// 所以这里必须走一遍真实的 import：那才是 dsh 启动时干的事。
// ─────────────────────────────────────────────────────────────
const installedEntry = path.join(INSTALLED, 'index.js')
if (!fs.existsSync(installedEntry)) {
  check('从已安装路径 import 插件', false, '找不到 index.js')
} else {
  let realPath = null
  try {
    realPath = fs.realpathSync(installedEntry)
  } catch { /* 下面报 */ }
  const isLink = realPath !== null && realPath !== installedEntry
  let imported = null
  let importError = ''
  try {
    imported = await import(pathToFileURL(installedEntry).href)
  } catch (error) {
    importError = error.message
  }
  check(
    '从已安装路径 import 插件（dsh 启动时走的就是这条）',
    imported !== null,
    imported !== null ? `apply=${typeof imported.apply} Config=${typeof imported.Config}` : importError,
    isLink
      ? 'node_modules 是指向源码目录的链接，所以源码目录必须自带 node_modules 才能解析依赖：cd <源码目录> && npm install --omit=dev'
      : '检查插件依赖是否装全。',
  )
  if (imported !== null) {
    check('插件导出 apply 与 Config', typeof imported.apply === 'function' && typeof imported.Config === 'function')
  }
  rows.push({
    label: 'node_modules 的挂载方式',
    ok: true,
    // 实体副本照样能跑，所以这里不算失败；但它意味着「改完即生效」没了。
    detail: isLink
      ? `链接 → ${realPath}（改源目录即改线上）`
      : '实体副本 —— 改源目录不会同步，跑 node scripts/relink.mjs 换成链接',
    fix: '',
  })
}

// ─────────────────────────────────────────────────────────────
// 7. 运行中的 dsh 是否加载了当前插件代码
//
//    这条原来比的是「补丁文件 mtime」。插件不再依赖补丁之后，真正要紧的是
//    进程有没有在本插件的 index.js 最后一次修改之后启动：服务端逻辑改了必须
//    重启；只改 client.js 时刷新页面就够，所以这里不比 client.js。
// ─────────────────────────────────────────────────────────────
if (fs.existsSync(PLUGIN_ENTRY)) {
  const serverMtime = fs.statSync(PLUGIN_ENTRY).mtimeMs
  let startedAt = null
  try {
    const running = path.join(HOME, 'dsh-config-manager', 'running', 'web.json')
    if (fs.existsSync(running)) startedAt = Date.parse(JSON.parse(fs.readFileSync(running, 'utf8')).startedAt)
  } catch { /* 拿不到就算了 */ }
  if (startedAt === null || Number.isNaN(startedAt)) {
    check('读得到运行实例的启动时间', false, '跳过「进程是否加载了当前代码」这一条')
  } else {
    check(
      '运行中的 dsh 启动于插件代码之后（否则进程里还是旧模块）',
      startedAt > serverMtime,
      `进程 ${new Date(startedAt).toLocaleString('zh-CN')}  /  插件 ${new Date(serverMtime).toLocaleString('zh-CN')}`,
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
