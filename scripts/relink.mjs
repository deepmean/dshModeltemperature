#!/usr/bin/env node
/**
 * modelConfig / dsh-per-model-temperature / scripts/relink.mjs
 *
 * 把 profile 的 node_modules 里那份插件，重新接回**源目录**（本仓库）。
 *
 * 为什么需要它：profile 的 `package.json` 用 `file:` 依赖装这个插件，pnpm 的
 * 做法是**把源目录复制进 node_modules**。dsh 每次更新都会重跑安装，于是：
 *
 *   - 你把 node_modules 建成指向源目录的**联接**，想让「改完即生效」；
 *   - 下一次 `dsh update` → pnpm 重新安装 → **联接被真实副本覆盖**；
 *   - 改动不再同步，而这一点**无声无息**，没有任何报错。
 *
 * 所以 dsh 更新后跑一次这个脚本即可恢复。它是幂等的：已经是联接就什么都不做。
 *
 * 用法：
 *   node scripts/relink.mjs            # 检查并在需要时重建
 *   node scripts/relink.mjs --dry-run  # 只看会做什么
 * 退出码：0 链接就绪（含「本来就是」）；1 失败。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DRY = process.argv.includes('--dry-run')
const here = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = path.resolve(here, '..')

const HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
function resolveProfileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  const name = process.env.DSH_PROFILE
  if (name) return path.isAbsolute(name) ? name : path.join(HOME, 'profiles', name)
  return path.join(HOME, 'profiles', 'web')
}
const PROFILE = resolveProfileDir()
const INSTALLED = path.join(PROFILE, 'node_modules', 'dsh-per-model-temperature')

function say(msg) { console.log(msg) }

say(`源目录 : ${SOURCE}`)
say(`安装位 : ${INSTALLED}`)
say(`模式   : ${DRY ? 'dry-run（不写入）' : '执行'}\n`)

// ── 前置：源目录必须自带依赖 ──────────────────────────────────────
// 链接生效后 Node 会从**真实路径**往上找 node_modules，源目录没有依赖就加载失败。
const sourceDeps = path.join(SOURCE, 'node_modules')
if (!fs.existsSync(sourceDeps)) {
  say('❌ 源目录没有 node_modules —— 链接后插件会因解析不到依赖而加载失败。')
  say(`   先跑：cd ${SOURCE} && npm install --omit=dev`)
  process.exit(1)
}
say('✓ 源目录自带 node_modules')

// ── 现状判定 ─────────────────────────────────────────────────────
if (!fs.existsSync(INSTALLED)) {
  say('安装位不存在 —— 需要先装一次插件：')
  say(`   dsh plugin --profile web add "file:${SOURCE}"`)
  process.exit(1)
}

const stat = fs.lstatSync(INSTALLED)
const isLink = stat.isSymbolicLink()
let realTarget = null
try { realTarget = fs.realpathSync(INSTALLED) } catch { /* 下面报 */ }

if (isLink) {
  const same = realTarget !== null && path.resolve(realTarget) === path.resolve(SOURCE)
  if (same) {
    say('✓ 已经是指向源目录的链接，无需处理')
    process.exit(0)
  }
  say(`⚠️ 是链接，但指向别处：${realTarget}`)
} else {
  say('• 当前是**真实副本**（dsh 更新后 pnpm 装出来的），需要换成链接')
}

if (DRY) {
  say('\n[dry-run] 会执行：')
  say(`  1. 把现有目录重命名为 .pmt-copy-backup`)
  say(`  2. 新建链接 ${INSTALLED} -> ${SOURCE}`)
  process.exit(0)
}

// ── 换链接 ───────────────────────────────────────────────────────
const BACKUP = path.join(path.dirname(INSTALLED), '.pmt-copy-backup')
if (fs.existsSync(BACKUP)) {
  try { fs.rmSync(BACKUP, { recursive: true, force: true }) } catch { /* 留着，下面重建时会再试 */ }
}

try {
  fs.renameSync(INSTALLED, BACKUP)
  say('✓ 已把旧目录挪到 .pmt-copy-backup')
} catch (error) {
  say(`❌ 挪不动现有目录：${error.message}`)
  say('   多半是运行中的 dsh 还持有文件句柄 —— 停掉 dsh 再跑一次。')
  process.exit(1)
}

try {
  // Windows 上 junction 不需要管理员或开发者模式；其他平台用目录符号链接。
  fs.symlinkSync(SOURCE, INSTALLED, process.platform === 'win32' ? 'junction' : 'dir')
  say('✓ 链接已建立')
} catch (error) {
  say(`❌ 建链接失败：${error.message}`)
  say('   正在回滚……')
  try { fs.renameSync(BACKUP, INSTALLED); say('✓ 已回滚，安装位恢复原状') } catch { say('⚠️ 回滚也失败，请手动把 .pmt-copy-backup 改回来') }
  process.exit(1)
}

// ── 真加载一次 ───────────────────────────────────────────────────
let ok = false
try {
  const mod = await import(pathToFileURL(path.join(INSTALLED, 'index.js')).href)
  ok = typeof mod.apply === 'function' && typeof mod.settingsSchema === 'function'
  say(ok ? '✓ 从安装位 import 成功（dsh 启动时走的就是这条）' : '⚠️ import 成功但导出不对')
} catch (error) {
  say(`❌ 从安装位 import 失败：${error.message}`)
}

if (ok) {
  try { fs.rmSync(BACKUP, { recursive: true, force: true }); say('✓ 备份已清理') }
  catch { say(`• 备份删不掉（dsh 占用），可稍后手动删：${BACKUP}`) }
  say('\n完成：现在改源目录 = 改线上，无需再复制。')
  say('注意：重启 dsh 后日志里若报「Cannot find package」，说明源目录依赖缺失，回去跑 npm install。')
  process.exit(0)
}

say(`\n出问题了。把备份改回来可恢复原状：`)
say(`  Move-Item "${BACKUP}" "${INSTALLED}" -Force`)
process.exit(1)