/**
 * 参考卡（服装 / 人像）→ Danbooru tag 的纯映射表。
 *
 * 只回答一个问题：在选图器里点了这张服装卡或人像卡，提示词里该多带哪几个词。
 * 不读盘、不查索引、不依赖 lib/poses.js —— 面板与 /forge 都能直接调。
 *
 * 所有 tag 都在 data/danbooru/general.jsonl 里核对过（tests/ref-tags.test.mjs 会再复核），
 * 库里没有的词一律换近义真词或者干脆不写：stockings → thighhighs、tights → pantyhose、
 * muffler → scarf、knit → sweater（库无 knitwear）、air bangs 用 swept_bangs 近似。
 * 宁可少一个 tag，也不造词。
 */

/**
 * 服装卡的英文关键词（人像/服装库自己写的空格分隔串）→ tag。
 * 键按库里原样小写登记；两词短语（mini skirt / polka-dot …）优先于单词匹配。
 */
export const COSTUME_WORD_TAGS = {
  frill: ['frills'],
  lace: ['frills'],
  ribbon: ['ribbon'],
  bow: ['bow'],
  knit: ['sweater'],
  cardigan: ['cardigan'],
  camisole: ['tank_top'],
  tank: ['tank_top'],
  blouse: ['blouse'],
  shirt: ['shirt'],
  't-shirt': ['t-shirt'],
  'dress shirt': ['dress_shirt'],
  turtleneck: ['turtleneck'],
  sweater: ['sweater'],
  vest: ['vest'],
  hoodie: ['hoodie'],
  hood: ['hood'],
  jacket: ['jacket'],
  blazer: ['blazer'],
  coat: ['coat'],
  'puffer jacket': ['down_jacket'],
  trench: ['trench_coat'],
  parka: ['parka'],
  suit: ['suit'],
  corset: ['leotard'],
  halterneck: ['halterneck'],
  sleeveless: ['sleeveless_dress'],
  'detached sleeves': ['detached_sleeves'],
  'pleated skirt': ['pleated_skirt'],
  skirt: ['skirt'],
  'mini skirt': ['miniskirt'],
  'midi skirt': ['skirt'],
  'pleated mini': ['pleated_skirt', 'miniskirt'],
  'denim skirt': ['denim_skirt'],
  dress: ['dress'],
  'mini dress': ['short_dress'],
  'midi dress': ['dress'],
  maxi: ['long_dress'],
  robe: ['robe'],
  apron: ['apron'],
  pinafore: ['pinafore_dress'],
  pants: ['pants'],
  jeans: ['jeans'],
  shorts: ['shorts'],
  'bike shorts': ['bike_shorts'],
  briefs: ['underwear'],
  leggings: ['leggings'],
  tights: ['pantyhose'],
  stockings: ['pantyhose'],
  socks: ['socks'],
  'white socks': ['white_socks'],
  boots: ['boots'],
  heels: ['high_heels'],
  pumps: ['high_heels'],
  sandals: ['sandals'],
  sneakers: ['sneakers'],
  loafers: ['loafers'],
  shoes: ['shoes'],
  bra: ['sports_bra'],
  'sports bra': ['sports_bra'],
  swimsuit: ['one-piece_swimsuit'],
  bikini: ['bikini'],
  underwear: ['underwear'],
  lingerie: ['negligee'],
  necklace: ['necklace'],
  choker: ['choker'],
  earrings: ['earrings'],
  headband: ['headband'],
  scrunchie: ['scrunchie'],
  hat: ['hat'],
  beret: ['beret'],
  beanie: ['beanie'],
  scarf: ['scarf'],
  muffler: ['scarf'],
  gloves: ['gloves'],
  belt: ['belt'],
  sunglasses: ['sunglasses'],
  bag: ['bag'],
  tote: ['tote_bag'],
  'tote bag': ['tote_bag'],
  'polka dot': ['polka_dot'],
  floral: ['floral_print'],
  denim: ['denim'],
  leather: ['leather'],
  fur: ['fur_trim'],
  satin: ['satin'],
  silk: ['silk'],
  wool: ['wool'],
  mesh: ['mesh'],
  translucent: ['translucent'],
  transparent: ['transparent'],
  cape: ['cape'],
  cloak: ['cloak'],
  overalls: ['overalls'],
  suspenders: ['suspenders'],
  jumpsuit: ['jumpsuit'],
  qipao: ['qipao'],
  kimono: ['kimono'],
  yukata: ['yukata'],
  maid: ['maid'],
  'sailor collar': ['sailor_collar'],
  uwabaki: ['uwabaki'],
  'gym uniform': ['gym_uniform'],
  'track jacket': ['track_jacket'],
  watch: ['watch'],
}

