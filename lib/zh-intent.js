// plan: 中文白话 → 姿势/视角/体位 tag 的确定性意图识别与补全（无网络、无 LLM）
/**
 * lib/zh-intent.js — 中文动作意图 → Danbooru tag。
 *
 * 为什么单独一个文件：模型自己写的 tag 经常是"差一点就对"的幻觉词
 * （top-down_bottom_up、worm's-eye_view、one_leg_up 这类库里没有的写法），
 * 中文说法（跪趴、屁股翘起来、从下面看、过肩）也落不到 tag 上。
 * 这里用一张固定的中文短语表把白话钉到真库存在的 tag 上：纯本地、确定性、可单测。
 *
 * 三层：
 *   1. POSE_HINTS：短语 → tag[] 的对照表，姿势权重高于视角（姿势决定画面，视角只是镜头）。
 *   2. detectPoseHints：在描述里找短语（长词优先、去重叠），得到命中的意图。
 *   3. applyPoseHints：把命中意图里**缺失**的 tag 补进已有 tag 列表，保序、只补不改。
 *   4. selectCandidates：给 RAG 用，把中英候选（含命中意图的 tag）合成一份注入列表。
 *
 * 表里每个 tag 都核对过真实 danbooru 数据（99k 条，见 tests/tags-pose.test.mjs 的覆盖测试）。
 */

/** 权重档位：姿势 1.10、体位 1.12、视角 1.05 —— 都落在 1.05–1.15 之间。 */
const W_POSE = 1.1
const W_POSITION = 1.12
const W_VIEW = 1.05
const W_SOFT = 1.05

/**
 * 中文短语 → tag。when 里都是用户真实会用到的说法（越口语越好）。
 * 同一个 tag 允许在多个意图里出现（比如 all_fours 既在"跪趴"也在"后入"里）。
 */
