#!/usr/bin/env node
/**
 * modelConfig / scripts/probe-apply-temperature.mjs
 *
 * 证明「配置里那条记录」真的会改到发出去的请求上。
 *
 * 为什么必须测这里：DSH 的 agent loop 自己从来不产出 temperature ——
 * seedConfig 只带 provider/model/reasoningEffort/maxTokens。唯一能把
 * temperature 放上线路的地方，就是本插件挂在 `agent/request` waterfall
 * 上的那个 listener，它把决定权交给 `applyTemperature(entries, config)`。
 * 所以只要这个函数的输入输出对，线上行为就对。
 *
 * 这里不读配置猜、不 mock harness 语义，而是把「已安装的那份」index.js
 * 当真模块 import 进来，拿它导出的 applyTemperature 和 apply() 挂上的
 * listener 分别验证。
 *
 * 覆盖：
 *   1) 命中 provider+model -> 注入 temperature（值必须一致）
 *   2) 同 route 不同 model -> 不注入
 *   3) 不同 route 同 model -> 不注入
 *   4) 行在但温度为空 -> 不注入（等于不干预，走上游默认）
 *   5) 多行并存 -> 只取本行，别的记录不许污染
 *   6) 空表 -> 不注入
 *   7) 配置值 ≠ 上游默认 1（否则改了等于没改）
 *   8) 传入的 config 不被就地改写（harness 的 proposal 是 deep-frozen）
 *
 * 用法：
 *   node scripts/probe-apply-temperature.mjs
 *   node scripts/probe-apply-temperature.mjs --entry wbproxy-intl deepseek-v4.1-flash 0.9
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
const INSTALLED = path.join(PROFILE, 'node_modules', 'dsh-per-model-temperature', 'index.js')
const SOURCE = path.join(here, '..', 'index.js')

const target = fs.existsSync(INSTALLED) ? INSTALLED : SOURCE
const origin = target === INSTALLED ? '已安装副本' : '源码目录'

let pass = 0
let fail = 0
function check(label, ok, extra = '') {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${extra === '' ? '' : '  ' + extra}`) }
}

// 源码目录下没有 node_modules，@deepseek-ai/schemastery 解析不到；
// 从 profile 目录解析出绝对入口，把那一行 import 说明符换掉再加载。
// 已安装副本本来就能解析，走同一条路也无害。
let entry = target
let scratch = null
const raw = fs.readFileSync(target, 'utf8')
if (!fs.existsSync(path.join(path.dirname(target), 'node_modules')) && /@deepseek-ai\/schemastery/.test(raw)) {
  const profileRequire = createRequire(path.join(PROFILE, 'package.json'))
  let resolved = null
  try {
    resolved = profileRequire.resolve('@deepseek-ai/schemastery')
  } catch (error) {
    console.log(`FAIL  从 ${PROFILE} 解析 @deepseek-ai/schemastery: ${error.message}`)
    process.exit(1)
  }
  scratch = path.join(os.tmpdir(), `pmt-probe-${process.pid}.mjs`)
  fs.writeFileSync(
    scratch,
    raw.replace(
      /(['"])@deepseek-ai\/schemastery\1/,
      JSON.stringify(pathToFileURL(resolved).href),
    ),
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

check('index.js 导出 applyTemperature()', typeof mod.applyTemperature === 'function')
check('index.js 导出 apply()', typeof mod.apply === 'function')
check('插件名 = per-model-temperature', mod.name === 'per-model-temperature', `实际 ${mod.name}`)
check('inject 声明了 settings', Array.isArray(mod.inject) && mod.inject.includes('settings'))

// ---------------------------------------------------------------- 端到端：走 execute listener
let storedEntries = []
let registered = null
const ctx = {
  settings: {
    register: (namespace, schema) => {
      registered = namespace
      return { get: () => ({ entries: storedEntries }), set: async () => true, watch: () => () => {} }
    },
  },
  on: (event, fn) => { if (event === 'agent/request') listener = fn; return () => {} },
  effect: (fn) => { if (typeof fn === 'function') fn() },
  logger: { warn: () => {}, info: () => {} },
}
let listener = null
try {
  mod.apply(ctx)
} catch (error) {
  console.log(`NOTE  apply() 抛了 ${error.message}`)
}
check('settings.register 命名空间 = per-model-temperature', registered === 'per-model-temperature', `实际 ${registered}`)
check('apply() 挂上了 agent/request 监听', typeof listener === 'function')

const applyTemperature = mod.applyTemperature
async function run(entries, config) {
  if (typeof listener === 'function') {
    storedEntries = entries
    const frozen = Object.freeze({ ...config })
    return await listener({ turn: 1, step: 1, signal: undefined }, async () => frozen)
  }
  return applyTemperature(entries, config)
}

// ---------------------------------------------------------------- 用户当前那条记录
const argv = process.argv.slice(2)
let provider = 'wbproxy-intl'
let model = 'deepseek-v4.1-flash'
let temperature = 0.9
if (argv[0] === '--entry' && argv.length >= 4) {
  provider = argv[1]
  model = argv[2]
  temperature = Number(argv[3])
}

console.log(`\n来源: ${origin}\n文件: ${target}\n测试记录: ${provider} / ${model} / temperature=${temperature}\n`)

const entries = [{ provider, model, temperature }]

const hit = await run(entries, { provider, model })
check('命中 provider+model -> 注入 temperature', hit.temperature === temperature, `实际 ${JSON.stringify(hit.temperature)}`)

const missModel = await run(entries, { provider, model: `${model}-other` })
check('同 route 不同 model -> 不注入', missModel.temperature === undefined, `实际 ${JSON.stringify(missModel.temperature)}`)

const missRoute = await run(entries, { provider: `${provider}-x`, model })
check('不同 route 同 model -> 不注入', missRoute.temperature === undefined, `实际 ${JSON.stringify(missRoute.temperature)}`)

const blank = await run([{ provider, model, temperature: undefined }], { provider, model })
check('行在但温度为空 -> 不注入', blank.temperature === undefined, `实际 ${JSON.stringify(blank.temperature)}`)

const multi = await run(
  [{ provider, model, temperature }, { provider: 'openrouter', model: 'x-ai/grok-4', temperature: 0.1 }],
  { provider, model },
)
check('多行并存 -> 只取本行', multi.temperature === temperature, `实际 ${JSON.stringify(multi.temperature)}`)

const none = await run([], { provider, model })
check('空表 -> 不注入（harness 默认）', none.temperature === undefined, `实际 ${JSON.stringify(none.temperature)}`)

check('配置值 != 上游默认 1（改了确实有区别）', temperature !== 1, `temperature=${temperature}`)

const seed = { provider, model, maxTokens: 4096 }
const out = await run(entries, seed)
check('不改写传入对象（返回新对象）', seed.temperature === undefined && out !== seed, `seed.temperature=${JSON.stringify(seed.temperature)}`)

// 既有的 temperature 也要被重算：中途换模型不能把旧值带过去
const stale = await run(entries, { provider, model: `${model}-other`, temperature: 1.5 })
check('不命中的旧 temperature 被清掉', stale.temperature === undefined, `实际 ${JSON.stringify(stale.temperature)}`)

if (scratch !== null) fs.rmSync(scratch, { force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
