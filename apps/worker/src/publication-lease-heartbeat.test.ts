import { describe, expect, test, vi } from 'vitest';
import { startPublicationLeaseHeartbeat } from './publication-lease-heartbeat.js';

describe('publication lease heartbeat', () => {
  test('renews without overlapping callbacks', async () => {
    let active = 0;
    let maximum = 0;
    const heartbeat = startPublicationLeaseHeartbeat({
      intervalMs: 5,
      renew: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 12));
        active -= 1;
        return true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    await heartbeat.close();
    expect(maximum).toBe(1);
  });

  test('aborts and reports ownership loss on renewal failure', async () => {
    const heartbeat = startPublicationLeaseHeartbeat({
      intervalMs: 1,
      renew: vi.fn().mockResolvedValue(false),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(heartbeat.ownershipLost()).toBe(true);
    expect(heartbeat.signal.aborted).toBe(true);
    await heartbeat.close();
  });

  test('cannot lose a parent abort that happened before heartbeat creation', async () => {
    const parent = new AbortController();
    const reason = new Error('runtime already shutting down');
    parent.abort(reason);
    const renew = vi.fn().mockResolvedValue(true);

    const heartbeat = startPublicationLeaseHeartbeat({
      intervalMs: 1,
      renew,
      parentSignal: parent.signal,
    });

    expect(heartbeat.signal.aborted).toBe(true);
    expect(heartbeat.signal.reason).toBe(reason);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(renew).not.toHaveBeenCalled();
    expect(heartbeat.ownershipLost()).toBe(false);
    await heartbeat.close();
  });
});
