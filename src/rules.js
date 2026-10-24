'use strict';

/**
 * リスツール設定(.listt)の除外ルールを読み、JSで同じ判定をする。
 * 除外は「その列に filter の文字列が含まれていたら除外」(完全一致の部分文字列・大文字小文字を区別)。
 * 業種は置換(`、.*` → 空)後に判定される=先頭の1つだけで判定する。
 */

const COLUMN_MAP = { '屋号': 'name', '業種': 'category', '登録URL': 'website', '電話番号': 'phone' };

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tag(block, name) {
  const m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(block);
  return m ? decodeEntities(m[1]) : null;
}

function section(xml, name) {
  const m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(xml);
  return m ? m[1] : '';
}

function blocks(xml, name) {
  return [...xml.matchAll(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'g'))].map((m) => m[1]);
}

function parseListt(xmlText) {
  const xml = String(xmlText).replace(/^﻿/, '');
  const out = {
    replace: [],
    dedupeColumns: [],
    exclude: { name: [], category: [], website: [], phone: [] },
    other: {},
    ignored: [],
    excludeEmpty: {},   // 空欄なら除外する列(リスツールでは「空白だけの条件」で表していた)
  };

  for (const b of blocks(section(xml, 'option_replace_columns'), 'column')) {
    const to = tag(b, 'to') || '';
    out.replace.push({
      column: (tag(b, 'out_column_name') || '').trim(),
      from: tag(b, 'from') || '',
      to: to.trim() === '' ? '' : to,
      regex: (tag(b, 'reg') || '').trim() === '1',
    });
  }

  if ((tag(section(xml, 'option_remove_dupl') ? xml : '', 'option_remove_dupl') || '').trim() === '1') {
    out.dedupeColumns = blocks(section(xml, 'option_remove_dupl_columns'), 'column').map((c) => decodeEntities(c).trim()).filter(Boolean);
  }

  for (const b of blocks(section(xml, 'option_filter_columns'), 'column')) {
    const col = (tag(b, 'out_column_name') || '').trim();
    const type = (tag(b, 'type') || '').trim();
    let filter = tag(b, 'filter');
    if (filter === null) { out.ignored.push({ column: col, value: '', reason: 'filter要素なし' }); continue; }
    filter = filter.replace(/[\r\n]+$/, '');
    if (filter.trim() === '') {
      // 電話番号の「空白だけの条件」は「電話番号が無い店を除外する」意図(2026-10 確認済み)
      if (COLUMN_MAP[col] === 'phone') { out.excludeEmpty.phone = true; continue; }
      out.ignored.push({ column: col, value: filter, reason: '空白のみ' }); continue;
    }
    if (type !== '1') { out.ignored.push({ column: col, value: filter, reason: 'type=' + type + '(未対応)' }); continue; }
    const key = COLUMN_MAP[col];
    const list = key ? out.exclude[key] : (out.other[col] = out.other[col] || []);
    if (!list.includes(filter)) list.push(filter);
  }
  return out;
}

/** rules(parseListtの結果 または 保存JSON)から判定関数を作る。keep→null / 除外→{column, keyword} */
function compileRules(rules) {
  const ex = rules.exclude || {};
  const spec = [
    ['name', '屋号', (r) => r.name],
    ['category', '業種', (r) => r.category_main],
    ['website', '登録URL', (r) => r.website_url],
    ['phone', '電話番号', (r) => r.phone],
  ];
  const empty = rules.excludeEmpty || {};
  return function check(row) {
    for (const [key, column, get] of spec) {
      const v = get(row);
      if (v === null || v === undefined || String(v).trim() === '') {
        if (empty[key]) return { column, keyword: '(空欄)' };
        continue;
      }
      const s = String(v);
      for (const kw of ex[key] || []) if (s.includes(kw)) return { column, keyword: kw };
    }
    return null;
  };
}

/**
 * 上書き設定(rules/<名前>.overrides.json)を反映する。.listt から作り直しても消えない社内判断をここに置く。
 * 形式: { "remove": { "name": ["店"] }, "add": { "name": ["…"] }, "excludeEmpty": { "phone": true } }
 */
function applyOverrides(rules, ov) {
  if (!ov) return rules;
  const r = JSON.parse(JSON.stringify(rules));
  r.exclude = r.exclude || {};
  for (const [k, list] of Object.entries(ov.remove || {})) r.exclude[k] = (r.exclude[k] || []).filter((x) => !list.includes(x));
  for (const [k, list] of Object.entries(ov.add || {})) { r.exclude[k] = r.exclude[k] || []; for (const x of list) if (!r.exclude[k].includes(x)) r.exclude[k].push(x); }
  r.excludeEmpty = Object.assign({}, r.excludeEmpty || {}, ov.excludeEmpty || {});
  return r;
}

module.exports = { parseListt, compileRules, applyOverrides, COLUMN_MAP, decodeEntities };
