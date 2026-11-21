/**
 * 参考样式预设库：给 /studio 中栏的「参考样式」卡片用。
 *
 * 纯数据 + 纯函数：零依赖、无 IO、不读环境变量，面板与服务端都能直接 import。
 * 每个 tag 都在 data/danbooru/general.jsonl 里逐条核对过（tests/styles.test.mjs 会复核）。
 * 这里只放画风 / 光照 / 场景 / 镜头 / 氛围，不放人群与露骨词 —— 这个库要能进公开版。
 *
 * 维护约定：每张卡的 tags 数组写在同一行（发布脚本按行裁剪，跨行会把卡片切坏）。
 */

/** 五个分组，顺序即面板从上到下的顺序。 */
export const STYLE_GROUPS = [
  { key: 'look', label: '画风质感', note: '同一张图换成另一种画法：线条、上色、介质感' },
  { key: 'light', label: '光照', note: '光从哪来、硬还是软，决定画面情绪的一半' },
  { key: 'scene', label: '场景', note: '背景与地点，撑住构图又不抢主体' },
  { key: 'camera', label: '镜头构图', note: '景别与机位，改的是取景范围与透视' },
  { key: 'mood', label: '情绪氛围', note: '冷暖、动静、年代感，给整张图定调' },
]

/** 卡片。id 全局唯一（kebab-case）；accent 只用于卡片左侧小色条。 */
export const STYLES = [
  { id: 'film-noir-look', title: '黑白片', group: 'look', accent: 'slate', note: '黑白高反差加胶片颗粒，像老式黑色电影的一帧', tags: ['greyscale', 'high_contrast', 'film_grain'] },
  { id: 'soft-pastel', title: '柔和粉彩', group: 'look', accent: 'rose', note: '低饱和粉彩色块，平涂上色，柔和干净不刺眼', tags: ['pastel_colors', 'limited_palette', 'flat_color'] },
  { id: 'ink-lineart', title: '墨线稿', group: 'look', accent: 'slate', note: '素描线稿加单色，像随手画在纸上的草稿', tags: ['sketch', 'lineart', 'monochrome'] },
  { id: 'cel-shaded', title: '赛璐璐上色', group: 'look', accent: 'indigo', note: '动画赛璐璐分色，阴影边界干净利落', tags: ['anime_coloring', 'flat_color', 'lineart'] },
  { id: 'comic-print', title: '美漫网点', group: 'look', accent: 'amber', note: '美漫印刷味：网点、粗线、少量套色', tags: ['comic', 'halftone', 'limited_palette'] },
  { id: 'pixel-game', title: '像素游戏', group: 'look', accent: 'teal', note: '像素颗粒配平涂高饱和，复古游戏画面感', tags: ['pixel_art', 'flat_color', 'saturated'] },
  { id: 'ukiyo-e-print', title: '浮世绘', group: 'look', accent: 'amber', note: '木版浮世绘的平涂与套色，东方版画质感', tags: ['ukiyo-e', 'flat_color', 'limited_palette'] },
  { id: 'photo-real', title: '照片写实', group: 'look', accent: 'slate', note: '写实质感加镜头缺陷：色散与暗角一起来', tags: ['realistic', 'chromatic_aberration', 'vignetting'] },

  { id: 'golden-hour', title: '黄金时刻', group: 'light', accent: 'amber', note: '低角度暖阳逆着打过来，轮廓镶金边', tags: ['golden_hour', 'sunlight', 'backlighting'] },
  { id: 'rim-glow', title: '轮廓光', group: 'light', accent: 'amber', note: '强逆光只留一圈亮边，主体几乎成剪影', tags: ['backlighting', 'silhouette', 'lens_flare'] },
  { id: 'moonlight-hour', title: '月夜冷光', group: 'light', accent: 'teal', note: '月光那层冷蓝，昼夜交界处的安静感', tags: ['moonlight', 'night', 'twilight'] },
  { id: 'neon-night', title: '霓虹夜光', group: 'light', accent: 'rose', note: '霓虹灯管外溢的光晕，边缘带一点色散', tags: ['neon_lights', 'bloom', 'chromatic_aberration'] },
  { id: 'candle-warm', title: '烛火暖调', group: 'light', accent: 'amber', note: '单点烛光照明，明暗分界强烈，暖到发红', tags: ['candlelight', 'bloom', 'chiaroscuro'] },
  { id: 'sunbeam-dust', title: '光柱浮尘', group: 'light', accent: 'teal', note: '穿窗的光柱里浮着尘埃，空气感立起来', tags: ['sunbeam', 'light_particles', 'dappled_sunlight'] },
  { id: 'hard-spotlight', title: '硬光聚束', group: 'light', accent: 'slate', note: '一束硬光打下来，影子边缘锋利', tags: ['spotlight', 'shadow', 'high_contrast'] },

  { id: 'quiet-bedroom', title: '卧室清晨', group: 'scene', accent: 'teal', note: '卧室窗边透进来的晨光，私密又安静', tags: ['bedroom', 'curtains', 'window_light'] },
  { id: 'school-classroom', title: '教室', group: 'scene', accent: 'teal', note: '靠窗的课桌与走廊，天然的校园叙事场所', tags: ['classroom', 'indoors', 'window'] },
  { id: 'city-street-night', title: '夜街', group: 'scene', accent: 'indigo', note: '夜里街道与店铺灯光，适合都市感构图', tags: ['street', 'city_lights', 'night'] },
  { id: 'forest-path', title: '林间', group: 'scene', accent: 'teal', note: '林子里斑驳的光影，绿色基调压住画面', tags: ['forest', 'tree', 'nature'] },
  { id: 'seaside-shore', title: '海边', group: 'scene', accent: 'teal', note: '沙滩、海面与浪花，留白和天空都好用', tags: ['beach', 'ocean', 'waves'] },
  { id: 'shrine-autumn', title: '秋日神社', group: 'scene', accent: 'amber', note: '神社与秋色，木构建筑配暖色落叶', tags: ['shrine', 'autumn', 'tree'] },
  { id: 'cozy-cafe', title: '咖啡馆', group: 'scene', accent: 'amber', note: '室内暖光的咖啡馆，窗边座位最有故事', tags: ['cafe', 'indoors', 'window_light'] },
  { id: 'rain-street', title: '雨街', group: 'scene', accent: 'slate', note: '雨里的街道与地面反光，湿冷氛围拉满', tags: ['street', 'rain', 'reflection'] },
  { id: 'snow-field', title: '雪原', group: 'scene', accent: 'slate', note: '积雪覆盖的旷野，冷白大面积留白', tags: ['snow', 'field', 'winter'] },
  { id: 'moonlit-rooftop', title: '月下天台', group: 'scene', accent: 'indigo', note: '楼顶天台加星空，城市上方的空旷感', tags: ['rooftop', 'night', 'starry_sky'] },

  { id: 'extreme-close-up', title: '近景特写', group: 'camera', accent: 'slate', note: '只留胸口以上，背景化开，情绪直接怼脸', tags: ['close-up', 'portrait', 'depth_of_field'] },
  { id: 'cowboy-mid', title: '中景', group: 'camera', accent: 'slate', note: '裁到大腿中部，动作与手势都能看清', tags: ['cowboy_shot', 'upper_body', 'depth_of_field'] },
  { id: 'full-body-framing', title: '全身构图', group: 'camera', accent: 'indigo', note: '从头到脚全进画，姿势与服装一览无余', tags: ['full_body', 'depth_of_field'] },
  { id: 'high-angle', title: '俯拍机位', group: 'camera', accent: 'indigo', note: '从高处往下看，压缩空间、凸显地面', tags: ['from_above', 'wide_shot'] },
  { id: 'low-angle', title: '仰拍机位', group: 'camera', accent: 'indigo', note: '从下往上拍，拉长腿线、气势压人', tags: ['from_below', 'wide_shot'] },
  { id: 'side-profile', title: '侧面剪影', group: 'camera', accent: 'slate', note: '纯侧脸角度，鼻梁与下颌线的形状说话', tags: ['from_side', 'silhouette'] },
  { id: 'wide-panorama', title: '宽幅远景', group: 'camera', accent: 'teal', note: '横向拉开的远景，人小景大，适合风景叙事', tags: ['wide_shot', 'panorama', 'scenery'] },
  { id: 'fish-eye-lens', title: '鱼眼镜头', group: 'camera', accent: 'rose', note: '极广鱼眼，边缘拉伸变形，画面带张力', tags: ['fisheye', 'chromatic_aberration', 'vignetting'] },

  { id: 'quiet-night', title: '静夜', group: 'mood', accent: 'indigo', note: '夜色与月光，把节奏压慢、声音抽走', tags: ['night', 'moon', 'twilight'] },
  { id: 'nostalgic-warm', title: '旧照怀旧', group: 'mood', accent: 'amber', note: '偏黄褪色的旧照片感，像回忆里的一格', tags: ['sepia', 'vignetting', 'film_grain'] },
  { id: 'dreamy-glow', title: '梦幻光晕', group: 'mood', accent: 'rose', note: '柔光加浮尘，画面像蒙了一层薄纱', tags: ['bloom', 'light_particles', 'pastel_colors'] },
  { id: 'dark-thriller', title: '暗黑悬疑', group: 'mood', accent: 'slate', note: '压暗整体亮度、拉高对比，紧张感上来了', tags: ['dark', 'high_contrast', 'shadow'] },
  { id: 'festive-bright', title: '节庆亮色', group: 'mood', accent: 'rose', note: '彩屑、亮片与高饱和，热闹得有点吵', tags: ['confetti', 'colorful', 'sparkle'] },
  { id: 'spring-breeze', title: '春日微风', group: 'mood', accent: 'rose', note: '樱色花瓣被风吹起，清爽又轻盈', tags: ['cherry_blossoms', 'petals', 'wind'] },
  { id: 'stormy-tension', title: '风雨将至', group: 'mood', accent: 'teal', note: '阴云、雷电与雨，气压低到能听见', tags: ['storm', 'lightning', 'overcast'] },
]

