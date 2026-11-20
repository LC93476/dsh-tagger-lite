// plan: 规则数据层 —— 13 段桶表、上下位对、同义组、性别与人数词表、精确桶表、词根规则；只放常量，不放流程。
/**
 * lib/postprocess/rules.js — 后处理用到的全部「词表 / 桶表」数据。
 *
 * 为什么单独一层：这些表是**看得见、调得动**的策略（哪个词算镜头、哪两词同义、上位词降多少）。
 * 真机锻造出问题时，要改的几乎总是这里；而流程（lib/postprocess/index.js）应该稳定不动。
 * 两者混在一个 652 行的文件里时，改一条规则要翻过十几段流程，很容易顺手碰坏逻辑。
 *
 * 词表已按 lead 核实的真库清单校对：库里没有的词（explicit / nsfw / topless / presenting /
 * face_closeup / doggy_style / young_adult 等）不收进来，免得规则自己制造未收录词。
 *
 * 纯数据，零依赖，浏览器与测试里都能直接 import。
 */

/**
 * 桶序为什么是这个顺序（每一段的位置都是被真机错误逼出来的）：
 *   1  subject    主体与人数 —— 读者第一眼要知道「画面里有谁、几个人」；
 *   2  character  角色与作品 —— 认人先于认衣服，name_(copyright) 必须紧跟主体；
 *   3  hair       发型与瞳色 —— 角色的可识别细节，仍属于「这个人」；
 *   4  body       体型与外观 —— 比发型次要的外形描述；
 *   5  expression 表情 —— 依赖前面的主体与五官，放太靠后会读成一堆形容词；
 *   6  pose       姿势与动作 —— 人物骨架，后面的服装要挂在它身上才讲得通；
 *   7  limbs      肢体关系与手 —— 手放哪、和谁接触，是姿势的细分；
 *   8  clothing   服装与配饰 —— 必须在姿势之后（衣服是穿在姿势上的），
 *                也必须在镜头之前（真机错误：镜头词跑到服装词前面，把构图权重抢走）；
 *   9  sexual     性相关细节 —— 语义最重的细节，靠后但不落到画质段；
 *  10  camera     镜头与构图 —— from_side / close-up 描述「怎么看」，
 *                一定排在「看到什么」之后，且不许压过服装；
 *  11  scene      场景与背景 —— 先人后景；
 *  12  lighting   光照与风格 —— 光与氛围是最后一层修饰；
 *  13  other      画质 / 文字 / 后期 —— 一条都不要抢前面任何词的位置。
 */
/** 13 段桶表，顺序即词序；与 lib/purge.js「## 词序」的 1–13 段对齐。 */
export const BUCKETS = [
  { key: 'subject', label: '主体与人数' },
  { key: 'character', label: '角色与作品' },
  { key: 'hair', label: '发型与瞳色' },
  { key: 'body', label: '体型与外观' },
  { key: 'expression', label: '表情' },
  { key: 'pose', label: '姿势与动作' },
  { key: 'limbs', label: '肢体关系与手' },
  { key: 'clothing', label: '服装与配饰' },
  { key: 'sexual', label: '性相关细节' },
  { key: 'camera', label: '镜头与构图' },
  { key: 'scene', label: '场景与背景' },
  { key: 'lighting', label: '光照与风格' },
  { key: 'other', label: '其它' },
]

export const BUCKET_INDEX = Object.fromEntries(BUCKETS.map((bucket, index) => [bucket.key, index]))

/**
 * 上下位对：[上位词, 下位词]。两者同时出现时上位词权重降到 0.85（**不删**）。
 * 下位词保留原权重 —— 用户想表达的是「仰卧」，不是笼统的「躺着」。
 */
export const SUPERSET_PAIRS = [
  ['lying', 'on_back'],
  ['lying', 'on_stomach'],
  ['lying', 'on_side'],
  ['sitting', 'seiza'],
  ['sitting', 'wariza'],
  ['standing', 'contrapposto'],
  ['standing', 'standing_sex'],
  // 注意：from_behind / facing_away 曾经也在这里，但这俩不是一个量级 —— 视角词被降到 0.85
  // 会把用户明说的「从正后方拍」压软，所以不降权，两个都留。
  ['nude', 'completely_nude'],
  // 公开版不含成人向上下位对：完整版在「裸体」之后还有几条「上位词 + 具体行为」的降权关系，
  // 公开版不内置这套词表，所以这一段只留姿势与裸体。
]

/**
 * 真同义组：组内第一个是留下的（库里更 canonical 的那个），其余全部删掉。
 * 只收「同一个意思的两种写法」，不收「粗细不同」的词 —— 后者走 SUPERSET_PAIRS。
 */
