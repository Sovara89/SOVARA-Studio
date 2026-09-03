import { apiBaseUrl } from '../env';

export async function getHealth(): Promise<{ status: string }> {
  const response = await fetch(`${apiBaseUrl}/health`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`API request failed: ${response.status}`);
  return response.json() as Promise<{ status: string }>;
}
