/**
 * SPI（服务提供接口）：给「以后接别的插件 / 做 web 版」留的扩展点。
 *
 * 设计原则：核心（tags / forge / refine / comfy）不 import 任何外部东西；
 * 外部想插进来，只能通过这个注册表 —— 注册在 runtime 里，卸载时整批 dispose。
 *
 * 三类扩展：
 *   1. 槽位（slot）：有明确契约的实现，同名 id 覆盖式注册，例如
 *        - tagProviders   { id, label, search(term, limit) → [{tag, cn}] }
 *        - postProcessors { id, apply(result, ctx) → result }（按注册顺序串行）
 *        - workflowBackends { id, label, ping(), listWorkflows(), submit(payload), status(id) }
 *   2. 钩子（hook）：生命周期回调，只能观察/改写传进来的 payload，不返回值
 *        - beforeForge / afterForge / beforeRefine / afterRefine / beforeSubmit / afterSubmit
 *   3. 自定义面板（web 版用）：{ id, label, mount(el, api) }
 *
 * 全部同步注册、异步执行；任何扩展抛错都只记日志，绝不打断主流程。
 */

import { configView, persistPatch } from './cordis/config.js'

export const SPI_VERSION = 1

export const SLOTS = ['tagProviders', 'postProcessors', 'workflowBackends', 'panels']

export const HOOKS = ['beforeForge', 'afterForge', 'beforeRefine', 'afterRefine', 'beforeSubmit', 'afterSubmit']

function msgOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {{ logger?: {info?:Function,warn?:Function}, config?: object }} options
 */
export function createRegistry({ logger, config } = {}) {
  const slots = new Map(SLOTS.map(name => [name, new Map()]))
  const hooks = new Map(HOOKS.map(name => [name, []]))

  function slotOf(name) {
    const slot = slots.get(name)
    if (slot === undefined) throw new Error('未知槽位：' + name + '（可用：' + SLOTS.join(', ') + '）')
    return slot
  }

  function hookOf(name) {
    const bus = hooks.get(name)
    if (bus === undefined) throw new Error('未知钩子：' + name + '（可用：' + HOOKS.join(', ') + '）')
    return bus
  }

  return {
    version: SPI_VERSION,

    /** 注册一个槽位实现；同名 id 会替换旧的，旧的 dispose 先跑。返回 dispose。 */
    register(slotName, id, impl, meta = {}) {
      const slot = slotOf(slotName)
      if (typeof id !== 'string' || id.trim() === '') throw new Error('SPI 注册需要非空 id')
      if (impl === null || typeof impl !== 'object') throw new Error('SPI 注册需要对象实现：' + slotName + '/' + id)
      const previous = slot.get(id)
      if (previous !== undefined) {
        try { previous.dispose?.() } catch (error) { logger?.warn?.('[tagger] SPI ' + id + ' dispose 失败：' + msgOf(error)) }
      }
      const entry = { id, ...meta, impl, dispose: null }
      const dispose = typeof impl.dispose === 'function' ? () => impl.dispose() : null
      entry.dispose = dispose
      slot.set(id, entry)
      logger?.info?.('[tagger] SPI 注册 ' + slotName + '/' + id)
      return () => {
        const current = slot.get(id)
        if (current === entry) slot.delete(id)
        try { dispose?.() } catch (error) { logger?.warn?.('[tagger] SPI ' + id + ' dispose 失败：' + msgOf(error)) }
      }
    },

    has(slotName, id) {
      return slots.get(slotName)?.has(id) === true
    },

    get(slotName, id) {
      return slots.get(slotName)?.get(id)?.impl
    },

    entries(slotName) {
      return [...(slots.get(slotName)?.values() ?? [])]
    },

    /** 只拿实现对象数组，按注册顺序。 */
    values(slotName) {
      return this.entries(slotName).map(entry => entry.impl)
    },

    on(hookName, fn, meta = {}) {
      const bus = hookOf(hookName)
      if (typeof fn !== 'function') throw new Error('钩子需要函数')
      const entry = { id: typeof meta.id === 'string' ? meta.id : 'hook-' + (bus.length + 1), fn, meta }
      bus.push(entry)
      return () => {
        const index = bus.indexOf(entry)
        if (index >= 0) bus.splice(index, 1)
      }
    },

    /** 依次调用钩子；payload 可被就地改写，单个钩子失败不影响后续。 */
    async emit(hookName, payload, ctx) {
      for (const entry of [...hookOf(hookName)]) {
        try {
          await entry.fn(payload, ctx)
        } catch (error) {
          logger?.warn?.('[tagger] 钩子 ' + hookName + '/' + entry.id + ' 失败（已忽略）：' + msgOf(error))
        }
      }
      return payload
    },

    /** 串行跑 postProcessors：每个都拿到上一步的结果。 */
    async applyPostProcessors(result, ctx) {
      let current = result
      for (const impl of this.values('postProcessors')) {
        if (typeof impl.apply !== 'function') continue
        try {
          const next = await impl.apply(current, ctx)
          if (next !== undefined && next !== null) current = next
        } catch (error) {
          logger?.warn?.('[tagger] postProcessor ' + (impl.id ?? '?') + ' 失败（已跳过）：' + msgOf(error))
        }
      }
      return current
    },

    /** 标签补源：本地索引没命中时按顺序问 providers，第一个给出结果的胜出。 */
    async searchProviders(term, limit) {
      for (const impl of this.values('tagProviders')) {
        if (typeof impl.search !== 'function') continue
        try {
          const rows = await impl.search(term, limit)
          if (Array.isArray(rows) && rows.length > 0) return rows
        } catch (error) {
          logger?.warn?.('[tagger] tagProvider ' + (impl.id ?? '?') + ' 失败（已跳过）：' + msgOf(error))
        }
      }
      return []
    },

    /** GET /spi 的返回体：列出所有扩展点，便于「以后接别的插件」时自检。 */
    describe() {
      const out = { version: SPI_VERSION, slots: {}, hooks: {} }
      for (const name of SLOTS) {
        out.slots[name] = this.entries(name).map(entry => ({ id: entry.id, label: entry.label ?? entry.id }))
      }
      for (const name of HOOKS) {
        out.hooks[name] = hooks.get(name).map(entry => entry.id)
      }
      out.backends = this.entries('workflowBackends').map(entry => ({ id: entry.id, label: entry.label ?? entry.id }))
      return out
    },
  }
}

