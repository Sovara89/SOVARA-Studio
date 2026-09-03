import { RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router } from './router';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <p>SOVARA Studio</p>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
