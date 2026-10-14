/**
 * Client source for the aggregated live hazard feed.
 *
 * Reads the local `/api/events` route rather than the upstreams directly, so the
 * server owns caching, rate limiting and provider keys.
 */
import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeEventSnapshot } from './records.js';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Create the hazard feed source.
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {{getSnapshot: (options?: {signal?: AbortSignal}) => Promise<object>}}
 */
export function createEventFeedSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<object>} Normalized snapshot.
     */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/events', {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Hazard feed HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        MAX_RESPONSE_BYTES,
        signal,
      );
      signal?.throwIfAborted();
      const snapshot = normalizeEventSnapshot(payload);
      if (!snapshot) throw new Error('Malformed hazard feed');
      return snapshot;
    },
  };
}
