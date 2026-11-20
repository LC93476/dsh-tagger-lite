/* 姿势画廊（tag 版）：原生脚本，零构建、零依赖、零外链。
   数据优先走 /tagger/api/pose-gallery（分组 / 计数 / 视角 / 分页），
   接口缺席时退回已有的 /poses 在前端分组（只是兜底，不当作主路径）。 */
(function () {
  'use strict'

  var API = '/tagger/api'
  var PAGE = 120
  var PENDING_KEY = 'dsh-tagger:pending-prompt'
  var ANGLE_ORDER = ['正面', '斜侧', '侧面', '俯视', '仰视', '背面']
  var ANGLE_LABELS = {
    front: '正面', diag: '斜侧', side: '侧面', back: '背面', top: '俯视',
    up: '仰视', down: '俯视', low: '仰视', high: '俯视', front_side: '斜侧', three_quarter: '斜侧'
  }
  var SET_ZH = { full_single: '标准系', full_sexy: '性感系', bust_single: '上半身', pair: '双人' }
  var SET_HINT = [['sexy', '性感系'], ['bust', '上半身'], ['pair', '双人'], ['single', '标准系']]
  var TOAST_MS = 1500
  var CAT_PILLS = 12

  var state = {
    set: '',
    q: '',
    category: '',
    angle: '',
    groups: [],
    total: 0,
    shown: 0,
    offset: 0,
    sets: [],
    categories: [],
    angles: [],
    loading: false,
    exhausted: false,
    degraded: false,
    modalFrom: null,
    picked: null,
    tagSeq: 0,
    tags: { base: '', angle: '', list: [], note: '' },
    tagsLoading: false,
    removed: {},
    toastTimer: 0
  }

  // ---------- 小工具 ----------
  function $(id) { return document.getElementById(id) }

  function h(tag, attrs, kids) {
    var node = document.createElement(tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (name) {
        var value = attrs[name]
        if (value === null || value === undefined || value === false) return
        if (name === 'class') node.className = value
        else if (name === 'text') node.textContent = String(value)
        else if (name.slice(0, 2) === 'on') node.addEventListener(name.slice(2), value)
        else node.setAttribute(name, value === true ? '' : String(value))
      })
    }
    ;(kids || []).forEach(function (kid) { if (kid) node.appendChild(kid) })
    return node
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild) }

  function num(value, fallback) {
    var n = Number(value)
    return isFinite(n) ? n : fallback
  }

  function qs(params) {
    var parts = []
    Object.keys(params).forEach(function (key) {
      var value = params[key]
      if (value === '' || value === null || value === undefined) return
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value))
    })
    return parts.join('&')
  }

  function getJson(path) {
    return fetch(path, { headers: { accept: 'application/json' } }).then(function (res) {
      return res.json().then(function (data) {
        return { status: res.status, data: data && typeof data === 'object' ? data : {} }
      }).catch(function () {
        return { status: res.status, data: {} }
      })
    })
  }

  function thumbUrl(id) { return API + '/pose-thumb?id=' + encodeURIComponent(String(id || '')) }

  function angleLabel(angle) {
    if (!angle) return ''
    return ANGLE_LABELS[angle] || String(angle)
  }

  function setLabel(key) {
    if (!key) return '未分组'
    if (SET_ZH[key]) return SET_ZH[key]
    for (var i = 0; i < SET_HINT.length; i++) {
      if (String(key).indexOf(SET_HINT[i][0]) >= 0) return SET_HINT[i][1]
    }
    return String(key)
  }

  function orderedAngles(list) {
    var seen = {}
    var out = []
    ;(list || []).forEach(function (raw) {
      var key = typeof raw === 'string' ? raw : String((raw && (raw.key || raw.angle)) || '')
      if (key === '' || seen[key]) return
      seen[key] = true
      out.push(key)
    })
    return out.sort(function (a, b) {
      var ia = ANGLE_ORDER.indexOf(angleLabel(a))
      var ib = ANGLE_ORDER.indexOf(angleLabel(b))
      if (ia < 0 && ib < 0) return a < b ? -1 : 1
      if (ia < 0) return 1
      if (ib < 0) return -1
      return ia - ib
    })
  }

  // ---------- 数据 ----------
  function normalizeGroup(raw) {
    if (!raw || typeof raw !== 'object') return null
    var variants = (Array.isArray(raw.variants) ? raw.variants : []).map(function (item) {
      var id = String((item && item.id) || '')
      var angle = String((item && item.angle) || '')
      var thumb = (item && item.thumb) || thumbUrl(id)
      // 服务端的 image 是姿势库里的相对路径（../../img/x.png），浏览器里解不出来；
      // 只有以 / 开头的站内地址才直接用，其余一律走 220px 缩略图接口。
      var raw = String((item && item.image) || '')
      return { id: id, angle: angle, thumb: thumb, image: raw.charAt(0) === '/' ? raw : thumb }
    }).filter(function (item) { return item.id !== '' })
    if (variants.length === 0) return null
    var base = String(raw.base || variants[0].id)
    return {
      base: base,
      code: String(raw.code || ''),
      name: String(raw.name || raw.code || base),
      set: String(raw.set || ''),
      setLabel: String(raw.setLabel || setLabel(raw.set)),
      category: String(raw.category || '未分类'),
      count: num(raw.count, variants.length),
      variants: variants
    }
  }

  function indexOfGroup(base) {
    for (var i = 0; i < state.groups.length; i++) if (state.groups[i].base === base) return i
    return -1
  }

  function applyPage(data, reset) {
    state.degraded = false
    if (reset) state.groups = []
    var incoming = Array.isArray(data.groups) ? data.groups : []
    incoming.forEach(function (raw) {
      var group = normalizeGroup(raw)
      if (!group) return
      var at = indexOfGroup(group.base)
      if (at >= 0) state.groups[at] = group
      else state.groups.push(group)
    })
    state.total = num(data.total, state.groups.length)
    state.shown = num(data.shown, state.groups.length)
    state.offset = num(data.offset, state.shown)
    if (Array.isArray(data.sets) && data.sets.length) state.sets = data.sets
    if (Array.isArray(data.categories) && data.categories.length) state.categories = data.categories
    if (Array.isArray(data.angles) && data.angles.length) state.angles = data.angles
    state.exhausted = incoming.length < PAGE
  }

  function fallbackGroups(reset) {
    // 兜底：/poses 只有扁平行，前端按 set + code 归组；分页用 offset+PAGE 切片。
    var query = qs({ set: state.set, q: state.q, limit: 0 })
    return getJson(API + '/poses?' + query).then(function (res) {
      var data = res.data || {}
      state.degraded = true
      if (res.status !== 200 || data.ok !== true || !Array.isArray(data.poses)) {
        if (reset) state.groups = []
        state.total = 0
        state.exhausted = true
        return
      }
      var rows = data.poses
      var byKey = {}
      var list = []
      var counts = {}
      rows.forEach(function (row) {
        var key = String(row.set || '') + '|' + String(row.code || row.id || '')
        var group = byKey[key]
        if (!group) {
          group = {
            base: key,
            code: String(row.code || ''),
            name: String(row.name || row.code || row.id || ''),
            set: String(row.set || ''),
            setLabel: setLabel(row.set),
            category: String(row.category || '未分类'),
            count: 0,
            variants: []
          }
          byKey[key] = group
          list.push(group)
          counts[group.category] = (counts[group.category] || 0) + 1
        }
        group.count += 1
        if (group.variants.length < 8) {
          group.variants.push({
            id: String(row.id),
            angle: String(row.angle || ''),
            thumb: thumbUrl(row.id),
            image: thumbUrl(row.id)
          })
        }
      })
      var sets = Array.isArray(data.sets) ? data.sets : []
      state.sets = sets.map(function (key) {
        return { key: key, label: setLabel(key), count: list.filter(function (g) { return g.set === key }).length }
      })
      state.categories = Object.keys(counts).sort().map(function (key) { return { key: key, count: counts[key] } })
      state.angles = orderedAngles([].concat.apply([], list.map(function (g) {
        return g.variants.map(function (v) { return v.angle })
      })))
      var filtered = list
      if (state.category) filtered = filtered.filter(function (g) { return g.category === state.category })
      if (state.angle) {
        filtered = filtered.filter(function (g) {
          return g.variants.some(function (v) { return v.angle === state.angle })
        })
      }
      var end = Math.min(filtered.length, (reset ? 0 : state.offset) + PAGE)
      state.groups = filtered.slice(0, end)
      state.total = filtered.length
      state.shown = state.groups.length
      state.offset = end
      state.exhausted = end >= filtered.length
    })
  }

  function load(reset) {
    if (state.loading) return
    if (!reset && state.exhausted) return
    if (reset) {
      state.offset = 0
      state.shown = 0
      state.exhausted = false
    }
    state.loading = true
    if (reset) showSkeleton(true)
    setMore()
    var query = qs({
      set: state.set, q: state.q, category: state.category, angle: state.angle,
      limit: PAGE, offset: reset ? 0 : state.offset
    })
    getJson(API + '/pose-gallery?' + query).then(function (res) {
      var data = res.data || {}
      if (res.status === 200 && data.ok === true && Array.isArray(data.groups)) {
        applyPage(data, reset)
        return true
      }
      return fallbackGroups(reset)
    }).catch(function () {
      return fallbackGroups(reset)
    }).then(function () {
      state.loading = false
      showSkeleton(false)
      render()
    })
  }

  // ---------- 渲染 ----------
  function setList() {
    var seen = {}
    var out = []
    ;(state.sets || []).forEach(function (item) {
      var key = typeof item === 'string' ? item : String((item && item.key) || '')
      // 服务端在清单最前面塞了一个聚合项 all（全部 288），分段控件自己就有「全部」，别重复
      if (key === '' || key === 'all' || seen[key]) return
      seen[key] = true
      out.push({
        key: key,
        label: (item && item.label) || setLabel(key),
        count: num(item && item.count, 0)
      })
    })
    if (out.length === 0) {
      state.groups.forEach(function (group) {
        if (seen[group.set]) return
        seen[group.set] = true
        out.push({ key: group.set, label: group.setLabel, count: 0 })
      })
    }
    return out
  }

  function renderSets() {
    var box = $('set-list')
    if (!box) return
    clear(box)
    var sets = setList()
    var all = h('a', { class: 'nav-i' + (state.set === '' ? ' is-on' : ''), href: '#all', text: '全部姿势' }, [])
    if (state.set === '') all.setAttribute('aria-current', 'page')
    all.addEventListener('click', function (ev) { ev.preventDefault(); pickSet('') })
    box.appendChild(all)
    sets.forEach(function (item) {
      var link = h('a', {
        class: 'nav-i' + (state.set === item.key ? ' is-on' : ''),
        href: '#set-' + item.key
      }, [h('span', { text: item.label })])
      if (item.count > 0) link.appendChild(h('span', { class: 'nav-count', text: String(item.count) }))
      if (state.set === item.key) link.setAttribute('aria-current', 'page')
      link.addEventListener('click', function (ev) { ev.preventDefault(); pickSet(item.key) })
      box.appendChild(link)
    })
  }

  function renderSeg() {
    var box = $('system-seg')
    if (!box) return
    clear(box)
    var items = [{ key: '', label: '全部' }].concat(setList())
    items.forEach(function (item) {
      var on = state.set === item.key
      var btn = h('button', {
        type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false',
        text: item.label
      })
      btn.addEventListener('click', function () { pickSet(item.key) })
      box.appendChild(btn)
    })
  }

  function renderPills() {
    var box = $('pills')
    if (!box) return
    clear(box)
    var pill = function (label, count, on, onClick) {
      var node = h('button', {
        class: 'pill', type: 'button', 'aria-pressed': on ? 'true' : 'false'
      }, [h('span', { text: label })])
      if (count > 0) node.appendChild(h('span', { class: 'n', text: String(count) }))
      node.addEventListener('click', onClick)
      return node
    }
    box.appendChild(pill('全部', 0, state.category === '', function () { pickCategory('') }))
    var list = (state.categories || []).filter(function (item) {
      return (typeof item === 'string' ? item : String((item && item.key) || '')) !== ''
    })
    // 分类有三十来个：默认只露前 12 个（已选中的一定露），其余折进「更多分类」
    var head = list.slice(0, CAT_PILLS)
    var hiddenCount = list.length - head.length
    var current = list.filter(function (item) {
      return (typeof item === 'string' ? item : item.key) === state.category
    })
    if (state.category !== '' && head.indexOf(current[0]) < 0 && current.length) head = head.concat(current)
    head.forEach(function (item) {
      var key = typeof item === 'string' ? item : String((item && item.key) || '')
      box.appendChild(pill(key, num(item && item.count, 0), state.category === key, function () {
        pickCategory(state.category === key ? '' : key)
      }))
    })
    if (state.catsOpen) {
      list.slice(CAT_PILLS).forEach(function (item) {
        var key = typeof item === 'string' ? item : String((item && item.key) || '')
        box.appendChild(pill(key, num(item && item.count, 0), state.category === key, function () {
          pickCategory(state.category === key ? '' : key)
        }))
      })
    } else if (hiddenCount > 0) {
      var more = h('button', { class: 'pill', type: 'button', text: '更多分类 ＋' + hiddenCount })
      more.addEventListener('click', function () { state.catsOpen = true; renderPills() })
      box.appendChild(more)
    }
  }

  function renderAngles() {
    var box = $('angles')
    if (!box) return
    clear(box)
    var list = orderedAngles(state.angles.length ? state.angles : [].concat.apply([], state.groups.map(function (g) {
      return g.variants.map(function (v) { return v.angle })
    })))
    box.appendChild(h('button', {
      class: 'pill', type: 'button', 'aria-pressed': state.angle === '' ? 'true' : 'false', text: '全部视角',
      onclick: function () { pickAngle('') }
    }))
    list.forEach(function (angle) {
      var btn = h('button', {
        class: 'pill', type: 'button',
        'aria-pressed': state.angle === angle ? 'true' : 'false',
        text: angleLabel(angle)
      })
      btn.addEventListener('click', function () { pickAngle(state.angle === angle ? '' : angle) })
      box.appendChild(btn)
    })
  }

  function renderCategorySelect() {
    var box = $('category')
    if (!box) return
    var current = state.category
    clear(box)
    box.appendChild(h('option', { value: '', text: '全部分类' }))
    ;(state.categories || []).forEach(function (item) {
      var key = typeof item === 'string' ? item : String((item && item.key) || '')
      if (key === '') return
      box.appendChild(h('option', { value: key, text: key }))
    })
    box.value = current
  }

  function currentVariant(group) {
    if (state.picked && state.picked.base === group.base) {
      for (var i = 0; i < group.variants.length; i++) {
        if (group.variants[i].id === state.picked.variantId) return group.variants[i]
      }
    }
    return group.variants[0]
  }

  function imageNode(src, alt) {
    var img = h('img', { src: src, alt: alt, loading: 'lazy', decoding: 'async' })
    img.addEventListener('error', function () {
      var miss = h('span', { class: 'miss', text: '无缩略图' })
      if (img.parentNode) img.parentNode.replaceChild(miss, img)
    })
    return img
  }

  function renderCard(group) {
    var variant = currentVariant(group)
    var picked = !!(state.picked && state.picked.base === group.base)
    var card = h('div', {
      class: 'gcard',
      role: 'button',
      tabindex: '0',
      'aria-pressed': picked ? 'true' : 'false',
      'data-base': group.base,
      'aria-label': group.name + ' · ' + group.setLabel + ' · ' + group.category,
      'aria-keyshortcuts': 'Enter Space'
    })
    card.appendChild(h('div', { class: 'gcard-img' }, [
      imageNode(variant.image, group.name + '（' + (angleLabel(variant.angle) || '默认视角') + '）'),
      h('span', { class: 'gcard-code', text: group.code || '' }),
      h('span', { class: 'gcard-angle', text: angleLabel(variant.angle) }),
      h('span', { class: 'gcard-add', text: '＋ 加入提示词' })
    ]))
    card.appendChild(h('div', { class: 'gcard-cap' }, [
      h('div', { class: 'gcard-name', text: group.name }),
      h('div', { class: 'gcard-meta' }, [
        h('span', { text: group.setLabel + ' · ' + group.category }),
        h('span', { class: 'gcard-count', text: group.count > 1 ? group.count + ' 视角' : '' })
      ])
    ]))
    if (group.variants.length > 1) {
      var row = h('div', { class: 'gcard-thumbs' })
      group.variants.slice(0, 5).forEach(function (item) {
        var on = item.id === variant.id
        var thumb = h('button', {
          class: 'gcard-thumb', type: 'button',
          'aria-pressed': on ? 'true' : 'false',
          title: angleLabel(item.angle) || item.id,
          'aria-label': '切换视角：' + (angleLabel(item.angle) || item.id)
        }, [imageNode(item.thumb, group.name + ' ' + (angleLabel(item.angle) || ''))])
        thumb.addEventListener('click', function (ev) {
          ev.stopPropagation()
          pick(group, item.id)
        })
        row.appendChild(thumb)
      })
      card.appendChild(row)
    }
    card.addEventListener('click', function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('.gcard-thumb')) return
      pick(group, variant.id)
    })
    card.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      pick(group, variant.id)
    })
    return card
  }

  function renderGrid() {
    var grid = $('grid')
    if (!grid) return
    clear(grid)
    state.groups.forEach(function (group) { grid.appendChild(renderCard(group)) })
    var empty = $('empty')
    if (empty) empty.hidden = !(state.groups.length === 0 && !state.loading)
    var note = $('note')
    if (note) {
      note.hidden = !state.degraded
      note.textContent = state.degraded ? '分组接口还没就绪，正用本机姿势库临时分组渲染（功能完整，计数略简）。' : ''
    }
    var badge = $('count-badge')
    if (badge) badge.textContent = state.total + ' 组' + (state.degraded ? ' · 降级' : '')
  }

  function renderDock() {
    var dock = $('dock')
    if (!dock) return
    var picked = state.picked
    dock.hidden = !picked
    if (!picked) return
    var group = picked.group
    var variant = picked.variant || currentVariant(group)
    var name = $('dock-name')
    if (name) name.textContent = group.name
    var meta = $('dock-meta')
    if (meta) meta.textContent = [group.setLabel, group.category, group.code, angleLabel(variant.angle)].filter(Boolean).join(' · ')
    var thumb = $('dock-thumb')
    if (thumb) {
      thumb.src = variant.image
      thumb.alt = group.name
    }
    var chips = $('dock-chips')
    if (chips) {
      clear(chips)
      var tags = visibleTags()
      tags.forEach(function (item) {
        var chip = h('button', {
          class: 'chip', type: 'button', title: (item.cn || item.tag) + '（点击移除）',
          text: item.tag
        })
        chip.addEventListener('click', function () {
          state.removed[item.tag] = true
          renderDock()
        })
        chips.appendChild(chip)
      })
      if (state.tagsLoading) chips.appendChild(h('span', { class: 'dim', text: '取 tag 中…' }))
    }
    var note = $('dock-note')
    if (note) {
      var text = state.tags.note || ''
      note.hidden = text === ''
      note.textContent = text
    }
    var has = visibleTags().length > 0
    ;['dock-copy', 'dock-fill'].forEach(function (id) {
      var btn = $(id)
      if (btn) btn.disabled = !has
    })
  }

  function render() {
    renderSets()
    renderSeg()
    renderPills()
    renderAngles()
    renderCategorySelect()
    renderGrid()
    renderDock()
    setMore()
  }

  function setMore() {
    var more = $('more')
    if (!more) return
    more.hidden = state.loading || state.exhausted || state.groups.length === 0
  }

  function showSkeleton(on) {
    var sk = $('skeleton')
    var grid = $('grid')
    if (!sk) return
    if (on) {
      if (sk.childNodes.length === 0) {
        for (var i = 0; i < 12; i++) sk.appendChild(h('div', { class: 'sk' }))
      }
      sk.hidden = false
      if (grid) grid.hidden = true
    } else {
      sk.hidden = true
      if (grid) grid.hidden = false
    }
  }

  // ---------- tag ----------
  function tagsOf(payload) {
    var out = []
    var seen = {}
    ;[['pose', '动作'], ['camera', '视角'], ['tags', '其它']].forEach(function (pair) {
      var list = Array.isArray(payload[pair[0]]) ? payload[pair[0]] : []
      list.forEach(function (item) {
        var tag = typeof item === 'string' ? item : String((item && item.tag) || '')
        tag = tag.trim()
        if (tag === '' || seen[tag]) return
        seen[tag] = true
        out.push({
          tag: tag,
          cn: typeof item === 'object' && item ? String(item.cn || '') : '',
          group: pair[1]
        })
      })
    })
    return out
  }

  function visibleTags() {
    return (state.tags.list || []).filter(function (item) { return !state.removed[item.tag] })
  }

  function tagLine() {
    return visibleTags().map(function (item) { return item.tag }).join(', ')
  }

  function loadTags(group, angle) {
    state.tagSeq += 1
    var token = state.tagSeq
    state.tagsLoading = true
    state.removed = {}
    state.tags = { base: group.base, angle: angle, list: [], note: '' }
    renderDock()
    var query = qs({ base: group.base, angle: angle, code: group.code, name: group.name })
    getJson(API + '/pose-tags?' + query).then(function (res) {
      if (token !== state.tagSeq) return
      var data = res.data || {}
      state.tagsLoading = false
      if (res.status !== 200 || data.ok !== true) {
        state.tags = { base: group.base, angle: angle, list: [], note: '标签接口还没就绪，先复制编号用着。' }
      } else {
        var list = tagsOf(data)
        state.tags = {
          base: group.base, angle: angle, list: list,
          note: list.length ? '' : '这个视角暂时没有 tag。'
        }
      }
      renderDock()
    }).catch(function () {
      if (token !== state.tagSeq) return
      state.tagsLoading = false
      state.tags = { base: group.base, angle: angle, list: [], note: '标签接口还没就绪，先复制编号用着。' }
      renderDock()
    })
  }

  // ---------- 交互 ----------
  function pickSet(key) {
    if (state.set === key) return
    state.set = key
    load(true)
    render()
  }

  function pickCategory(key) {
    state.category = key
    load(true)
    render()
  }

  function pickAngle(key) {
    state.angle = key
    load(true)
    render()
  }

  function pick(group, variantId) {
    if (!group) return
    var variant = null
    for (var i = 0; i < group.variants.length; i++) {
      if (group.variants[i].id === variantId) variant = group.variants[i]
    }
    if (!variant) variant = group.variants[0]
    var same = !!(state.picked && state.picked.base === group.base && state.picked.variantId === variant.id)
    state.picked = { base: group.base, variantId: variant.id, group: group, variant: variant }
    loadTags(group, variant.angle)
    if (!same) renderGrid()
    renderDock()
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true }).catch(function () {
        return legacyCopy(text)
      })
    }
    return Promise.resolve(legacyCopy(text))
  }

  function legacyCopy(text) {
    var area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.left = '-9999px'
    document.body.appendChild(area)
    area.select()
    var ok = false
    try { ok = document.execCommand('copy') } catch (err) { ok = false }
    document.body.removeChild(area)
    return ok
  }

  function toast(text) {
    var box = $('toast')
    if (!box) return
    box.textContent = text
    box.hidden = false
    if (state.toastTimer) window.clearTimeout(state.toastTimer)
    state.toastTimer = window.setTimeout(function () { box.hidden = true }, TOAST_MS)
  }

  function copyTags() {
    var line = tagLine()
    if (line === '') { toast('还没有可复制的 tag'); return }
    copyText(line).then(function (ok) { toast(ok ? '已复制 ' + visibleTags().length + ' 个 tag' : '复制失败，请手动选中') })
  }

  function fillPanel() {
    var line = tagLine()
    if (line === '') { toast('还没有可填入的 tag'); return }
    try {
      window.localStorage.setItem(PENDING_KEY, line)
    } catch (err) {
      toast('这个浏览器不让写本地存储，先复制吧')
      return
    }
    toast('已带去锻造面板')
    window.location.href = '/'
  }

  function resetFilters() {
    var had = state.set !== '' || state.q !== '' || state.category !== '' || state.angle !== ''
    state.set = ''
    state.q = ''
    state.category = ''
    state.angle = ''
    var input = $('q')
    if (input) input.value = ''
    if (had) load(true)
    render()
  }

  function debounce(fn, wait) {
    var timer = 0
    return function () {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(fn, wait)
    }
  }

  function openAbout(which) {
    var modal = $('about-modal')
    if (!modal) return
    state.modalFrom = document.activeElement
    modal.hidden = false
    document.body.classList.add('modal-on')
    var sec = which === 'source' ? $('about-source') : null
    if (sec) {
      sec.classList.add('is-hit')
      window.setTimeout(function () { sec.classList.remove('is-hit') }, 1600)
      if (sec.scrollIntoView) sec.scrollIntoView({ block: 'nearest' })
    }
    var closeBtn = $('about-close')
    if (closeBtn) closeBtn.focus()
  }

  function closeAbout() {
    var modal = $('about-modal')
    if (!modal || modal.hidden) return
    modal.hidden = true
    document.body.classList.remove('modal-on')
    var from = state.modalFrom
    state.modalFrom = null
    if (from && from.focus) from.focus()
  }

  function keepFocusInModal(ev, modal) {
    var items = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    if (!items.length) return
    var first = items[0]
    var last = items[items.length - 1]
    if (ev.shiftKey && (document.activeElement === first || document.activeElement === modal)) {
      ev.preventDefault()
      last.focus()
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault()
      first.focus()
    }
  }

  function bind() {
    var input = $('q')
    if (input) {
      input.addEventListener('input', debounce(function () {
        state.q = input.value.trim()
        load(true)
      }, 200))
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') {
          ev.preventDefault()
          if (input.value !== '') { input.value = ''; state.q = ''; load(true) }
          else resetFilters()
        }
      })
    }
    var category = $('category')
    if (category) category.addEventListener('change', function () { pickCategory(category.value) })
    var more = $('more')
    if (more) more.addEventListener('click', function () { load(false) })
    var reset = $('reset')
    if (reset) reset.addEventListener('click', resetFilters)
    var copy = $('dock-copy')
    if (copy) copy.addEventListener('click', copyTags)
    var fill = $('dock-fill')
    if (fill) fill.addEventListener('click', fillPanel)
    var clearBtn = $('dock-clear')
    if (clearBtn) clearBtn.addEventListener('click', function () {
      state.picked = null
      state.tags = { base: '', angle: '', list: [], note: '' }
      state.tagSeq += 1
      renderGrid()
      renderDock()
    })
    var aboutTriggers = document.querySelectorAll('[data-about]')
    for (var t = 0; t < aboutTriggers.length; t++) {
      aboutTriggers[t].addEventListener('click', function (ev) {
        openAbout(ev.currentTarget.getAttribute('data-about') === '1' ? 'source' : 'about')
      })
    }
    var aboutClose = $('about-close')
    if (aboutClose) aboutClose.addEventListener('click', closeAbout)
    var aboutMask = document.querySelector('#about-modal .modal-mask')
    if (aboutMask) aboutMask.addEventListener('click', closeAbout)
    document.addEventListener('keydown', function (ev) {
      var open = $('about-modal')
      if (open && !open.hidden) {
        if (ev.key === 'Escape') { ev.preventDefault(); closeAbout(); return }
        if (ev.key === 'Tab') { keepFocusInModal(ev, open); return }
      }
      if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey) return
      var tag = ev.target && ev.target.tagName ? ev.target.tagName.toLowerCase() : ''
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (ev.target && ev.target.isContentEditable)) return
      ev.preventDefault()
      var box = $('q')
      if (box) box.focus()
    })
    // 无限滚动：滚到底部的「加载更多」哨兵自动续页
    var total = $('more')
    if (total && 'IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting && !state.loading && !state.exhausted) load(false)
        })
      }, { rootMargin: '240px' })
      io.observe(total)
    }
  }

  function version() {
    getJson(API + '/health').then(function (res) {
      var data = res.data || {}
      var text = data.version ? 'v' + data.version : (data.ok ? 'ok' : '—')
      var box = $('version')
      if (box) box.textContent = 'tag 版 · ' + text
    }).catch(function () {
      var box = $('version')
      if (box) box.textContent = 'tag 版'
    })
  }

  function boot() {
    bind()
    version()
    load(true)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
