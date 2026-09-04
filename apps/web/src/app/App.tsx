import { FormEvent, useEffect, useState } from 'react';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router } from './router';
import { signIn, signOut, unauthorizedEvent, useSession } from '../lib/auth-client';
import './app.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

export function App() {
  const { data: session, isPending } = useSession();
  const [unauthorized, setUnauthorized] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const showLogin = () => setUnauthorized(true);
    window.addEventListener(unauthorizedEvent, showLogin);
    return () => window.removeEventListener(unauthorizedEvent, showLogin);
  }, []);
  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    const result = await signIn({ email, password });
    if (result.error) return setError(result.error.message ?? 'Не удалось выполнить вход.');
    window.location.reload();
  };
  const logout = async () => {
    await signOut();
    setUnauthorized(true);
  };
  const openSettings = () => {
    const dialog = document.getElementById('studio-settings');
    if (dialog instanceof HTMLDialogElement) dialog.showModal();
  };
  if (isPending) return null;
  return (
    <QueryClientProvider client={queryClient}>
      {!session?.user || unauthorized ? (
        <main className="login-shell">
          <form className="login-card" onSubmit={(event) => void login(event)}>
            <div className="brand login-brand">
              <span className="logo" aria-hidden="true">S</span>
              <div><h1>SOVARA Studio</h1><small>Загрузка и публикация видео</small></div>
            </div>
            <label className="field">
              <span>Email</span>
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            </label>
            <label className="field">
              <span>Пароль</span>
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
            </label>
            <button className="primary" type="submit">Войти</button>
            {error && <p role="alert">{error}</p>}
          </form>
        </main>
      ) : (
        <>
          <header className="topbar">
            <div className="brand">
              <span className="logo" aria-hidden="true">S</span>
              <div><h1>SOVARA Studio</h1><small>Загрузка и публикация видео</small></div>
            </div>
            <div className="top-actions">
              <button className="settings-button" type="button" onClick={openSettings}>Настройки</button>
              <button type="button" onClick={() => void logout()}>Выйти</button>
            </div>
          </header>
          <RouterProvider router={router} />
        </>
      )}
    </QueryClientProvider>
  );
}