export const SYNONYM_GROUPS = [
  // profile 只描述「侧脸」，与 from_side 的侧面视角重复时会互相打架（真机实测的高频错误）
  ['from_side', 'profile'],
  ['bent_over', 'bending_over'],
  ['squatting', 'crouching'],
  ['kiss', 'kissing'],
]

/** 上位词降到的权重。写成「降到」而不是「乘以」，这样 apply 两遍结果不变。 */
export const SUPERSET_WEIGHT = 0.85

/** 人数词：只要结果里出现任何一个，就说明人数已经被表达过，一律不再补。 */
export const COUNT_WORDS = new Set([
  '1girl', '1boy', '2girls', '2boys', '3girls', '3boys', '4girls', '4boys',
  '5girls', '5boys', '6+girls', '6+boys', 'multiple_girls', 'multiple_boys',
  'multiple_others', '1other', 'solo', 'solo_focus', 'hetero', 'duo', 'couple',
  'male_focus', 'no_humans',
])

export const COUNT_RE = /^\d+\+?(girl|boy|other)s?$/

/** 白话里出现这些词就认为「画面里有女性 / 男性」。注意先剔掉「其他 / 其它 / 吉他」里的「他」。 */
export const FEMALE_RE = /少女|女孩|女生|女性|妹子|姐姐|妹妹|姑娘|女人|女/
export const MALE_RE = /男孩|男生|男性|男人|汉子|哥哥|弟弟|大叔|他|男/
export const MALE_FALSE_POSITIVE_RE = /其他|其它|吉他/g

