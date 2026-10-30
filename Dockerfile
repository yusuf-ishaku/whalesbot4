FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY migrations ./migrations
ARG CODE_VERSION=dev
ENV CODE_VERSION=$CODE_VERSION NODE_ENV=production
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "src/main.ts"]
