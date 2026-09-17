/**
 * 极简 zip 打包器（零第三方依赖）。
 *
 * 为什么不用 tar.exe？
 *   Windows 自带的 bsdtar 打 zip 时，会把非 ASCII 文件名按**本机代码页**写进去，
 *   而且**不设置** zip 的 "UTF-8 文件名" 标志位（通用位 11）。
 *   结果：在中文 Windows 上解压正常，换到英文 Windows 就变成一堆乱码文件名 ——
 *   而我们的启动脚本正好叫 `点我启动助手.cmd`。
 *
 * 所以自己写：所有文件名一律 UTF-8 编码 + 强制置位 0x0800。
 * 这样任何解压工具（Windows 自带、7-Zip、WinRAR、macOS 归档工具）都能还原正确名字。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const FLAG_UTF8 = 0x0800
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/* ---- CRC-32 ---- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()

function crc32 (buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/* ---- MS-DOS 时间格式 ---- */
function dosStamp (d) {
  const year = Math.max(1980, d.getFullYear())
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF,
    date: (((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF
  }
}

/** 递归收集目录下的所有条目，名字统一用 '/' 分隔、相对 srcDir。 */
function collect (srcDir, relBase = '') {
  const out = []
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(srcDir, e.name)
    const rel = relBase ? relBase + '/' + e.name : e.name
    if (e.isDirectory()) {
      out.push({ name: rel + '/', dir: true, abs })
      out.push(...collect(abs, rel))
    } else if (e.isFile()) {
      out.push({ name: rel, dir: false, abs })
    }
  }
  return out
}

/**
 * 把一个目录打包成 zip。
 * @param {string} srcDir  要打包的目录
 * @param {string} rootName 压缩包内的顶层目录名（比如 'dsh-wps'）
 * @param {string} outFile  输出的 .zip 路径
 * @returns {{bytes:number, entries:number}}
 */
export function createZip (srcDir, rootName, outFile) {
  const items = collect(srcDir)
  if (items.length > 0xFFFF) throw new Error('条目数超过 65535，这个极简打包器不支持 zip64')

  const chunks = []          // 本地文件头 + 数据
  const central = []         // 中央目录
  let offset = 0

  const push = (buf) => { chunks.push(buf); offset += buf.length }
  const utf8 = (s) => Buffer.from(s, 'utf8')

  // 顶层目录本身也写一条，保持和常见压缩工具一致的观感
  items.unshift({ name: rootName + '/', dir: true, abs: srcDir })

  for (const it of items) {
    const nameBuf = utf8(rootName + '/' + it.name)
    const st = fs.statSync(it.abs)
    const { time, date } = dosStamp(st.mtime)

    let raw = Buffer.alloc(0)
    let body = Buffer.alloc(0)
    let method = METHOD_STORE
    if (!it.dir) {
      raw = fs.readFileSync(it.abs)
      const deflated = zlib.deflateRawSync(raw, { level: 9 })
      // 压不小就原样存 —— 压缩包只会变胖
      if (deflated.length < raw.length) { body = deflated; method = METHOD_DEFLATE } else { body = raw }
    }
    const crc = it.dir ? 0 : crc32(raw)

    /* 本地文件头 */
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)   // 签名
    lh.writeUInt16LE(20, 4)           // 解压所需版本 2.0
    lh.writeUInt16LE(FLAG_UTF8, 6)    // ★ 关键：UTF-8 文件名标志
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(time, 10)
    lh.writeUInt16LE(date, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)           // 无扩展字段
    const localOffset = offset
    push(lh)
    push(nameBuf)
    if (body.length) push(body)

    /* 中央目录项 */
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)           // 制作版本（MS-DOS）
    ch.writeUInt16LE(20, 6)           // 解压所需版本
    ch.writeUInt16LE(FLAG_UTF8, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(time, 12)
    ch.writeUInt16LE(date, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt16LE(0, 30)           // 扩展字段长度
    ch.writeUInt16LE(0, 32)           // 注释长度
    ch.writeUInt16LE(0, 34)           // 起始磁盘号
    ch.writeUInt16LE(0, 36)           // 内部属性
    ch.writeUInt32LE(it.dir ? 0x10 : 0x20, 38)  // 外部属性：目录 / 归档
    ch.writeUInt32LE(localOffset, 42)
    central.push(ch, nameBuf)
  }

  /* 中央目录结尾 */
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(items.length, 8)
  eocd.writeUInt16LE(items.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  const out = Buffer.concat([...chunks, centralBuf, eocd])
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, out)
  return { bytes: out.length, entries: items.length }
}

/* 直接跑： node dev/mkzip.mjs <源目录> <顶层名> <输出.zip> */
if (process.argv[1] && process.argv[1].endsWith('mkzip.mjs')) {
  const [src, root, out] = process.argv.slice(2)
  if (!src || !root || !out) {
    console.error('用法: node dev/mkzip.mjs <源目录> <顶层目录名> <输出.zip>')
    process.exit(2)
  }
  const r = createZip(src, root, out)
  console.log(`  OK    ${out}  ${r.entries} 个条目  ${(r.bytes / 1024).toFixed(1)} KB`)
}