export const POSE_HINTS = [
  // ---------------- 姿势：跪 / 趴 / 坐 / 躺 ----------------
  {
    key: 'all_fours',
    when: ['四肢着地', '四肢撑床', '双手撑床', '趴跪', '跪趴'],
    tags: [{ tag: 'all_fours', weight: W_POSE }, { tag: 'kneeling', weight: W_SOFT }],
  },
  {
    key: 'kneel',
    when: ['跪在床边', '跪在床上', '跪在床', '双膝跪地', '跪坐', '正坐', '跪着', '单膝跪'],
    tags: [{ tag: 'kneeling', weight: W_POSE }, { tag: 'seiza', weight: W_SOFT }],
  },
  {
    key: 'lying_back',
    when: ['仰躺', '仰卧', '平躺', '仰面躺', '躺床上'],
    tags: [{ tag: 'on_back', weight: W_POSE }, { tag: 'lying', weight: W_SOFT }],
  },
  {
    key: 'lying_side',
    when: ['侧躺', '侧卧', '侧身躺', '侧着躺'],
    tags: [{ tag: 'on_side', weight: W_POSE }],
  },
  {
    key: 'lying_stomach',
    when: ['趴卧', '俯卧', '趴床上', '趴着'],
    tags: [{ tag: 'on_stomach', weight: W_POSE }],
  },
  {
    key: 'squat',
    when: ['蹲着', '下蹲', '蹲姿', '蹲下'],
    tags: [{ tag: 'squatting', weight: W_POSE }],
  },
  {
    key: 'sit_cross_legged',
    when: ['盘腿', '盘坐', '打坐', 'w坐姿', '鸭子坐'],
    tags: [{ tag: 'indian_style', weight: W_POSE }, { tag: 'crossed_legs', weight: W_SOFT }],
  },
  {
    key: 'knees_to_chest',
    when: ['抱膝', '蜷起来', '蜷缩', '膝盖抱到胸前'],
    tags: [{ tag: 'knees_to_chest', weight: W_POSE }, { tag: 'hugging_own_legs', weight: W_SOFT }],
  },
  {
    key: 'bent_over',
    when: ['弯腰', '俯身', '撅着', '身体前倾', '往前倾'],
    tags: [{ tag: 'bent_over', weight: W_POSE }, { tag: 'leaning_forward', weight: W_SOFT }],
  },
  {
    key: 'butt_up',
    when: ['屁股翘起来', '屁股翘起', '翘起屁股', '屁股翘高', '翘屁股', '翘臀', '撅屁股', '翘着屁股', '塌腰', '挺起腰'],
    tags: [{ tag: 'arched_back', weight: W_POSE }, { tag: 'ass', weight: W_SOFT }, { tag: 'bent_over', weight: W_SOFT }],
  },
  {
    key: 'legs_up',
    when: ['双腿抬起', '双腿举起', '腿举起来', '仰躺双腿抬起', '脚朝天'],
    tags: [{ tag: 'on_back', weight: W_POSE }, { tag: 'legs_up', weight: W_POSE }],
  },
  {
    key: 'leg_up',
    when: ['抬起一条腿', '单腿抬起', '抬腿'],
    tags: [{ tag: 'leg_up', weight: W_POSE }],
  },
  {
    key: 'spread_legs',
    when: ['劈开腿', '张开大腿', '张开腿', '张开双腿', 'm字开腿', 'm字腿', '双腿分开', '腿分开'],
    tags: [{ tag: 'spread_legs', weight: W_POSE }],
  },
  {
    key: 'against_wall',
    when: ['贴着墙', '靠墙', '按在墙上', '壁咚'],
    tags: [{ tag: 'against_wall', weight: W_POSE }],
  },
  {
    key: 'straddle',
    when: ['跨坐', '跨在腿上', '坐大腿', '坐在腿上', '坐在怀里'],
    tags: [{ tag: 'straddling', weight: W_POSE }, { tag: 'sitting_on_lap', weight: W_SOFT }],
  },
  {
    key: 'carry',
    when: ['抱起来', '公主抱', '抱起', '横抱'],
    tags: [{ tag: 'carrying', weight: W_POSE }, { tag: 'princess_carry', weight: W_SOFT }],
  },
  {
    key: 'look_back',
    when: ['回头看镜头', '回头看', '回头', '回眸', '扭头看', '扭过头', '转头看'],
    tags: [{ tag: 'looking_back', weight: W_VIEW }],
  },
  {
    key: 'facing_away',
    when: ['背对着', '背对镜头', '背身'],
    tags: [{ tag: 'facing_away', weight: W_VIEW }, { tag: 'from_behind', weight: W_SOFT }],
  },

  // ---------------- 视角与镜头 ----------------
  {
    key: 'from_below',
    when: ['从下面往上看', '从下面看', '从下往上看', '低角度仰拍', '仰拍', '仰视', '由下往上'],
    tags: [{ tag: 'from_below', weight: W_VIEW }],
  },
  {
    key: 'from_above',
    when: ['从上往下看', '从上往下', '往下看', '高角度俯拍', '俯拍', '俯视', '由上往下'],
    tags: [{ tag: 'from_above', weight: W_VIEW }],
  },
  {
    key: 'worm_eye',
    when: ['虫眼视角', '贴地视角', '极低角度', '超仰视'],
    tags: [{ tag: "worm's_eye_view", weight: W_VIEW }, { tag: 'from_below', weight: W_SOFT }],
  },
  {
    key: 'from_side',
    when: ['侧面视角', '从侧面看', '侧方', '侧面', '侧脸'],
    tags: [{ tag: 'from_side', weight: W_VIEW }, { tag: 'profile', weight: W_SOFT }],
  },
  {
    key: 'from_behind',
    when: ['从正后方拍', '正后方视角', '正后方', '从后面看', '背后视角', '后方视角', '从背后看', '背影'],
    tags: [{ tag: 'from_behind', weight: W_VIEW }, { tag: 'facing_away', weight: W_SOFT }],
  },
  {
    key: 'over_shoulder',
    when: ['过肩镜头', '过肩', '越肩', '肩膀上方看'],
    tags: [{ tag: 'over_shoulder', weight: W_VIEW }],
  },
  {
    key: 'pov',
    when: ['第一视角', '第一人称', '代入视角', '主体视角'],
    tags: [{ tag: 'pov', weight: W_VIEW }],
  },
  {
    key: 'dutch_angle',
    when: ['荷兰角', '斜构图', '镜头倾斜', '歪斜构图'],
    tags: [{ tag: 'dutch_angle', weight: W_VIEW }],
  },
  {
    key: 'close_up',
    when: ['脸部特写', '特写', '近景'],
    tags: [{ tag: 'close-up', weight: W_VIEW }],
  },
  {
    key: 'full_body',
    when: ['全身', '整个人入镜', '全景'],
    tags: [{ tag: 'full_body', weight: W_VIEW }],
  },
  {
    key: 'wide_shot',
    when: ['远景', '大远景'],
    tags: [{ tag: 'wide_shot', weight: W_VIEW }],
  },
  {
    key: 'upskirt',
    when: ['裙底', '走光视角', '往裙底看'],
    tags: [{ tag: 'upskirt', weight: W_VIEW }],
  },

  // ---------------- 体位 ----------------
  {
    key: 'missionary',
    when: ['正常位', '传教士', '男上女下', '正常体位'],
    tags: [{ tag: 'missionary', weight: W_POSITION }, { tag: 'boy_on_top', weight: W_SOFT }],
  },
  {
    key: 'girl_on_top',
    when: ['女上位', '骑乘位', '骑在身上', '女上', '女骑男'],
    tags: [{ tag: 'cowgirl_position', weight: W_POSITION }, { tag: 'girl_on_top', weight: W_POSE }],
  },
  {
    key: 'reverse_cowgirl',
    when: ['反向女上', '反向骑乘', '背对骑乘'],
    tags: [{ tag: 'reverse_cowgirl_position', weight: W_POSITION }],
  },
  {
    key: 'doggystyle',
    when: ['跪趴后入', '狗爬式', '趴着被进', '后入式', '后入', '从后面做', '从后面插'],
    tags: [{ tag: 'sex_from_behind', weight: W_POSITION }, { tag: 'doggystyle', weight: W_POSE }, { tag: 'all_fours', weight: W_SOFT }],
  },
  {
    key: 'spoon',
    when: ['侧卧后抱', '汤匙式', '侧躺抱着'],
    tags: [{ tag: 'spooning', weight: W_POSITION }, { tag: 'on_side', weight: W_SOFT }],
  },
  {
    key: 'group',
    when: ['三人行', '群交', '群p', '3p', '多人'],
    tags: [{ tag: 'threesome', weight: W_POSITION }, { tag: 'group_sex', weight: W_SOFT }],
  },
  {
    key: 'nude',
    when: ['全裸', '裸体', '一丝不挂', '光着身体'],
    tags: [{ tag: 'nude', weight: W_POSE }, { tag: 'completely_nude', weight: W_SOFT }],
  },
]