/**
 * 服装卡中文标签的兜底表：英文关键词为空、或卡片只有中文名时用它。
 * 键是卡片里会出现的中文写法，值照旧是真 tag。
 */
export const COSTUME_CN_TAGS = {
  荷叶边: ['frills'],
  蕾丝: ['frills'],
  缎带: ['ribbon'],
  蝴蝶结: ['bow'],
  发带: ['hair_ribbon'],
  发箍: ['headband'],
  发饰: ['hair_ornament'],
  针织: ['sweater'],
  开衫: ['cardigan'],
  吊带衫: ['tank_top'],
  吊带背心: ['tank_top'],
  背心: ['tank_top'],
  女衫: ['blouse'],
  女式衬衫: ['blouse'],
  衬衫: ['shirt'],
  高领: ['turtleneck'],
  毛衣: ['sweater'],
  连衣裙: ['dress'],
  半身裙: ['skirt'],
  迷你裙: ['miniskirt'],
  百褶裙: ['pleated_skirt'],
  中长裙: ['long_skirt'],
  过膝裙: ['long_skirt'],
  包臀裙: ['pencil_skirt'],
  铅笔裙: ['pencil_skirt'],
  牛仔: ['denim'],
  牛仔布: ['denim'],
  牛仔裤: ['jeans'],
  短裤: ['shorts'],
  长裤: ['pants'],
  连裤袜: ['pantyhose'],
  长筒袜: ['pantyhose'],
  长筒丝袜: ['pantyhose'],
  短袜: ['socks'],
  靴子: ['boots'],
  高跟鞋: ['high_heels'],
  浅口高跟鞋: ['high_heels'],
  浅口单鞋: ['high_heels'],
  凉鞋: ['sandals'],
  运动鞋: ['sneakers'],
  乐福鞋: ['loafers'],
  大衣: ['coat'],
  面包服: ['down_jacket'],
  羽绒服: ['down_jacket'],
  夹克: ['jacket'],
  西装: ['suit'],
  束腰胸衣: ['leotard'],
  束身衣: ['leotard'],
  围巾: ['scarf'],
  丝巾: ['scarf'],
  手套: ['gloves'],
  腰带: ['belt'],
  帽子: ['hat'],
  礼帽: ['hat'],
  贝雷帽: ['beret'],
  项链: ['necklace'],
  颈链: ['choker'],
  耳环: ['earrings'],
  墨镜: ['sunglasses'],
  太阳镜: ['sunglasses'],
  托特包: ['tote_bag'],
  手提包: ['bag'],
  斜挎包: ['bag'],
  单肩包: ['bag'],
  双肩包: ['bag'],
  手拿包: ['bag'],
  背包: ['bag'],
  文胸: ['sports_bra'],
  内裤: ['underwear'],
  泳衣: ['one-piece_swimsuit'],
  比基尼: ['bikini'],
  碎花: ['floral_print'],
  波点: ['polka_dot'],
  缎面: ['satin'],
  皮革: ['leather'],
  皮质: ['leather'],
  毛绒: ['fur_trim'],
  羊毛: ['wool'],
  薄纱: ['translucent'],
  旗袍: ['qipao'],
  和服: ['kimono'],
  浴衣: ['yukata'],
  女仆装: ['maid'],
  校服: ['school_uniform'],
  水手服: ['serafuku'],
  汉服: ['chinese_clothes'],
  运动套装: ['gym_uniform'],
  长袍: ['robe'],
  围裙: ['apron'],
}

