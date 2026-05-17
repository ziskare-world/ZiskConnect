(function (global) {
  class ZiskConnectClient {
    constructor({ baseUrl, userCode, apiKey, fetchImpl } = {}) {
      if (!baseUrl) throw new Error('baseUrl is required');
      if (!userCode) throw new Error('userCode is required');
      if (!apiKey) throw new Error('apiKey is required');
      this.baseUrl = String(baseUrl).replace(/\/$/, '');
      this.userCode = String(userCode).trim().toUpperCase();
      this.apiKey = apiKey;
      this.fetchImpl = fetchImpl || global.fetch;
      if (!this.fetchImpl) throw new Error('fetch is not available');
    }

    async sendSms({ address, body, flash = false }) {
      return this.request('/api/external/sms/send', {
        method: 'POST',
        body: { address, body, flash }
      });
    }

    async getSmsLogs({ direction = '', status = '', applicationId = '', limit = 50 } = {}) {
      const params = new URLSearchParams();
      if (direction) params.set('direction', direction);
      if (status) params.set('status', status);
      if (applicationId) params.set('applicationId', applicationId);
      if (limit) params.set('limit', String(limit));
      const suffix = params.toString() ? `?${params}` : '';
      return this.request(`/api/external/sms/logs${suffix}`);
    }

    async getIncomingSms(limit = 25) {
      return this.getSmsLogs({ direction: 'incoming', limit });
    }

    async request(path, options = {}) {
      const headers = {
        'x-user-code': this.userCode,
        'x-api-key': this.apiKey,
        ...(options.headers || {})
      };
      const init = {
        method: options.method || 'GET',
        headers
      };
      if (options.body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(options.body);
      }

      const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `Zisk Connect request failed with ${response.status}`);
      }
      return data;
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ZiskConnectClient };
  }
  global.ZiskConnectClient = ZiskConnectClient;
})(typeof globalThis !== 'undefined' ? globalThis : window);