/** 表里出现过的所有 tag（判断"已有同义"与"姿势段"用）。 */
const POSE_TAG_SET = new Set()
for (const hint of POSE_HINTS) for (const item of hint.tags) POSE_TAG_SET.add(item.tag)

/** tag 归一化：小写、空格/下划线等价、去掉括号转义的反斜杠。 */
function normTag(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\\(.)/g, '$1')
    .replace(/[\s_]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** 描述归一化：全角空格/标点统一，小写（英文缩写如 3P 也要能命中）。 */
function normText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\u3000\s]+/g, ' ')
}

/** 权重统一保留两位小数，并夹到调用方约定的安全区间外也照原样（这里只做舍入）。 */
function round2(value) {
  return Math.round(Number(value) * 100) / 100
}

/**
 * 在描述里找姿势/视角/体位意图。
 *
 * - 子串匹配，**长词优先**：'跪趴后入' 会先吃掉整段，不会重复命中 '跪趴'。
 * - 去重叠：已匹配的字符区间被占用，后面的短语落在里面就跳过（'跪趴在床上' 不会又命中 '趴着'）。
 * - 同一个 key 只返回一次，matched 是实际命中的说法。
 *
 * @param {string} described 用户的白话描述
 * @returns {Array<{key: string, matched: string, tags: Array<{tag: string, weight: number}>}>}
 */
export function detectPoseHints(described) {
  const text = normText(described)
  if (text.trim() === '') return []
  // 长词优先：同一 key 内部也按长度降序，保证 '跪趴后入' 先于 '跪趴'
  const flat = []
  for (const hint of POSE_HINTS) {
    for (const word of hint.when) {
      const needle = normText(word)
      if (needle === '') continue
      flat.push({ key: hint.key, tags: hint.tags, word, needle })
    }
  }
  flat.sort((a, b) => b.needle.length - a.needle.length || a.needle.localeCompare(b.needle))
  const taken = []
  const hits = []
  const usedKeys = new Set()
  for (const item of flat) {
    if (usedKeys.has(item.key)) continue
    const at = text.indexOf(item.needle)
    if (at < 0) continue
    const end = at + item.needle.length
    if (taken.some(range => at < range.end && end > range.start)) continue
    taken.push({ start: at, end })
    usedKeys.add(item.key)
    hits.push({ key: item.key, matched: item.word, tags: item.tags.map(tag => ({ tag: tag.tag, weight: tag.weight })) })
  }
  return hits
}

/** 已有 tag 集合（归一化）。 */
function collectExisting(rows) {
  const set = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row === 'string') set.add(normTag(row))
    else if (row !== null && typeof row === 'object' && typeof row.tag === 'string') set.add(normTag(row.tag))
  }
  return set
}

/** 找到"姿势段"的末尾下标：最后一条属于 POSE_HINTS 词表的行；没有就返回 -1。 */
function lastPoseIndex(rows) {
  let last = -1
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const tag = typeof row === 'string' ? row : row !== null && typeof row === 'object' ? row.tag : ''
    if (POSE_TAG_SET.has(normTag(tag))) last = i
  }
  return last
}

