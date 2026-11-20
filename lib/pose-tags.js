/**
 * 姿势 → Danbooru tag 的纯映射表。
 *
 * 只回答一个问题：选了这个姿势，提示词里该多带哪几个 tag。
 * 不读盘、不查词表、不依赖 lib/poses.js —— 面板和 /forge 都能直接调。
 *
 * 所有 tag 都在 data/danbooru/general.jsonl 里核对过（tests/pose-tags.test.mjs 会再复核一遍），
 * 不写自造词，也不写只在 overlay 里出现的词。
 */

/** catalog「角度」→ 镜头 tag。斜侧与侧面在 Danbooru 都是 from_side（不区分左右）。 */
export const ANGLE_TAGS = {
  正面: 'facing_viewer',
  斜侧: 'from_side',
  侧面: 'from_side',
  俯视: 'from_above',
  仰视: 'from_below',
}

/**
 * catalog「分类」→ 姿态 tag（1~3 个，按分类语义挑，不按名字猜）。
 * 键必须覆盖真 catalog 里出现过的每一个分类值 —— 测试会遍历真 catalog 检查缺键。
 * 空数组是合法值：分类本身太杂、没有稳定姿态词时宁可不补。
 */
export const CATEGORY_TAGS = {
  站姿: ['standing'],
  坐姿: ['sitting'],
  跪立: ['kneeling'],
  '跪立・四肢着地': ['kneeling', 'all_fours'],
  趴卧: ['lying', 'on_stomach'],
  侧卧位: ['lying'],
  蹲姿: ['squatting'],
  前倾: ['leaning_forward'],
  '后仰・挺背': ['arched_back', 'leaning_back'],
  扭身: ['twisted_torso'],
  '侧坐・女孩坐': ['sitting', 'wariza'],
  坐位: ['sitting'],
  '坐位贴身': ['sitting', 'hug'],
  '面对面坐位': ['sitting', 'hug'],
  '背向坐位': ['sitting', 'sitting_on_lap'],
  贴身: ['hug'],
  贴脸系: ['cheek-to-cheek', 'heads_together'],
  // 可爱系是一堆手部小动作的合集（比 V / 敬礼 / 遮脸…），整类只给 heart_hands 会误标，交给名称提示逐条判。
  可爱系: [],
  '性感・大胆系': ['seductive_smile'],
  '挤胸・强调事业线系': ['cleavage', 'breasts_squeezed_together'],
  特殊: [],
  立位: ['standing'],
  立位贴身: ['hug'],
  '正常位（传教士）': ['on_back'],
  后入位: ['all_fours'],
  骑乘位: ['straddling'],
}

/**
 * catalog「姿势名称」关键词 → 补充 tag。
 * 按名称原文匹配（`re` 一律不带 g 标志，避免 lastIndex 状态串台）；顺序即优先级，命中的都补。
 */
