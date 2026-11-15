// 培训题库领域模型（与手机端 lib/models/training.dart 的 TrainingQuestionItem 同构）
//
// 设计依据：《作业票属地审批链与培训题库管理设计方案.md》§3
// 责任主体：安环部确认生效；软件自动检索生成 pending，确认后转 enabled。
// 三态：pending 待确认 / enabled 已启用 / disabled 已停用。
// 合规：《安全生产法》§25 未经培训合格不得上岗；合格线 80 分。

export const QUESTION_TYPES = ['单选', '多选', '判断'];
export const QUESTION_LEVELS = ['基础', '中等', '较难'];
export const QUESTION_CATEGORIES = ['通用', '动火', '受限空间', '高处', '消防', '应急', '岗位', '有限空间'];
export const QUESTION_STATUS = { pending: '待确认', enabled: '已启用', disabled: '已停用' };
export const PASS_LINE = 80;

// 内置种子题库（法规常识，与手机端 TrainingQuestion.bank / TrainingQuestionItem.seedItems 同源）
// 答案 answer 为下标数组：单选/判断长度 1，多选 > 1；判断固定 ['正确','错误']。
export const SEED_QUESTIONS = [
  { id: 'seed_q01', type: '单选', stem: '未经安全生产教育和培训合格的从业人员，是否可以上岗作业？', options: ['可以', '不可以', '培训一天后可以', '领导同意即可'], answer: [1], explain: '《安全生产法》第二十五条', category: '通用', level: '基础' },
  { id: 'seed_q02', type: '单选', stem: '金属冶炼等高危行业新上岗从业人员岗前安全培训时间不得少于多少学时？', options: ['24学时', '32学时', '48学时', '72学时'], answer: [3], explain: '《生产经营单位安全培训规定》第十三条', category: '通用', level: '基础' },
  { id: 'seed_q03', type: '单选', stem: '三级安全培训教育是指哪三级？', options: ['公司级、部门级、班组级', '厂（矿）级、车间（工段）级、班组级', '集团级、厂级、车间级', '入职级、年度级、专项级'], answer: [1], explain: '《生产经营单位安全培训规定》第十四条', category: '通用', level: '基础' },
  { id: 'seed_q04', type: '单选', stem: '特种作业操作证有效期为多久？', options: ['3年', '6年', '9年', '长期有效'], answer: [1], explain: '《特种作业人员安全技术培训考核管理规定》第十九条', category: '岗位', level: '基础' },
  { id: 'seed_q05', type: '单选', stem: '特种作业操作证每几年复审一次？', options: ['1年', '2年', '3年', '6年'], answer: [2], explain: '《特种作业人员安全技术培训考核管理规定》第二十一条', category: '岗位', level: '中等' },
  { id: 'seed_q06', type: '单选', stem: '动火作业（特级/一级）有效期最长不超过多久？', options: ['8小时', '24小时', '72小时', '7天'], answer: [0], explain: 'GB 30871-2022 第5.1.5条（工贸行业参照基准）', category: '动火', level: '中等' },
  { id: 'seed_q07', type: '单选', stem: '受限空间作业氧含量合格范围是多少？', options: ['18%~21%', '19.5%~23.5%', '20%~25%', '21%~25%'], answer: [1], explain: '《有限空间作业安全技术规范》', category: '有限空间', level: '基础' },
  { id: 'seed_q08', type: '判断', stem: '受限空间作业期间，可以向内部通纯氧通风。', options: ['正确', '错误'], answer: [1], explain: 'GB 30871-2022 第六章：严禁向受限空间通纯氧', category: '有限空间', level: '中等' },
  { id: 'seed_q09', type: '单选', stem: '高处安全作业票有效期最长为多久？', options: ['24小时', '72小时', '7天', '15天'], answer: [2], explain: 'GB 30871-2022 第8.2.11条（参照基准）', category: '高处', level: '中等' },
  { id: 'seed_q10', type: '单选', stem: '从业人员离岗多久以上重新上岗，须重新接受车间级和班组级安全培训？', options: ['三个月', '六个月', '一年', '两年'], answer: [2], explain: '《生产经营单位安全培训规定》第十九条', category: '通用', level: '基础' },
  { id: 'seed_q11', type: '判断', stem: '采用新工艺、新技术、新材料或使用新设备时，需要对从业人员进行专门培训。', options: ['正确', '错误'], answer: [0], explain: '《安全生产法》第二十九条', category: '通用', level: '基础' },
  { id: 'seed_q12', type: '单选', stem: '受限空间作业时，监护人应当站在什么位置？', options: ['受限空间内', '受限空间外全程监护', '任意位置', '远距离巡视'], answer: [1], explain: 'GB 30871-2022 第6.8条（参照基准）', category: '有限空间', level: '基础' },
  { id: 'seed_q13', type: '单选', stem: '金属冶炼单位主要负责人和安全生产管理人员初次安全培训不得少于多少学时？', options: ['24学时', '32学时', '48学时', '72学时'], answer: [2], explain: '《生产经营单位安全培训规定》第九条', category: '通用', level: '中等' },
  { id: 'seed_q14', type: '单选', stem: '高处作业人员佩戴安全带的正确方式是？', options: ['低挂高用', '高挂低用', '随意挂扣', '可不佩戴'], answer: [1], explain: 'GB 6095《坠落防护 安全带》', category: '高处', level: '基础' },
  { id: 'seed_q15', type: '多选', stem: '生产经营单位应当如实记录安全生产教育和培训的哪些情况？', options: ['培训时间', '培训内容', '参加人员', '考核结果'], answer: [0, 1, 2, 3], explain: '《安全生产法》第二十八条：时间、内容、参加人员以及考核结果', category: '通用', level: '中等' },
  { id: 'seed_q16', type: '判断', stem: '工贸企业有限空间作业应严格执行「先通风、再检测、后作业」。', options: ['正确', '错误'], answer: [0], explain: '应急管理部令第 13 号《工贸企业有限空间作业安全规定》§14', category: '有限空间', level: '基础' },
  { id: 'seed_q17', type: '多选', stem: '下列哪些属于特种作业？', options: ['电工作业', '焊接与热切割作业', '高处作业', '一般文书工作'], answer: [0, 1, 2], explain: '《特种作业人员安全技术培训考核管理规定》附件《特种作业目录》', category: '岗位', level: '中等' }
];