/**
 * 把命中意图补进已有 tag 列表。
 *
 * 规则：
 *   - **只补缺失**：已有同 tag 就不补；该意图的头一个 tag（主 tag）已经在列表里时，视为"同义已有"，整条意图跳过。
 *   - 权重固定档位（姿势 1.10 / 体位 1.12 / 视角 1.05），不做温度之类的随机化，保证可复现。
 *   - **不改已有顺序**：新 tag 插到"姿势段"（最后一条属于词表的行）之后；表里没有姿势份儿时才追加到末尾。
 *   - 行的形状跟输入走：字符串进就字符串出，对象进就对象出。
 *
 * @param {Array<string|{tag: string, weight?: number}>} rows
 * @param {Array<{key: string, tags: Array<{tag: string, weight: number}>}>} hints detectPoseHints 的返回值
 * @returns {{rows: Array<string|object>, added: Array<{tag: string, weight: number, key: string}>}}
 */
export function applyPoseHints(rows, hints) {
  const list = Array.isArray(rows) ? rows.slice() : []
  const hintList = Array.isArray(hints) ? hints : []
  const existing = collectExisting(list)
  const asObjects = list.some(row => row !== null && typeof row === 'object')
  const added = []
  const insertAfter = lastPoseIndex(list)
  let cursor = insertAfter
  for (const hint of hintList) {
    const tags = Array.isArray(hint.tags) ? hint.tags : []
    if (tags.length === 0) continue
    // 主 tag 已在 → 这条意图算"已有同义"，不补
    if (existing.has(normTag(tags[0].tag))) continue
    for (const item of tags) {
      const key = normTag(item.tag)
      if (key === '' || existing.has(key)) continue
      const weight = round2(item.weight ?? W_SOFT)
      existing.add(key)
      added.push({ tag: item.tag, weight, key: hint.key })
      const payload = asObjects ? { tag: item.tag, weight } : weight === 1 ? item.tag : '(' + item.tag + ':' + weight + ')'
      if (cursor >= 0) {
        cursor += 1
        list.splice(cursor, 0, payload)
      } else {
        list.push(payload)
      }
    }
  }
  return { rows: list, added }
}

/**
 * 给 RAG 注入用的候选列表：先放意图命中的 tag（确定性），再用现有索引补齐中英候选。
 *
 * 不联网、不调模型：tags.search 是纯本地同步检索，这里只是把描述按标点切段多查几次。
 *
 * @param {{ described?: string, tags?: {search: Function, ready?: Function} | null, limit?: number }} [options]
 * described 用户白话；tags 标签索引（缺失时只返回意图 tag）；limit 上限（默认 18）
 * @returns {Promise<Array<{tag: string, cn: string, from?: string}>>}
 */
export async function selectCandidates({ described = '', tags, limit = 18 } = {}) {
  const max = Math.max(1, Number(limit) || 18)
  const hints = detectPoseHints(described)
  const out = []
  const seen = new Set()
  const push = (tag, cn, from) => {
    if (typeof tag !== 'string' || tag.trim() === '') return
    const key = normTag(tag)
    if (key === '' || seen.has(key)) return
    seen.add(key)
    out.push({ tag, cn: typeof cn === 'string' ? cn : '', from })
  }
  const index = tags !== null && typeof tags === 'object' ? tags : null
  if (index !== null && typeof index.ready === 'function') {
    try {
      await index.ready()
    } catch {
      // 索引构建失败不影响意图识别：下面的 search 会自己返回 seed 结果
    }
  }
  const lookupCn = tag => {
    if (index === null || typeof index.search !== 'function') return ''
    try {
      const rows = index.search(tag, { limit: 4 })
      for (const row of Array.isArray(rows) ? rows : []) if (normTag(row.tag) === normTag(tag)) return row.cn ?? ''
    } catch {
      return ''
    }
    return ''
  }
  for (const hint of hints) {
    for (const item of hint.tags) {
      if (out.length >= max) break
      push(item.tag, lookupCn(item.tag), 'hint:' + hint.key)
    }
  }
  if (index !== null && typeof index.search === 'function') {
    const text = String(described ?? '').trim()
    const segments = []
    if (text !== '') {
      segments.push(text)
      for (const part of text.split(/[\s,，。;；、/|]+/)) {
        const piece = part.trim()
        if (piece !== '' && piece !== text && !segments.includes(piece)) segments.push(piece)
      }
    }
    for (const segment of segments.slice(0, 8)) {
      if (out.length >= max) break
      try {
        const rows = index.search(segment, { limit: Math.min(max, 12) })
        for (const row of Array.isArray(rows) ? rows : []) {
          if (out.length >= max) break
          push(row.tag, row.cn, 'search')
        }
      } catch {
        // 单个查询失败就跳过，不影响其它段
      }
    }
  }
  return out.slice(0, max)
}

/** 词表里所有 tag（供接线方做"是否是姿势词"的判断）。 */
export const POSE_TAGS = [...POSE_TAG_SET].sort()

export default { POSE_HINTS, POSE_TAGS, detectPoseHints, applyPoseHints, selectCandidates }
