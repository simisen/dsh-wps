/**
 * 配置与凭据存储。
 *
 * 目录：$DSH_WPS_HOME，默认 %APPDATA%\dsh-wps
 *   config.json       非敏感配置（厂商、baseURL、模型名）
 *   credentials.json  仅 API Key，单独一个文件、权限 0600
 *
 * 安全说明（重要，不要含糊）：
 *   Key 目前是**明文存储**。这对开源工具是一处应当交代清楚的短板。
 *   缓解措施：单独文件 + 收紧权限 + API 永不回传 Key 本身（只回传 hasKey）。
 *   后续计划：改为 Windows DPAPI 加密（用户态绑定），或直接交给 DSH 的凭据库
 *   （$DSH_HOME/.credentials.yaml）统一管理。
 *
 * 环境变量覆盖：<PROVIDER_ID>_API_KEY（大写），例如 DEEPSEEK_API_KEY、OPENAI_API_KEY。
 *   这条让 CI、临时试用、以及"不想落盘"的用户有出路。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const HOME_DIR = process.env.DSH_WPS_HOME
  || path.join(process.env.APPDATA || os.homedir(), 'dsh-wps')

const CONFIG_PATH = path.join(HOME_DIR, 'config.json')
const CRED_PATH = path.join(HOME_DIR, 'credentials.json')

function ensureDir() {
  fs.mkdirSync(HOME_DIR, { recursive: true })
}

function readJson(p, fallback) {
  try {
    // 必须先剥掉 UTF-8 BOM，否则 JSON.parse 直接抛错、整个文件被当成不存在。
    // 这不是理论问题：记事本、PowerShell 的 Set-Content -Encoding UTF8
    // 都会给文件加上 BOM，用户手改一次配置，Key 就"莫名消失"了 ——
    // 表现出来正是「每次都要重新输入 API」。
    const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function writeJson(p, obj, mode = 0o600) {
  ensureDir()
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode })
  fs.renameSync(tmp, p)
  try { fs.chmodSync(p, mode) } catch { /* Windows 上基本是空操作，忽略 */ }
}

/* ---------------- 配置（非敏感） ---------------- */

const DEFAULT_CONFIG = {
  providerId: 'deepseek',
  api: 'openai',
  baseURL: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  // 写入策略：留痕（修订）优先，安全兜底
  writeMode: 'track',        // 'track' 修订留痕 | 'direct' 直接改
  undoGrouping: true,        // 把一轮改动打包成一次撤销
  temperature: 0.3,
  // 一次回复的输出上限。默认给足 —— 写长文（续写、起草材料）是常见需求，
  // 卡在 2048 会让内容被悄悄截断。用户可以在「模型设置 → 高级」里调。
  maxTokens: 8192
}

export function readConfig() {
  return { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, {}) }
}

export function writeConfig(patch) {
  const allowed = ['providerId', 'api', 'baseURL', 'model', 'writeMode', 'undoGrouping', 'temperature', 'maxTokens']
  const clean = {}
  for (const k of allowed) {
    if (patch[k] !== undefined) clean[k] = patch[k]
  }
  const next = { ...readConfig(), ...clean }
  writeJson(CONFIG_PATH, next)
  return next
}

/* ---------------- 凭据（仅 Key） ---------------- */

export function readCreds() {
  return readJson(CRED_PATH, {})
}

export function setApiKey(providerId, key) {
  const creds = readCreds()
  const trimmed = typeof key === 'string' ? key.trim() : ''
  if (trimmed) creds[providerId] = trimmed
  else delete creds[providerId]
  writeJson(CRED_PATH, creds)
}

export function getApiKey(providerId) {
  const envName = String(providerId || '').toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY'
  if (process.env[envName]) return { key: process.env[envName], source: 'env:' + envName }
  const creds = readCreds()
  if (creds[providerId]) return { key: creds[providerId], source: 'store' }
  return { key: '', source: 'none' }
}

export function hasApiKey(providerId) {
  return !!getApiKey(providerId).key
}

/* ---------------- 给前端的安全视图 ---------------- */

export function publicConfig() {
  const cfg = readConfig()
  return {
    ...cfg,
    // 永远不回传 Key 本身，只回传"有没有"
    hasKey: hasApiKey(cfg.providerId),
    keySource: getApiKey(cfg.providerId).source,
    homeDir: HOME_DIR
  }
}

export function configPath() { return CONFIG_PATH }
export function credPath() { return CRED_PATH }
