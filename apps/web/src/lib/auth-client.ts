import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  fetchOptions: { credentials: 'same-origin' },
});

export const signIn = authClient.signIn.email;
export const signOut = authClient.signOut;
export const getSession = authClient.getSession;
export function useSession(): { data: { user: { id: string } } | null; isPending: boolean } {
  return authClient.useSession() as { data: { user: { id: string } } | null; isPending: boolean };
}
export const unauthorizedEvent = 'sovara:unauthorized';
export function notifyUnauthorized(response: Response) {
  if (response.status === 401) window.dispatchEvent(new Event(unauthorizedEvent));
}
