# Bun executa TypeScript direto: não há etapa de build.
FROM oven/bun:1.2.15

WORKDIR /app

COPY package.json bun.lock ./
# Inclui as devDependencies: o serviço de migração usa o CLI do MikroORM.
RUN bun install --frozen-lockfile

COPY tsconfig.json mikro-orm.config.ts ./
COPY migrations ./migrations
COPY src ./src

ENV PORT=3000
EXPOSE 3000
USER bun

CMD ["bun", "src/main.ts"]
