import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LEASE_SERVICE_POLL_MS = 2;
const LEASE_SERVICE_HEARTBEAT_MS = 25;
const LEASE_SERVICE_HEARTBEAT_STALE_MS = 500;
let leaseService;

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const until = Date.now() + ms; while (Date.now() < until) {} }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function leaseIsFresh(lease, staleMs) {
  return lease && Number.isFinite(lease.updatedAt) && Date.now() - lease.updatedAt <= staleMs;
}

function tryRemoveStale(lockDir, token, staleMs) {
  const leaseFile = path.join(lockDir, 'lease.json');
  const observed = readJson(leaseFile);
  if (leaseIsFresh(observed, staleMs)) return false;
  if (!observed) {
    try { if (Date.now() - fs.statSync(lockDir).mtimeMs <= staleMs) return false; }
    catch { return false; }
  }

  const quarantine = `${lockDir}.stale-${token}`;
  try { fs.renameSync(lockDir, quarantine); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EEXIST' || error.code === 'EPERM') return false;
    throw error;
  }

  const finalLease = readJson(path.join(quarantine, 'lease.json'));
  if (leaseIsFresh(finalLease, staleMs)) {
    try { fs.renameSync(quarantine, lockDir); }
    catch {}
    return false;
  }
  fs.rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function keeperAcquire(lockDir, token, parentPid, staleMs) {
  const guardDir = `${lockDir}.guard`;
  let guarded = false;
  for (let attempt = 0; attempt < 2 && !guarded; attempt++) {
    try {
      fs.mkdirSync(guardDir);
      guarded = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(guardDir).mtimeMs > staleMs) fs.rmSync(guardDir, { recursive: true, force: true });
        else return null;
      } catch { return null; }
    }
  }
  if (!guarded) return null;

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.mkdirSync(lockDir);
        const lease = { token, keeperPid: process.pid, parentPid, updatedAt: Date.now() };
        writeJsonAtomic(path.join(lockDir, 'lease.json'), lease);
        return lease;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!tryRemoveStale(lockDir, token, staleMs)) return null;
      }
    }
    return null;
  } finally {
    fs.rmSync(guardDir, { recursive: true, force: true });
  }
}

function keeperRelease(lockDir, token) {
  const lease = readJson(path.join(lockDir, 'lease.json'));
  if (lease?.token !== token) return false;
  fs.rmSync(lockDir, { recursive: true, force: true });
  return true;
}

function leaseFailureFile(releaseFile) {
  return `${releaseFile}.failed`;
}

function runKeeper({ lockDir, token, statusFile, releaseFile, parentPid, staleMs, updateMs }) {
  let lease;
  try { lease = keeperAcquire(lockDir, token, parentPid, staleMs); }
  catch (error) {
    writeJsonAtomic(statusFile, { state: 'error', message: error.message });
    process.exit(1);
  }
  if (!lease) {
    writeJsonAtomic(statusFile, { state: 'busy' });
    process.exit(3);
  }

  writeJsonAtomic(statusFile, { state: 'acquired', pid: process.pid });
  const interval = setInterval(() => {
    const current = readJson(path.join(lockDir, 'lease.json'));
    if (current?.token !== token) {
      clearInterval(interval);
      process.exit(4);
    }
    if (!processExists(parentPid)) {
      keeperRelease(lockDir, token);
      clearInterval(interval);
      process.exit(0);
    }
    const release = readJson(releaseFile);
    if (release?.token === token) {
      keeperRelease(lockDir, token);
      clearInterval(interval);
      process.exit(0);
    }
    try {
      lease.updatedAt = Date.now();
      writeJsonAtomic(path.join(lockDir, 'lease.json'), lease);
    } catch {
      clearInterval(interval);
      process.exit(5);
    }
  }, updateMs);
}

function leaseServicePaths(directory, requestId) {
  return {
    requestFile: path.join(directory, `${requestId}.request.json`),
    responseFile: path.join(directory, `${requestId}.response.json`),
    cancelFile: path.join(directory, `${requestId}.cancel`),
  };
}