/** 精确桶表：命中即定桶，优先于任何词根规则（这些词靠词根会被分错）。 */
export const EXACT_BUCKET = {
  // 主体与人数
  '1girl': 'subject', '1boy': 'subject', '2girls': 'subject', '2boys': 'subject',
  '3girls': 'subject', '3boys': 'subject', '4girls': 'subject', '4boys': 'subject',
  '5girls': 'subject', '5boys': 'subject', '6+girls': 'subject', '6+boys': 'subject',
  multiple_girls: 'subject', multiple_boys: 'subject', multiple_others: 'subject',
  '1other': 'subject', solo: 'subject', solo_focus: 'subject', hetero: 'subject',
  duo: 'subject', couple: 'subject', male_focus: 'subject',
  no_humans: 'subject',

  // 发型与瞳色
  long_hair: 'hair', short_hair: 'hair', medium_hair: 'hair',
  blonde_hair: 'hair', black_hair: 'hair', brown_hair: 'hair', white_hair: 'hair',
  blue_hair: 'hair', pink_hair: 'hair', red_hair: 'hair',
  purple_hair: 'hair', green_hair: 'hair', grey_hair: 'hair', orange_hair: 'hair',
  multicolored_hair: 'hair', gradient_hair: 'hair', twintails: 'hair', ponytail: 'hair',
  side_ponytail: 'hair', braid: 'hair', twin_braids: 'hair', hair_bun: 'hair',
  // 注意：bangs / silver_hair 不在本机词表快照里（刘海被拆成 blunt_bangs / parted_bangs 等，银发走 grey_hair），
  // 这张表只收库里真有的词 —— 收进来只会误导维护者，见 tests/postprocess.test.mjs 的「幽灵词」断言。
  double_bun: 'hair', bob_cut: 'hair', hime_cut: 'hair', ahoge: 'hair',
  blunt_bangs: 'hair', sidelocks: 'hair', hair_between_eyes: 'hair',
  heterochromia: 'hair', eyelashes: 'hair', eyebrows: 'hair',
  blue_eyes: 'hair', red_eyes: 'hair', green_eyes: 'hair', brown_eyes: 'hair',
  yellow_eyes: 'hair', purple_eyes: 'hair', grey_eyes: 'hair',

  // 表情
  smile: 'expression', smiling: 'expression', seductive_smile: 'expression',
  blush: 'expression', open_mouth: 'expression', closed_mouth: 'expression',
  'closed_eyes': 'expression', one_eye_closed: 'expression', parted_lips: 'expression',
  'half-closed_eyes': 'expression', frown: 'expression', angry: 'expression',
  sad: 'expression', crying: 'expression', tears: 'expression', sweat: 'expression',
  sweatdrop: 'expression', ahegao: 'expression', expressionless: 'expression',
  pout: 'expression', grin: 'expression', smirk: 'expression', laughing: 'expression',
  surprised: 'expression', embarrassed: 'expression', nervous: 'expression',
  scared: 'expression', heart: 'expression', tongue: 'expression',
  tongue_out: 'expression', rolling_eyes: 'expression', clenched_teeth: 'expression',
  heavy_breathing: 'expression', drooling: 'expression', trembling: 'expression',

  // 体型与外观
  breasts: 'body', large_breasts: 'body', medium_breasts: 'body', small_breasts: 'body',
  flat_chest: 'body', cleavage: 'body', navel: 'body', collarbone: 'body',
  thighs: 'body', long_legs: 'body', thick_thighs: 'body', wide_hips: 'body',
  narrow_waist: 'body', skinny: 'body', slim: 'body', muscular: 'body', abs: 'body',
  curvy: 'body', toned: 'body', mature_female: 'body', shiny_skin: 'body',
  loli: 'body', shota: 'body', milf: 'body', bare_shoulders: 'body', sideboob: 'body',
  freckles: 'body', feet: 'body', hands: 'body', pointy_ears: 'body', animal_ears: 'body',
  cat_ears: 'body', fox_ears: 'body', rabbit_ears: 'body', dog_ears: 'body',
  horns: 'body', tail: 'body', cat_tail: 'body', angel_wings: 'body', demon_wings: 'body',
  fang: 'body', mole_under_eye: 'body', testicles: 'body',

  // 姿势与动作
  standing: 'pose', sitting: 'pose', lying: 'pose', on_back: 'pose', on_stomach: 'pose',
  on_side: 'pose', kneeling: 'pose', squatting: 'pose', crouching: 'pose',
  walking: 'pose', running: 'pose', jumping: 'pose', dancing: 'pose',
  leaning_forward: 'pose', arms_up: 'pose', hands_up: 'pose', arms_behind_back: 'pose',
  spread_arms: 'pose', spread_legs: 'pose', dynamic_pose: 'pose', contrapposto: 'pose',
  arched_back: 'pose', bending_over: 'pose', bent_over: 'pose', all_fours: 'pose',
  seiza: 'pose', wariza: 'pose', crossed_legs: 'pose', legs_up: 'pose',
  legs_apart: 'pose', legs_together: 'pose', leg_up: 'pose', knee_up: 'pose',
  on_one_knee: 'pose', sitting_on_lap: 'pose', straddling: 'pose',
  upright_straddle: 'pose', indian_style: 'pose', fetal_position: 'pose',
  head_tilt: 'pose', handstand: 'pose',

  // 肢体关系与手
  hand_on_hip: 'limbs', hands_on_hips: 'limbs', hand_on_breast: 'limbs',
  hand_on_own_breast: 'limbs', hand_on_butt: 'limbs', hand_on_own_cheek: 'limbs',
  hand_up: 'limbs',
  crossed_arms: 'limbs', interlocked_fingers: 'limbs', arm_support: 'limbs',
  holding_hands: 'limbs', hugging: 'limbs', covering_face: 'limbs',
  hands_on_own_hips: 'limbs', hug: 'limbs', cupping_breasts: 'limbs', squeezing_own_breasts: 'limbs', grabbing: 'limbs',
  covering_breasts: 'limbs', covering_crotch: 'limbs', hands_on_own_thighs: 'limbs',
  hand_on_own_thigh: 'limbs',

  // 服装与配饰
  dress: 'clothing', skirt: 'clothing', pleated_skirt: 'clothing', shirt: 'clothing',
  blouse: 'clothing', jacket: 'clothing', coat: 'clothing', hoodie: 'clothing',
  sweater: 'clothing', school_uniform: 'clothing', serafuku: 'clothing', kimono: 'clothing',
  yukata: 'clothing', swimsuit: 'clothing', bikini: 'clothing', lingerie: 'clothing',
  panties: 'clothing', bra: 'clothing', thighhighs: 'clothing', pantyhose: 'clothing',
  stockings: 'clothing', socks: 'clothing', barefoot: 'clothing', shoes: 'clothing',
  boots: 'clothing', gloves: 'clothing', hat: 'clothing', glasses: 'clothing',
  sunglasses: 'clothing', earrings: 'clothing', necklace: 'clothing', choker: 'clothing',
  ribbon: 'clothing', bow: 'clothing', hair_bow: 'clothing', hair_ornament: 'clothing',
  hairclip: 'clothing', hairband: 'clothing', hair_ribbon: 'clothing',
  'one-piece_swimsuit': 'clothing', belt: 'clothing', tie: 'clothing', necktie: 'clothing', collar: 'clothing',
  apron: 'clothing', leotard: 'clothing', bodysuit: 'clothing', nightgown: 'clothing',
  negligee: 'clothing', pants: 'clothing', shorts: 'clothing', jeans: 'clothing',
  scarf: 'clothing', garter_belt: 'clothing', 'see-through': 'clothing',
  wet_clothes: 'clothing', partially_covered: 'clothing',

  // 性相关细节
  // 公开版不含成人向细节词表（部位 / 行为 / 体液）：完整版这一段逐词分桶，
  // 公开版按「按本机词表直写」处理，不内置这份词表。
  sex: 'sexual', oral: 'sexual', missionary: 'sexual', doggystyle: 'sexual',
  sex_from_behind: 'sexual', against_wall: 'sexual', facial: 'sexual', nude: 'sexual',
  completely_nude: 'sexual', butt_grab: 'sexual', saliva: 'sexual',

  // 镜头与构图
  'close-up': 'camera', from_side: 'camera', from_behind: 'camera', from_above: 'camera',
  from_below: 'camera', pov: 'camera', pov_hands: 'camera', looking_at_viewer: 'camera',
  looking_back: 'camera', looking_away: 'camera', looking_up: 'camera', looking_down: 'camera',
  looking_at_another: 'camera', looking_to_the_side: 'camera', eye_contact: 'camera',
  cowboy_shot: 'camera', portrait: 'camera', full_body: 'camera', upper_body: 'camera',
  lower_body: 'camera', profile: 'camera', facing_away: 'camera', facing_viewer: 'camera',
  'top-down_bottom-up': 'camera', "worm's_eye_view": 'camera',
  over_shoulder: 'camera', dutch_angle: 'camera', depth_of_field: 'camera',
  blurry_background: 'camera', simple_background: 'camera', white_background: 'camera',
  transparent_background: 'camera', gradient_background: 'camera', wide_shot: 'camera',
  medium_shot: 'camera', feet_out_of_frame: 'camera', head_out_of_frame: 'camera',
  fisheye: 'camera', symmetry: 'camera', letterboxed: 'camera',

  // 场景与背景
  scenery: 'scene', outdoors: 'scene', indoors: 'scene', sky: 'scene', cloud: 'scene',
  blue_sky: 'scene', sunset: 'scene', night: 'scene', day: 'scene', starry_sky: 'scene',
  rain: 'scene', snow: 'scene', water: 'scene', ocean: 'scene', beach: 'scene',
  forest: 'scene', mountain: 'scene', flower: 'scene', cherry_blossoms: 'scene',
  grass: 'scene', tree: 'scene', city: 'scene', cityscape: 'scene', street: 'scene',
  bedroom: 'scene', bathroom: 'scene', kitchen: 'scene',
  classroom: 'scene', bed: 'scene', on_bed: 'scene', chair: 'scene', couch: 'scene', sofa: 'scene', table: 'scene',
  window: 'scene', curtain: 'scene', pillow: 'scene', blanket: 'scene', mirror: 'scene',
  door: 'scene', wall: 'scene', floor: 'scene', wooden_floor: 'scene', tile_floor: 'scene',
  pool: 'scene', onsen: 'scene', library: 'scene', rooftop: 'scene', train: 'scene',
  car: 'scene', landscape: 'scene', ruins: 'scene',

  // 光照与风格（只收库内真词：rim_light / cinematic_lighting / soft_lighting / dramatic_lighting
  // / volumetric_lighting / room 在本机词表快照里都没有，收进来只会误导维护者）
  sunlight: 'lighting', moonlight: 'lighting', backlighting: 'lighting', sidelighting: 'lighting',
  underlighting: 'lighting', dim_lighting: 'lighting', light_particles: 'lighting', ring_light: 'lighting',
  spotlight: 'lighting', candlelight: 'lighting', lens_flare: 'lighting', glowing: 'lighting',
  sparkle: 'lighting', monochrome: 'lighting', greyscale: 'lighting', sepia: 'lighting',
  pastel_colors: 'lighting', vibrant_colors: 'lighting', 'watercolor_(medium)': 'lighting',
  'oil_painting_(medium)': 'lighting', sketch: 'lighting', lineart: 'lighting',
  '3d': 'lighting', photorealistic: 'lighting', chibi: 'lighting', realistic: 'lighting',
  high_contrast: 'lighting', motion_blur: 'lighting', chromatic_aberration: 'lighting',
  film_grain: 'lighting', vignetting: 'lighting',

  // 其它：画质 / 后期 / 文字类，一律排最后
  'best_quality': 'other', 'good_quality': 'other', 'normal_quality': 'other',
  'worst_quality': 'other', 'low_quality': 'other', lowres: 'other', highres: 'other',
  absurdres: 'other', 'jpeg_artifacts': 'other', blurry: 'other', bad_anatomy: 'other',
  bad_hands: 'other', bad_proportions: 'other', extra_digits: 'other',
  fewer_digits: 'other', missing_fingers: 'other', extra_limbs: 'other', bad_feet: 'other',
  text: 'other', watermark: 'other', signature: 'other', username: 'other', logo: 'other',
  english_text: 'other', chinese_text: 'other', speech_bubble: 'other', border: 'other',
  frame: 'other', censored: 'other', bar_censor: 'other', mosaic_censoring: 'other',
  uncensored: 'other',
}


