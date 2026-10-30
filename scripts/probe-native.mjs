#!/usr/bin/env node
/**
 * modelConfig / dsh-per-model-temperature / scripts/probe-native.mjs
 *
 * 证明插件现在只用 **dsh 原生能力**：volatile `Config` + `configEditor` +
 * `agent/request`。完全不碰 `ctx.settings.register`（那是 dsh-purge 加的
 * 非上游 API，正是过去三次更新失效的根因）。
 *
 * 覆盖：
 *   1. Config 的三个字段都是 volatile（设置页能读写的前提）
 *   2. `agent/request` 监听器按 provider+model 注入温度
 *   3. 不命中时主动移除 temperature（防止上一个模型的值赖着走）
 *   4. config 以 volatile 引用形式到达时能正确解包；普通对象也行
 *   5. 首次启动把 settings-legacy.yaml 的旧记录迁移进原生 config（仅一次）
 *   6. 目录发布：路由与模型写入 config，单路由失败不影响其它，双重上限
 *   7. 幂等：内容没变不重复写
 *   8. 宿主缺少 configEditor / llm 时不抛错
 *
 * 用法：node scripts/probe-native.mjs
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

// 源码目录缺 node_modules 时，把 schemastery / yaml 的说明符换成绝对路径
const raw = fs.readFileSync(target, 'utf8')
let entry = target
let scratch = null
if (!fs.existsSync(path.join(path.dirname(target), 'node_modules'))) {
  const profileRequire = createRequire(path.join(PROFILE, 'package.json'))
  let text = raw
  for (const spec of ['@deepseek-ai/schemastery', 'yaml']) {
    try {
      const resolved = profileRequire.resolve(spec)
      text = text.replace(new RegExp(`(['"])${spec.replace('/', '\\/')}\\1`, 'g'), JSON.stringify(pathToFileURL(resolved).href))
    } catch { /* 留给下面报错 */ }
  }
  scratch = path.join(os.tmpdir(), `pmt-native-${process.pid}.mjs`)
  fs.writeFileSync(scratch, text, 'utf8')
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

// ── 1. Config 契约 ────────────────────────────────────────────────
check('导出 Config schema', typeof mod.Config === 'function')
check('导出 applyTemperature()', typeof mod.applyTemperature === 'function')
check('导出 apply()', typeof mod.apply === 'function')

/**
 * Volatility is read off the live schema (`Config.dict[field].meta.volatile`),
 * not off `toJSON()`: schemastery's toJSON is a flat `{uid, refs}` reference
 * table with no per-field metadata, so looking for `meta` there finds nothing
 * and reports a false failure.
 */
const fields = mod.Config?.dict ?? {}
for (const field of ['entries', 'routes', 'models']) {
  check(`Config.${field} 标记为 volatile`, fields[field]?.meta?.volatile === true,
    JSON.stringify(fields[field]?.meta ?? null))
}

/**
 * 源码层面证明与 purge 脱钩：不能再出现 ctx.settings.register。
 * 这是"全新安装的 dsh 也能跑"的核心保证。
 *
 * 注释先剥掉：文件顶部的历史说明里会提到 `ctx.settings.register`，而那正是
 * 我们要解释"为什么不再用它"的文字——按裸文本匹配会把说明当成调用。
 */
