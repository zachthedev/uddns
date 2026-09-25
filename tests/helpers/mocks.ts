import { vi, type Mock } from 'vitest';
import { ALERT_DISTINCT, type RefusalTally, type RefusalUpdate } from '../../src/refusals';

export const createMockCloudflareClient = () => {
  const mockClient = {
    user: {
      tokens: {
        verify: vi.fn(),
      },
    },
    zones: {
      list: vi.fn(),
    },
    dns: {
      records: {
        list: vi.fn(),
        update: vi.fn(),
      },
    },
  };

  return mockClient;
};

/**
 * Stands in for the SDK's `PagePromise`, which is both awaitable and async
 * iterable. The worker consumes list endpoints with `for await`, so a mock
 * that only resolves to the page would never yield an item.
 *
 * Pass the pages a real multi-page response would deliver in order.
 */
export const mockPage = <T>(...pages: { result: T[] }[]): Promise<{ result: T[] }> & AsyncIterable<T> => {
  const first = pages[0] ?? { result: [] };
  return Object.assign(Promise.resolve(first), {
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      for (const page of pages) {
        // The SDK fetches each page over the network, so the worker sees a
        // suspension point at every page boundary. Keep that shape here.
        yield* await Promise.resolve(page.result);
      }
    },
  });
};

/** KV refuses an expirationTtl under this, and the worker must respect it. */
const KV_MIN_EXPIRATION_TTL = 60;