/** 人像卡分区 → 取景 tag。正脸参考是头像/胸像的正面机位，造型氛围是带场景的半身。 */
export const PORTRAIT_FRAMING = {
  正脸参考: ['portrait', 'upper_body'],
  造型氛围: ['portrait'],
}

/** 人像卡分区 → 构图/视线 tag。造型氛围不锁视线（多半在看别处），只保留取景。 */
export const PORTRAIT_PARTITION_TAGS = {
  正脸参考: ['facing_viewer'],
  造型氛围: [],
}

/**
 * 人像卡发长（四档）→ 头发长度 tag。
 * 库里正好四档 short / medium / long / very_long，一档对一档，不互相叠：
 * 中长发落 long_hair，长发落 very_long_hair（中长发给 very_long 会虚标长度）。
 */
export const PORTRAIT_HAIR_TAGS = {
  短发: ['short_hair'],
  中发: ['medium_hair'],
  中长发: ['long_hair'],
  长发: ['very_long_hair'],
}

/**
 * 发型名称 / 标题里的关键词 → 补充 tag。
 * 按名称原文匹配（re 一律不带 g 标志，避免 lastIndex 状态串台）。
 *
 * 互斥靠 family，不靠正则前瞻：「低位双马尾」里隔着一个「位」，(?<!低) 挡不住；
 * 所以泛称条目（马尾 / 辫子 / 丸子 / 双马尾）标 generic，同族有特化词命中时整条跳过。
 * suppresses 处理跨族遮蔽：双马尾同时含「马尾」两字，出了 twintails 就不该再补 ponytail。
 */
export const PORTRAIT_STYLE_HINTS = [
  { re: /低双马尾|低位双马尾/, tags: ['low_twintails'], why: '低双马尾', family: 'twintails', suppresses: ['ponytail'] },
  { re: /短双马尾|双马尾很短/, tags: ['short_twintails'], why: '短双马尾', family: 'twintails', suppresses: ['ponytail'] },
  { re: /双马尾|两侧马尾|两个马尾/, tags: ['twintails'], why: '双马尾', family: 'twintails', generic: true, suppresses: ['ponytail'] },
  { re: /(?<!双|两)侧马尾|单侧马尾/, tags: ['side_ponytail'], why: '侧马尾', family: 'ponytail' },
  { re: /高马尾|高位马尾/, tags: ['high_ponytail'], why: '高马尾', family: 'ponytail' },
  { re: /低马尾|低位马尾/, tags: ['low_ponytail'], why: '低马尾', family: 'ponytail' },
  { re: /马尾/, tags: ['ponytail'], why: '马尾', family: 'ponytail', generic: true },
  { re: /双丸子|两个丸子|丸子头双/, tags: ['double_bun'], why: '双丸子头', family: 'bun' },
  { re: /丸子头|丸子|发髻|圆髻/, tags: ['hair_bun'], why: '丸子头/发髻', family: 'bun', generic: true },
  { re: /双麻花辫|两条辫子|双辫/, tags: ['twin_braids'], why: '双麻花辫', family: 'braid' },
  { re: /侧编发|单条辫子|侧麻花/, tags: ['single_braid'], why: '侧编发', family: 'braid' },
  { re: /麻花辫|辫子|编发|三股辫/, tags: ['braid'], why: '麻花辫/编发', family: 'braid', generic: true },
  { re: /公主切|齐刘海长发/, tags: ['hime_cut'], why: '公主切' },
  { re: /齐刘海|平刘海/, tags: ['blunt_bangs'], why: '齐刘海' },
  { re: /空气刘海|薄刘海/, tags: ['swept_bangs'], why: '空气刘海（库无 see-through_bangs，用斜刘海近似）' },
  { re: /斜刘海|斜分刘海/, tags: ['swept_bangs'], why: '斜刘海' },
  { re: /中分|分刘海/, tags: ['parted_bangs'], why: '中分刘海' },
  { re: /波浪|大卷|微卷/, tags: ['wavy_hair'], why: '波浪卷' },
  { re: /卷发|卷毛|烫卷/, tags: ['curly_hair'], why: '卷发' },
  { re: /直发|顺直|拉直/, tags: ['straight_hair'], why: '直发' },
  { re: /呆毛/, tags: ['ahoge'], why: '呆毛' },
  { re: /遮眼|半遮眼|盖住一只眼/, tags: ['hair_over_one_eye'], why: '遮住单眼' },
  { re: /钻头|螺旋卷/, tags: ['drill_hair'], why: '钻头卷' },
  { re: /外翘|内扣|翻翘/, tags: ['flipped_hair'], why: '发尾外翘/内扣' },
  { re: /挑染|挑色/, tags: ['streaked_hair'], why: '挑染' },
  { re: /双色|渐变染|渐层染/, tags: ['multicolored_hair'], why: '双色/渐层染发' },
  { re: /发带|丝带/, tags: ['hair_ribbon'], why: '发带' },
  { re: /发饰|发夹/, tags: ['hair_ornament'], why: '发饰' },
]