/** 卡片小色条允许的颜色令牌（前端只认这几个 class）。 */
export const ACCENTS = ['indigo', 'amber', 'teal', 'rose', 'slate']

function normalizeId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s_]+/g, '-') : ''
}

/** 组 + 卡片的浅拷贝（改动返回的对象不会污染源表）。 */
export function listStyles() {
  return {
    groups: STYLE_GROUPS.map(group => ({ ...group })),
    styles: STYLES.map(style => ({ ...style, tags: [...style.tags] })),
  }
}

/** 按 id 取卡片（容忍大小写、空格、下划线写法），找不到给 null；命中的是浅拷贝。 */
export function styleById(id) {
  const key = normalizeId(id)
  if (key === '') return null
  const hit = STYLES.find(style => style.id === key)
  return hit === undefined ? null : { ...hit, tags: [...hit.tags] }
}

/** 成对的外层括号。 */
const BRACKETS = [['(', ')'], ['{', '}'], ['[', ']']]

/** 权重尾巴：night:1.2 / night::1.2（ComfyUI 两种写法都有）。 */
const WEIGHT_TAIL = /^(.*?):{1,2}\s*[\d.]+$/

/**
 * 去掉 ((tag)) / {{tag}} / [tag] / tag:1.2 / tag::1.2 这些包装，
 * 再统一成小写下划线形态，只用于比较，不用于输出。
 */
