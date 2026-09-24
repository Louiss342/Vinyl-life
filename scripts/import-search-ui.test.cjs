const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'm').exec(css)?.[1] || '';
}

test('导入搜索：弹窗在窄窗口下不用固定最小宽度撑出屏幕', () => {
  const body = rule('.vinyl-album-import');
  assert.match(body, /width:\s*min\(/);
  assert.doesNotMatch(body, /min-width:/);
  assert.match(body, /max-width:\s*100%/);
});

test('导入搜索：来源和操作收在同一行，按钮文字不换行不裁切', () => {
  assert.match(rule('.vinyl-import-result-side'), /flex-direction:\s*row/);
  const button = rule('.vinyl-import-result-side button');
  assert.match(button, /white-space:\s*nowrap/);
  assert.match(button, /width:\s*auto/);
});

test('导入搜索：来源分段控件在弹窗与浮层里各收进自家留白', () => {
  assert.match(rule('.vinyl-add-body .vinyl-import-scope'), /padding:\s*0 14px/, '浮层：两侧对齐 14px');
  assert.match(
    rule('.vinyl-add-body .vinyl-import-scope .vinyl-segments'),
    /margin-top:\s*8px/,
    '浮层：与搜索行 / 状态行同一节奏'
  );
  // 基础规则（弹窗）直接扫全文：.vinyl-add-body 的覆盖规则在文件里排在前面，
  // rule() 取的是第一次匹配，会先撞上它
  assert.match(
    css,
    /\.vinyl-import-scope \.vinyl-segments \{\s*margin:\s*10px 0 0;/,
    '弹窗：只留上边距，两侧交给容器'
  );
});

test('导入搜索：来源可选（聚合 / 仅网易云 / 仅 QQ），换档重搜、翻页同档、选择落盘', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/views/album-search.ts'), 'utf8');
  assert.match(src, /SEARCH_SCOPES/, '分段控件按档位常量渲染（与内核同源）');
  assert.match(src, /discoverAlbums\(this\.ctx, query, scope\)/, '搜索带上当前范围');
  assert.match(src, /loadMoreAlbums\(this\.ctx, this\.query, this\.scope\)/, '翻页也用当前范围');
  assert.match(src, /settings\(\)\.searchSource = scope/, '换档写回设置（记住上次选择）');
  assert.match(src, /void this\.ctx\.saveSettings\?\.\(\)/, '并落盘（宿主没给出口时静默）');
  assert.match(src, /!parseAlbumInput\(query\)/, '纯链接输入换档不重跑（那是导入动作）');
});
