#!/usr/bin/env node
/**
 * modelConfig / dsh-per-model-temperature / scripts/probe-directory.mjs
 *
 * 证明服务端会把**活路由表**和**每个路由的模型**发布进插件自己的设置文档。
 *
 * 为什么需要它：`dsh-our-free-model` 和 `@opencode2dsh/dsh-plugin` 用
 * `ctx.llm.registerAdapter()` 在运行时注册路由，这些路由**不在** `llm-pi-ai`
 * 的静态 providers 段里。设置页原来只读静态段，于是那两个插件的模型在界面上
 * 根本选不到。
 *
 * 修法是让服务端把它们写进 `routes` / `models` 两个字段 —— 客户端本来就在读
 * 这份文档（行数据就是从它来的），所以不依赖 remote API 能不能用。
 *
 * 踩过的坑，正是这里要防的：`llm.listModels()` 是**异步**的。早先版本同步读
 * `sessionController.modelCatalog()`，拿到的是 Promise，`.groups` 永远 undefined
 * —— 结果是 routes 有了、models 永远是空数组。
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

/** 假的宿主：llm 有同步的 listProviders 和**异步**的 listModels。 */
const ROUTES = [
  { id: 'wbproxy-intl', name: 'wbproxy-intl' },
  { id: 'our-free-model', name: 'Our Free Model' },
  { id: 'our-free-model-region', name: 'Our Free Model · region-limited' },
  { id: 'opencode2dsh', name: 'opencode2dsh' },
  { id: 'empty-route', name: 'Empty' },
  { id: 'broken-route', name: 'Broken' },
]
const MODELS = {
  'wbproxy-intl': [{ id: 'deepseek-v4.1-flash' }, { id: 'hy3' }],
  'our-free-model': [{ id: 'deepseek-v4.1-flash-free' }, { id: 'other-free' }],
  'our-free-model-region': [{ id: 'region-only' }],
  'opencode2dsh': [{ id: 'opencode-model-a' }],
  'empty-route': [],
  'broken-route': 'THROW',
}

let stored = { entries: [] }
let updates = []
const makeCtx = (withServices) => ({
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
    if (!withServices) return undefined
    if (name === 'llm') {
      return {
        listProviders: () => ROUTES,
        listModels: async (route) => {
          const value = MODELS[route]
          if (value === 'THROW') throw new Error(`catalog unavailable for ${route}`)
          return value ?? []
        },
      }
    }
    return undefined
  },
})

mod.apply(makeCtx(true))
await new Promise((resolve) => setTimeout(resolve, 60))

check('服务端发布了 routes', Array.isArray(stored.routes) && stored.routes.length > 0, JSON.stringify(stored.routes))
check('活路由里包含 our-free-model', (stored.routes ?? []).includes('our-free-model'), JSON.stringify(stored.routes))
check('活路由里包含 our-free-model-region', (stored.routes ?? []).includes('our-free-model-region'))
check('活路由里包含 opencode2dsh', (stored.routes ?? []).includes('opencode2dsh'))
check('活路由里包含静态路由 wbproxy-intl', (stored.routes ?? []).includes('wbproxy-intl'))

const pairs = stored.models ?? []
check('发布了 models 对（异步读取真的生效）', Array.isArray(pairs) && pairs.length > 0, JSON.stringify(pairs))
check(
  'our-free-model 的模型被发布',
  pairs.some((p) => p.route === 'our-free-model' && p.model === 'deepseek-v4.1-flash-free'),
  JSON.stringify(pairs),
)
check(
  'opencode2dsh 的模型被发布',
  pairs.some((p) => p.route === 'opencode2dsh' && p.model === 'opencode-model-a'),
  JSON.stringify(pairs),
)
check(
  '取模型抛错的路由不影响其它路由',
  pairs.some((p) => p.route === 'our-free-model')
    && !pairs.some((p) => p.route === 'broken-route'),
  JSON.stringify(pairs.filter((p) => p.route === 'broken-route')),
)
check(
  '空模型列表的路由不产生条目',
  !pairs.some((p) => p.route === 'empty-route'),
  JSON.stringify(pairs.filter((p) => p.route === 'empty-route')),
)
check('每条路由 ≤ 40 个模型', (() => {
  const counts = new Map()
  for (const p of pairs) counts.set(p.route, (counts.get(p.route) ?? 0) + 1)
  return [...counts.values()].every((n) => n <= 40)
})())

// 幂等：内容没变时再跑不应重复写
const before = updates.length
mod.apply(makeCtx(true))
await new Promise((resolve) => setTimeout(resolve, 60))
check('内容没变时不再重复写（幂等）', updates.length === before, `新增 ${updates.length - before} 次写`)

// 宿主不提供 llm 时不能抛
let threw = null
try {
  mod.apply(makeCtx(false))
  await new Promise((resolve) => setTimeout(resolve, 60))
} catch (error) {
  threw = error
}
check('宿主不提供 llm 时不抛错', threw === null, threw === null ? '' : threw.message)

if (scratch !== null) fs.rmSync(scratch, { force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)