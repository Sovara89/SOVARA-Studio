import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  baseURL: '/api/auth',
  fetchOptions: { credentials: 'same-origin' },
});

export const signIn = authClient.signIn.email;
export const signOut = authClient.signOut;
export const getSession = authClient.getSession;
