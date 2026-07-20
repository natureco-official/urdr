#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const until = Date.now() + ms; while (Date.now() < until) {} }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function removeDirectory(directory) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try { fs.rmSync(directory, { recursive: true, force: true }); return; }
    catch { sleepSync(5); }
  }
}

function match({ query, caseSensitive, texts, hierarchyCount = 0 }) {
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
  return { matches };
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx' });
  fs.renameSync(temporary, file);
}

function runServer(directory, parentPid) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(requestInterval);
    clearInterval(parentInterval);
    removeDirectory(directory);
    process.exit(0);
  };
  const handleRequest = (requestFile) => {
    let request;
    try { request = JSON.parse(fs.readFileSync(requestFile, 'utf8')); }
    catch {
      try { fs.rmSync(requestFile, { force: true }); } catch {}
      return;
    }
    const responseFile = path.join(directory, `${request.requestId}.response.json`);
    try { writeJsonAtomic(responseFile, match(request)); }
    catch (error) {
      try { writeJsonAtomic(responseFile, { error: error?.message || String(error) }); } catch {}
    } finally {
      try { fs.rmSync(requestFile, { force: true }); } catch {}
    }
  };
  const requestInterval = setInterval(() => {
    let entries;
    try { entries = fs.readdirSync(directory); }
    catch { stop(); return; }
    for (const entry of entries) {
      if (entry.endsWith('.request.json')) handleRequest(path.join(directory, entry));
    }
    if (fs.existsSync(path.join(directory, 'stop'))) stop();
  }, 1);
  const parentInterval = setInterval(() => {
    if (!processExists(parentPid)) stop();
  }, 25);
  // PID probes on Windows can see a terminated process while another process still
  // holds its handle. The inherited lifecycle channel closes immediately on parent
  // death; request/response traffic remains exclusively file based.
  if (process.connected) process.once('disconnect', stop);
}

if (process.argv[2] === '--server') {
  runServer(process.argv[3], Number(process.argv[4]));
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try { process.stdout.write(JSON.stringify(match(JSON.parse(input)))); }
    catch (error) {
      process.stderr.write(error?.message || String(error));
      process.exitCode = 1;
    }
  });
}
