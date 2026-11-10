// 화면에 나올 글자만 남긴 작은 글꼴을 만든다.
// 이 교실에는 자유 입력이 없어서 보이는 글자가 모두 public 안의 코드에 들어 있다.
// 코드에 새 한글 문구를 넣었다면 `npm run fonts`를 다시 실행한다.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import subsetFont from 'subset-font';

const root = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(root, 'tools', 'PretendardVariable.woff2');
const OUTPUT = join(root, 'public', 'fonts', 'PretendardSubset.woff2');
const TEXT_FILES = new Set(['.html', '.js', '.css']);

async function collect(dir) {
  let text = '';
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'vendor') text += await collect(path);
    } else if (TEXT_FILES.has(extname(entry.name))) {
      text += await readFile(path, 'utf8');
    }
  }
  return text;
}

let ascii = '';
for (let code = 0x20; code < 0x7f; code++) ascii += String.fromCharCode(code);
const used = [...(await collect(join(root, 'public'))).replace(/[\x00-\x7f]/g, '')];
const chars = [...new Set([...ascii, ...used, '…', '·', '×', '÷', '–', '—', '“', '”', '‘', '’'])].join('');

const subset = await subsetFont(await readFile(SOURCE), chars, { targetFormat: 'woff2' });
await writeFile(OUTPUT, subset);
console.log(`${[...chars].length}자, ${Math.round(subset.length / 1024)}KB → ${OUTPUT}`);
