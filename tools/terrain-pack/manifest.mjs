// 在不改动 manifest 其余文本的前提下，为 maps.<key> 追加或替换 "packed" 字段。
// manifest 由另一个流程按原格式维护（CRLF、2192.0 这类浮点写法），整份 JSON.stringify 回写会改动已有字段的文本。

/** 返回顶层 maps 下各地图对象的文本区间与其中 packed 值的区间。 */
function scan(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const str = () => { const s = i; i++; while (text[i] !== '"') { if (text[i] === '\\') i++; i++; if (i >= text.length) throw new Error('manifest 字符串未闭合'); } i++; return JSON.parse(text.slice(s, i)); };
  const value = (path, spans) => {
    ws();
    const start = i, c = text[i];
    if (c === '{') {
      i++; ws();
      if (text[i] === '}') { i++; spans.set(path, [start, i]); return; }
      for (;;) {
        ws(); const key = str(); ws();
        if (text[i++] !== ':') throw new Error('manifest 缺少冒号 @' + i);
        value(path + '/' + key, spans); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
        throw new Error('manifest 对象格式错误 @' + i);
      }
    } else if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; spans.set(path, [start, i]); return; }
      let n = 0;
      for (;;) { value(path + '/' + n++, spans); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === ']') { i++; break; } throw new Error('manifest 数组格式错误 @' + i); }
    } else if (c === '"') str();
    else { while (i < text.length && !/[\s,\]}]/.test(text[i])) i++; }
    spans.set(path, [start, i]);
  };
  const spans = new Map();
  value('', spans);
  return spans;
}

export function upsertPacked(text, key, packed) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const spans = scan(text);
  const obj = spans.get('/maps/' + key);
  if (!obj) throw new Error(`manifest 中没有地图 ${key}`);
  // 取该地图对象内第一个字段的缩进，与原文件保持一致
  const firstLine = text.slice(obj[0], obj[1]).split(/\r?\n/)[1] || '      ';
  const indent = firstLine.match(/^\s*/)[0];
  const body = JSON.stringify(packed, null, 2).split('\n').map((l, n) => (n ? indent + l : l)).join(eol);
  const old = spans.get(`/maps/${key}/packed`);
  if (old) return text.slice(0, old[0]) + body + text.slice(old[1]);
  // 插在对象的右花括号前：回退到最后一个非空白字符之后
  let at = obj[1] - 1;
  while (at > obj[0] && /\s/.test(text[at - 1])) at--;
  return text.slice(0, at) + ',' + eol + indent + '"packed": ' + body + text.slice(at);
}