function runLeaseService({ directory, parentPid, serviceToken }) {
  const leases = new Map();
  let stopping = false;
  const heartbeatFile = path.join(directory, 'heartbeat.json');

  const forgetLease = (token, release) => {
    const active = leases.get(token);
    if (!active) return false;
    clearInterval(active.interval);
    leases.delete(token);
    return release ? keeperRelease(active.lockDir, token) : false;
  };

  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(requestInterval);
    clearInterval(parentInterval);
    clearInterval(heartbeatInterval);
    for (const token of [...leases.keys()]) {
      try { forgetLease(token, true); } catch {}
    }
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
    process.exit(0);
  };

  const registerLease = ({ lockDir, token, releaseFile, updateMs, lease }) => {
    const interval = setInterval(() => {
      const current = readJson(path.join(lockDir, 'lease.json'));
      if (current?.token !== token) {
        forgetLease(token, false);
        return;
      }
      if (readJson(releaseFile)?.token === token) {
        try { forgetLease(token, true); } catch { forgetLease(token, false); }
        return;
      }
      try {
        lease.updatedAt = Date.now();
        writeJsonAtomic(path.join(lockDir, 'lease.json'), lease);
      } catch {
        // Only this lease stops renewing; its stale directory remains recoverable.
        try { writeJsonAtomic(leaseFailureFile(releaseFile), { token }); } catch {}
        forgetLease(token, false);
      }
    }, updateMs);
    leases.set(token, { lockDir, interval });
  };

  const respond = (responseFile, value) => {
    try { writeJsonAtomic(responseFile, value); } catch {}
  };

  const handleRequest = (requestFile) => {
    const request = readJson(requestFile);
    if (!request?.requestId) {
      try { fs.rmSync(requestFile, { force: true }); } catch {}
      return;
    }
    const { responseFile, cancelFile } = leaseServicePaths(directory, request.requestId);
    try {
      if (request.operation === 'acquire') {
        if (fs.existsSync(cancelFile)) {
          respond(responseFile, { state: 'cancelled' });
          return;
        }
        const lease = keeperAcquire(request.lockDir, request.token, parentPid, request.staleMs);
        if (!lease) {
          respond(responseFile, { state: 'busy' });
          return;
        }
        if (fs.existsSync(cancelFile)) {
          keeperRelease(request.lockDir, request.token);
          respond(responseFile, { state: 'cancelled' });
          return;
        }
        registerLease({ ...request, lease });
        respond(responseFile, { state: 'acquired', pid: process.pid });
        return;
      }
      if (request.operation === 'release') {
        const active = leases.get(request.token);
        const released = active?.lockDir === request.lockDir
          ? forgetLease(request.token, true)
          : false;
        respond(responseFile, { state: 'released', released });
        return;
      }
      respond(responseFile, { state: 'error', message: 'unknown lease service operation' });
    } catch (error) {
      respond(responseFile, { state: 'error', message: error.message });
    } finally {
      try { fs.rmSync(requestFile, { force: true }); } catch {}
      try { fs.rmSync(cancelFile, { force: true }); } catch {}
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
  }, LEASE_SERVICE_POLL_MS);

  const parentInterval = setInterval(() => {
    if (!processExists(parentPid)) stop();
  }, 25);
  const writeHeartbeat = () => {
    try { writeJsonAtomic(heartbeatFile, { token: serviceToken, updatedAt: Date.now() }); } catch {}
  };
  writeHeartbeat();
  const heartbeatInterval = setInterval(writeHeartbeat, LEASE_SERVICE_HEARTBEAT_MS);
  // The channel closes when the parent exits even if a raw PID probe still sees a
  // zombie or a recycled PID. Lease requests and responses remain file based.
  if (process.connected) process.once('disconnect', stop);
}

function leaseServiceIsReachable(service) {
  if (!processExists(service.child.pid)) return false;
  const heartbeat = readJson(path.join(service.directory, 'heartbeat.json'));
  if (!heartbeat) return Date.now() - service.startedAt <= LEASE_SERVICE_HEARTBEAT_STALE_MS;
  return heartbeat.token === service.token
    && Date.now() - heartbeat.updatedAt <= LEASE_SERVICE_HEARTBEAT_STALE_MS;
}

function leaseServiceHandle() {
  if (leaseService && leaseServiceIsReachable(leaseService)) return leaseService;
  if (leaseService) {
    process.removeListener('exit', leaseService.cleanup);
    try { fs.writeFileSync(path.join(leaseService.directory, 'stop'), ''); } catch {}
    try { fs.rmSync(leaseService.directory, { recursive: true, force: true }); } catch {}
  }

  const directory = path.join(os.tmpdir(), `urdr-lease-service-${process.pid}-${crypto.randomUUID()}`);
  const token = crypto.randomUUID();
  fs.mkdirSync(directory);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--lease-service',
    directory, String(process.pid), token], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
  child.channel?.unref();

  const cleanup = () => {
    try { fs.writeFileSync(path.join(directory, 'stop'), ''); } catch {}
    const deadline = Date.now() + 1000;
    while (processExists(child.pid) && Date.now() < deadline) sleepSync(5);
    if (processExists(child.pid)) try { child.kill(); } catch {}
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
  };
  process.once('exit', cleanup);
  leaseService = { child, directory, token, startedAt: Date.now(), cleanup };
  return leaseService;
}

function publishServiceRequest(service, request) {
  const files = leaseServicePaths(service.directory, request.requestId);
  writeJsonAtomic(files.requestFile, request);
  return files;
}

function readServiceResponse(files) {
  const response = readJson(files.responseFile);
  if (!response) return null;
  try { fs.rmSync(files.responseFile, { force: true }); } catch {}
  return response;
}

