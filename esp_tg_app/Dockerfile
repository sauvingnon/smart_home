FROM node:20-alpine AS base

# Устанавливаем зависимости
FROM base AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Собираем приложение
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Запускаем
FROM base AS runner
WORKDIR /app
ENV NODE_ENV production

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3008
ENV PORT 3008
CMD ["node", "server.js"]