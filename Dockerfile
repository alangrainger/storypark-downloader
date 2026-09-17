FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
# No runtime dependencies: only the compiled output and package.json (for "type": "module").
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
VOLUME /downloads /state
EXPOSE 3000
CMD ["node", "dist/index.js"]