function waitForServiceResponse(service, files, deadline) {
  while (Date.now() <= deadline) {
    const response = readServiceResponse(files);
    if (response) return response;
    if (!leaseServiceIsReachable(service)) return { state: 'stopped' };
    sleepSync(2);
  }
  return null;
}

function requestLeaseRelease(service, handle, deadline) {
  const requestId = crypto.randomUUID();
  let files;
  try {
    files = publishServiceRequest(service, {
      operation: 'release',
      requestId,
      lockDir: handle.lockDir,
      token: handle.token,
    });
  } catch { return null; }
  return waitForServiceResponse(service, files, deadline);
}

export function acquireLeaseLock(lockDir, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const staleMs = opts.staleMs ?? 30000;
  const updateMs = opts.updateMs ?? Math.max(25, Math.min(1000, Math.floor(staleMs / 3)));
  if (updateMs >= staleMs) throw new Error('lock updateMs must be less than staleMs');

  const absoluteLockDir = path.resolve(lockDir);
  const start = Date.now();
  for (;;) {
    const token = crypto.randomUUID();
    const releaseFile = `${absoluteLockDir}.release-${token}.json`;
    const service = leaseServiceHandle();
    const requestId = crypto.randomUUID();
    let files;
    try {
      files = publishServiceRequest(service, {
        operation: 'acquire',
        requestId,
        lockDir: absoluteLockDir,
        token,
        releaseFile,
        staleMs,
        updateMs,
      });
    } catch {
      if (Date.now() - start >= timeoutMs) throw new Error(`lock timeout: ${absoluteLockDir}`);
      sleepSync(5 + Math.floor(Math.random() * 15));
      continue;
    }
    const attemptDeadline = Math.min(start + timeoutMs, Date.now() + 2000);
    let status = waitForServiceResponse(service, files, attemptDeadline);

    if (!status) {
      try { fs.writeFileSync(files.cancelFile, ''); } catch {}
      status = waitForServiceResponse(service, files, Date.now() + 2000);
      if (status?.state === 'acquired') {
        requestLeaseRelease(service, { lockDir: absoluteLockDir, token }, Date.now() + 2000);
      }
      try { fs.rmSync(files.responseFile, { force: true }); } catch {}
      status = { state: 'cancelled' };
    }

    if (status?.state === 'acquired') {
      return { lockDir: absoluteLockDir, token, releaseFile, pid: status.pid, staleMs, updateMs };
    }
    if (status?.state === 'error') throw new Error(`lock keeper failed: ${status.message}`);
    try { fs.rmSync(releaseFile, { force: true }); } catch {}
    if (Date.now() - start >= timeoutMs) throw new Error(`lock timeout: ${absoluteLockDir}`);
    sleepSync(5 + Math.floor(Math.random() * 15));
  }
}

export function assertLeaseOwned(handle) {
  const lease = readJson(path.join(handle.lockDir, 'lease.json'));
  if (lease?.token !== handle.token) throw new Error('lock ownership lost');
  if (readJson(leaseFailureFile(handle.releaseFile))?.token === handle.token) {
    throw new Error('lock lease renewal failed');
  }
  if (!processExists(handle.pid)) throw new Error('lock lease keeper stopped');
  if (!leaseIsFresh(lease, handle.staleMs)) throw new Error('lock lease renewal failed');
  return true;
}

export function releaseLeaseLock(handle, opts = {}) {
  if (!handle) return;
  writeJsonAtomic(handle.releaseFile, { token: handle.token });
  const deadline = Date.now() + (opts.timeoutMs ?? 2000);
  const service = leaseService;
  if (service?.child.pid === handle.pid && processExists(handle.pid)) {
    requestLeaseRelease(service, handle, deadline);
  }
  while (Date.now() <= deadline) {
    const lease = readJson(path.join(handle.lockDir, 'lease.json'));
    if (!lease || lease.token !== handle.token) break;
    sleepSync(5);
  }
  try { fs.rmSync(handle.releaseFile, { force: true }); } catch {}
  try { fs.rmSync(leaseFailureFile(handle.releaseFile), { force: true }); } catch {}
}

function isMain() {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '.'); }
  catch { return false; }
}

if (isMain() && process.argv[2] === '--lease-keeper') {
  const [, , , lockDir, token, statusFile, releaseFile, parentPid, staleMs, updateMs] = process.argv;
  runKeeper({
    lockDir,
    token,
    statusFile,
    releaseFile,
    parentPid: Number(parentPid),
    staleMs: Number(staleMs),
    updateMs: Number(updateMs),
  });
}

if (isMain() && process.argv[2] === '--lease-service') {
  const [, , , directory, parentPid, serviceToken] = process.argv;
  runLeaseService({ directory, parentPid: Number(parentPid), serviceToken });
}
