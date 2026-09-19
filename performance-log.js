const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

class PerformanceLog {
  constructor(filePath) {
    this.filePath = filePath;
    this.enabled = false;
    this.context = new AsyncLocalStorage();
    this.sequence = 0;
    this.warned = false;
    this.queue = [];
    this.scheduled = false;
    this.writing = false;
    this.flushWaiters = [];
  }

  write(event, details = {}) {
    if (!this.enabled) return;
    const context = this.context.getStore();
    const record = {
      time: new Date().toISOString(), pid: process.pid,
      operationId: context?.id,
      operationElapsedMs: context ? this.elapsed(context.start) : undefined,
      event, ...details
    };
    try {
      this.queue.push(JSON.stringify(record) + '\n');
      this.scheduleFlush();
    } catch (error) {
      this.reportError(error);
    }
  }

  scheduleFlush() {
    if (this.scheduled || this.writing || this.queue.length === 0) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  drain() {
    if (this.writing || this.queue.length === 0) {
      this.resolveFlushWaiters();
      return;
    }
    this.writing = true;
    const batch = this.queue.splice(0).join('');
    fs.mkdir(path.dirname(this.filePath), { recursive: true }, mkdirError => {
      if (mkdirError) return this.finishWrite(mkdirError);
      fs.appendFile(this.filePath, batch, 'utf8', appendError => this.finishWrite(appendError));
    });
  }

  finishWrite(error) {
    this.writing = false;
    if (error) this.reportError(error);
    else this.warned = false;
    if (this.queue.length > 0) this.scheduleFlush();
    else this.resolveFlushWaiters();
  }

  reportError(error) {
    if (!this.warned) console.error('无法写入性能日志：', error.message);
    this.warned = true;
  }

  flush() {
    if (!this.scheduled && !this.writing && this.queue.length === 0) return Promise.resolve();
    return new Promise(resolve => {
      this.flushWaiters.push(resolve);
      this.scheduleFlush();
    });
  }

  resolveFlushWaiters() {
    if (this.scheduled || this.writing || this.queue.length > 0) return;
    for (const resolve of this.flushWaiters.splice(0)) resolve();
  }

  elapsed(start) {
    return Math.round(Number(process.hrtime.bigint() - start) / 1e3) / 1e3;
  }

  operationId() {
    return this.context.getStore()?.id;
  }

  sync(event, fn, details = {}) {
    if (!this.enabled) return fn();
    const start = process.hrtime.bigint();
    try {
      const result = fn();
      this.write(event, { ...details, durationMs: this.elapsed(start), status: 'ok' });
      return result;
    } catch (error) {
      this.write(event, { ...details, durationMs: this.elapsed(start), status: 'error', message: error.message });
      throw error;
    }
  }

  async measure(event, fn, details = {}) {
    if (!this.enabled) return fn();
    const start = process.hrtime.bigint();
    try {
      const result = await fn();
      this.write(event, { ...details, durationMs: this.elapsed(start), status: 'ok' });
      return result;
    } catch (error) {
      this.write(event, { ...details, durationMs: this.elapsed(start), status: 'error', message: error.message });
      throw error;
    }
  }

  operation(name, fn) {
    if (!this.enabled) return fn();
    const context = { id: `${process.pid}-${Date.now()}-${++this.sequence}`, start: process.hrtime.bigint() };
    return this.context.run(context, () => {
      this.write(`${name}.start`);
      return this.measure(`${name}.return`, fn);
    });
  }
}

module.exports = { PerformanceLog };
