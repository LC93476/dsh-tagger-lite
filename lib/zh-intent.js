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
    when: ['跪在床边', '跪在床上', '跪在床', '双膝跪地', '跪坐', '正坐', '跪着'],
    tags: [{ tag: 'kneeling', weight: W_POSE }, { tag: 'seiza', weight: W_SOFT }],
  },
  {
    // 单膝跪是 on_one_knee，不是跪坐：不给 seiza，只把 kneeling 降权兜一层
    key: 'on_one_knee',
    when: ['单膝跪地', '单膝跪', '一膝跪地', '单腿跪地', '半跪'],
    tags: [{ tag: 'on_one_knee', weight: W_POSE }, { tag: 'kneeling', weight: W_SOFT }],
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
    when: ['盘腿坐', '盘腿', '盘坐', '打坐', '结跏趺坐', '腿交叉盘坐'],
    tags: [{ tag: 'indian_style', weight: W_POSE }, { tag: 'crossed_legs', weight: W_SOFT }],
  },
  {
    // 鸭子坐（W 坐）是 wariza，不是盘腿：拆开，别让 indian_style 串味
    key: 'wariza',
    when: ['鸭子坐', 'w坐姿', 'w坐', '割座', '双腿外翻坐'],
    tags: [{ tag: 'wariza', weight: W_POSE }],
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
    when: ['从上往下看', '从上往下', '高角度俯拍', '俯拍', '俯视', '由上往下'],
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
    // profile 不在这里补：postprocess 的 SYNONYM_GROUPS 已有 ['from_side','profile']，重复补会自相抵消
    tags: [{ tag: 'from_side', weight: W_VIEW }],
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
    when: ['全身', '整个人入镜', '全身入镜'],
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
    when: ['三人行', '群交', '群p', '3p'],
    tags: [{ tag: 'threesome', weight: W_POSITION }, { tag: 'group_sex', weight: W_SOFT }],
  },
  {
    key: 'nude',
    when: ['全裸', '裸体', '一丝不挂', '光着身体'],
    tags: [{ tag: 'nude', weight: W_POSE }, { tag: 'completely_nude', weight: W_SOFT }],
  },

  // ---------------- 姿势补充：坐 / 跪 / 蜷 / 悬空 ----------------
  {
    key: 'yokozuwari',
    when: ['横坐', '侧坐', '歪着坐', '侧面坐地上'],
    tags: [{ tag: 'yokozuwari', weight: W_POSE }],
  },
  {
    key: 'butterfly_sit',
    when: ['蝴蝶坐', '脚掌对脚掌坐', '脚心相对坐'],
    tags: [{ tag: 'butterfly_sitting', weight: W_POSE }, { tag: 'indian_style', weight: W_SOFT }],
  },
  {
    key: 'figure_four_sit',
    when: ['四字坐', '4字坐姿', '翘腿坐'],
    tags: [{ tag: 'figure_four_sitting', weight: W_POSE }, { tag: 'crossed_legs', weight: W_SOFT }],
  },
  {
    key: 'lotus_sit',
    when: ['莲花坐', '双盘坐', '打莲花坐'],
    tags: [{ tag: 'lotus_position', weight: W_POSE }],
  },
  {
    key: 'sit_on_person',
    when: ['坐在人身上', '坐在对方身上', '压坐在身上'],
    tags: [{ tag: 'sitting_on_person', weight: W_POSE }],
  },
  {
    key: 'sit_on_shoulder',
    when: ['骑脖子', '坐在肩膀上', '骑在肩上'],
    tags: [{ tag: 'sitting_on_shoulder', weight: W_POSE }, { tag: 'sitting_on_person', weight: W_SOFT }],
  },
  {
    key: 'piggyback',
    when: ['背着走', '驮着', '背在背上', '背人'],
    tags: [{ tag: 'piggyback', weight: W_POSE }],
  },
  {
    key: 'fetal',
    when: ['蜷成一团', '胎儿姿势', '婴儿蜷缩'],
    tags: [{ tag: 'fetal_position', weight: W_POSE }, { tag: 'knees_to_chest', weight: W_SOFT }],
  },
  {
    key: 'reclining',
    when: ['斜倚', '半躺', '斜靠着躺'],
    tags: [{ tag: 'reclining', weight: W_POSE }, { tag: 'leaning_back', weight: W_SOFT }],
  },
  {
    key: 'crawling',
    when: ['爬行', '往前爬', '匍匐前进', '四肢爬'],
    tags: [{ tag: 'crawling', weight: W_POSE }, { tag: 'all_fours', weight: W_SOFT }],
  },
  {
    key: 'floating',
    when: ['悬浮', '飘浮', '悬空', '飘在空中'],
    tags: [{ tag: 'floating', weight: W_POSE }, { tag: 'midair', weight: W_SOFT }],
  },
  {
    key: 'flying',
    when: ['飞翔', '在空中飞', '飞起来'],
    tags: [{ tag: 'flying', weight: W_POSE }, { tag: 'midair', weight: W_SOFT }],
  },
  {
    key: 'falling',
    when: ['坠落', '往下掉', '摔下来'],
    tags: [{ tag: 'falling', weight: W_POSE }, { tag: 'midair', weight: W_SOFT }],
  },
  {
    key: 'midair',
    when: ['腾空', '离地跃起', '半空中'],
    tags: [{ tag: 'midair', weight: W_POSE }],
  },
  {
    key: 'upside_down',
    when: ['倒置', '倒挂', '上下颠倒', '头朝下倒着'],
    tags: [{ tag: 'upside-down', weight: W_POSE }],
  },
  // ---------------- 姿势补充：劈叉 / 倒立 / 跪拜 / 驼背 ----------------
  {
    key: 'split',
    when: ['一字马', '横劈叉', '劈一字'],
    tags: [{ tag: 'split', weight: W_POSE }, { tag: 'spread_legs', weight: W_SOFT }],
  },
  {
    key: 'standing_split',
    when: ['站立劈叉', '站着劈叉', '立劈叉'],
    tags: [{ tag: 'standing_split', weight: W_POSE }, { tag: 'standing', weight: W_SOFT }],
  },
  {
    key: 'handstand',
    when: ['手倒立', '倒立撑地', '双手撑地倒立'],
    tags: [{ tag: 'handstand', weight: W_POSE }],
  },
  {
    key: 'headstand',
    when: ['头倒立', '头顶倒立', '用头顶着倒立'],
    tags: [{ tag: 'headstand', weight: W_POSE }],
  },
  {
    key: 'body_bridge',
    when: ['桥式', '下腰撑地', '拱桥姿势'],
    tags: [{ tag: 'body_bridge', weight: W_POSE }, { tag: 'arched_back', weight: W_SOFT }],
  },
  {
    key: 'prostration',
    when: ['五体投地', '跪地叩拜', '伏地跪拜', '磕头趴地'],
    tags: [{ tag: 'prostration', weight: W_POSE }, { tag: 'kneeling', weight: W_SOFT }],
  },
  {
    key: 'cowering',
    when: ['畏缩', '害怕地缩着', '缩着躲'],
    tags: [{ tag: 'cowering', weight: W_POSE }],
  },
  {
    key: 'slouching',
    when: ['含胸驼背', '驼背', '塌肩'],
    tags: [{ tag: 'slouching', weight: W_POSE }],
  },
  {
    key: 'sway_back',
    when: ['凹背', '挺胸塌腰', '骨盆前倾'],
    tags: [{ tag: 'sway_back', weight: W_POSE }, { tag: 'arched_back', weight: W_SOFT }],
  },
  {
    key: 'leaning_back',
    when: ['后仰', '身体后倾', '往后仰'],
    tags: [{ tag: 'leaning_back', weight: W_POSE }],
  },
  {
    key: 'head_back',
    when: ['头后仰', '脑袋往后仰', '脖子后仰'],
    tags: [{ tag: 'head_back', weight: W_POSE }, { tag: 'looking_up', weight: W_SOFT }],
  },
  {
    key: 'twisted_torso',
    when: ['扭腰', '身体扭转', '拧腰'],
    tags: [{ tag: 'twisted_torso', weight: W_POSE }],
  },
  {
    key: 'yoga',
    when: ['瑜伽', '做瑜伽', '瑜伽动作'],
    tags: [{ tag: 'yoga', weight: W_POSE }],
  },
  {
    key: 'over_the_knee',
    when: ['趴在膝上', '被按在腿上', '趴腿上'],
    tags: [{ tag: 'over_the_knee', weight: W_POSE }, { tag: 'bent_over', weight: W_SOFT }],
  },
  {
    key: 'spread_eagle',
    when: ['大字躺', '大字型仰躺', '四肢摊开躺'],
    tags: [{ tag: 'spread_eagle_position', weight: W_POSE }, { tag: 'on_back', weight: W_SOFT }],
  },
  {
    key: 'fighting_stance',
    when: ['战斗架势', '格斗姿势', '备战姿态'],
    tags: [{ tag: 'fighting_stance', weight: W_POSE }],
  },
  {
    key: 'pouncing',
    when: ['扑过去', '猛扑', '飞扑'],
    tags: [{ tag: 'pouncing', weight: W_POSE }],
  },
  {
    key: 'balancing',
    when: ['保持平衡', '平衡站立', '重心稳住'],
    tags: [{ tag: 'balancing', weight: W_POSE }],
  },
  // ---------------- 姿势补充：站姿细节（踮脚 / 内外八 / 交叉腿 / 字型） ----------------
  {
    key: 'tiptoes',
    when: ['踮脚', '踮起脚尖', '脚尖着地', '踮着脚'],
    tags: [{ tag: 'tiptoes', weight: W_POSE }],
  },
  {
    key: 'pigeon_toed',
    when: ['内八字', '内八站姿', '脚尖朝内'],
    tags: [{ tag: 'pigeon-toed', weight: W_POSE }, { tag: 'standing', weight: W_SOFT }],
  },
  {
    key: 'bowlegged',
    when: ['罗圈腿', 'o型腿', '腿往外撇着站'],
    tags: [{ tag: 'bowlegged_pose', weight: W_POSE }],
  },
  {
    key: 'watson_cross',
    when: ['交叉站姿', '一条腿绕到后面', '绕腿站立'],
    tags: [{ tag: 'watson_cross', weight: W_POSE }, { tag: 'crossed_legs', weight: W_SOFT }],
  },
  {
    key: 'a_pose',
    when: ['a字站姿', 'a字姿势', 'a形站姿'],
    tags: [{ tag: 'a-pose', weight: W_POSE }],
  },
  {
    key: 't_pose',
    when: ['t字站姿', 't字姿势', '双臂平举'],
    tags: [{ tag: 't-pose', weight: W_POSE }, { tag: 'outstretched_arms', weight: W_SOFT }],
  },
  {
    key: 'arms_at_sides',
    when: ['双臂垂在两侧', '双手放两侧', '垂手站着'],
    tags: [{ tag: 'arms_at_sides', weight: W_POSE }],
  },
  {
    key: 'knees_together_feet_apart',
    when: ['双膝并拢双脚分开', '并膝开脚', '膝盖并着脚分开'],
    tags: [{ tag: 'knees_together_feet_apart', weight: W_POSE }, { tag: 'legs_apart', weight: W_SOFT }],
  },
  {
    key: 'knees_apart_feet_together',
    when: ['双膝分开双脚并拢', '开膝并脚', '膝盖分开脚并着'],
    tags: [{ tag: 'knees_apart_feet_together', weight: W_POSE }],
  },
  {
    key: 'folded',
    when: ['对折', '身体折起来', '整个人折叠'],
    tags: [{ tag: 'folded', weight: W_POSE }],
  },
  {
    key: 'uneven_footing',
    when: ['站姿不稳', '重心不稳', '一只脚高一只脚低'],
    tags: [{ tag: 'uneven_footing', weight: W_POSE }],
  },
  {
    key: 'superhero_landing',
    when: ['超级英雄落地', '单膝落地登场', '英雄落地姿势'],
    tags: [{ tag: 'superhero_landing', weight: W_POSE }, { tag: 'on_one_knee', weight: W_SOFT }],
  },
  {
    key: 'faceplant',
    when: ['脸着地', '脸朝下倒下', '脸砸地上'],
    tags: [{ tag: 'faceplant', weight: W_POSE }, { tag: 'on_stomach', weight: W_SOFT }],
  },
  {
    key: 'zombie_pose',
    when: ['僵尸姿势', '僵尸走', '双手前伸僵硬'],
    tags: [{ tag: 'zombie_pose', weight: W_POSE }],
  },
  {
    key: 'ghost_pose',
    when: ['幽灵姿势', '双手垂着飘', '鬼魂姿势'],
    tags: [{ tag: 'ghost_pose', weight: W_POSE }],
  },
  {
    key: 'victory_pose',
    when: ['胜利姿势', '比胜利手势', '庆祝姿势'],
    tags: [{ tag: 'victory_pose', weight: W_POSE }],
  },
  {
    key: 'jojo_pose',
    when: ['jojo立', 'jojo姿势', '夸张站姿'],
    tags: [{ tag: 'jojo_pose', weight: W_POSE }],
  },
  {
    key: 'thigh_straddling',
    when: ['跨坐大腿', '跨在一条腿上', '侧跨坐'],
    tags: [{ tag: 'thigh_straddling', weight: W_POSE }, { tag: 'straddling', weight: W_SOFT }],
  },
  {
    key: 'legs_over_head',
    when: ['双腿过头', '腿举过头顶', '双腿翻到头上'],
    tags: [{ tag: 'legs_over_head', weight: W_POSE }],
  },
  {
    key: 'human_chair',
    when: ['人椅', '被当椅子坐', '坐成人椅'],
    tags: [{ tag: 'human_chair', weight: W_POSE }],
  },
  // ---------------- 手与支撑：抱头 / 合十 / 交叉 / 伸出去 ----------------
  {
    key: 'arms_behind_head',
    when: ['双手抱头', '两手放脑后', '双手枕后脑'],
    tags: [{ tag: 'arms_behind_head', weight: W_POSE }],
  },
  {
    key: 'arm_behind_head',
    when: ['一只手放脑后', '单手抱头', '手枕后脑'],
    tags: [{ tag: 'arm_behind_head', weight: W_POSE }],
  },
  {
    key: 'arm_behind_back',
    when: ['手臂背在身后', '单手反背', '手放背后'],
    tags: [{ tag: 'arm_behind_back', weight: W_POSE }],
  },
  {
    key: 'crossed_arms',
    when: ['双臂交叉', '抱臂', '双手抱胸'],
    tags: [{ tag: 'crossed_arms', weight: W_POSE }],
  },
  {
    key: 'hands_together',
    when: ['双手合十', '合掌', '双手合拢'],
    tags: [{ tag: 'own_hands_together', weight: W_POSE }],
  },
  {
    key: 'fingers_interlocked',
    when: ['十指相扣', '十指紧扣', '手指交错'],
    tags: [{ tag: 'interlocked_fingers', weight: W_POSE }, { tag: 'own_hands_clasped', weight: W_SOFT }],
  },
  {
    key: 'reaching',
    when: ['伸手去够', '伸手拿', '够东西'],
    tags: [{ tag: 'reaching', weight: W_POSE }, { tag: 'outstretched_arm', weight: W_SOFT }],
  },
  {
    key: 'outstretched_arms',
    when: ['张开双臂', '双手伸开', '两臂展开'],
    tags: [{ tag: 'outstretched_arms', weight: W_POSE }],
  },
  {
    key: 'outstretched_hand',
    when: ['摊开手掌', '手掌朝前', '伸出掌心'],
    tags: [{ tag: 'outstretched_hand', weight: W_POSE }],
  },
  {
    key: 'hand_in_pocket',
    when: ['手插口袋', '手放兜里', '插兜'],
    tags: [{ tag: 'hand_in_pocket', weight: W_POSE }],
  },
  {
    key: 'hugging_object',
    when: ['抱着东西', '抱着物品', '怀里抱着物'],
    tags: [{ tag: 'hugging_object', weight: W_POSE }],
  },
  {
    key: 'paw_pose',
    when: ['猫爪手', '爪爪手', '学猫爪'],
    tags: [{ tag: 'paw_pose', weight: W_POSE }],
  },
  {
    key: 'claw_pose',
    when: ['爪状手', '比爪', '手指弯曲成爪'],
    tags: [{ tag: 'claw_pose', weight: W_POSE }],
  },
  {
    key: 'heart_hands',
    when: ['比心', '爱心手势', '做个爱心'],
    tags: [{ tag: 'heart_hands', weight: W_POSE }],
  },
  {
    key: 'finger_frame',
    when: ['手指取景框', '用手比取景框', '手指框住画面'],
    tags: [{ tag: 'finger_frame', weight: W_VIEW }],
  },
  {
    key: 'stroke_chin',
    when: ['摸下巴', '托着下巴', '手摩下巴'],
    tags: [{ tag: 'stroking_own_chin', weight: W_POSE }],
  },
  {
    key: 'hand_on_ear',
    when: ['手放耳边', '捂着耳朵', '手摸耳朵'],
    tags: [{ tag: 'hand_on_own_ear', weight: W_POSE }],
  },
  {
    key: 'w_arms',
    when: ['w字手臂', '双臂摆w', '双手摆w'],
    tags: [{ tag: 'w_arms', weight: W_POSE }],
  },
  {
    key: 'v_arms',
    when: ['v字手臂', '双臂比v', '双手举成v'],
    tags: [{ tag: 'v_arms', weight: W_POSE }],
  },
  {
    key: 'v_over_eye',
    when: ['眼前比v', '眼睛旁比v', '脸旁比剪刀手'],
    tags: [{ tag: 'v_over_eye', weight: W_POSE }],
  },
  {
    key: 'flexing',
    when: ['秀肌肉', '展示肌肉', '绷紧手臂'],
    tags: [{ tag: 'flexing', weight: W_POSE }],
  },
  {
    key: 'shrugging',
    when: ['耸肩', '摊手耸肩', '肩膀一耸'],
    tags: [{ tag: 'shrugging', weight: W_POSE }],
  },
  {
    key: 'shushing',
    when: ['示意安静', '手指抵唇', '让人别说话'],
    tags: [{ tag: 'shushing', weight: W_POSE }],
  },
  {
    key: 'salute',
    when: ['敬礼', '举手礼', '军礼'],
    tags: [{ tag: 'salute', weight: W_POSE }],
  },
  {
    key: 'waving',
    when: ['挥手', '招手', '举手打招呼'],
    tags: [{ tag: 'waving', weight: W_POSE }],
  },
  // ---------------- 贴靠与抱持：挽手 / 搂腰 / 头挨头 ----------------
  {
    key: 'locked_arms',
    when: ['互挽手臂', '胳膊挽在一起', '勾着手臂'],
    tags: [{ tag: 'locked_arms', weight: W_POSE }],
  },
  {
    key: 'arm_hug',
    when: ['挽胳膊', '挽着手臂', '挎着胳膊'],
    tags: [{ tag: 'arm_hug', weight: W_POSE }],
  },
  {
    key: 'waist_hug',
    when: ['搂腰', '抱住腰', '手环腰'],
    tags: [{ tag: 'waist_hug', weight: W_POSE }],
  },
  {
    key: 'hug_from_behind',
    when: ['从背后抱', '背后抱住', '从后面搂住'],
    tags: [{ tag: 'hug_from_behind', weight: W_POSE }, { tag: 'hug', weight: W_SOFT }],
  },
  {
    key: 'group_hug',
    when: ['抱成一团', '团团抱', '几个人抱在一起'],
    tags: [{ tag: 'group_hug', weight: W_POSE }],
  },
  {
    key: 'head_rest',
    when: ['头枕着', '头靠着', '脑袋搁着'],
    tags: [{ tag: 'head_rest', weight: W_POSE }],
  },
  {
    key: 'head_on_chest',
    when: ['头靠胸口', '靠在胸前', '脑袋贴胸'],
    tags: [{ tag: 'head_on_chest', weight: W_POSE }],
  },
  {
    key: 'heads_together',
    when: ['头挨头', '脑袋靠一起', '额头顶着头'],
    tags: [{ tag: 'heads_together', weight: W_POSE }],
  },
  {
    key: 'cheek_to_cheek',
    when: ['脸贴脸', '脸颊相贴', '贴着脸'],
    tags: [{ tag: 'cheek-to-cheek', weight: W_POSE }],
  },
  {
    key: 'forehead_together',
    when: ['额头贴额头', '额头相抵', '额头顶着'],
    tags: [{ tag: 'forehead-to-forehead', weight: W_POSE }],
  },
  {
    key: 'noses_touching',
    when: ['鼻尖相碰', '鼻子碰鼻子', '鼻尖贴'],
    tags: [{ tag: 'noses_touching', weight: W_POSE }],
  },
  {
    key: 'face_to_face',
    when: ['面对面', '正对着对方', '脸对脸'],
    tags: [{ tag: 'face-to-face', weight: W_POSE }],
  },
  {
    key: 'back_to_back',
    when: ['背靠背', '背贴着背', '背对背靠着'],
    tags: [{ tag: 'back-to-back', weight: W_POSE }],
  },
  {
    key: 'tiptoe_kiss',
    when: ['踮脚接吻', '踮着脚亲', '垫脚吻'],
    tags: [{ tag: 'tiptoe_kiss', weight: W_POSE }],
  },
  {
    key: 'shoulder_carry',
    when: ['扛在肩上', '肩扛', '扛着走'],
    tags: [{ tag: 'shoulder_carry', weight: W_POSE }, { tag: 'carrying', weight: W_SOFT }],
  },
  {
    key: 'carrying_over_shoulder',
    when: ['过肩扛', '扛在肩后', '扛起来搭肩'],
    tags: [{ tag: 'carrying_over_shoulder', weight: W_POSE }],
  },
  {
    key: 'carrying_under_arm',
    when: ['夹在腋下', '夹着走', '胳肢窝夹着'],
    tags: [{ tag: 'carrying_under_arm', weight: W_POSE }],
  },
  {
    key: 'fireman_carry',
    when: ['消防员扛', '消防式扛抱', '急救扛法'],
    tags: [{ tag: 'fireman\'s_carry', weight: W_POSE }],
  },
  {
    key: 'wing_hug',
    when: ['用翅膀抱', '翅膀裹住', '翼拥抱'],
    tags: [{ tag: 'wing_hug', weight: W_POSE }],
  },
  {
    key: 'rabbit_pose',
    when: ['兔耳手势', '比兔耳朵', '手放头上比兔耳'],
    tags: [{ tag: 'rabbit_pose', weight: W_POSE }],
  },
  {
    key: 'akanbe',
    when: ['拉眼皮吐舌', '做鬼脸拉眼皮', '翻眼皮吐舌'],
    tags: [{ tag: 'akanbe', weight: W_POSE }],
  },
  {
    key: 'star_hands',
    when: ['手比星星', '双手比星', '手指比星形'],
    tags: [{ tag: 'star_hands', weight: W_POSE }],
  },
  {
    key: 'symmetrical_hand_pose',
    when: ['对称手势', '双手对称摆', '镜像手势'],
    tags: [{ tag: 'symmetrical_hand_pose', weight: W_POSE }],
  },
  // ---------------- 腿部与脚：脚踝 / 脚趾 / 抬腿 ----------------
  {
    key: 'crossed_ankles',
    when: ['交叉脚踝', '脚踝交叠', '脚腕交叉'],
    tags: [{ tag: 'crossed_ankles', weight: W_POSE }],
  },
  {
    key: 'toe_scrunch',
    when: ['蜷脚趾', '脚趾蜷起', '脚趾抓地'],
    tags: [{ tag: 'toe_scrunch', weight: W_POSE }],
  },
  {
    key: 'plantar_flexion',
    when: ['绷脚背', '脚背绷直', '脚尖下压'],
    tags: [{ tag: 'plantar_flexion', weight: W_POSE }],
  },
  {
    key: 'dorsiflexion',
    when: ['勾脚尖', '脚尖勾起', '脚趾朝上翘'],
    tags: [{ tag: 'dorsiflexion', weight: W_POSE }],
  },
  {
    key: 'outstretched_leg',
    when: ['伸出一条腿', '腿伸出去', '腿往前伸'],
    tags: [{ tag: 'outstretched_leg', weight: W_POSE }],
  },
  {
    key: 'leg_lift',
    when: ['侧抬腿', '抬腿张开', '腿抬起来分开'],
    tags: [{ tag: 'leg_lift', weight: W_POSE }, { tag: 'leg_up', weight: W_SOFT }],
  },
  {
    key: 'pin_legs',
    when: ['腿绷直', '伸直双腿', '腿伸直夹紧'],
    tags: [{ tag: 'pin_legs', weight: W_POSE }],
  },
  // ---------------- 视线与取景补充 ----------------
  {
    key: 'looking_afar',
    when: ['望向远方', '远望', '看着远处'],
    tags: [{ tag: 'looking_afar', weight: W_VIEW }],
  },
  {
    key: 'head_out_of_frame',
    when: ['头部出框', '头不在画面里', '脑袋在画外'],
    tags: [{ tag: 'head_out_of_frame', weight: W_VIEW }, { tag: 'cropped_head', weight: W_SOFT }],
  },
  {
    key: 'out_of_frame',
    when: ['出框', '超出画面', '跑出画框'],
    tags: [{ tag: 'out_of_frame', weight: W_VIEW }],
  },
  {
    key: 'cropped_legs',
    when: ['腿被裁掉', '腿没画全', '腿部被截断'],
    tags: [{ tag: 'cropped_legs', weight: W_VIEW }],
  },
  {
    key: 'cropped_torso',
    when: ['躯干被裁掉', '看不到躯干', '身体中段裁掉'],
    tags: [{ tag: 'cropped_torso', weight: W_VIEW }],
  },
  {
    key: 'very_wide_shot',
    when: ['极远景', '超远景', '极远构图'],
    tags: [{ tag: 'very_wide_shot', weight: W_VIEW }, { tag: 'wide_shot', weight: W_SOFT }],
  },
  {
    key: 'multiple_views',
    when: ['多角度', '多视角拼图', '几个角度放一起'],
    tags: [{ tag: 'multiple_views', weight: W_VIEW }],
  },
  {
    key: 'straight_on',
    when: ['正面平视', '水平正拍', '正前方机位'],
    tags: [{ tag: 'straight-on', weight: W_VIEW }, { tag: 'facing_viewer', weight: W_SOFT }],
  },
  {
    key: 'sideways',
    when: ['画面横放', '横置构图', '整张图横过来'],
    tags: [{ tag: 'sideways', weight: W_VIEW }],
  },
  {
    key: 'fisheye',
    when: ['鱼眼', '鱼眼镜头', '鱼眼畸变'],
    tags: [{ tag: 'fisheye', weight: W_VIEW }, { tag: 'perspective', weight: W_SOFT }],
  },
  {
    key: 'perspective',
    when: ['强透视', '带透视的画', '透视感强'],
    tags: [{ tag: 'perspective', weight: W_VIEW }],
  },
  {
    key: 'from_outside',
    when: ['从室外往里看', '窗外视角', '隔着窗看进去'],
    tags: [{ tag: 'from_outside', weight: W_VIEW }],
  },
  {
    key: 'hand_focus',
    when: ['手部特写', '聚焦手', '镜头对着手'],
    tags: [{ tag: 'hand_focus', weight: W_VIEW }],
  },
  {
    key: 'hip_focus',
    when: ['胯部特写', '聚焦胯', '镜头对着胯'],
    tags: [{ tag: 'hip_focus', weight: W_VIEW }],
  },
  {
    key: 'breast_focus',
    when: ['胸部特写', '聚焦胸', '镜头对着胸'],
    tags: [{ tag: 'breast_focus', weight: W_VIEW }],
  },
  {
    key: 'armpit_focus',
    when: ['腋下特写', '聚焦腋下', '镜头对着腋窝'],
    tags: [{ tag: 'armpit_focus', weight: W_VIEW }],
  },
  {
    key: 'navel_focus',
    when: ['肚脐特写', '聚焦肚子', '镜头对着腹部'],
    tags: [{ tag: 'navel_focus', weight: W_VIEW }],
  },
  {
    key: 'pectoral_focus',
    when: ['胸肌特写', '聚焦胸肌', '镜头对着胸肌'],
    tags: [{ tag: 'pectoral_focus', weight: W_VIEW }],
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

/**
 * 纯 ASCII 词（如 '3p'）要求前后不紧邻 [a-z0-9]，否则 mp3player / v3pro 会误中。
 * @param {string} text
 * @param {number} start
 * @param {number} end
 */
function asciiWordBoundary(text, start, end) {
  const before = start > 0 ? text[start - 1] : ''
  const after = end < text.length ? text[end] : ''
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)
}

