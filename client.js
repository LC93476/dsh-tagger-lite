/**
 * dsh-tagger · 左侧栏面板（浏览器侧，classic script，无构建）
 *
 * 这个文件只是**门面**：注册 id、装载 client/ 下的 ESM 子模块、把面板挂到侧边栏。
 * 面板本体在 client/panel.js（状态与动作）、client/view-*.js（渲染）、client/locale.js（文案）……
 * 子模块由宿主按 {PREFIX}/_mod/client/<name>.js 提供（text/javascript）；测试用 __DSH_TAGGER_MODBASE__ 喂 file:// 基址。
 *
 * 三条铁律：
 *   1. 这是 classic script，不能有顶层 import/export —— 只能用动态 import()。
 *   2. locale / betterSidebar 只能走 ctx.inject(['x'], scope => ...)，直接 ctx.get 会抛 inject 错误。
 *   3. 子模块加载失败也**不许**把插件标成 failed：降级成一张错误卡，apply 照常返回、slots 照常注册。
 */
window.__ModuleLoader__.load({
  // 这段注册 id 必须与包名一致：宿主按 package.json 的 name 取出模块行（graphRow(packageName, ...)），
  // 再在 __ModuleLoader__ 的工厂表里找同名 id。改成旧名 dsh-prompt-forge 会让宿主报
  // `could not load "dsh-tagger": loaded without registering "dsh-tagger"`。
  id: 'dsh-tagger',
  factory(require) {
    const React = require('react')

    const NS = 'dsh-tagger'
    // 主注册前缀是 lib/routes.js 的 PREFIX（/tagger/api）；/prompt-forge/api 只是旧前缀别名。
    const API = '/tagger/api'
    const LEGACY_API = '/prompt-forge/api'
    const PANEL_ID = 'prompt-forge'
    const TAB_ID = 'prompt-forge:forge'
    const MODBASE_KEY = '__DSH_TAGGER_MODBASE__'
    const MODCACHE_KEY = '__DSH_TAGGER_MODS__'
    // 子模块加载失败时面板还得能显示一句人话：这三个键不许走字典（字典本身也没加载成功）。
    const FALLBACK_TEXT = {
      'panel': '提示词',
      'meta.title': '提示词锻造台',
      'meta.description': '白话 → WD/Camie 标签 → ComfyUI',
    }

    function fallbackT(key) {
      return Object.prototype.hasOwnProperty.call(FALLBACK_TEXT, key) ? FALLBACK_TEXT[key] : String(key)
    }

    /** 基址候选：测试注入的 file:// 优先，然后主前缀，最后旧前缀。
     *  注意必须带 client/ 段：宿主的 _mod 路由白名单是 /^client\/[a-z0-9][a-z0-9-]*\.js$/，
     *  写成 {PREFIX}/_mod/<name>.js 会被判 400 bad-module。 */
    function baseList() {
      const list = []
      const injected = typeof globalThis !== 'undefined' ? globalThis[MODBASE_KEY] : ''
      if (typeof injected === 'string' && injected !== '') list.push(injected.endsWith('/') ? injected : injected + '/')
      list.push(API + '/_mod/client/', LEGACY_API + '/_mod/client/')
      return list
    }

    /** 测试里会提前 import 好并塞进 globalThis，这样 __internals 与 apply 都能同步用。 */
    function cachedModules() {
      if (typeof globalThis === 'undefined') return null
      const value = globalThis[MODCACHE_KEY]
      const usable = value !== null && typeof value === 'object' && typeof value.then !== 'function' && typeof value.createPanel === 'function'
      return usable ? value : null
    }

    let mods = cachedModules()
    let pending = null
    let built = null

    function loadModules() {
      if (mods !== null) return Promise.resolve({ ok: true, mods })
      if (pending !== null) return pending
      pending = (async () => {
        let lastError = null
        for (const base of baseList()) {
          try {
            const loaded = await import(base + 'panel.js')
            if (loaded === null || typeof loaded.createPanel !== 'function') throw new Error('panel.js 缺 createPanel')
            mods = loaded
            try {
              globalThis[MODCACHE_KEY] = loaded
            } catch (error) {
              // 冻结的 globalThis 也能忍：只是少一层缓存
            }
            return { ok: true, mods: loaded }
          } catch (error) {
            lastError = error
          }
        }
        return { ok: false, error: lastError }
      })()
      return pending
    }

    function instantiate(loaded) {
      if (built !== null) return built
      built = {
        Panel: loaded.createPanel({ React }).Panel,
        PanelIcon: loaded.createIcon({ React }),
      }
      return built
    }

    /** 加载失败时的极简卡：说清发生了什么、提示重启宿主，不做任何注册之外的副作用。 */
    function brokenPanel(error) {
      const message = error instanceof Error ? error.message : String(error ?? '')
      function LoadFailedCard() {
        return React.createElement('div', { class: 'ptf', 'data-testid': 'ptf-load-error' },
          React.createElement('div', { class: 'ptf-error', 'data-testid': 'ptf-load-error-message' },
            '子模块加载失败：' + message),
          React.createElement('div', { class: 'ptf-hint' },
            '面板的客户端子模块（client/panel.js）没取到，重启宿主后重试；其余功能不受影响。'),
        )
      }
      return LoadFailedCard
    }

    function brokenIcon() {
      return React.createElement('svg', {
        viewBox: '0 0 24 24',
        width: 18,
        height: 18,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        'aria-hidden': true,
        focusable: false,
      }, React.createElement('path', { d: 'M12 8v5' }), React.createElement('path', { d: 'M12 16.5v.01' }))
    }

    function registerAll(ctx, parts, t) {
      const Panel = parts.Panel
      const PanelIcon = parts.PanelIcon

      // 客户端 cordis 不能在声明 inject 之外直接摸服务（会抛 cannot get property "locale" without inject），
      // 所以 locale / betterSidebar 都走 ctx.inject(['x'], scope => ...)：服务缺席时回调不执行，面板照样挂载。
      if (mods !== null && typeof mods.withFallback === 'function' && typeof mods.dict === 'object' && typeof ctx.inject === 'function') {
        try {
          ctx.inject(['locale'], scope => {
            const locale = scope.locale
            if (locale === null || locale === undefined || typeof locale.register !== 'function') return
            const register = () => {
              const dispose = locale.register(NS, { zh: mods.dict.zh, en: mods.dict.en })
              if (typeof locale.bind === 'function') t.value = mods.withFallback(locale.bind(NS), mods.createT('zh'))
              return dispose
            }
            if (typeof scope.effect === 'function') scope.effect(register, 'tagger: dictionaries')
            else register()
          })
        } catch (error) {
          warn('locale', error)
        }
      }

      // betterSidebar 是可选注入：没有这个服务时 cordis 只是不执行回调，原生面板照样在。
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['betterSidebar'], scope => {
            const sidebar = scope?.betterSidebar ?? (typeof scope?.get === 'function' ? scope.get('betterSidebar') : undefined)
            if (sidebar === undefined || sidebar === null || typeof sidebar.registerTab !== 'function') return
            const register = () => sidebar.registerTab({
              id: TAB_ID,
              title: t.value('meta.title'),
              description: t.value('meta.description'),
              icon: PanelIcon,
              order: 41,
              single: true,
              component: Panel,
            })
            if (typeof scope.effect === 'function') scope.effect(register, 'tagger: betterSidebar tab')
            else register()
          })
        }
      } catch (error) {
        warn('betterSidebar', error)
      }

      const slots = ctx.slots
      if (slots === undefined || slots === null || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        warn('slots', 'slots 服务不可用，面板没有运行时挂载点。')
        return
      }

      slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 41,
        locale: NS,
        label: () => t.value('panel'),
      }, PanelIcon))

      slots.inject('main', () => slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ t: t.value, api: API }),
      }, Panel))
    }

    function internalsOf(loaded) {
      const parts = instantiate(loaded)
      return {
        Panel: parts.Panel,
        PanelIcon: parts.PanelIcon,
        dict: loaded.dict,
        createT: loaded.createT,
        formatTag: loaded.formatTag,
        formatTagLine: loaded.formatTagLine,
        normalizeTags: loaded.normalizeTags,
        normalizePipeline: loaded.normalizePipeline,
        normalizePurge: loaded.normalizePurge,
        normalizeDelta: loaded.normalizeDelta,
        chosenStandards: loaded.chosenStandards,
        apiUrl: loaded.apiUrl,
        imageSrc: loaded.imageSrc,
        requestJson: loaded.requestJson,
        NS: loaded.NS,
        API: loaded.API,
        PANEL_ID: loaded.PANEL_ID,
        LEVELS: loaded.LEVELS,
      }
    }

    function warn(where, error) {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        const message = error instanceof Error ? error.message : String(error)
        console.warn('[tagger] ' + where + ': ' + message)
      }
    }

    /**
     * apply 可能异步（要先等子模块），但注册动作本身永远是同步的一整段：
     * 先 await 拿 Component，再在同一个微任务里把 slots 全注册掉，避免宿主判 missing slot。
     */
    function apply(ctx) {
      const t = { value: mods !== null ? mods.createT('zh') : fallbackT }
      if (mods !== null) {
        registerAll(ctx, instantiate(mods), t)
        return undefined
      }
      return loadModules().then(result => {
        if (result.ok) {
          t.value = result.mods.createT('zh')
          registerAll(ctx, instantiate(result.mods), t)
          return undefined
        }
        warn('modules', result.error)
        registerAll(ctx, { Panel: brokenPanel(result.error), PanelIcon: brokenIcon }, t)
      })
    }

    const face = { name: 'dsh-tagger', inject: ['slots'], apply }
    // 宿主不读 __internals；测试在预载模块后直接拿它测纯函数与组件。
    if (mods !== null) face.__internals = internalsOf(mods)

    return face
  },
})
