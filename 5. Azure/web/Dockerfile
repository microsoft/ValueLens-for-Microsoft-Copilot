# syntax=docker/dockerfile:1

FROM node:22-alpine AS spa-build
WORKDIR /src/fabric-app
COPY ["1. Fabric/Fabric App/package.json", "1. Fabric/Fabric App/package-lock.json", "./"]
RUN npm ci
COPY ["1. Fabric/Fabric App/", "./"]
RUN npm run build

FROM node:22-alpine AS web-deps
WORKDIR /app
COPY ["5. Azure/web/package.json", "5. Azure/web/package-lock.json", "./"]
RUN npm ci --omit=dev

FROM node:22-alpine AS final
ENV NODE_ENV=production \
    PORT=8080 \
    VALUELENS_PUBLIC_DIR=/app/public
WORKDIR /app
RUN addgroup -S valuelens && adduser -S valuelens -G valuelens
COPY --from=web-deps /app/node_modules ./node_modules
COPY ["5. Azure/web/package.json", "./package.json"]
COPY ["5. Azure/web/src/", "./src/"]
COPY --from=spa-build /src/fabric-app/dist ./public
USER valuelens
EXPOSE 8080
CMD ["node", "src/server.js"]
