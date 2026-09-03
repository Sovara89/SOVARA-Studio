FROM node:24.15.0-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/infra/package.json packages/infra/package.json
COPY packages/platforms/package.json packages/platforms/package.json
RUN pnpm install --frozen-lockfile --prod=false
COPY apps/api ./apps/api
COPY packages/contracts ./packages/contracts
COPY packages/db ./packages/db
COPY packages/infra ./packages/infra
COPY packages/platforms ./packages/platforms
COPY tsconfig.base.json tsconfig.base.json
RUN pnpm --filter @sovara-studio/api... build
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
