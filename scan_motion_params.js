#!/usr/bin/env node
'use strict';

/**
 * scan_motion_params.js
 *
 * 扫描 Live2D 的 .motion3.json，导出「每个动作用到了哪些参数」，并找出
 * 共用参数过多的动作对（用来预判动作切换/叠加时的互相干扰，即「打架」）。
 *
 * 用法：
 *   node scan_motion_params.js                      # 用默认扫描路径
 *   node scan_motion_params.js <目录>               # 换扫描目录
 *   node scan_motion_params.js <目录> --out x.json  # 换输出文件名
 *   node scan_motion_params.js --threshold 3        # 共用参数 > 3 才算打架（默认 > 5）
 *   node scan_motion_params.js --top 20             # 只打印前 20 对（默认全打印）
 *
 * 产物：param_ownership.json，格式 { "动作名": ["参数1", "参数2", ...] }
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = 'D:/zyxgame/st/steamapps/common/FoxHimeZero/图/L2D/morichan';
const MOTION_SUFFIX = '.motion3.json';
const DEFAULT_THRESHOLD = 5; // 「超过 5 个相同参数」=> 共用数 > 5
const DEFAULT_OUT = 'param_ownership.json';
const DEFAULT_CONFLICTS_OUT = 'src/motionConflicts.json'; // 相对脚本所在的项目根目录

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const opts = { root: null, out: null, conflictsOut: null, threshold: DEFAULT_THRESHOLD, top: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--conflicts-out') opts.conflictsOut = argv[++i];
    else if (a === '--threshold') opts.threshold = Number(argv[++i]);
    else if (a === '--top') opts.top = Number(argv[++i]);
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (!a.startsWith('--')) opts.root = a;
  }
  if (!Number.isFinite(opts.threshold) || opts.threshold < 0) opts.threshold = DEFAULT_THRESHOLD;
  if (!Number.isFinite(opts.top) || opts.top < 0) opts.top = 0;
  return opts;
}

function walkMotions(dir, found = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMotions(full, found);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(MOTION_SUFFIX)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * 从单个 motion3.json 里取出它驱动的参数 Id（去重、保持出现顺序）。
 * Cubism 3 的 Curves 里 Target 通常是 "Parameter"；"PartOpacity" 之类
 * 不是参数，跳过并单独计数，避免污染「打架」统计。
 */
function extractParamIds(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const data = JSON.parse(raw);
  const curves = Array.isArray(data.Curves) ? data.Curves : [];

  const ids = [];
  const seen = new Set();
  let skipped = 0;

  for (const curve of curves) {
    if (!curve || typeof curve !== 'object') continue;
    const target = typeof curve.Target === 'string' ? curve.Target : 'Parameter';
    if (target !== 'Parameter') { skipped++; continue; }
    const id = curve.Id;
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  const meta = data.Meta && typeof data.Meta === 'object' ? data.Meta : {};
  return {
    ids,
    skipped,
    curveCount: Number.isFinite(meta.CurveCount) ? meta.CurveCount : curves.length,
  };
}

/** 相对 root 的 "动作名"：优先用文件名；若不同子目录下有同名文件则退回相对路径。 */
function buildActionName(root, file, baseCounts) {
  const rel = path.relative(root, file).slice(0, -MOTION_SUFFIX.length).split(path.sep).join('/');
  const base = path.basename(rel);
  return (baseCounts.get(base) || 0) > 1 ? rel : base;
}

// ---------- 打架统计 ----------

function findConflicts(ownership, threshold) {
  const names = Object.keys(ownership);
  const sets = new Map(names.map((n) => [n, new Set(ownership[n])]));
  const pairs = [];

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = sets.get(names[i]);
      const b = sets.get(names[j]);
      const [small, big] = a.size <= b.size ? [a, b] : [b, a];
      const shared = [];
      for (const id of small) if (big.has(id)) shared.push(id);
      if (shared.length > threshold) {
        pairs.push({ a: names[i], b: names[j], shared: shared.sort() });
      }
    }
  }

  pairs.sort((x, y) => y.shared.length - x.shared.length || `${x.a}|${x.b}`.localeCompare(`${y.a}|${y.b}`));
  return pairs;
}

// ---------- 输出 ----------