/** The KV namespace createMockEnv puts in `env`, typed as the mock it is. */
export interface KVMock {
  get: Mock<(key: string) => Promise<string | null>>;
  put: Mock<(key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>>;
  delete: Mock<(key: string) => Promise<void>>;
  list: Mock<() => Promise<{ keys: unknown[]; list_complete: boolean; cursor: string }>>;
  getWithMetadata: Mock<() => Promise<unknown>>;
}

export const createMockKVNamespace = (): KVNamespace => {
  const storage = new Map<string, string>();

  const kv: KVMock = {
    get: vi.fn((key: string) => Promise.resolve(storage.get(key) ?? null)),
    put: vi.fn((key: string, value: string, options?: { expirationTtl?: number }) => {
      // The real namespace rejects a short TTL, and the worker swallows the
      // rejection, so a mock that accepts one turns a cache that never
      // exists into a passing test.
      const ttl = options?.expirationTtl;
      if (ttl !== undefined && ttl < KV_MIN_EXPIRATION_TTL) {
        return Promise.reject(
          new Error(
            `KV PUT failed: 400 Invalid expiration_ttl of ${String(ttl)}. Expiration TTL must be at least ${String(KV_MIN_EXPIRATION_TTL)}.`,
          ),
        );
      }
      storage.set(key, value);
      return Promise.resolve(undefined);
    }),
    delete: vi.fn((key: string) => {
      storage.delete(key);
      return Promise.resolve(undefined);
    }),
    list: vi.fn(() => Promise.resolve({ keys: [], list_complete: true, cursor: '' })),
    getWithMetadata: vi.fn<() => Promise<unknown>>(),
  };
  return kv as unknown as KVNamespace;
};

/**
 * A D1PreparedStatement mock whose bind() returns itself so callers can chain
 * .bind(...).all() or pass it to batch(). The all() default returns an empty
 * results set; override per-test via mockResolvedValue.
 */
export interface D1StatementMock {
  bind: Mock<(...values: unknown[]) => D1StatementMock>;
  all: Mock<() => Promise<{ results: unknown[] }>>;
  run: Mock<() => Promise<{ success: boolean }>>;
  first: Mock<() => Promise<unknown>>;
  raw: Mock<() => Promise<unknown[]>>;
}

/** The audit database createMockEnv puts in `env`, typed as the mock it is. */
export interface AuditDbMock {
  prepare: Mock<(query: string) => D1StatementMock>;
  batch: Mock<(statements: D1StatementMock[]) => Promise<unknown[]>>;
  exec: Mock<(query: string) => Promise<{ count: number; duration: number }>>;
  dump: Mock<() => Promise<ArrayBuffer>>;
  /** The one statement every prepare() returns, so a test reads it without calling prepare itself. */
  statement: D1StatementMock;
}

export const createMockD1Statement = (): D1StatementMock => {
  const stmt: D1StatementMock = {
    bind: vi.fn<(...values: unknown[]) => D1StatementMock>(),
    all: vi.fn<() => Promise<{ results: unknown[] }>>().mockResolvedValue({ results: [] }),
    run: vi.fn<() => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
    first: vi.fn<() => Promise<unknown>>().mockResolvedValue(null),
    raw: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
  };
  // bind() returns the same statement so chaining works
  stmt.bind.mockReturnValue(stmt);
  return stmt;
};

/** The arguments of the statement's last bind() call. Throws when bind() was never called. */
export const lastBind = (statement: D1StatementMock): unknown[] => {
  const call = statement.bind.mock.calls.at(-1);
  if (call === undefined) {
    throw new Error('bind() was never called on the statement');
  }
  return call;
};

export const createMockAuditDb = (): D1Database => {
  const statement = createMockD1Statement();
  const db: AuditDbMock = {
    prepare: vi.fn<(query: string) => D1StatementMock>().mockReturnValue(statement),
    batch: vi.fn<(statements: D1StatementMock[]) => Promise<unknown[]>>().mockResolvedValue([]),
    exec: vi.fn<(query: string) => Promise<{ count: number; duration: number }>>().mockResolvedValue({
      count: 0,
      duration: 0,
    }),
    dump: vi.fn<() => Promise<ArrayBuffer>>().mockResolvedValue(new ArrayBuffer(0)),
    statement,
  };
  return db as unknown as D1Database;
};

/** One token's stand-in counter, as the refusals namespace hands it out. */
export interface RefusalStubMock {
  add: Mock<(day: string, hostnames: string[]) => Promise<RefusalUpdate>>;
  tally: Mock<(day: string) => Promise<RefusalTally>>;
}

/** The refusals namespace createMockEnv puts in `env`, typed as the mock it is. */
export interface RefusalsMock {
  getByName: Mock<(tokenId: string) => RefusalStubMock>;
}

/** The rate limiter createMockEnv puts in `env`, typed as the mock it is. */
export interface RateLimiterMock {
  limit: Mock<(options: RateLimitOptions) => Promise<RateLimitOutcome>>;
}

/**
 * Stands in for the refusal-counter namespace, backed by a Map so a tally
 * accumulates across calls the way a real Durable Object instance would.
 * `getByName` returns the same stub per token, so tests can assert on it.
 *
 * The real object is exercised in tests/refusals.test.ts; this only has to
 * behave the way the worker reads it.
 */
export const createMockRefusals = () => {
  const tallies = new Map<string, { day: string; n: number; names: string[]; warned: boolean }>();
  const stubs = new Map<string, RefusalStubMock>();
  const getByName = vi.fn((tokenId: string): RefusalStubMock => {
    const existing = stubs.get(tokenId);
    if (existing !== undefined) {
      return existing;
    }
    const stub: RefusalStubMock = {
      add: vi.fn((day: string, hostnames: string[]): Promise<RefusalUpdate> => {
        const state = tallies.get(tokenId);
        const current = state?.day === day ? state : { day, n: 0, names: [], warned: false };
        const names = [...new Set([...current.names, ...hostnames])];
        // The object decides when a tally is worth reporting, and reports
        // it once; the worker only reads the flag. The threshold is
        // imported rather than copied, so a change to it cannot leave the
        // worker-level test asserting against a stale number.
        const alert = names.length >= ALERT_DISTINCT && !current.warned;
        tallies.set(tokenId, { day, n: current.n + hostnames.length, names, warned: alert || current.warned });
        return Promise.resolve({
          total: current.n + hostnames.length,
          distinct: names.length,
          hostnames: names,
          alert,
        });
      }),
      tally: vi.fn((day: string): Promise<RefusalTally> => {
        const state = tallies.get(tokenId);
        if (state?.day !== day) {
          return Promise.resolve({ total: 0, distinct: 0, hostnames: [] });
        }
        return Promise.resolve({ total: state.n, distinct: state.names.length, hostnames: state.names });
      }),
    };
    stubs.set(tokenId, stub);
    return stub;
  });
  const namespace: RefusalsMock = { getByName };
  return { namespace: namespace as unknown as Env['REFUSALS'], getByName, stubs };
};

export const createMockEnv = (): Env => {
  const rateLimiter: RateLimiterMock = {
    limit: vi.fn<(options: RateLimitOptions) => Promise<RateLimitOutcome>>().mockResolvedValue({ success: true }),
  };
  const env: Env = {
    DDNS_KV: createMockKVNamespace(),
    AUDIT_DB: createMockAuditDb(),
    ACCESS_KEY: '',
    RATE_LIMITER: rateLimiter,
    REFUSALS: createMockRefusals().namespace,
  };
  return env;
};

// createMockEnv types each binding as the real one, so `env` is an Env. These
// read a binding back as the mock that stands in for it.

export const kvOf = (env: Env): KVMock => env.DDNS_KV as unknown as KVMock;

export const auditDbOf = (env: Env): AuditDbMock => env.AUDIT_DB as unknown as AuditDbMock;

export const rateLimiterOf = (env: Env): RateLimiterMock => env.RATE_LIMITER as unknown as RateLimiterMock;

export const refusalsOf = (env: Env): RefusalsMock => env.REFUSALS as unknown as RefusalsMock;

export interface MockCtx {
  /** Passed to worker.fetch as the ExecutionContext. */
  ctx: ExecutionContext;
  /** Standalone mock handles for assertions (method references off the
   * ExecutionContext type would trip unbound-method). */
  waitUntil: ReturnType<typeof vi.fn>;
  passThroughOnException: ReturnType<typeof vi.fn>;
}

export const createMockCtx = (): MockCtx => {
  const waitUntil = vi.fn();
  const passThroughOnException = vi.fn();
  const ctx: ExecutionContext = {
    waitUntil,
    passThroughOnException,
    abort: vi.fn(),
    exports: {} as ExecutionContext['exports'],
    tracing: {} as ExecutionContext['tracing'],
    props: {},
  };
  return { ctx, waitUntil, passThroughOnException };
};

export const createMockRequest = (
  url: string,
  options: Partial<{
    method: string;
    headers: Record<string, string>;
    body: string;
    connectingIp: string | null;
  }> = {},
): Request => {
  const headers = new Headers(options.headers ?? {});

  // Cloudflare always sets this at the edge, so it is the default here too.
  // Pass `connectingIp: null` for the case where it is genuinely absent.
  if (options.connectingIp === null) {
    headers.delete('CF-Connecting-IP');
  } else if (options.connectingIp !== undefined) {
    headers.set('CF-Connecting-IP', options.connectingIp);
  } else if (!headers.has('CF-Connecting-IP')) {
    headers.set('CF-Connecting-IP', '192.168.1.1');
  }

  return new Request(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body,
  });
};

