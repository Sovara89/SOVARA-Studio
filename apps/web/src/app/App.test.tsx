// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../test/setup';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App';

vi.mock('../lib/auth-client', () => ({ signIn: vi.fn(), signOut: vi.fn(), useSession: vi.fn(), unauthorizedEvent: 'sovara:unauthorized' }));
import { signIn, useSession } from '../lib/auth-client';

describe('App', () => {
  beforeEach(() => vi.mocked(useSession).mockReturnValue({ data: null, isPending: false } as never));

  test('shows Russian email/password login and submits it to Better Auth', async () => {
    vi.mocked(signIn).mockResolvedValue({ error: { message: 'Invalid credentials' } } as never);
    render(<App />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith({ email: 'user@example.com', password: 'secret-password' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid credentials');
  });

  test('returns an authenticated session to login after an API 401 event', () => {
    vi.mocked(useSession).mockReturnValue({ data: { user: { id: 'user-id' } }, isPending: false } as never);
    render(<App />);
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeInTheDocument();
    window.dispatchEvent(new Event('sovara:unauthorized'));
    expect(screen.getByRole('button', { name: 'Войти' })).toBeInTheDocument();
  });
});
