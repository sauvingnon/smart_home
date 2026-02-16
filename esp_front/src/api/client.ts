import { useAuth } from '../context/AuthContext';

const API_BASE_URL = 'https://tgapp.dotnetdon.ru:4444' 
// const API_BASE_URL = 'http://localhost:8005' 

// export const API_ENDPOINTS = {
//   telemetry: `${API_BASE}/telemetry`,
//   settings: `${API_BASE}/settings`,
//   weather: `${API_BASE}/weather`
// }


class ApiClient {
  private accessKey: string | null = null;

  setAccessKey(key: string | null) {
    this.accessKey = key;
  }

  async fetch(endpoint: string, options: RequestInit = {}) {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (this.accessKey) {
      headers['X-Access-Key'] = this.accessKey;
    }

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers,
    });

    // Если 401/403 - пробрасываем ошибку для обработки
    if (response.status === 401 || response.status === 403) {
      throw new AuthError('Invalid or expired key');
    }

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response.json();
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export const apiClient = new ApiClient();