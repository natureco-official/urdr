#!/usr/bin/env node

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const { query, caseSensitive, texts, hierarchyCount = 0 } = JSON.parse(input);
    const flags = caseSensitive ? '' : 'i';
    let matcher;
    try {
      matcher = new RegExp(query, flags);
    } catch {
      matcher = new RegExp(String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    }
    const matches = [];
    for (let index = 0; index < texts.length; index++) {
      matcher.lastIndex = 0;
      if (matcher.test(texts[index])) matches.push(index);
      if (hierarchyCount > 0 && index + 1 === hierarchyCount && matches.length > 0) break;
    }
    process.stdout.write(JSON.stringify({ matches }));
  } catch (error) {
    process.stderr.write(error?.message || String(error));
    process.exitCode = 1;
  }
});