const codeOnly = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
check('源码不再调用 ctx.settings.register', !/settings\.register\s*\(/.test(codeOnly))
check('源码不再 inject settings', !/inject\s*=\s*\[[^\]]*['"]settings['"]/.test(codeOnly))

// ── 2-4. 监听器行为 ──────────────────────────────────────────────
const ref = (value) => ({ get: () => value })
const listeners = new Map()
const makeCtx = ({ entries = [], configEditor, llm, home } = {}) => ({
  on: (event, fn) => { listeners.set(event, fn); return () => {} },
  get: (name) => {
    if (name === 'configEditor') return configEditor
    if (name === 'llm') return llm
    if (name === 'profileContext') return home === undefined ? undefined : { home }
    return undefined
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
})

/** 一个记录写入的 configEditor 桩。 */
function editorStub(initial = {}) {
  const state = { config: { ...initial }, writes: [] }
  return {
    state,
    entries: () => [{ options: { id: 'per-model-temperature' }, fiber: {} }],
    edit: async (_entry, change) => {
      state.config = change(state.config)
      state.writes.push(state.config)
    },
  }
}

function freshCtx(options) {
  listeners.clear()
  const ctx = makeCtx(options)
  return ctx
}

// 2. 命中注入
{
  const entries = [{ provider: 'x', model: 'm', temperature: 0.7 }]
  const ctx = freshCtx()
  mod.apply(ctx, { entries: ref(entries), routes: ref([]), models: ref([]) })
  const listener = listeners.get('agent/request')
  check('apply() 注册了 agent/request 监听', typeof listener === 'function')
  const out = await listener({ turn: 1, step: 1, signal: undefined }, async () => Object.freeze({ provider: 'x', model: 'm' }))
  check('命中 provider+model → 注入温度', out.temperature === 0.7, JSON.stringify(out.temperature))

  const miss = await listener({ turn: 1, step: 1, signal: undefined }, async () => Object.freeze({ provider: 'x', model: 'other' }))
  check('不命中 → 不下发', miss.temperature === undefined, JSON.stringify(miss.temperature))

  const stale = await listener({ turn: 1, step: 1, signal: undefined }, async () => Object.freeze({ provider: 'x', model: 'other', temperature: 1.5 }))
  check('不命中时清掉旧温度', stale.temperature === undefined, JSON.stringify(stale.temperature))
}

// 4. 普通对象（非引用）也要能用
{
  const ctx = freshCtx()
  mod.apply(ctx, { entries: [{ provider: 'p', model: 'm', temperature: 0.3 }], routes: [], models: [] })
  const listener = listeners.get('agent/request')
  const out = await listener({ turn: 1, step: 1, signal: undefined }, async () => Object.freeze({ provider: 'p', model: 'm' }))
  check('config 是普通对象时同样生效', out.temperature === 0.3, JSON.stringify(out.temperature))
}

// ── 5. 旧配置迁移 ────────────────────────────────────────────────
{
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pmt-migrate-'))
  fs.writeFileSync(path.join(tmpHome, 'settings-legacy.yaml'), [
    'per-model-temperature:',
    '  entries:',
    '    - provider: wbproxy-intl',
    '      model: deepseek-v4.1-flash',
    '      temperature: 0.9',
    '    - provider: our-free-model',
    '      model: z-ai/glm-5.3',
    '      temperature: 0.5',
    '    - provider: ""',
    '      model: skipped',
    '',
  ].join('\n'), 'utf8')

  const editor = editorStub({ entries: [], routes: [], models: [] })
  const ctx = freshCtx({ configEditor: editor, home: tmpHome })
  mod.apply(ctx, { entries: ref([]), routes: ref([]), models: ref([]) })
  await new Promise((r) => setTimeout(r, 60))

  const written = editor.state.writes.at(-1) ?? {}
  check('迁移：把旧文件里的 2 条有效记录写进原生 config',
    Array.isArray(written.entries) && written.entries.length === 2, JSON.stringify(written.entries))
  check('迁移：保留温度值',
    written.entries?.[0]?.temperature === 0.9 && written.entries?.[1]?.temperature === 0.5,
    JSON.stringify(written.entries))
  check('迁移：丢掉 provider 为空的行', !written.entries?.some((e) => e.provider === ''))
  fs.rmSync(tmpHome, { recursive: true, force: true })
}

// 迁移只做一次：已有 entries 时不再写
{
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pmt-migrate2-'))
  fs.writeFileSync(path.join(tmpHome, 'settings-legacy.yaml'),
    'per-model-temperature:\n  entries:\n    - provider: a\n      model: b\n', 'utf8')
  const editor = editorStub({ entries: [{ provider: 'keep', model: 'me', temperature: 1 }], routes: [], models: [] })
  const ctx = freshCtx({ configEditor: editor, home: tmpHome })
  mod.apply(ctx, { entries: ref([{ provider: 'keep', model: 'me', temperature: 1 }]), routes: ref([]), models: ref([]) })
  await new Promise((r) => setTimeout(r, 60))
  check('已有 entries 时不再迁移（不覆盖用户改动）',
    !editor.state.writes.some((w) => JSON.stringify(w.entries ?? []) !== JSON.stringify([{ provider: 'keep', model: 'me', temperature: 1 }])),
    JSON.stringify(editor.state.writes))
  fs.rmSync(tmpHome, { recursive: true, force: true })
}

// ── 6. 目录发布 ──────────────────────────────────────────────────
{
  const ROUTES = [
    { id: 'wbproxy-intl', name: 'wbproxy-intl' },
    { id: 'our-free-model', name: 'Our Free Model' },
    { id: 'opencode2dsh', name: 'opencode2dsh' },
    { id: 'broken-route', name: 'Broken' },
  ]
  const MODELS = {
    'wbproxy-intl': [{ id: 'deepseek-v4.1-flash' }],
    'our-free-model': [{ id: 'z-ai/glm-5.3', name: 'EAC GLM 5.3' }, { id: 'big-pickle' }],
    'opencode2dsh': [{ id: 'beam-free' }],
    'broken-route': 'THROW',
  }
  const llm = {
    listProviders: () => ROUTES,
    listModels: async (route) => {
      if (MODELS[route] === 'THROW') throw new Error('catalog unavailable')
      return MODELS[route] ?? []
    },
  }
  const editor = editorStub({ entries: [], routes: [], models: [] })
  const ctx = freshCtx({ configEditor: editor, llm })
  mod.apply(ctx, { entries: ref([]), routes: ref([]), models: ref([]) })
  await new Promise((r) => setTimeout(r, 80))

  const written = editor.state.writes.at(-1) ?? {}
  check('发布：写入了 routes', Array.isArray(written.routes) && written.routes.length === 4, JSON.stringify(written.routes))
  check('发布：含运行时注册的 our-free-model', (written.routes ?? []).includes('our-free-model'))
  check('发布：含 opencode2dsh', (written.routes ?? []).includes('opencode2dsh'))
  check('发布：models 带有显示名',
    (written.models ?? []).some((m) => m.route === 'our-free-model' && m.model === 'z-ai/glm-5.3' && m.name === 'EAC GLM 5.3'),
    JSON.stringify(written.models))
  check('发布：单路由取模型抛错不影响其它',
    !(written.models ?? []).some((m) => m.route === 'broken-route')
      && (written.models ?? []).some((m) => m.route === 'opencode2dsh'))

  const before = editor.state.writes.length
  listeners.get('llm/adapters-updated')?.()
  await new Promise((r) => setTimeout(r, 60))
  check('幂等：内容没变时不再重复写', editor.state.writes.length === before,
    `新增 ${editor.state.writes.length - before} 次`)
}

// 上限
{
  const many = []
  for (let i = 0; i < 60; i++) many.push({ id: `m-${i}` })
  const llm = { listProviders: () => [{ id: 'big' }], listModels: async () => many }
  const editor = editorStub({ entries: [], routes: [], models: [] })
  const ctx = freshCtx({ configEditor: editor, llm })
  mod.apply(ctx, { entries: ref([]), routes: ref([]), models: ref([]) })
  await new Promise((r) => setTimeout(r, 80))
  const written = editor.state.writes.at(-1) ?? {}
  check('上限：每路由最多 40 个模型', (written.models ?? []).length === 40, String((written.models ?? []).length))
}

// 早期快照不得缩小已发布的目录
{
  /**
   * 真实事故：临时实例在适配器注册完之前发布，把 30 个路由覆盖成 dsh 自带的
   * 2 个，顺带清空了模型列表 —— 正是"下拉又空了"。启动期读到的是子集，
   * 所以「比已有更小」必须被视为不完整而跳过。
   */
  const llm = {
    listProviders: () => [{ id: 'deepseek-account' }, { id: 'deepseek-official' }],
    listModels: async () => [{ id: 'm' }],
  }
  const storedRoutes = []
  for (let i = 0; i < 30; i++) storedRoutes.push(`route-${i}`)
  const editor = editorStub({ entries: [], routes: storedRoutes, models: [] })
  const ctx = freshCtx({ configEditor: editor, llm })
  mod.apply(ctx, { entries: ref([]), routes: ref(storedRoutes), models: ref([]) })
  await new Promise((r) => setTimeout(r, 80))
  check(
    '启动早期的子集不覆盖已发布目录（不缩小）',
    editor.state.writes.length === 0,
    JSON.stringify(editor.state.writes.map((w) => w.routes)),
  )
}

// ── 8. 缺服务时不抛 ─────────────────────────────────────────────
{
  let threw = null
  try {
    const ctx = freshCtx({})   // 没有 configEditor / llm / profileContext
    mod.apply(ctx, { entries: ref([]), routes: ref([]), models: ref([]) })
    await new Promise((r) => setTimeout(r, 60))
  } catch (error) {
    threw = error
  }
  check('宿主缺 configEditor / llm 时不抛错', threw === null, threw === null ? '' : threw.message)
}

if (scratch !== null) fs.rmSync(scratch, { force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