export const NAME_HINTS = [
  { re: /回头|回望|回眸|向后看|回身看/, tags: ['looking_back'], why: '回头/回望' },
  { re: /抱后脑|抱头|手在脑后|脑后交叉/, tags: ['arm_behind_head'], why: '双手抱头' },
  { re: /比心/, tags: ['heart_hands'], why: '比心' },
  { re: /撑地|手撑|扶地|单手支撑/, tags: ['arm_support'], why: '手撑地' },
  { re: /展臂|双臂上举|双手上举|举双臂|双臂上抬|双手举起|举双手/, tags: ['arms_up'], why: '双臂上举' },
  { re: /撩发|抚发|摸头|扶发|整理头发/, tags: ['hand_on_own_head'], why: '手抚发/摸头' },
  { re: /抱膝|抱腿|抱大腿|抱小腿/, tags: ['hugging_own_legs'], why: '抱膝/抱腿' },
  { re: /抬腿|单腿高抬|双腿上抬|单腿后举|高抬腿|单腿抬起/, tags: ['leg_up'], why: '抬腿' },
  { re: /翘臀|撅臀|挺臀|臀部上翘|高抬胯/, tags: ['arched_back'], why: '翘臀/挺胯' },
  { re: /盘腿/, tags: ['indian_style'], why: '盘腿' },
  { re: /正坐|跪坐/, tags: ['seiza'], why: '正坐/跪坐' },
  { re: /托腮|支腮|手托脸|捧脸|戳脸/, tags: ['hand_on_own_cheek'], why: '托腮/捧脸' },
  { re: /膝上|坐于膝|坐在腿上/, tags: ['sitting_on_lap'], why: '坐于膝上' },
  { re: /抱胸|双臂交叉|双手交叉抱/, tags: ['crossed_arms'], why: '抱胸/双臂交叉' },
  { re: /V字打开|张腿|打开双腿|双腿打开|开脚|分腿/, tags: ['spread_legs'], why: '双腿打开' },
  { re: /交缠|双腿交叉|腿缠绕/, tags: ['crossed_legs'], why: '双腿交缠' },
  { re: /自背后环抱|背后环抱|从背后抱|背后抱/, tags: ['hug_from_behind'], why: '从背后环抱' },
  { re: /相拥|拥抱|依偎|环抱/, tags: ['hug'], why: '相拥/依偎' },
  { re: /捧胸|揉胸|托胸|摸胸|手抚胸/, tags: ['hand_on_own_chest'], why: '双手捧/揉胸' },
  { re: /收膝|屈膝|膝盖收/, tags: ['knees_up'], why: '屈膝/收膝' },
  { re: /并腿|双腿并拢/, tags: ['legs_together'], why: '双腿并拢' },
  { re: /目视前方|直视|看向前方/, tags: ['looking_at_viewer'], why: '目视前方' },
  { re: /后仰/, tags: ['leaning_back'], why: '后仰' },
  { re: /桥式|挺胯/, tags: ['bridge'], why: '桥式/挺胯' },
  { re: /搭肩|扶肩/, tags: ['arm_around_shoulder'], why: '搭肩/扶肩' },
  { re: /扶膝|触膝/, tags: ['hand_on_own_knee'], why: '手扶膝' },
  // 「特殊」分类没有固定 tag，只能靠名称判：团身 / 开腿 / 四肢着地 / 踮脚 / 蹲，这几类在真 catalog 里都出现过。
  { re: /团身|蜷缩/, tags: ['curled_up'], why: '团身/蜷缩' },
  { re: /开腿|横叉|全开/, tags: ['spread_legs'], why: '开腿/横叉' },
  { re: /四肢着地|桌面式/, tags: ['all_fours'], why: '四肢着地/桌面式' },
  { re: /踮脚|脚尖点地/, tags: ['tiptoes'], why: '踮脚' },
  { re: /蹲/, tags: ['squatting'], why: '蹲姿' },
  { re: /顶胯|翘臀/, tags: ['arched_back'], why: '顶胯/翘臀' },
  { re: /扶墙|手扶墙/, tags: ['hand_on_wall', 'against_wall'], why: '手扶墙' },
  { re: /倒立/, tags: ['handstand'], why: '倒立' },
  // 可爱系那批手部小动作：catalog 名称很具体，逐条对到库里真有的词才补得上。
  { re: /比V|比双V|剪刀手|辣妹V/, tags: ['v'], why: '比 V' },
  { re: /食指抵唇|嘘|噤声/, tags: ['shushing', 'finger_to_mouth'], why: '食指抵唇' },
  { re: /遮单眼|手遮单眼/, tags: ['hand_on_own_face'], why: '手遮单眼' },
  { re: /敬礼/, tags: ['salute'], why: '敬礼' },
  { re: /伸懒腰|伸展/, tags: ['stretching'], why: '伸懒腰/伸展' },
  { re: /取景框|指向镜头|手指镜头/, tags: ['pointing_at_viewer'], why: '指向镜头' },
  { re: /合十|拜托/, tags: ['own_hands_together'], why: '双手合十' },
  { re: /挽至耳后|拨到耳后|挽发/, tags: ['hair_behind_ear', 'tucking_hair'], why: '挽发至耳后' },
  { re: /害羞|抱紧自己/, tags: ['embarrassed'], why: '害羞/抱紧自己' },
  { re: /腋下/, tags: ['armpit_peek'], why: '展露腋下' },
  { re: /食指/, tags: ['index_finger_raised'], why: '食指立起' },
  { re: /比心/, tags: ['heart_hands'], why: '比心' },
  { re: /单腿后抬|单腿抬|高抬腿|高抬|劈叉/, tags: ['leg_up'], why: '抬腿' },
  { re: /扶大腿|手扶腿|手触小腿/, tags: ['hand_on_own_leg'], why: '手扶腿' },
  { re: /握拳/, tags: ['clenched_hand'], why: '握拳' },
  { re: /猫爪|招财猫/, tags: ['paw_pose'], why: '猫爪手势' },
  { re: /飞吻/, tags: ['blowing_kiss'], why: '飞吻' },
  { re: /掩口|捂嘴/, tags: ['hand_on_own_face'], why: '掩口' },
  { re: /指缝|窥视/, tags: ['peeking_through_fingers'], why: '指缝窥视' },
]

