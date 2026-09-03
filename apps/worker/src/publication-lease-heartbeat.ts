export type PublicationLeaseHeartbeat = {
  readonly signal: AbortSignal;
  readonly ownershipLost: () => boolean;
  close(): Promise<void>;
};

export function startPublicationLeaseHeartbeat(input: {
  intervalMs: number;
  renew: () => Promise<boolean>;
  parentSignal?: AbortSignal;
}): PublicationLeaseHeartbeat {
  const controller = new AbortController();
  let stopped = false;
  let lost = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const onParentAbort = () => {
    controller.abort(input.parentSignal?.reason);
    if (timer) clearTimeout(timer);
  };
  if (input.parentSignal?.aborted) onParentAbort();
  else input.parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  const tick = async () => {
    if (stopped || lost || controller.signal.aborted) return;
    inFlight = (async () => {
      try {
        if (!(await input.renew())) {
          lost = true;
          controller.abort(new Error('publication lease lost'));
        }
      } catch {
        lost = true;
        controller.abort(new Error('publication lease renewal failed'));
      } finally {
        inFlight = undefined;
        if (!stopped && !lost && !controller.signal.aborted)
          timer = setTimeout(() => void tick(), input.intervalMs);
        else resolveClosed();
      }
    })();
    await inFlight;
  };

  if (!controller.signal.aborted) timer = setTimeout(() => void tick(), input.intervalMs);

  return {
    signal: controller.signal,
    ownershipLost: () => lost,
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      input.parentSignal?.removeEventListener('abort', onParentAbort);
      if (inFlight) await inFlight;
      resolveClosed();
      await closed;
    },
  };
}