/**
 * 词根规则：精确表没命中时按顺序试；**顺序即优先级**，别随便插。
 * 全部用小写、无空格、无转义的正则字面量，方便一眼看出谁先谁后。
 */
export const TOKEN_RULES = [
  // 角色与作品：带括号后缀的一律是角色 / 作品 / 画师名
  [/[(].+[)]$/, 'character'],
  [/^cosplay/, 'character'],
  [/^(series|artist|character)_/, 'character'],

  // 发型与瞳色
  [/_hair$|^hair|hair_|_eyes$|^eyes$|eye_color|bangs|twintails|ponytail|braid|ahoge|sidelocks|eyebrow|eyelash|heterochromia/, 'hair'],

  // 服装与配饰
  [/dress|skirt|shirt|sweater|jacket|coat$|hoodie|uniform|kimono|yukata|swimsuit|bikini|lingerie|panties|_bra$|^bra_|thighhigh|pantyhose|stocking|_socks?$|_shoes?$|boots|glove|_hat$|glasses|earring|necklace|choker|ribbon|_bow$|^bow_|belt|apron|leotard|bodysuit|cloth|outfit|costume|collar|_tie$|scarf|_pants$|shorts|jeans|barefoot|jewelry|ornament|hairclip|hairband|veil|crown|_mask$|corset|garter/, 'clothing'],

  // 性相关
  [/sex|nude|naked|saliva|foreplay|aroused|lewd|suggestive|butt_grab|sexually_suggestive/, 'sexual'],

  // 镜头与构图
  [/^from_|_view$|viewer|_angle|_shot$|^shot_|^close|portrait|framing|^pov|cropped|out_of_frame|composition|_focus|depth_of_field|blurry_background|perspective|^over_shoulder/, 'camera'],

  // 场景与背景
  [/background|outdoors|indoors|_sky$|^sky_|night$|^night_|_day$|room$|_bed$|^on_bed|chair|couch|sofa|window|curtain|pillow|blanket|floor|_wall$|^wall_|door$|street|cityscape|^city|forest|mountain|ocean|beach|water|rain|snow|flower|tree|grass|classroom|library|rooftop|train|_car$|pool|onsen|scenery|landscape|ruins|furniture/, 'scene'],

  // 光照与风格
  [/light|shadow|glow|blur|flare|_effect|monochrome|greyscale|sepia|_color|palette|_style|painting|sketch|lineart|realistic|cinematic|_render|_photo|gradient|pastel/, 'lighting'],

  // 肢体关系与手
  [/hand_.*|hands_.*|_hand$|_hands$|fingers?|^arm|_arm$|_arms$|^hug|_hug$|hugging|grabbing|holding|covering_|cupping|squeezing|_support$|interlocked/, 'limbs'],

  // 表情
  [/smil|blush|mouth|lips|frown|tears?$|crying|sweat|ahegao|expression|pout|grin|smirk|laugh|surprised|embarrass|nervous|scared|angry|sad$|teeth|tongue|drool|trembl|breathing|half-closed|rolling_eyes/, 'expression'],

  // 姿势与动作
  [/standing|sitting|kneel|lying|squat|crouch|bend|lean|arch|spread|straddl|_pose$|^pose_|position|walk|run$|jump|danc|^leg|_leg$|_legs$|knee|^sit|^lie_|^stand/, 'pose'],

  // 体型与外观
  [/breast|chest|thigh|hip|waist|navel|skin|muscular|slim|_abs$|body|figure|shoulder|freckle|ears?$|horns?$|tail$|wings?$|fang|mole|scar|tattoo/, 'body'],

  // 主体与人数
  [/^[0-9]+[+]?(girl|boy|other)s?$|^multiple_|^solo|^hetero|^duo|^couple|no_humans/, 'subject'],

  // 画质 / 后期 / 文字（排最后）
  [/quality|res$|resolution|artifact|^bad_|censored|text$|^text_|watermark|signature|_logo|bubble|border|^frame|username/, 'other'],
]