/**
 * 运行时里可以被装进 ctx 的服务名（顺序即装配顺序）。插件模式下这些由 DSH 的容器提供，
 * 独立入口（server/standalone.mjs）自己把它们补进最小 ctx。
 */
export const SERVICE_KEYS = ['llm', 'webServer', 'tools', 'tags', 'forge', 'refine', 'comfy', 'poses', 'spi', 'mcp']

/**
 * 从 runtime 摘一份服务表：只收真有的（null / undefined 跳过），独立入口无痛装配。
 * @param {Record<string, any>} rt createRuntime 的返回值
 * @param {string[]} [keys] 默认 SERVICE_KEYS
 * @returns {Record<string, any>}
 */
export function servicesOf(rt, keys = SERVICE_KEYS) {
  /** @type {Record<string, any>} */
  const out = {}
  if (rt === null || typeof rt !== 'object') return out
  for (const key of keys) {
    if (rt[key] !== null && rt[key] !== undefined) out[key] = rt[key]
  }
  return out
}

/**
 * 把 runtime 的服务装进 ctx：独立入口建好 rt 之后调一次（插件模式下由宿主容器负责）。
 * @param {{ provide?: (name: string, value: any) => any }} ctx
 * @param {Record<string, any>} rt
 * @param {string[]} [keys] 默认 SERVICE_KEYS
 * @returns {string[]} 实际装进去的服务名
 */
export function bindServices(ctx, rt, keys = SERVICE_KEYS) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.provide !== 'function') return []
  /** @type {string[]} */
  const provided = []
  for (const [name, value] of Object.entries(servicesOf(rt, keys))) {
    try {
      ctx.provide(name, value)
      provided.push(name)
    } catch (error) {
      console.warn('[tagger] ctx.provide(' + name + ') 失败（已跳过）：' + msgOf(error))
    }
  }
  return provided
}

/** 配置读取的统一入口（面板、独立入口都走这里，别各自拼 configView）。 */
export function readConfig(rt) {
  return configView(rt)
}

/** 配置落盘（patch 合并 + 归一化 + 写 settings.json）的统一入口。 */
export function saveConfig(rt, patch) {
  return persistPatch(rt, patch ?? {})
}
