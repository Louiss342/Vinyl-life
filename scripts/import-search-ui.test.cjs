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
