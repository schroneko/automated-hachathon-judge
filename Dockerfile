FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.base.json tsconfig.container.json ./
COPY src ./src
RUN npm run build:container

FROM node:22-bookworm-slim
RUN apt-get update
RUN apt-get install -y ca-certificates
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/build ./build
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["./docker-entrypoint.sh"]