/**
 * POSE_HINTS 展平成「词 → 意图」并长度降序，模块加载时算一次。
 * 原来每次调用 detectPoseHints 都重建再排序，热路径上白烧 CPU。
 */
const FLAT_HINTS = (() => {
  /** @type {Array<{key: string, tags: Array<{tag: string, weight: number}>, word: string, needle: string, ascii: boolean}>} */
  const flat = []
  for (const hint of POSE_HINTS) {
    for (const word of hint.when) {
      const needle = normText(word)
      if (needle === '') continue
      flat.push({ key: hint.key, tags: hint.tags, word, needle, ascii: /^[a-z0-9]+$/.test(needle) })
    }
  }
  // 长词优先：同一 key 内部也按长度降序，保证 '跪趴后入' 先于 '跪趴'
  flat.sort((a, b) => b.needle.length - a.needle.length || a.needle.localeCompare(b.needle))
  return flat
})()

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
  const taken = []
  const hits = []
  const usedKeys = new Set()
  for (const item of FLAT_HINTS) {
    if (usedKeys.has(item.key)) continue
    // 首次命中的位置被别的（更长的）短语占掉时，继续往后找下一次出现 —— 整条跳过会漏检
    let from = 0
    let at = -1
    while (from <= text.length - item.needle.length) {
      const found = text.indexOf(item.needle, from)
      if (found < 0) break
      const end = found + item.needle.length
      if (item.ascii && !asciiWordBoundary(text, found, end)) {
        from = found + 1
        continue
      }
      if (taken.some(range => found < range.end && end > range.start)) {
        from = found + 1
        continue
      }
      at = found
      break
    }
    if (at < 0) continue
    const end = at + item.needle.length
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
 * @param {{ described?: string, tags?: {search: Function, get?: Function, ready?: Function} | null, limit?: number }} [options]
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
    if (index === null) return ''
    const key = normTag(tag)
    // 先走 O(1) 精确查询（tags.get），命中就直接拿 cn；拿不到再退回模糊 search
    if (typeof index.get === 'function') {
      try {
        const found = index.get(tag)
        const entry = Array.isArray(found) ? found[0] : found
        if (entry !== null && typeof entry === 'object' && normTag(entry.tag ?? '') === key && typeof entry.cn === 'string') return entry.cn
      } catch {
        // 精确查询失败就当没拿到，走下面的 search
      }
    }
    if (typeof index.search !== 'function') return ''
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
