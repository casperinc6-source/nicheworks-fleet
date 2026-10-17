/**
 * promptfoo custom provider — one fleet probe.
 *
 * promptfoo's built-in HTTP provider aborts an eval as soon as any target
 * answers 401/403/404/501 ("this error will not resolve on retry"), and a
 * hardening probe *expects* 404s: a dotfile that isn't served is exactly the
 * passing result. So the request is made here instead and the status, headers
 * and body are handed to promptfoo as a plain observation for the invariant
 * checks to grade.
 *
 * A dropped connection is reported as an observation with `status: null` rather
 * than an error, so "the server closed on us" is graded like any other finding.
 */

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BODY_CHARS = 200000;

module.exports = class FleetProbeProvider {
  constructor(options = {}) {
    this.config = options.config || {};
    this.providerId = `fleet-probe:${this.config.probe || options.label || 'unknown'}`;
  }

  id() {
    return this.providerId;
  }

  async callApi() {
    const { url, method = 'GET', headers = {}, body } = this.config;
    const timeoutMs = this.config.timeoutMs || DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();

    try {
      const response = await fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      let text = '';
      try { text = await response.text(); } catch { text = ''; }
      return {
        output: {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers),
          body: text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text,
        },
        tokenUsage: { total: 0, prompt: 0, completion: 0 },
        metadata: { probe: this.config.probe, latencyMs: Date.now() - startedAt },
      };
    } catch (error) {
      return {
        output: {
          status: null,
          statusText: null,
          headers: {},
          body: '',
        },
        tokenUsage: { total: 0, prompt: 0, completion: 0 },
        metadata: {
          probe: this.config.probe,
          latencyMs: Date.now() - startedAt,
          transportError: error && error.message ? error.message : String(error),
        },
      };
    }
  }
};
