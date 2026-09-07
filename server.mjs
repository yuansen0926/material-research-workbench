import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const preferredPort = Number(process.env.PORT || 4173);
const openAiKey = process.env.OPENAI_API_KEY || "";
const openAiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

const curatedSources = [
  {
    title: "IEA - Global EV Outlook 2026: Electric vehicle batteries",
    url: "https://www.iea.org/reports/global-ev-outlook-2026/electric-vehicle-batteries",
    date: "2026",
    snippet: "IEA 年度电动车展望中的电池章节，用于判断电池需求、关键矿产和产业链变化。",
    type: "国际机构报告",
    grade: "A",
  },
  {
    title: "IEA - Batteries and Secure Energy Transitions",
    url: "https://www.iea.org/reports/batteries-and-secure-energy-transitions",
    date: "2024-04",
    snippet: "IEA 电池专题报告，覆盖电池制造、关键矿产、回收和能源转型中的瓶颈。",
    type: "国际机构专题报告",
    grade: "A",
  },
  {
    title: "USGS - Mineral Commodity Summaries 2026",
    url: "https://pubs.usgs.gov/publication/mcs2026",
    date: "2026-02",
    snippet: "USGS 年度矿产摘要，可用于核对锂、石墨、镍、钴、铜等关键矿产口径。",
    type: "政府矿产数据",
    grade: "A",
  },
  {
    title: "中国政府网 - China revises guidelines for lithium-ion battery industry",
    url: "https://english.www.gov.cn/news/202406/19/content_WS6672a076c6d0868f4e8e851d.html",
    date: "2024-06",
    snippet: "中国锂电池行业规范修订信息，可用于政策、质量、安全环保和产业规范分析。",
    type: "政策与规范",
    grade: "A-",
  },
];

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 1_000_000) {
      throw new Error("Request body is too large.");
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function cleanText(value = "") {
  return String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function sourceGrade(link = "") {
  try {
    const hostname = new URL(link).hostname;
    if (/iea\.org|usgs\.gov|gov\.cn|miit\.gov\.cn|ndrc\.gov\.cn/i.test(hostname)) {
      return { grade: "A", label: "官方/国际机构" };
    }
    if (/sse\.com\.cn|szse\.cn|hkexnews\.hk|sec\.gov|csrc\.gov\.cn/i.test(hostname)) {
      return { grade: "A-", label: "公告/监管披露" };
    }
    if (/caam\.org\.cn|ciaps\.org\.cn|spglobal|reuters|bloomberg|nikkei/i.test(hostname)) {
      return { grade: "B+", label: "协会/专业媒体" };
    }
    return { grade: "B", label: "公开搜索" };
  } catch {
    return { grade: "B", label: "公开搜索" };
  }
}

function mergeResults(primary, secondary) {
  const seen = new Set();
  return [...primary, ...secondary].filter((item) => {
    const key = item.url || item.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function industryQuery(query) {
  const batteryHints = /电解质|正极|负极|电解液|隔膜|铜箔|锂|钠电|固态|battery|cathode|anode|electrolyte/i.test(query);
  const context = batteryHints ? " 锂电池 电池材料 新能源汽车 储能" : " 制造业 材料 行业研究 产业链";
  return `${query}${context} -硬盘 -SSD -NVMe -京东 -淘宝 -百科`;
}

function isBadSearchResult(item) {
  const text = `${item.title || ""} ${item.snippet || ""} ${item.url || ""}`;
  return /固态硬盘|SSD|NVMe|京东|淘宝|商城|百度百科|知乎|小红书|贴吧|Wikiwand|wikipedia|百科/i.test(text);
}

function isTrustedSearchResult(item) {
  if (isBadSearchResult(item)) return false;
  if (/^A/.test(item.grade || "")) return true;
  try {
    const host = new URL(item.url).hostname;
    return /reuters|bloomberg|nikkei|spglobal|sse\.com\.cn|szse\.cn|hkexnews|sec\.gov|csrc\.gov\.cn|caam\.org\.cn|ciaps\.org\.cn|battery|energy|industry|research|pdf/i.test(host + " " + item.title);
  } catch {
    return false;
  }
}

async function bingSearch(query, limit = 6) {
  const rssUrl = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(industryQuery(query))}`;
  const response = await fetch(rssUrl, {
    headers: { "user-agent": "Mozilla/5.0 MaterialResearchDemo/1.0" },
    signal: AbortSignal.timeout(9000),
  });
  if (!response.ok) throw new Error(`RSS source returned ${response.status}.`);
  const xml = await response.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit).map((match) => {
    const block = match[1];
    const pick = (tag) => cleanText(block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] || "");
    const link = pick("link");
    const grade = sourceGrade(link);
    return {
      title: pick("title"),
      url: link,
      date: pick("pubDate"),
      snippet: pick("description"),
      type: grade.label,
      grade: grade.grade,
    };
  }).filter((item) => item.title && item.url);
}

async function collectResearchPack(material, goal = "") {
  const queries = [
    `${material} 行业研究 研报 技术路线 市场空间 竞争格局`,
    `${material} 供需 价格 产能 扩产 公告`,
    `${material} policy regulation battery material IEA USGS`,
    `${material} 上市公司 年报 招股书 客户 验证`,
  ];
  const batches = await Promise.allSettled(queries.map((query) => bingSearch(query, 5)));
  const webResults = batches.flatMap((batch) => batch.status === "fulfilled" ? batch.value : []);
  return mergeResults(curatedSources, webResults.filter(isTrustedSearchResult))
    .map((item, index) => ({ ...item, id: index + 1 }))
    .slice(0, 14);
}

function sourceGroundedReport(input, researchPack) {
  const material = input.material || "目标材料";
  const company = input.company || "制造业材料企业";
  const goal = input.goal || "形成材料赛道战略判断";
  const strongSources = researchPack.slice(0, 6);
  const sourceLine = strongSources.map((item) => `【${item.id}】${item.title}`).join("；");
  const sourceNotes = strongSources.map((item) => `来源【${item.id}】${item.title}：${item.snippet || item.note || "需进一步阅读原文核验。"}`).join("\n");
  return {
    title: `${material}行业研究与战略进入分析报告`,
    executiveSummary: [
      `本报告以“${goal}”为目标，先通过公开网络检索形成资料包，再围绕技术、需求、供给、竞争、成本、政策和企业匹配度进行结构化分析。当前资料包优先纳入官方机构、政府披露、上市公司公告和专业研究信息，代表性来源包括：${sourceLine || "公开资料待补充"}。`,
      `基于已抓取摘要，${material}的战略判断不能停留在“材料概念是否热门”，而应回到三个问题：下游客户是否真实导入、企业现有能力是否能低成本复用、供需和价格周期是否允许合理进入。对${company}而言，建议先做验证型布局，而不是直接给出重资产扩产结论。`
    ].join("\n\n"),
    technology: [
      `${material}的技术分析应从性能指标、量产稳定性、客户验证和工艺放大四层展开。公开资料只能提供方向性判断，真正决定商业化的往往是样品一致性、良率、设备适配和电芯级验证结果。`,
      `资料包提示：\n${sourceNotes}`,
      "因此，技术章节应写成“指标拆解 + 量产约束 + 客户验证问题清单”，这比简单介绍材料定义更能体现分析深度。"
    ].join("\n\n"),
    applications: "应用场景需要按动力电池、储能、消费电池、电子材料或其他下游拆分。不同场景的决策权重不同：动力场景重视安全、能量密度和车规验证；储能场景更重视寿命、成本和可靠性；电子材料场景更重视纯度、稳定性和客户认证周期。报告应说明该材料最可能率先进入的客户场景，并区分短期导入与长期空间。",
    market: "市场空间不建议直接给单一规模数字，而应采用“下游需求 - 单位材料用量 - 渗透率 - 价格假设”的推导链。联网资料包用于识别需求方向、政策约束和产业链信号；若需要正式版本，还应补充券商研报、协会数据、上市公司年报和价格数据库。",
    supply: "供给分析应区分名义产能、有效产能、认证产能和可盈利产能。很多制造业赛道都会出现公告产能大于真实可供产能的情况，因此报告需要跟踪扩产进度、良率、核心设备、原料保障和客户绑定，而不是简单统计项目数量。",
    competition: "竞争格局建议按玩家类型拆分：材料龙头、下游客户自建或参股企业、技术型新进入者、区域配套型企业。分析重点是每类玩家的优势来源：规模成本、客户关系、配方专利、工艺 know-how、供应链控制或资本开支能力。",
    costPrice: "价格和盈利弹性应拆分为原料价格、加工费、能耗、良率、折旧、库存和客户议价。当前 Demo 可用公开搜索形成价格口径提示，但正式研究中应接入 Wind、百川、隆众、卓创、生意社或公司内部采购销售数据做交叉验证。",
    policy: "政策与合规部分应关注产业规范、安全环保、碳足迹、回收责任和海外本地化。对制造业企业而言，政策不只是宏观背景，也会影响客户准入、产能审批、海外认证和供应链披露要求。",
    companyFit: `结合企业背景“${company}”和能力“${input.capability || "未填写"}”，匹配度评估建议看四项：现有工艺能否复用、客户资源能否转化为验证机会、资本开支能否分阶段控制、团队是否具备持续跟踪价格和技术迭代的能力。`,
    strategy: "建议采用“资料验证 - 客户验证 - 小试/中试 - 投资决策”的渐进路径。第一阶段先形成权威来源库和竞品数据库；第二阶段访谈客户或专家，确认真实痛点；第三阶段做样品或合作验证；第四阶段再判断自建、合资、并购或放弃。这样既体现 AI 辅助研究效率，也保留战略分析应有的审慎。",
    milestones: "第 1 周：确定材料定义、应用场景和资料来源分级。\n第 2-3 周：完成技术指标、价格口径、竞品和客户导入表。\n第 4 周：形成管理层摘要、关键风险和进入路径。\n后续：用访谈、公司公告和价格数据库替换弱来源。",
    risks: [
      "公开搜索结果可能包含百科、营销稿或重复转载，需要按来源等级筛选。",
      "行业研报中的市场规模和价格预测口径不同，不能直接横向拼接。",
      "没有客户验证数据时，技术先进性不等于商业化确定性。",
      "若使用大模型生成报告，必须保留来源包和人工复核环节，避免模型编造细节。"
    ],
    evidence: researchPack.slice(0, 8),
  };
}

function extractOutputText(payload) {
  if (payload.output_text) return payload.output_text;
  const pieces = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.text) pieces.push(content.text);
    }
  }
  return pieces.join("\n").trim();
}

function parseJsonReport(text) {
  const direct = text.trim();
  try {
    return JSON.parse(direct);
  } catch {
    const match = direct.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Model response did not contain JSON.");
    return JSON.parse(match[0]);
  }
}

function fallbackReport(input) {
  const material = input.material || "磷酸锰铁锂";
  const goal = input.goal || "判断材料赛道的战略进入价值";
  const company = input.company || "制造业材料企业";
  return {
    title: `${material}行业研究报告`,
    executiveSummary: `${material}是动力电池材料体系升级中的重要方向。本报告围绕“${goal}”展开，从技术路线、应用场景、供需格局、竞争态势、价格成本、政策合规和战略进入方式形成判断。对${company}而言，建议优先验证与现有工艺、客户和资本开支节奏的匹配度。`,
    technology: `${material}的技术价值主要体现在性能改善、成本优化或供应链安全增强。当前阶段应重点关注材料一致性、量产良率、客户验证周期、设备适配和与现有产线的耦合程度。`,
    applications: "应用端应拆分动力电池、储能、消费电池和海外客户场景。不同场景对能量密度、安全性、循环寿命、成本和认证周期的权重不同，不能用单一市场规模口径替代客户导入判断。",
    market: "需求端由新能源车、储能和海外供应链重构共同驱动。中短期市场空间取决于下游电池厂导入速度，长期空间取决于成本曲线、技术渗透率和主流路线确定性。",
    supply: "供给端需要区分名义产能、有效产能、客户认证产能和可盈利产能。公告扩产不能直接等同于有效供给，良率、客户认证和价格周期会影响实际竞争强度。",
    competition: "竞争格局呈现头部企业规模化、技术企业差异化、区域企业服务化三类路径。新进入者需要避开单纯扩产竞争，围绕客户联合开发和细分应用场景建立切入点。",
    costPrice: "价格和成本应拆分为原料、加工、良率、能耗、折旧和客户议价。建议使用基准、乐观、压力三种情景，避免用单点价格预测替代战略判断。",
    policy: "政策与合规关注产业规范、安全环保、碳足迹、回收责任和海外供应链审查。对于制造业材料企业，合规能力可能从成本项转变为客户准入门槛。",
    companyFit: `对${company}而言，匹配度取决于现有工艺复用、客户资源转化、质量体系和资本开支节奏。若只能满足部分条件，应优先采用合作验证或小试路线。`,
    strategy: `建议${company}采用“主航道验证 + 小规模期权布局”的策略：先完成样品验证、成本测算和客户反馈闭环，再决定中试、自建产线、合资合作或并购参股。`,
    milestones: "0-1个月：完成技术指标表、竞品数据库和权威来源引用库。\n1-3个月：访谈潜在客户或专家，验证真实痛点和导入门槛。\n3-6个月：形成样品、小试或合作方案，建立成本敏感性模型。\n6个月后：根据客户反馈和财务测算决定是否进入中试或投资谈判。",
    risks: [
      "上游原料价格波动可能改变盈利假设。",
      "客户认证周期可能长于项目投资节奏。",
      "技术路线替代风险会影响产能利用率。",
      "公开资料存在滞后和口径差异，关键结论需要一手访谈或企业数据复核。"
    ],
    evidence: [
      { title: "IEA - Global EV Outlook 2026: Electric vehicle batteries", type: "国际机构报告", note: "用于判断电动汽车电池需求、关键矿产需求和全球产业趋势。", url: "https://www.iea.org/reports/global-ev-outlook-2026/electric-vehicle-batteries", grade: "A" },
      { title: "IEA - Batteries and Secure Energy Transitions", type: "国际机构专题报告", note: "覆盖电池技术进步、制造、关键矿产、回收和能源转型约束。", url: "https://www.iea.org/reports/batteries-and-secure-energy-transitions", grade: "A" },
      { title: "USGS - Mineral Commodity Summaries 2026", type: "政府矿产数据", note: "用于核对锂、石墨、镍、钴、铜等关键矿产供给和统计口径。", url: "https://pubs.usgs.gov/publication/mcs2026", grade: "A" },
      { title: "中国政府网 - China revises guidelines for lithium-ion battery industry", type: "政策与规范", note: "用于识别中国锂电池行业规范、技术质量、安全环保和产业政策约束。", url: "https://english.www.gov.cn/news/202406/19/content_WS6672a076c6d0868f4e8e851d.html", grade: "A-" }
    ]
  };
}

function buildPrompt(input, researchPack = []) {
  const sources = researchPack.map((item) => [
    `【${item.id}】${item.title}`,
    `类型：${item.type || "公开资料"}；等级：${item.grade || "B"}；日期：${item.date || "未知"}`,
    `链接：${item.url}`,
    `摘要：${item.snippet || item.note || "无摘要"}`,
  ].join("\n")).join("\n\n");
  return [
    "你是一名制造业战略投资与材料行业研究分析师。",
    "请基于用户输入和下方联网资料包生成一份中文制造业材料行业研究报告。",
    "报告必须面向管理层和战略分析场景，重点体现技术理解、市场判断、竞争格局、风险和企业行动建议。",
    "必须优先使用资料包中的来源做归纳，不能编造具体公司、价格、份额或市场规模数字；无法确认的数据用判断性描述。",
    "每个关键判断后可以用【来源编号】标注依据，证据不足时明确写“需进一步核验”。",
    "请只输出 JSON，不要 Markdown。",
    "JSON 字段必须包含：title, executiveSummary, technology, applications, market, supply, competition, costPrice, policy, companyFit, strategy, milestones, risks, evidence。",
    "risks 是字符串数组，evidence 是对象数组，每个对象包含 title, type, note。",
    "每个正文段落至少 120 个中文字，适合作为可继续人工复核和修改的研究初稿。",
    "优先引用或建议核验 IEA、USGS、中国政府/工信体系、上市公司公告、行业协会、券商研报等相对权威来源。",
    "",
    `材料方向：${input.material || ""}`,
    `研究目标：${input.goal || ""}`,
    `企业背景：${input.company || ""}`,
    `现有能力：${input.capability || ""}`,
    `重点视角：${input.lens || ""}`,
    `报告深度：${input.depth || ""}`,
    `补充要求：${input.notes || ""}`,
    "",
    "联网资料包：",
    sources || "无可用联网资料。",
  ].join("\n");
}

async function generateReport(req, res) {
  let input;
  try {
    input = await readBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
    return;
  }

  const researchPack = await collectResearchPack(input.material || "", input.goal || "").catch((error) => {
    console.warn("Research pack failed:", error.message);
    return curatedSources.map((item, index) => ({ ...item, id: index + 1 }));
  });

  if (!openAiKey) {
    sendJson(res, 200, {
      ok: true,
      source: "web-research-template",
      report: sourceGroundedReport(input, researchPack),
      researchPack,
      message: "未检测到 OPENAI_API_KEY，已基于联网资料包生成结构化报告。",
    });
    return;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${openAiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: openAiModel,
        input: buildPrompt(input, researchPack),
        store: false,
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error?.message || `OpenAI request failed with ${response.status}.`;
      sendJson(res, response.status, { ok: false, error: message });
      return;
    }

    const text = extractOutputText(payload);
    const report = parseJsonReport(text);
    sendJson(res, 200, { ok: true, source: "openai", model: openAiModel, report, researchPack });
  } catch (error) {
    sendJson(res, 200, {
      ok: true,
      source: "web-research-template",
      report: sourceGroundedReport(input, researchPack),
      researchPack,
      warning: error.message,
      message: "模型生成失败，已基于联网资料包生成结构化报告。",
    });
  }
}

async function searchRss(req, res, url) {
  const query = url.searchParams.get("q") || "";
  if (!query.trim()) {
    sendJson(res, 400, { ok: false, error: "Missing query." });
    return;
  }

  const scopedQuery = `${industryQuery(query)} (site:iea.org OR site:usgs.gov OR site:gov.cn OR site:miit.gov.cn OR site:sse.com.cn OR site:szse.cn)`;
  const rssUrl = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(scopedQuery)}`;
  try {
    const response = await fetch(rssUrl, {
      headers: { "user-agent": "Mozilla/5.0 MaterialResearchDemo/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`RSS source returned ${response.status}.`);
    const xml = await response.text();
    const rssItems = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 10).map((match) => {
      const block = match[1];
      const pick = (tag) => cleanText(block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] || "");
      const link = pick("link");
      const grade = sourceGrade(link);
      return {
        title: pick("title"),
        url: link,
        date: pick("pubDate"),
        snippet: pick("description"),
        type: grade.label,
        grade: grade.grade,
      };
    }).filter((item) => item.title && item.url)
      .sort((a, b) => a.grade.localeCompare(b.grade));
    const items = mergeResults(curatedSources, rssItems.filter(isTrustedSearchResult)).slice(0, 10);
    sendJson(res, 200, { ok: true, query, results: items });
  } catch (error) {
    sendJson(res, 200, { ok: true, query, results: curatedSources, warning: error.message });
  }
}

async function fetchSource(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
    return;
  }

  let target;
  try {
    target = new URL(body.url);
    if (!/^https?:$/.test(target.protocol)) throw new Error("Only http/https URLs are supported.");
  } catch {
    sendJson(res, 400, { ok: false, error: "请输入有效的 http/https 链接。" });
    return;
  }

  const known = curatedSources.find((item) => item.url === target.href || target.href.startsWith(item.url));
  if (known) {
    sendJson(res, 200, {
      ok: true,
      source: { ...known, note: known.snippet },
      message: "已识别为内置权威来源。",
    });
    return;
  }

  try {
    const response = await fetch(target, {
      headers: { "user-agent": "Mozilla/5.0 MaterialResearchDemo/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`来源返回 ${response.status}`);
    const html = await response.text();
    const title = cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || target.hostname);
    const description = cleanText(
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i)?.[1] ||
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i)?.[1] ||
      cleanText(html).slice(0, 260)
    );
    const grade = sourceGrade(target.href);
    sendJson(res, 200, {
      ok: true,
      source: {
        title,
        url: target.href,
        date: "",
        snippet: description,
        note: description || "已抓取来源，但未识别到摘要。",
        type: grade.label,
        grade: grade.grade,
      },
    });
  } catch (error) {
    sendJson(res, 502, { ok: false, error: error.message });
  }
}

async function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const target = normalize(join(root, pathname));
  if (!target.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(target)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function createApp(port) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/api/generate-report") {
      await generateReport(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/search") {
      await searchRss(req, res, url);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/fetch-source") {
      await fetchSource(req, res);
      return;
    }
    if (req.method === "GET") {
      await serveStatic(req, res, url);
      return;
    }
    sendJson(res, 405, { ok: false, error: "Method not allowed." });
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && port < preferredPort + 20) {
      createApp(port + 1);
      return;
    }
    console.error(error);
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`Material research generator running at http://localhost:${port}`);
    if (!openAiKey) {
      console.log("OPENAI_API_KEY is not set; /api/generate-report will use web research template output.");
    }
  });
}

createApp(preferredPort);
