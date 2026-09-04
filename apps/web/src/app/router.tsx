import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { UploadPage } from '../features/uploads/UploadPage';

const rootRoute = createRootRoute({
  component: () => (
    <div className="app-route">
      <Outlet />
    </div>
  ),
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: UploadPage,
});
export const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]) });