/** 来源表：五张表都在这里登记，测试与文档遍历用（加表要记得登记）。 */
export const REF_SOURCES = {
  word: COSTUME_WORD_TAGS,
  cn: COSTUME_CN_TAGS,
  framing: PORTRAIT_FRAMING,
  partition: PORTRAIT_PARTITION_TAGS,
  hair: PORTRAIT_HAIR_TAGS,
  style: PORTRAIT_STYLE_HINTS,
}

/** tag → 中文名。给面板 chip 上的中文提示用；只覆盖这套映射会产出的词。 */
export const TAG_CN = {
  frills: '荷叶边',
  // 公开版：lace 归到 frills（SFW 词表里没有 lace）
  lace_trim: '蕾丝花边',
  ribbon: '缎带',
  bow: '蝴蝶结',
  hair_ribbon: '发带',
  hair_ornament: '发饰',
  sweater: '毛衣/针织衫',
  cardigan: '开衫',
  // 公开版：camisole 归到 tank_top
  tank_top: '背心',
  blouse: '女衫',
  shirt: '衬衫',
  't-shirt': 'T 恤',
  dress_shirt: '正装衬衫',
  turtleneck: '高领',
  vest: '马甲',
  hoodie: '连帽卫衣',
  hood: '兜帽',
  jacket: '夹克',
  blazer: '西装外套',
  coat: '大衣',
  down_jacket: '羽绒服',
  trench_coat: '风衣',
  parka: '派克大衣',
  suit: '西装套装',
  leotard: '连体紧身衣',
  halterneck: '挂脖',
  sleeveless_dress: '无袖连衣裙',
  detached_sleeves: '分离袖套',
  pleated_skirt: '百褶裙',
  skirt: '半身裙',
  pencil_skirt: '包臀裙',
  miniskirt: '迷你裙',
  denim_skirt: '牛仔裙',
  long_skirt: '长裙',
  dress: '连衣裙',
  short_dress: '短连衣裙',
  long_dress: '长连衣裙',
  robe: '长袍',
  apron: '围裙',
  pinafore_dress: '背带裙',
  pants: '长裤',
  jeans: '牛仔裤',
  shorts: '短裤',
  bike_shorts: '骑行短裤',
  // 公开版：panties 归到 underwear
  leggings: '打底裤',
  pantyhose: '连裤袜',
  // 公开版：thighhighs 归到 pantyhose
  socks: '短袜',
  white_socks: '白袜',
  boots: '靴子',
  high_heels: '高跟鞋',
  sandals: '凉鞋',
  sneakers: '运动鞋',
  loafers: '乐福鞋',
  shoes: '鞋子',
  // 公开版：bra 归到 sports_bra
  sports_bra: '运动内衣',
  'one-piece_swimsuit': '连体泳衣',
  bikini: '比基尼',
  underwear: '内衣',
  negligee: '睡裙',
  necklace: '项链',
  choker: '颈链',
  earrings: '耳环',
  headband: '发箍',
  scrunchie: '发圈',
  hat: '帽子',
  beret: '贝雷帽',
  beanie: '针织帽',
  scarf: '围巾',
  gloves: '手套',
  belt: '腰带',
  sunglasses: '墨镜',
  bag: '包',
  tote_bag: '托特包',
  polka_dot: '波点',
  floral_print: '碎花',
  denim: '牛仔',
  leather: '皮革',
  fur_trim: '毛边',
  satin: '缎面',
  silk: '丝绸',
  wool: '羊毛',
  mesh: '网眼',
  translucent: '半透明',
  transparent: '透明',
  cape: '披风',
  cloak: '斗篷',
  overalls: '背带裤',
  suspenders: '背带',
  jumpsuit: '连体裤',
  qipao: '旗袍',
  kimono: '和服',
  yukata: '浴衣',
  maid: '女仆装',
  sailor_collar: '水手领',
  uwabaki: '室内鞋',
  gym_uniform: '运动服',
  track_jacket: '运动外套',
  watch: '手表',
  school_uniform: '校服',
  serafuku: '水手服',
  chinese_clothes: '中式服装',
  short_hair: '短发',
  medium_hair: '中发',
  long_hair: '长发',
  very_long_hair: '及腰长发',
  twintails: '双马尾',
  low_twintails: '低双马尾',
  short_twintails: '短双马尾',
  ponytail: '马尾',
  side_ponytail: '侧马尾',
  high_ponytail: '高马尾',
  low_ponytail: '低马尾',
  braid: '麻花辫',
  single_braid: '单侧麻花辫',
  twin_braids: '双麻花辫',
  hair_bun: '丸子头',
  double_bun: '双丸子头',
  hime_cut: '公主切',
  blunt_bangs: '齐刘海',
  swept_bangs: '斜刘海',
  parted_bangs: '中分刘海',
  wavy_hair: '波浪卷发',
  curly_hair: '卷发',
  straight_hair: '直发',
  ahoge: '呆毛',
  hair_over_one_eye: '遮眼发',
  drill_hair: '钻头卷',
  flipped_hair: '翻翘发尾',
  multicolored_hair: '双色发',
  streaked_hair: '挑染',
  facing_viewer: '正对镜头',
  portrait: '人像取景',
  upper_body: '胸像取景',
}