/** Emits a Basic auth header: `Basic base64(user:token)`. */
export const createAuthHeader = (user: string, token: string): string => {
  return `Basic ${btoa(`${user}:${token}`)}`;
};

/** Emits a Bearer auth header: `Bearer <rawToken>`. */
export const createBearerHeader = (rawToken: string): string => {
  return `Bearer ${rawToken}`;
};

/**
 * Wires the standard single-zone / single-record happy-path mocks used by
 * tests that exercise the post-auth update pipeline without customising the
 * Cloudflare API responses.
 *
 * Zone id: 'zone123', record id: 'record123', hostname: 'test.example.com',
 * current content: '192.168.1.1', token id: 'token-id-123'.
 */
export const wireStandardHappyPath = (mockClient: ReturnType<typeof createMockCloudflareClient>): void => {
  mockClient.user.tokens.verify.mockResolvedValue({ id: 'token-id-123', status: 'active' });
  mockClient.zones.list.mockReturnValue(
    mockPage({
      result: [{ id: 'zone123', name: 'example.com' }],
    }),
  );
  mockClient.dns.records.list.mockReturnValue(
    mockPage({
      result: [
        {
          id: 'record123',
          name: 'test.example.com',
          type: 'A',
          content: '192.168.1.1',
          proxied: false,
          ttl: 1,
        },
      ],
    }),
  );
  mockClient.dns.records.update.mockResolvedValue(undefined);
};
