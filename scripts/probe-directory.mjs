#!/usr/bin/env node
/**
 * modelConfig / dsh-per-model-temperature / scripts/probe-directory.mjs
 *
 * 证明服务端真的会把**活路由表**发布进插件自己的设置文档。
 *
 * 为什么需要它：`dsh-our-free-model` 和 `@opencode2dsh/dsh-plugin` 用
 * `ctx.llm.registerAdapter()` 在运行时注册路由，这些路由**不在** `llm-pi-ai`
 * 的静态 providers 段里。设置页原来只读静态段，于是那两个插件的模型在界面上
 * 根本选不到。
 *
 * 修法是让服务端把它们写进 `routes` / `models` 两个字段 —— 而客户端本来就在读
 * 这份文档（行数据就是从它来的），所以不依赖 remote API 能不能用。
 *
 * 这个脚本用真实的 index.js + 假的 llm / sessionController 验证那条发布路径。
 *
 * 用法：node scripts/probe-directory.mjs
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
const INSTALLED = path.join(PROFILE, 'node_modules', 'dsh-per-model-temperature', 'index.js')
const SOURCE = path.join(here, '..', 'index.js')
const target = fs.existsSync(INSTALLED) ? INSTALLED : SOURCE

let pass = 0
let fail = 0
function check(label, ok, extra = '') {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${extra === '' ? '' : '  ' + extra}`) }
}

// 源码目录没有 node_modules 时，把 schemastery 的说明符换成绝对路径再加载
const raw = fs.readFileSync(target, 'utf8')
let entry = target
let scratch = null
if (!fs.existsSync(path.join(path.dirname(target), 'node_modules')) && /@deepseek-ai\/schemastery/.test(raw)) {
  const profileRequire = createRequire(path.join(PROFILE, 'package.json'))
  const resolved = profileRequire.resolve('@deepseek-ai/schemastery')
  scratch = path.join(os.tmpdir(), `pmt-dir-${process.pid}.mjs`)
  fs.writeFileSync(scratch, raw.replace(/(['"])@deepseek-ai\/schemastery\1/, JSON.stringify(pathToFileURL(resolved).href)), 'utf8')
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

/** 假的宿主：llm 有 listProviders，sessionController 有 modelCatalog。 */
const ROUTES = [
  { id: 'wbproxy-intl', name: 'wbproxy-intl' },
  { id: 'our-free-model', name: 'Our Free Model' },
  { id: 'our-free-model-region', name: 'Our Free Model · region-limited' },
  { id: 'opencode2dsh', name: 'opencode2dsh' },
]
const CATALOG = {
  default: { provider: 'our-free-model', model: 'deepseek-v4.1-flash-free' },
  routableProviders: ['our-free-model'],
  groups: [
    { id: 'our-free-model', name: 'Our Free Model', models: [{ id: 'deepseek-v4.1-flash-free' }, { id: 'other-free' }] },
    { id: 'opencode2dsh', name: 'opencode2dsh', models: [{ id: 'opencode-model-a' }] },
    // 一个没有对应路由的组：不允许被凭空变成下拉项
    { id: 'ghost-group', name: 'Ghost', models: [{ id: 'ghost-model' }] },
  ],
}

let stored = { entries: [] }
let updates = []
const ctx = {
  settings: {
    register: () => ({
      get: () => stored,
      update: (patch) => { updates.push(patch); stored = { ...stored, ...patch }; return Promise.resolve() },
      watch: () => () => {},
    }),
  },
  on: () => () => {},
  effect: (fn) => { if (typeof fn === 'function') fn() },
  logger: { warn: () => {}, info: () => {} },
  get: (name) => {
    if (name === 'llm') return { listProviders: () => ROUTES }
    if (name === 'sessionController') return { modelCatalog: () => CATALOG }
    return undefined
  },
}

mod.apply(ctx)
// 发布是定时的（覆盖启动顺序），等第一轮 setTimeout(0) 落地
await new Promise((resolve) => setTimeout(resolve, 30))

check('服务端发布了 routes', Array.isArray(stored.routes) && stored.routes.length > 0, JSON.stringify(stored.routes))
check(
  '活路由里包含 our-free-model',
  (stored.routes ?? []).includes('our-free-model'),
  JSON.stringify(stored.routes),
)
check(
  '活路由里包含 our-free-model-region',
  (stored.routes ?? []).includes('our-free-model-region'),
  JSON.stringify(stored.routes),
)
check('活路由里包含 opencode2dsh', (stored.routes ?? []).includes('opencode2dsh'), JSON.stringify(stored.routes))
check('活路由里包含静态路由 wbproxy-intl', (stored.routes ?? []).includes('wbproxy-intl'), JSON.stringify(stored.routes))

const pairs = stored.models ?? []
check('发布了 models 对', Array.isArray(pairs) && pairs.length > 0, JSON.stringify(pairs))
check(
  'our-free-model 的模型被发布',
  pairs.some((p) => p.route === 'our-free-model' && p.model === 'deepseek-v4.1-flash-free'),
  JSON.stringify(pairs),
)
check(
  '没有对应路由的 catalog 组被忽略',
  !pairs.some((p) => p.route === 'ghost-group'),
  JSON.stringify(pairs.filter((p) => p.route === 'ghost-group')),
)
check('没有撑爆：每条路由 ≤ 40 个模型', (() => {
  const counts = new Map()
  for (const p of pairs) counts.set(p.route, (counts.get(p.route) ?? 0) + 1)
  return [...counts.values()].every((n) => n <= 40)
})(), JSON.stringify([...new Set(pairs.map((p) => p.route))]))

// 幂等：再发布一次不应该再写
const before = updates.length
mod.apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 30))
check('内容没变时不再重复写（幂等）', updates.length === before, `新增 ${updates.length - before} 次写`)

// 读不到 llm / sessionController 时不能抛
let threw = null
try {
  mod.apply({ ...ctx, get: () => undefined })
  await new Promise((resolve) => setTimeout(resolve, 30))
} catch (error) {
  threw = error
}
check('宿主不提供 llm / sessionController 时不抛错', threw === null, threw === null ? '' : threw.message)

if (scratch !== null) fs.rmSync(scratch, { force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)