/**
 * 泛称 → 具体词的降级关系：具体词在场时把泛称丢掉，
 * 免得「百褶迷你半身裙」同时吐出 pleated_skirt、miniskirt 和 skirt。
 */
const GENERIC_TAGS = {
  skirt: ['miniskirt', 'pleated_skirt', 'denim_skirt', 'long_skirt', 'pencil_skirt'],
  dress: ['short_dress', 'long_dress', 'pinafore_dress', 'sundress'],
  shoes: ['sneakers', 'loafers', 'sandals', 'high_heels', 'boots', 'mary_janes'],
  bag: ['tote_bag', 'handbag'],
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 卡片的中文标签数组：真库叫 tags，文档里写 cn，两种都认。 */
function chineseLabels(item) {
  const out = []
  for (const field of [item.tags, item.cn]) {
    if (!Array.isArray(field)) continue
    for (const value of field) {
      const label = text(value)
      if (label !== '') out.push(label)
    }
  }
  return out
}

/**
 * 关键词串切词：连字符、下划线、连续空格一律折成单词边界。
 * 归一后 mini-skirt 与 mini skirt 同形、polka-dot 与 polka dot 同形，两词短语键只写一种。
 */
function wordsOf(value) {
  return String(value)
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter(token => token !== '')
}

/** 归一后的短语（1~2 词）→ tags；'t-shirt' 与 't shirt' 落同一个键。 */
const WORD_FORMS = (() => {
  const map = new Map()
  for (const key of Object.keys(COSTUME_WORD_TAGS)) {
    const phrase = wordsOf(key).join(' ')
    if (phrase === '') continue
    if (map.has(phrase) === false) map.set(phrase, COSTUME_WORD_TAGS[key])
  }
  return map
})()

/** 中文表按词长倒序：长词先占位，短词不重复认领已占区间（女式衬衫只出 blouse）。 */
const CN_KEYS = Object.keys(COSTUME_CN_TAGS).sort((a, b) => b.length - a.length)

/**
 * 扫一段中文里的表键，长词优先 + 区间去重叠。
 * 返回按出现位置排序的 [{ word, at }]；同一个「牛仔裤」不会再被「牛仔」二次认领。
 */
function scanChinese(label) {
  const taken = []
  const hits = []
  for (const word of CN_KEYS) {
    let from = 0
    for (;;) {
      const at = label.indexOf(word, from)
      if (at < 0) break
      const end = at + word.length
      const clash = taken.some(range => at < range.end && range.start < end)
      if (clash === false) {
        taken.push({ start: at, end })
        hits.push({ word, at })
      }
      from = at + 1
    }
  }
  return hits.sort((a, b) => a.at - b.at)
}

/**
 * 服装卡 → tag。
 * @param {{ keywords?: string, tags?: string[], cn?: string[], name?: string, category?: string }} item
 * @returns {{ tags: { tag: string, cn: string }[], reasons: string[] }}
 */
export function tagsForCostume(item) {
  const row = item !== null && typeof item === 'object' ? item : {}
  const picked = []
  const add = (tag, why) => {
    if (typeof tag !== 'string' || tag === '') return
    if (picked.some(entry => entry.tag === tag)) return
    picked.push({ tag, why })
  }

  // 1) 英文关键词：两词短语优先，命中就吃掉两个词，避免 mini skirt 又出一次 skirt
  const words = wordsOf(text(row.keywords))
  for (let i = 0; i < words.length; ) {
    const pair = i + 1 < words.length ? words[i] + ' ' + words[i + 1] : ''
    const pairTags = pair === '' ? undefined : WORD_FORMS.get(pair)
    if (Array.isArray(pairTags)) {
      for (const tag of pairTags) add(tag, '关键词「' + pair + '」→ ' + tag)
      i += 2
      continue
    }
    const single = WORD_FORMS.get(words[i])
    if (Array.isArray(single)) for (const tag of single) add(tag, '关键词「' + words[i] + '」→ ' + tag)
    i += 1
  }

  // 2) pleated 单说不是裙子：得有 skirt、且没混进 dress / blouse 才算百褶裙
  const hasDressy = words.includes('dress') || words.includes('blouse')
  if (words.includes('pleated') && words.includes('skirt') && hasDressy === false) {
    add('pleated_skirt', '关键词「pleated」+「skirt」→ pleated_skirt')
  }

  // 3) 中文标签兜底：长词优先、区间去重叠，只有英文关键词漏掉的词才补
  for (const label of chineseLabels(row)) {
    for (const hit of scanChinese(label)) {
      for (const tag of COSTUME_CN_TAGS[hit.word]) add(tag, '中文标签「' + hit.word + '」→ ' + tag)
    }
    if (label.includes('百褶') && label.includes('裙')) add('pleated_skirt', '中文标签「百褶…裙」→ pleated_skirt')
  }

  // 4) 中文名兜底：卡片名是一串用「・」连起来的单品，逐词扫一遍
  const name = text(row.name)
  if (name !== '') {
    for (const hit of scanChinese(name)) {
      for (const tag of COSTUME_CN_TAGS[hit.word]) add(tag, '名称「' + hit.word + '」→ ' + tag)
    }
    if (name.includes('百褶') && name.includes('裙')) add('pleated_skirt', '名称「百褶…裙」→ pleated_skirt')
  }

  // 5) 泛称降级：具体单品在场时丢掉 skirt / dress / shoes 这类上位词
  const kept = picked.filter(entry => {
    const specific = GENERIC_TAGS[entry.tag]
    if (!Array.isArray(specific)) return true
    return specific.some(tag => picked.some(other => other.tag === tag)) === false
  })

  if (kept.length === 0 && (words.length > 0 || name !== '')) {
    return { tags: [], reasons: ['这张卡没有能映射成真词的词，按原样不补 tag'] }
  }
  return {
    tags: kept.map(entry => ({ tag: entry.tag, cn: TEXT_FALLBACK(entry.tag) })),
    reasons: kept.map(entry => entry.why),
  }
}

function TEXT_FALLBACK(tag) {
  return typeof TAG_CN[tag] === 'string' ? TAG_CN[tag] : ''
}

/**
 * 人像卡 → tag。
 * @param {{ partition?: string, hair?: string, style?: string, title?: string, popular?: boolean }} item
 * @returns {{ tags: { tag: string, cn: string }[], reasons: string[] }}
 */
export function tagsForPortrait(item) {
  const row = item !== null && typeof item === 'object' ? item : {}
  const tags = []
  const reasons = []
  const add = (tag, why) => {
    if (typeof tag !== 'string' || tag === '') return
    if (tags.some(entry => entry.tag === tag)) return
    tags.push({ tag, cn: TEXT_FALLBACK(tag) })
    reasons.push(why)
  }

  const partition = text(row.partition)
  if (partition !== '') {
    const framing = PORTRAIT_FRAMING[partition]
    if (Array.isArray(framing)) {
      for (const tag of framing) add(tag, '分区：' + partition + ' → ' + tag)
    } else {
      reasons.push('分区：' + partition + ' → 未收录，不补取景词')
    }
    const partitionTags = PORTRAIT_PARTITION_TAGS[partition]
    if (Array.isArray(partitionTags)) {
      for (const tag of partitionTags) add(tag, '分区：' + partition + ' → ' + tag)
    }
  }

  const hair = text(row.hair)
  if (hair !== '') {
    const hairTags = PORTRAIT_HAIR_TAGS[hair]
    if (Array.isArray(hairTags)) {
      for (const tag of hairTags) add(tag, '发长：' + hair + ' → ' + tag)
    } else {
      reasons.push('发长：' + hair + ' → 未收录，不补发长词')
    }
  }

  // 发型名称与标题都扫：库里两列写法一致，但别的数据源可能只填一个
  const labels = []
  for (const source of ['style', 'title']) {
    const label = text(row[source])
    if (label !== '') labels.push({ source, label })
  }

  // 两趟：先把命中的提示都收齐（特化词定族），再补词，同族泛称整条跳过
  const hits = []
  for (const { source, label } of labels) {
    for (const hint of PORTRAIT_STYLE_HINTS) {
      if (hint.re.test(label) === false) continue
      hits.push({ hint, source })
    }
  }
  const suppressed = new Set()
  for (const { hint } of hits) {
    for (const shadow of hint.suppresses === undefined ? [] : hint.suppresses) suppressed.add(shadow)
    if (hint.generic === true) continue
    if (typeof hint.family === 'string') suppressed.add(hint.family)
  }
  for (const { hint, source } of hits) {
    if (hint.generic === true && suppressed.has(hint.family)) continue
    for (const tag of hint.tags) add(tag, '发型（' + source + '）：「' + hint.why + '」→ ' + tag)
  }

  if (tags.length === 0 && (partition !== '' || hair !== '')) {
    reasons.push('这张卡没有能映射成真词的词，按原样不补 tag')
  }
  return { tags, reasons }
}

/**
 * 统一入口：按卡片种类调对应的推导器，只回 tag 名数组（写提示词用这个）。
 * @param {'costume'|'portrait'} kind
 * @param {object} item
 * @returns {string[]}
 */
export function tagListFor(kind, item) {
  const picked = kind === 'costume' ? tagsForCostume(item) : kind === 'portrait' ? tagsForPortrait(item) : null
  return picked === null ? [] : picked.tags.map(entry => entry.tag)
}
