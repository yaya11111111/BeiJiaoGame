/**
 * levels 集合种子数据生成脚本
 * ==================================================================
 * 输入：client/assets/resources/configs/level.*.json（D 维护的客户端关卡配置）
 * 输出：server/seeds/levels.seed.json（直接导入云开发 levels 集合）
 *
 * 为什么服务端还要存一份？
 *   客户端配置是「完整版」，答案和线索都在里面（本地判题要用）；
 *   服务端的 levels 集合是「权威副本」，用于：
 *     1. level.submit 服务端判题（防改包、防内存修改）
 *     2. level.getView 按视角下发线索（信息差玩法的服务端口径）
 *     3. level.list 给地图页提供 unlocks（通关解锁哪些节点）
 *
 * 用法（在仓库根目录）：
 *   node server/seeds/build-seed.js
 *
 * 然后到云开发控制台 → 数据库 → levels → 导入 → 选 levels.seed.json
 * （导入模式选「覆盖」/upsert，重复执行不会产生重复数据）。
 *
 * 9/27 剧情定稿、A/B 给出正式节点清单后，D 更新客户端配置，
 * 重新跑一遍这个脚本再导入即可，不用手改种子文件。
 * ==================================================================
 */

const fs = require('fs')
const path = require('path')

// 仓库根目录 = 本脚本上两级（server/seeds/ → 仓库根）
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const CONFIG_DIR = path.join(REPO_ROOT, 'client', 'assets', 'resources', 'configs')
const OUT_FILE = path.join(__dirname, 'levels.seed.json')

/** 从一个视角的 hotspots 里抽线索：inspect 热点的 text 就是要下发的线索正文 */
function extractClues(view) {
  const clues = {}
  for (const hs of (view && view.hotspots) || []) {
    if (hs.action === 'inspect' && typeof hs.text === 'string') {
      clues[hs.nodeId] = hs.text
    }
  }
  return clues
}

function buildDoc(config) {
  const doc = {
    _id: config.levelId,
    levelId: config.levelId,
    chapterId: config.chapterId,
    title: config.title,
    views: {
      A: { clues: extractClues(config.views && config.views.A) },
      B: { clues: extractClues(config.views && config.views.B) },
    },
    // rewards.progress = 通关后解锁的地图节点 id 列表（自由列表，与 chapterId 无关）
    unlocks: (config.rewards && config.rewards.progress) || [],
  }

  // 有 puzzle = 答题通关；没有 = 操作通关（服务端不判题，submit 采信上报）
  if (config.puzzle) {
    doc.puzzle = {
      type: config.puzzle.type,
      submitNodeId: config.puzzle.submitNodeId,
      // answer 可能是数组（有序）或对象（按键），原样拷贝
      answer: config.puzzle.answer,
    }
    if (Array.isArray(config.puzzle.requiredItems)) {
      doc.puzzle.requiredItems = config.puzzle.requiredItems
    }
    if (typeof config.puzzle.maxAttempts === 'number') {
      doc.puzzle.maxAttempts = config.puzzle.maxAttempts
    }
  }

  return doc
}

function main() {
  const files = fs
    .readdirSync(CONFIG_DIR)
    .filter((f) => /^level\..*\.json$/.test(f))
    .sort()

  if (files.length === 0) {
    console.error('没找到任何关卡配置：' + CONFIG_DIR)
    process.exit(1)
  }

  const docs = []
  for (const file of files) {
    const raw = fs.readFileSync(path.join(CONFIG_DIR, file), 'utf8')
    const config = JSON.parse(raw)
    const doc = buildDoc(config)
    docs.push(doc)
    console.log(
      `✓ ${file} → ${doc.levelId}（${doc.puzzle ? '答题通关' : '操作通关'}，` +
        `A 线索 ${Object.keys(doc.views.A.clues).length} 条，` +
        `B 线索 ${Object.keys(doc.views.B.clues).length} 条，` +
        `unlocks: ${doc.unlocks.join(', ') || '(无)'}）`
    )
  }

  // 云开发数据库导入要求「每行一个 JSON 对象」（JSONL），不能是整体数组
  const lines = docs.map((d) => JSON.stringify(d))
  fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n', 'utf8')
  console.log(`\n生成完毕：${OUT_FILE}（共 ${docs.length} 关，JSONL 格式）`)
  console.log('下一步：云开发控制台 → 数据库 → levels → 导入，冲突处理选 Upsert')
}

main()
