#!/usr/bin/env node
/**
 * 词表结构自检：data/tags/*.jsonl 每行必须是一行合法 JSON，且至少有非空字符串 tag。
 * 可选字段：cn（字符串）、aliases（字符串数组）、postCount（数字）。
 *
 * 为什么需要：词表是手写补丁文件，一个中文逗号、一个漏引号就会让整行被加载器安静跳过，
 * 表现为「这个词明明写了却查不到」。CI 里先跑这一道，把语法错挡在测试之前。
 *
 * 用法：node scripts/check-tags.mjs [--dir <目录>] [--quiet]
 * 退出码：0 全部合法；1 有错；2 词表目录不存在。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const out = { dir: path.join(ROOT, 'data', 'tags'), quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dir') out.dir = String(argv[++i] ?? '')
    else if (arg.startsWith('--dir=')) out.dir = arg.slice(6)
    else if (arg === '--quiet' || arg === '-q') out.quiet = true
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/check-tags.mjs [--dir <目录>] [--quiet]')
      process.exit(0)
    } else {
      console.error('不认识的参数: ' + arg)
      process.exit(2)
    }
  }
  return out
}

/** 校验单行记录，返回错误描述数组（空数组表示合法）。 */
function checkRecord(record) {
  const problems = []
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    problems.push('不是对象')
    return problems
  }
  if (typeof record.tag !== 'string' || record.tag.trim() === '') problems.push('tag 缺失或不是非空字符串')
  if (record.cn !== undefined && typeof record.cn !== 'string') problems.push('cn 必须是字符串')
  if (record.aliases !== undefined) {
    if (!Array.isArray(record.aliases)) problems.push('aliases 必须是数组')
    else {
      const bad = record.aliases.filter(item => typeof item !== 'string' || item.trim() === '')
      if (bad.length > 0) problems.push('aliases 里有 ' + bad.length + ' 个非字符串/空串')
    }
  }
  if (record.postCount !== undefined && typeof record.postCount !== 'number') problems.push('postCount 必须是数字')
  if (problems.length === 0) {
    const tag = record.tag
    if (/\s/.test(tag) && tag !== tag.trim()) problems.push('tag 首尾有空白')
    if (/[,\uFF0C]/.test(tag)) problems.push('tag 里出现逗号（会被当成分隔符）')
  }
  return problems
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.dir === '' || !fs.existsSync(args.dir)) {
    console.error('词表目录不存在: ' + args.dir)
    return 2
  }
  const files = fs.readdirSync(args.dir).filter(name => name.endsWith('.jsonl')).sort()
  if (files.length === 0) {
    console.error('目录里没有 .jsonl: ' + args.dir)
    return 1
  }
  const errors = []
  const summary = []
  let totalRows = 0
  for (const name of files) {
    const file = path.join(args.dir, name)
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const lines = text.split(/\r?\n/)
    const seen = new Map()
    let rows = 0
    let blanks = 0
    const dups = []
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim()
      if (raw === '') { blanks++; continue }
      let record
      try {
        record = JSON.parse(raw)
      } catch (error) {
        errors.push(name + ':' + (i + 1) + ' JSON 解析失败 —— ' + String(error && error.message ? error.message : error))
        continue
      }
      const problems = checkRecord(record)
      if (problems.length > 0) { errors.push(name + ':' + (i + 1) + ' ' + problems.join('; ')); continue }
      rows++
      const key = String(record.tag)
      if (seen.has(key)) dups.push(key)
      else seen.set(key, i + 1)
    }
    totalRows += rows
    summary.push({ file: name, rows, blanks, dups: dups.length })
    for (const tag of dups) {
      errors.push(name + ' 里 tag 重复: ' + tag + '（索引合并安全，但文件脏了，建议删掉后出现的那行）')
    }
  }
  if (args.quiet === false) {
    for (const row of summary) console.log(row.file.padEnd(28) + String(row.rows).padStart(5) + ' 行' + (row.dups > 0 ? '  重复 ' + row.dups : ''))
    console.log('合计 ' + totalRows + ' 行 / ' + files.length + ' 个文件')
  }
  if (errors.length > 0) {
    console.error('')
    console.error('发现 ' + errors.length + ' 个问题：')
    for (const line of errors.slice(0, 60)) console.error('  ' + line)
    if (errors.length > 60) console.error('  ……还有 ' + (errors.length - 60) + ' 条')
    return 1
  }
  console.log('词表结构自检通过')
  return 0
}

process.exit(main())
