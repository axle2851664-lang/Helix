import { describe, expect, it, vi } from 'vitest';
import { ConsoleSink, Logger, MemorySink, REDACTED, redact } from './Logger.js';
import type { LogRecord, LogSink } from './Logger.js';

class CaptureSink implements LogSink {
  records: LogRecord[] = [];
  write(record: LogRecord): void {
    this.records.push(record);
  }
}

describe('redact', () => {
  it('replaces values under sensitive keys', () => {
    const out = redact({ apiKey: 'super-secret', model: 'llama3' }) as Record<string, unknown>;
    expect(out['apiKey']).toBe(REDACTED);
    expect(out['model']).toBe('llama3');
  });

  it('matches sensitive keys regardless of case or separators', () => {
    const out = redact({
      API_KEY: 'a', accessToken: 'b', 'refresh-token': 'c',
      Authorization: 'd', userPassword: 'e', privateKey: 'f',
    }) as Record<string, unknown>;
    for (const key of Object.keys(out)) {
      expect(out[key], `${key} should be redacted`).toBe(REDACTED);
    }
  });

  it('redacts a whole container when the container key is itself sensitive', () => {
    const out = redact({ provider: { name: 'x', credentials: { token: 'abc' } } }) as any;
    // Stricter than redacting just the leaf: nothing under 'credentials' survives.
    expect(out.provider.credentials).toBe(REDACTED);
    expect(out.provider.name).toBe('x');
  });

  it('redacts a sensitive leaf nested under ordinary keys', () => {
    const out = redact({ settings: { vision: { endpoint: 'http://localhost', apiKey: 'abc' } } }) as any;
    expect(out.settings.vision.apiKey).toBe(REDACTED);
    expect(out.settings.vision.endpoint).toBe('http://localhost');
  });

  // Key-based redaction alone is not enough: a key can leak through an
  // innocuous field name, so value shapes are scrubbed too.
  it('redacts key-shaped values even under a harmless key', () => {
    const out = redact({ note: 'use sk-abcdefghijklmnopqrstuvwx to auth' }) as Record<string, string>;
    expect(out['note']).not.toContain('sk-abcdefghij');
    expect(out['note']).toContain(REDACTED);
  });

  it('redacts bearer headers and JWTs in free text', () => {
    const bearer = redact('Authorization: Bearer abcdef1234567890xyz') as string;
    expect(bearer).toContain(REDACTED);

    const jwt = redact('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123') as string;
    expect(jwt).toContain(REDACTED);
  });

  it('never expands binary or media payloads into log text', () => {
    expect(redact(new ArrayBuffer(8))).toBe('[arraybuffer]');
    expect(redact(new Uint8Array([1, 2, 3]))).toBe('[binary]');
  });

  it('survives circular references', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node['self'] = node;
    const out = redact(node) as Record<string, unknown>;
    expect(out['self']).toBe('[circular]');
  });

  it('caps recursion depth', () => {
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };
    expect(JSON.stringify(redact(deep))).toContain('[depth-limit]');
  });

  it('reduces an Error to name and message', () => {
    const out = redact(new TypeError('bad input')) as Record<string, unknown>;
    expect(out['name']).toBe('TypeError');
    expect(out['message']).toBe('bad input');
  });

  it('passes through primitives unchanged', () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });
});

describe('Logger', () => {
  it('honours the level threshold', () => {
    const sink = new CaptureSink();
    const log = new Logger('test', { level: 'WARN', sinks: [sink] });

    log.error('e'); log.warn('w'); log.info('i'); log.debug('d');

    expect(sink.records.map((r) => r.level)).toEqual(['ERROR', 'WARN']);
  });

  it('can disable debug output entirely', () => {
    const sink = new CaptureSink();
    const log = new Logger('test', { level: 'ERROR', sinks: [sink] });
    log.debug('should not appear');
    expect(sink.records).toHaveLength(0);
  });

  it('redacts detail payloads before they reach a sink', () => {
    const sink = new CaptureSink();
    const log = new Logger('test', { level: 'DEBUG', sinks: [sink] });

    log.info('provider configured', { provider: 'openai', apiKey: 'sk-livekey1234567890' });

    const detail = sink.records[0]?.detail as Record<string, unknown>;
    expect(detail['apiKey']).toBe(REDACTED);
    expect(JSON.stringify(sink.records[0])).not.toContain('sk-livekey');
  });

  it('redacts the message string itself', () => {
    const sink = new CaptureSink();
    const log = new Logger('test', { level: 'DEBUG', sinks: [sink] });
    log.info('calling with sk-abcdefghijklmnopqrstuv now');
    expect(sink.records[0]?.message).toContain(REDACTED);
  });

  it('tags records with a scope and child scope', () => {
    const sink = new CaptureSink();
    const log = new Logger('helix', { level: 'DEBUG', sinks: [sink] });
    log.child('camera').info('started');
    expect(sink.records[0]?.scope).toBe('helix:camera');
  });

  it('a throwing sink cannot break the caller', () => {
    const bad: LogSink = { write: () => { throw new Error('sink down'); } };
    const good = new CaptureSink();
    const log = new Logger('test', { level: 'INFO', sinks: [bad, good] });

    expect(() => log.info('still works')).not.toThrow();
    expect(good.records).toHaveLength(1);
  });

  it('setLevel changes the threshold at runtime', () => {
    const sink = new CaptureSink();
    const log = new Logger('test', { level: 'ERROR', sinks: [sink] });
    log.debug('hidden');
    log.setLevel('DEBUG');
    log.debug('shown');
    expect(sink.records).toHaveLength(1);
  });
});

describe('MemorySink', () => {
  it('drops the oldest records past capacity', () => {
    const sink = new MemorySink(3);
    const log = new Logger('t', { level: 'DEBUG', sinks: [sink] });
    for (let i = 0; i < 5; i += 1) log.info(`m${i}`);

    expect(sink.records).toHaveLength(3);
    expect(sink.records.map((r) => r.message)).toEqual(['m2', 'm3', 'm4']);
  });

  it('clear() empties the buffer', () => {
    const sink = new MemorySink();
    new Logger('t', { level: 'DEBUG', sinks: [sink] }).info('x');
    sink.clear();
    expect(sink.records).toHaveLength(0);
  });
});

describe('ConsoleSink', () => {
  it('routes errors to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    new Logger('t', { level: 'DEBUG', sinks: [new ConsoleSink()] }).error('boom');
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