/** 生成内置种子题目（默认已启用，保证离线可考；云端同 id 存在时以云端为准） */
export function seedQuestions() {
  const now = new Date().toISOString();
  return SEED_QUESTIONS.map((q) => Object.assign({}, q, {
    cloudId: '', version: 1, status: 'enabled', source: 'seed',
    sourceRef: q.explain, sourceUrl: '',
    jobTags: [], workshopTags: [], confirmedBy: '系统内置', confirmedAt: now,
    createdAt: now, updatedAt: now, stats: { answered: 0, errorRate: 0 }
  }));
}

/** 合并内置种子与云端题目：云端同 id 覆盖种子（安环部确认结果优先） */
export function mergeQuestions(cloud) {
  const seeds = seedQuestions();
  const list = (cloud || []).filter((q) => q && !q.isDeleted);
  const byId = new Map();
  seeds.forEach((q) => byId.set(String(q.id), q));
  list.forEach((q) => byId.set(String(q.id || q._id), q));
  return [...byId.values()];
}

/** 组卷：优先已启用题目；难度按 基础60%/中等30%/较难10% 配比；同一次随机打散 */
export function drawPaper(pool, size = 15) {
  const list = (pool && pool.length) ? pool.slice() : seedQuestions();
  const shuffle = (arr) => arr.slice().sort(() => Math.random() - 0.5);
  const pick = (arr, n) => shuffle(arr).slice(0, n);
  const basic = list.filter((q) => (q.level || '基础') === '基础');
  const medium = list.filter((q) => q.level === '中等');
  const hard = list.filter((q) => q.level === '较难');
  const nb = Math.min(basic.length, Math.round(size * 0.6));
  const nm = Math.min(medium.length, Math.round(size * 0.3));
  const nh = Math.min(hard.length, Math.max(0, size - nb - nm));
  let paper = [...pick(basic, nb), ...pick(medium, nm), ...pick(hard, nh)];
  if (paper.length < size) {
    const used = new Set(paper.map((q) => q.id));
    paper = paper.concat(pick(list.filter((q) => !used.has(q.id)), size - paper.length));
  }
  return shuffle(paper).slice(0, size).map((q) => Object.assign({}, q, {
    _answer: q.type === '多选' ? [] : null,
    _ok: false
  }));
}

/** 判分：多选需选项集合完全一致 */
export function gradePaper(paper) {
  let right = 0;
  (paper || []).forEach((q) => {
    const correct = (q.answer || []).slice().map(Number).sort().join(',');
    const mine = (q._answer == null ? [] : [].concat(q._answer)).map(Number).sort().join(',');
    q._ok = correct !== '' && correct === mine;
    if (q._ok) right++;
  });
  const total = (paper || []).length || 1;
  return { score: Math.round(right / total * 100), right, total };
}

export function answerText(q) {
  return (q.answer || []).map((i) => String.fromCharCode(65 + Number(i))).join('、');
}