function bareTag(entry) {
  let text = typeof entry === 'string' ? entry.trim() : ''
  if (text === '') return ''
  // 转义反斜杠先去掉：\(night\) 与 (night) 是同一个词
  text = text.replace(/\\([()[\]{}])/g, '$1')
  // 括号与权重可以互相嵌套（(night:1.2)、((night))::1.2），剥到不再变化为止
  for (let guard = 0; guard < 16; guard += 1) {
    const before = text
    const weighted = WEIGHT_TAIL.exec(text)
    if (weighted !== null) text = weighted[1].trim()
    for (const [open, close] of BRACKETS) {
      if (text.length > open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
        text = text.slice(open.length, -close.length).trim()
      }
    }
    if (text === before) break
  }
  return text.toLowerCase().replace(/[\s_]+/g, '_')
}

/** 提示词切分：英文逗号、中文逗号、顿号、换行都算分隔符（面板里中英混排很常见）。 */
function splitPrompt(text) {
  return text.split(/[,，、\n]/)
}

/**
 * 按 ids 顺序展开样式 tags，去重保序；current 里已有的跳过（比较时忽略权重语法）。
 * @param {string[] | string} ids
 * @param {{ current?: string[] | string }} [options]
 * @returns {string[]}
 */
export function tagsOfStyles(ids, { current = [] } = {}) {
  const list = Array.isArray(ids) ? ids : typeof ids === 'string' ? [ids] : []
  const existing = new Set(
    (Array.isArray(current) ? current : typeof current === 'string' ? splitPrompt(current) : [])
      .map(bareTag)
      .filter(tag => tag !== ''),
  )
  const out = []
  for (const id of list) {
    const style = styleById(id)
    if (style === null) continue
    for (const tag of style.tags) {
      const key = bareTag(tag)
      if (key === '' || existing.has(key)) continue
      existing.add(key)
      out.push(tag)
    }
  }
  return out
}

/**
 * 面板「套用样式」：样式 tags 在前、原文本在后，逗号连接，空片段丢弃。
 * 原文本里已经写过的词不再重复补一遍。
 * @param {string[] | string} ids
 * @param {string} [text]
 */
export function mergeStylePrompt(ids, text = '') {
  const body = typeof text === 'string' ? text.trim() : ''
  const alreadyThere = body === '' ? [] : splitPrompt(body)
  const tags = tagsOfStyles(ids, { current: alreadyThere })
  const parts = [...tags, body].map(part => part.trim()).filter(part => part !== '')
  return parts.join(', ')
}