/**
 * catalog 所在体系（set 名）→ 人物数 tag。
 * 单人体系（all / standard / sexy / upper）不补；双人体系给 couple（真实 tag，不分性别）。
 */
export const SET_TAGS = {
  all: [],
  standard: [],
  sexy: [],
  upper: [],
  couple: ['couple'],
  double: ['couple'],
}

/** 来源表：四个推导来源各自的表，测试与文档遍历用。 */
export const TAG_SOURCES = {
  category: CATEGORY_TAGS,
  name: NAME_HINTS,
  angle: ANGLE_TAGS,
  set: SET_TAGS,
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 姿势 → tag。
 * @param {{ base?: string, code?: string, name?: string, category?: string, angle?: string, set?: string }} input
 *   catalog 一行：base 是同一姿势的基准编码（不参与推导），code 是姿势编号。
 * @returns {{ pose: string[], camera: string[], reasons: string[] }}
 *   pose：set 标签 + 分类标签 + 名称提示（去重保序）；camera：角度对应的单个镜头词；
 *   reasons：人类可读的推导链，给面板 tooltip 用。
 */
export function tagsForPose(input) {
  const row = input !== null && typeof input === 'object' ? input : {}
  const name = text(row.name)
  // 名称是这套映射的锚点：没有名字就没什么可推的，直接给空数组（不抛）
  if (name === '') return { pose: [], camera: [], reasons: [] }

  const category = text(row.category)
  const angle = text(row.angle)
  const set = text(row.set)
  const pose = []
  const reasons = []
  const add = (tag, why) => {
    if (typeof tag !== 'string' || tag === '' || pose.includes(tag)) return
    pose.push(tag)
    reasons.push(why)
  }

  for (const tag of SET_TAGS[set] ?? []) add(tag, '体系：' + set + ' → ' + tag)

  const categoryTags = CATEGORY_TAGS[category]
  if (Array.isArray(categoryTags) === false) {
    reasons.push('分类：' + (category === '' ? '（空）' : category) + ' → 未收录，跳过')
  } else if (categoryTags.length === 0) {
    reasons.push('分类：' + category + ' → 没有稳定的姿态词，不补')
  } else {
    for (const tag of categoryTags) add(tag, '分类：' + category + ' → ' + tag)
  }

  for (const hint of NAME_HINTS) {
    if (hint.re.test(name) === false) continue
    for (const tag of hint.tags) add(tag, '名称：「' + hint.why + '」→ ' + tag)
  }

  const cameraTag = ANGLE_TAGS[angle]
  const camera = typeof cameraTag === 'string' && cameraTag !== '' ? [cameraTag] : []
  reasons.push(
    camera.length > 0
      ? '角度：' + angle + ' → ' + cameraTag
      : '角度：' + (angle === '' ? '（空）' : angle) + ' → 未收录，不补镜头词',
  )

  return { pose, camera, reasons }
}
