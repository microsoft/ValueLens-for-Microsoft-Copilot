# syntax=docker/dockerfile:1

FROM node:24-alpine AS spa-build
WORKDIR /src/fabric-app
COPY ["1. Fabric/Fabric App/package.json", "1. Fabric/Fabric App/package-lock.json", "./"]
RUN npm ci
COPY ["1. Fabric/Fabric App/", "./"]
RUN npm run build

FROM node:24-alpine AS web-deps
WORKDIR /app
COPY ["2. Azure/web/package.json", "2. Azure/web/package-lock.json", "./"]
RUN npm ci --omit=dev

FROM node:24-alpine AS final
ENV NODE_ENV=production \
    PORT=8080 \
    VALUELENS_PUBLIC_DIR=/app/public \
    VALUELENS_ASK_DIR=/app/ask
WORKDIR /app
RUN addgroup -S valuelens && adduser -S valuelens -G valuelens
COPY --from=web-deps /app/node_modules ./node_modules
COPY ["2. Azure/web/package.json", "./package.json"]
COPY ["2. Azure/web/src/", "./src/"]
COPY ["1. Fabric/Fabric App/src/ask/catalogue.json", "./ask/catalogue.json"]
COPY ["1. Fabric/Fabric App/src/queries/", "./ask/queries/"]
COPY --from=spa-build /src/fabric-app/dist ./public
USER valuelens
EXPOSE 8080
CMD ["node", "src/server.js"]