function pad(str, width) {
  const s = String(str);
  return s + ' '.repeat(Math.max(0, width - s.length));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('用法: node scan_motion_params.js [目录] [--out 文件] [--conflicts-out 文件] [--threshold N] [--top N]');
    return;
  }

  const root = path.resolve(opts.root || DEFAULT_ROOT);
  const outFile = path.resolve(process.cwd(), opts.out || DEFAULT_OUT);

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`[错误] 扫描目录不存在或不是目录: ${root}`);
    process.exitCode = 1;
    return;
  }

  console.log(`扫描目录: ${root}`);
  const files = walkMotions(root).sort();
  if (files.length === 0) {
    console.error(`[错误] 该目录下没有找到任何 *${MOTION_SUFFIX}`);
    process.exitCode = 1;
    return;
  }
  console.log(`找到 ${files.length} 个 motion3 文件\n`);

  const baseCounts = new Map();
  for (const f of files) {
    const base = path.basename(f).slice(0, -MOTION_SUFFIX.length);
    baseCounts.set(base, (baseCounts.get(base) || 0) + 1);
  }

  const ownership = {};
  const errors = [];
  const warnings = [];
  let skippedCurves = 0;

  for (const file of files) {
    const name = buildActionName(root, file, baseCounts);
    try {
      const { ids, skipped } = extractParamIds(file);
      ownership[name] = ids;
      skippedCurves += skipped;
      if (skipped > 0) warnings.push(`${name}: 跳过 ${skipped} 条非参数曲线`);
      if (ids.length === 0) warnings.push(`${name}: Curves 里没有任何参数（空动作？）`);
    } catch (err) {
      errors.push(`${path.relative(root, file)}: ${err.message}`);
    }
  }

  const names = Object.keys(ownership);
  if (names.length === 0) {
    console.error('[错误] 没有解析出任何动作');
    for (const e of errors) console.error('  ' + e);
    process.exitCode = 1;
    return;
  }

  // 写 param_ownership.json（键按动作名排序，便于 diff）
  const sorted = {};
  for (const n of names.slice().sort((a, b) => a.localeCompare(b))) sorted[n] = ownership[n];
  fs.writeFileSync(outFile, JSON.stringify(sorted, null, 2) + '\n', 'utf8');

  const allParams = new Set();
  for (const n of names) for (const id of ownership[n]) allParams.add(id);
  const sizes = names.map((n) => ownership[n].length);

  console.log(`写入: ${outFile}`);
  console.log(`动作数: ${names.length}   参数总数(去重): ${allParams.size}` +
    `   单动作参数数: 最少 ${Math.min(...sizes)} / 最多 ${Math.max(...sizes)}`);
  if (skippedCurves > 0) console.log(`已跳过非参数曲线: ${skippedCurves} 条`);
  if (warnings.length) {
    console.log('\n提示:');
    for (const w of warnings) console.log('  - ' + w);
  }
  if (errors.length) {
    console.log('\n解析失败:');
    for (const e of errors) console.log('  - ' + e);
  }

  // 打架预判
  const pairs = findConflicts(ownership, opts.threshold);
  const limit = opts.top > 0 ? Math.min(opts.top, pairs.length) : pairs.length;

  // 冲突对落盘：给运行时做动作调度约束用
  const conflictsOut = path.resolve(opts.conflictsOut || path.join(__dirname, DEFAULT_CONFLICTS_OUT));
  const byAction = {};
  for (const n of names) byAction[n] = [];
  for (const p of pairs) {
    byAction[p.a].push({ with: p.b, sharedCount: p.shared.length });
    byAction[p.b].push({ with: p.a, sharedCount: p.shared.length });
  }

  const conflictsDoc = {
    threshold: opts.threshold,
    pairCount: pairs.length,
    pairs: pairs.map((p) => ({ a: p.a, b: p.b, sharedCount: p.shared.length, shared: p.shared })),
    byAction,
  };
  fs.mkdirSync(path.dirname(conflictsOut), { recursive: true });
  fs.writeFileSync(conflictsOut, JSON.stringify(conflictsDoc, null, 2) + '\n', 'utf8');
  console.log(`写入: ${conflictsOut}  (${pairs.length} 对)`);

  console.log(`\n=== 共用参数 > ${opts.threshold} 的动作对: ${pairs.length} 对` +
    (limit < pairs.length ? `（显示前 ${limit} 对）` : '') + ' ===');

  if (pairs.length === 0) {
    console.log('没有动作对超过该阈值，动作之间基本不会打架。');
  }

  const nameWidth = Math.min(28, Math.max(...names.map((n) => n.length)));
  const shown = pairs.slice(0, limit);
  shown.forEach((p, i) => {
    const label = `#${i + 1}  ${pad(p.a, nameWidth)} <-> ${p.b}`;
    console.log(`${label}   共用 ${p.shared.length} 个`);
    const preview = p.shared.slice(0, 8).join(', ');
    console.log(`     ${preview}${p.shared.length > 8 ? ', …' : ''}`);
  });

  if (limit < pairs.length) {
    console.log(`\n（还有 ${pairs.length - limit} 对未显示，用 --top 0 看全部）`);
  }

  // 参数集完全相同的动作族：同一套模板的不同演绎，切换时几乎必然互相覆盖
  const families = new Map();
  for (const n of names) {
    const key = ownership[n].slice().sort().join('|');
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(n);
  }
  const familyGroups = [...families.values()].filter((g) => g.length > 1);
  if (familyGroups.length) {
    console.log('\n=== 参数集完全相同的动作族（驱动同一组参数，切换时互相覆盖）===');
    for (const g of familyGroups.sort((x, y) => y.length - x.length)) {
      console.log(`  ${g.length} 个动作 / 共用同一套 ${ownership[g[0]].length} 个参数:`);
      console.log(`    ${g.slice().sort((a, b) => a.localeCompare(b)).join(', ')}`);
    }
  }

  // 冲突热度榜：谁的「打架对象」最多
  if (pairs.length) {
    const degree = new Map(names.map((n) => [n, { partners: 0, maxShared: 0 }]));
    for (const p of pairs) {
      for (const n of [p.a, p.b]) {
        const d = degree.get(n);
        d.partners++;
        d.maxShared = Math.max(d.maxShared, p.shared.length);
      }
    }
    const hot = [...degree.entries()]
      .sort((x, y) => y[1].partners - x[1].partners || y[1].maxShared - x[1].maxShared)
      .slice(0, 5);
    console.log('\n=== 冲突热度榜（打架对象数最多的 5 个动作）===');
    for (const [n, d] of hot) {
      console.log(`  ${pad(n, nameWidth)} 与 ${d.partners} 个动作冲突，最高共用 ${d.maxShared} 个参数`);
    }
  }
}

main();
