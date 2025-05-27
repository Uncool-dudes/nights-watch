FROM node:24-slim AS base

RUN apt-get update && \
  apt-get install -y --no-install-recommends wget busybox ca-certificates && \
  rm -rf /var/lib/apt/lists/*


ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

ARG STOCKFISH_URL="https://github.com/official-stockfish/Stockfish/releases/latest/download/stockfish-ubuntu-x86-64-avx2.tar"

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY . .

RUN wget -qO stockfish.tar "$STOCKFISH_URL" \
  && mkdir -p ./stockfish \
  && busybox tar -xf stockfish.tar \
  && rm stockfish.tar \
  && chmod +x ./stockfish/stockfish-ubuntu-x86-64-avx2 \
  && ldd ./stockfish/stockfish-ubuntu-x86-64-avx2


FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm run build

FROM base

COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist

EXPOSE 3000

CMD ["pnpm", "start"]
